import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type Socket as TcpSocket } from 'node:net'
import test from 'node:test'
import { DEFAULTS } from '../config'
import { ConfigUpdateConflictFailure } from '../rpc/contract'
import { listenOrSkip } from '../test-helpers'
import type { DataEngine } from '../web/data-engine'
import type { WebSnapshot } from '../web/contract'
import { mountWsRpc } from '../web/ws'
import { createDaemonRpcClient, DaemonRpcRequestTimeoutError, type RpcConnState } from './daemon-rpc-client'

interface ConnEvent {
  readonly state: RpcConnState
  readonly error?: unknown
  readonly at: number
}

/** Captures the onConn callback sequence plus arrival times, so the backoff
 * schedule can be asserted from observable data alone. */
function connRecorder() {
  const events: ConnEvent[] = []
  return {
    events,
    states: () => events.map(event => event.state),
    onConn: (state: RpcConnState, error?: unknown) => {
      events.push({ state, error, at: Date.now() })
    },
    count: (state: RpcConnState) => events.filter(event => event.state === state).length,
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} was not reached within ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function stubEngine(overrides: Partial<DataEngine> = {}): DataEngine {
  return {
    snapshot: () => null,
    sessionUsage: async () => { throw new Error('session usage not configured') },
    start: () => {},
    subscribe: () => () => {},
    subscribeConfig: () => () => {},
    touch: () => {},
    refresh: async () => {},
    setConfig: () => {},
    broadcastConfig: () => {},
    stop: () => {},
    ...overrides,
  }
}

const sampleSnapshot: WebSnapshot = {
  version: 'semantics-test',
  generatedAt: Date.now(),
  tz: 'UTC',
  intervalMs: 1_000,
  billingIntervalMs: 60_000,
  providers: [],
  accounts: [],
  seeded: false,
  peak: null,
}

async function unusedLoopbackUrl(t: test.TestContext): Promise<string | null> {
  const server = createServer()
  if (!await listenOrSkip(t, server)) return null
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return `http://127.0.0.1:${address.port}`
}

interface Daemon {
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

async function startDaemon(engine: DataEngine, port: number): Promise<Daemon> {
  const server: Server = createServer()
  const closeRpc = await mountWsRpc(server, { engine, state: { config: { ...DEFAULTS } } })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await closeRpc()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** A listener that accepts the TCP connection and then says nothing, so the
 * WebSocket upgrade never completes and a connect attempt stays in flight for a
 * known window instead of failing instantly like a refused port would. */
async function startBlackHole(): Promise<Daemon> {
  const sockets = new Set<TcpSocket>()
  const server = createTcpServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

test('a failed connect reports connecting then error and starts no reconnect loop without subscriptions', async (t) => {
  const url = await unusedLoopbackUrl(t)
  if (!url) return
  const conn = connRecorder()
  const client = createDaemonRpcClient(url, {
    transport: 'node',
    reconnectAttempts: 5,
    reconnectBaseDelayMs: 10,
    requestTimeoutMs: 100,
    onConn: conn.onConn,
  })
  try {
    await assert.rejects(client.getConfig())
    assert.deepEqual(conn.states(), ['connecting', 'error'])
    assert.notEqual(conn.events[1]!.error, undefined)

    // No subscription exists, so nothing may retry in the background.
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.deepEqual(conn.states(), ['connecting', 'error'])
  } finally {
    await client.close()
  }
  assert.deepEqual(conn.states(), ['connecting', 'error', 'closed'])
})

test('a subscription against a dead daemon retries on the bounded backoff schedule', async (t) => {
  const url = await unusedLoopbackUrl(t)
  if (!url) return
  const conn = connRecorder()
  const baseDelayMs = 60
  const client = createDaemonRpcClient(url, {
    transport: 'node',
    reconnectAttempts: 2,
    reconnectBaseDelayMs: baseDelayMs,
    requestTimeoutMs: 100,
    onConn: conn.onConn,
  })
  const unsubscribe = client.subscribeSnapshot(() => {})
  try {
    // Initial attempt plus exactly `reconnectAttempts` retries. The client has
    // never been live, so every attempt announces itself as 'connecting'.
    await waitFor(() => conn.count('error') >= 3, 'three failed connect attempts')
    assert.deepEqual(conn.states(), ['connecting', 'error', 'connecting', 'error', 'connecting', 'error'])

    // min(2500, base * 1.5 ** attemptsUsed) separates a failure from the retry.
    const retryDelays = [1, 2].map(retry => {
      const failed = conn.events.filter(event => event.state === 'error')[retry - 1]!
      const retried = conn.events.filter(event => event.state === 'connecting')[retry]!
      return retried.at - failed.at
    })
    assert.ok(retryDelays[0]! >= baseDelayMs - 5, `first backoff ${retryDelays[0]}ms < ${baseDelayMs}ms`)
    assert.ok(retryDelays[1]! >= baseDelayMs * 1.5 - 5, `second backoff ${retryDelays[1]}ms < ${baseDelayMs * 1.5}ms`)

    // The attempt bound is honoured: nothing more is scheduled.
    await new Promise(resolve => setTimeout(resolve, baseDelayMs * 3))
    assert.equal(conn.count('connecting'), 3)
  } finally {
    unsubscribe()
    await client.close()
  }
})

test('a unary call issued during an in-flight connect attempt does not collapse the next backoff rung', async (t) => {
  const listening = await listenOrSkip(t, startBlackHole)
  if (!listening) return
  const blackHole = listening.value
  const conn = connRecorder()
  const baseDelayMs = 400
  const client = createDaemonRpcClient(blackHole.url, {
    transport: 'node',
    reconnectAttempts: 2,
    reconnectBaseDelayMs: baseDelayMs,
    requestTimeoutMs: 250,
    onConn: conn.onConn,
  })
  const unsubscribe = client.subscribeSnapshot(() => {})
  try {
    // Land the unary call inside the first attempt's open timeout. It rides that
    // very attempt, so it adds no demand the supervisor is not already serving,
    // and its wake-up poke must not outlive the attempt it was raised during.
    await waitFor(() => conn.count('connecting') >= 1, 'the first connect attempt')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(conn.count('error'), 0, 'the first connect attempt should still be in flight')
    const pending = assert.rejects(client.getConfig())

    await waitFor(() => conn.count('connecting') >= 2, 'the first retry attempt', 5_000)
    await pending

    const failedAt = conn.events.find(event => event.state === 'error')!.at
    const retriedAt = conn.events.filter(event => event.state === 'connecting')[1]!.at
    assert.ok(
      retriedAt - failedAt >= baseDelayMs - 20,
      `retry waited ${retriedAt - failedAt}ms, expected the full ${baseDelayMs}ms backoff rung`,
    )
  } finally {
    unsubscribe()
    await client.close()
    await blackHole.stop()
  }
})

test('unsubscribing to zero while live does not collapse the next backoff rung', async (t) => {
  const snapshotEngine = () => stubEngine({
    subscribe: (onSnapshot) => {
      onSnapshot({ ...sampleSnapshot, generatedAt: Date.now() })
      return () => {}
    },
  })
  const listening = await listenOrSkip(t, async () => startDaemon(snapshotEngine(), 0))
  if (!listening) return
  const daemon = listening.value
  let daemonStopped = false
  const stopDaemon = async () => {
    if (daemonStopped) return
    daemonStopped = true
    await daemon.stop()
  }

  const conn = connRecorder()
  // Large enough that the rung dominates the dead session's ~1s scope teardown.
  const baseDelayMs = 2_400
  const client = createDaemonRpcClient(daemon.url, {
    transport: 'node',
    reconnectAttempts: 1,
    reconnectBaseDelayMs: baseDelayMs,
    requestTimeoutMs: 500,
    onConn: conn.onConn,
  })
  let unsubscribe = client.subscribeSnapshot(() => {})
  try {
    await waitFor(() => conn.count('live') >= 1, 'the first live session')

    // Churn the last subscription while the session is live — a React effect
    // cleanup or a TUI pane toggle. The supervisor is parked on the session, so
    // the wake-up poke this raises has no waiter, and the ladder started by the
    // next death must not inherit it.
    unsubscribe()
    unsubscribe = client.subscribeSnapshot(() => {})

    await stopDaemon()
    await waitFor(() => conn.count('reconnecting') >= 1, 'the session death', 5_000)
    const diedAt = conn.events.find(event => event.state === 'reconnecting')!.at

    await waitFor(() => conn.count('reconnecting') >= 2, 'the first retry attempt', 10_000)
    const retriedAt = conn.events.filter(event => event.state === 'reconnecting')[1]!.at
    assert.ok(
      retriedAt - diedAt >= baseDelayMs,
      `retry waited ${retriedAt - diedAt}ms, expected at least the ${baseDelayMs}ms backoff rung`,
    )
  } finally {
    unsubscribe()
    await client.close()
    await stopDaemon()
  }
})

test('a live subscription survives a daemon restart and resumes delivering values', async (t) => {
  const snapshotEngine = () => stubEngine({
    subscribe: (onSnapshot) => {
      onSnapshot({ ...sampleSnapshot, generatedAt: Date.now() })
      return () => {}
    },
  })
  const listening = await listenOrSkip(t, async () => startDaemon(snapshotEngine(), 0))
  if (!listening) return
  let daemon = listening.value

  const conn = connRecorder()
  let values = 0
  const client = createDaemonRpcClient(daemon.url, {
    transport: 'node',
    reconnectBaseDelayMs: 40,
    requestTimeoutMs: 500,
    onConn: conn.onConn,
  })
  const unsubscribe = client.subscribeSnapshot(() => { values++ })
  try {
    await waitFor(() => values >= 1 && conn.count('live') >= 1, 'the first live snapshot')
    assert.deepEqual(conn.states(), ['connecting', 'live'])
    const valuesBeforeRestart = values

    const stoppedAt = Date.now()
    await daemon.stop()
    await waitFor(() => conn.count('reconnecting') >= 1, 'a reconnecting state after the daemon died')

    // The dead session's stream fiber only settles ~1s after its socket dies,
    // and a subscription is never re-attached while it still holds a fiber. A
    // reconnect that wins that race leaves the client live but permanently
    // silent, so hold the daemon down until the old fiber is gone.
    await waitFor(() => Date.now() - stoppedAt >= 1_300, 'the dead session to finish tearing down', 3_000)
    daemon = await startDaemon(snapshotEngine(), daemon.port)

    await waitFor(
      () => conn.count('live') >= 2 && values > valuesBeforeRestart,
      'a live state and resumed values after the restart',
      5_000,
    )
    assert.equal(conn.states()[0], 'connecting')
    assert.equal(conn.states().at(-1), 'live')
    // Post-restart attempts announce 'reconnecting', never a second 'connecting'.
    assert.equal(conn.count('connecting'), 1)
  } finally {
    unsubscribe()
    await client.close()
    await daemon.stop()
  }
})

test('unary calls work on a live session and reject once the client is closed', async (t) => {
  const listening = await listenOrSkip(t, async () => startDaemon(stubEngine(), 0))
  if (!listening) return
  const daemon = listening.value
  const conn = connRecorder()
  const client = createDaemonRpcClient(daemon.url, {
    transport: 'node',
    reconnectAttempts: 0,
    requestTimeoutMs: 500,
    onConn: conn.onConn,
  })
  try {
    // Concurrent callers share the single in-flight connect.
    const states = await Promise.all([client.getConfig(), client.getConfig(), client.getConfig()])
    for (const state of states) assert.equal(state.config.revision, DEFAULTS.revision)
    assert.deepEqual(conn.states(), ['connecting', 'live'])

    await client.close()
    assert.deepEqual(conn.states(), ['connecting', 'live', 'closed'])
    await assert.rejects(client.getConfig(), /closed/)
    await assert.rejects(client.refresh('all'), /closed/)
    await assert.rejects(client.browseFs('~'), /closed/)
    // close() is idempotent and fires 'closed' exactly once.
    await client.close()
    assert.equal(conn.count('closed'), 1)
    assert.deepEqual(conn.states(), ['connecting', 'live', 'closed'])
  } finally {
    await client.close()
    await daemon.stop()
  }
})

test('an in-flight unary call times out as DaemonRpcRequestTimeoutError without killing the session', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const listening = await listenOrSkip(t, async () => startDaemon(stubEngine({ refresh: () => gate }), 0))
  if (!listening) return
  const daemon = listening.value
  const conn = connRecorder()
  const client = createDaemonRpcClient(daemon.url, {
    transport: 'node',
    reconnectAttempts: 0,
    requestTimeoutMs: 80,
    onConn: conn.onConn,
  })
  try {
    await client.getConfig()
    assert.deepEqual(conn.states(), ['connecting', 'live'])

    await assert.rejects(client.refresh('all'), (error: unknown) => {
      assert.ok(error instanceof DaemonRpcRequestTimeoutError)
      assert.equal(error.method, 'tokmon.refresh')
      assert.equal(error.timeoutMs, 80)
      return true
    })
    // A request timeout is not a session failure: the session stays live.
    assert.deepEqual(conn.states(), ['connecting', 'live'])
    assert.equal((await client.getConfig()).config.revision, DEFAULTS.revision)
    assert.deepEqual(conn.states(), ['connecting', 'live'])
  } finally {
    release()
    await client.close()
    await daemon.stop()
  }
})

test('a unary call whose daemon dies invalidates the session without starting a reconnect loop', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const listening = await listenOrSkip(t, async () => startDaemon(stubEngine({ refresh: () => gate }), 0))
  if (!listening) return
  const daemon = listening.value
  const conn = connRecorder()
  const client = createDaemonRpcClient(daemon.url, {
    transport: 'node',
    reconnectBaseDelayMs: 20,
    requestTimeoutMs: 2_000,
    onConn: conn.onConn,
  })
  try {
    await client.getConfig()
    assert.deepEqual(conn.states(), ['connecting', 'live'])

    const pending = assert.rejects(client.refresh('all'))
    await waitFor(() => conn.count('live') === 1, 'the live session')
    await daemon.stop()
    await pending

    // Either the socket hook or the request failure invalidates the session,
    // whichever loses the race is a no-op, so exactly one state is emitted.
    await waitFor(() => conn.states().length > 2, 'the session invalidation')
    assert.equal(conn.states().length, 3)
    assert.ok(['reconnecting', 'error'].includes(conn.states()[2]!))

    // No subscription exists, so nothing retries in the background.
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(conn.states().length, 3)
  } finally {
    release()
    await client.close()
    await daemon.stop()
  }
})

test('a typed RPC failure crosses the promise seam intact and leaves the session live', async (t) => {
  const listening = await listenOrSkip(t, async () => startDaemon(stubEngine(), 0))
  if (!listening) return
  const daemon = listening.value
  const conn = connRecorder()
  const client = createDaemonRpcClient(daemon.url, {
    transport: 'node',
    reconnectAttempts: 0,
    requestTimeoutMs: 500,
    onConn: conn.onConn,
  })
  try {
    await client.getConfig()
    assert.deepEqual(conn.states(), ['connecting', 'live'])

    await assert.rejects(
      client.setConfig({ expectedRevision: DEFAULTS.revision + 7, config: { ...DEFAULTS } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigUpdateConflictFailure)
        assert.equal(error.kind, 'conflict')
        assert.equal(error.state.config.revision, DEFAULTS.revision)
        return true
      },
    )

    // A typed failure is request-local: no state change, session still usable.
    assert.deepEqual(conn.states(), ['connecting', 'live'])
    assert.equal((await client.getConfig()).config.revision, DEFAULTS.revision)
    assert.deepEqual(conn.states(), ['connecting', 'live'])
  } finally {
    await client.close()
    await daemon.stop()
  }
})

test('close during a reconnect backoff fires closed once and leaves no live timers', async (t) => {
  const url = await unusedLoopbackUrl(t)
  if (!url) return

  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const timeouts = new Set<unknown>()
  const intervals = new Set<unknown>()

  // A one-shot timer that has already fired is spent, not leaked, so drop it on
  // fire. What survives in `timeouts` is exactly the set of still-armed timers.
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const holder: { timer?: unknown } = {}
    const onFire = (...fired: unknown[]) => {
      timeouts.delete(holder.timer)
      if (typeof handler === 'function') return (handler as (...a: unknown[]) => unknown)(...fired)
      return undefined
    }
    const timer = originalSetTimeout(onFire as TimerHandler, timeout, ...args)
    holder.timer = timer
    timeouts.add(timer)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    timeouts.delete(timer)
    return originalClearTimeout(timer)
  }) as typeof clearTimeout
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSetInterval(handler, timeout, ...args)
    intervals.add(timer)
    return timer
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    intervals.delete(timer)
    return originalClearInterval(timer)
  }) as typeof clearInterval

  // Deliberately timer-free waiting: an unhooked sleep would pollute the sets.
  const settled = <T>(build: (resolve: (value: T) => void) => void) => new Promise<T>(build)

  try {
    const conn = connRecorder()
    let firstError!: () => void
    const sawError = settled<void>((resolve) => { firstError = resolve })
    const client = createDaemonRpcClient(url, {
      transport: 'node',
      reconnectAttempts: 8,
      reconnectBaseDelayMs: 400,
      requestTimeoutMs: 150,
      snapshotStaleFloorMs: 20,
      onConn: (state, error) => {
        conn.onConn(state, error)
        if (state === 'error') firstError()
      },
    })
    client.subscribeSnapshot(() => {})
    await sawError
    // Let the retry be scheduled, using the unhooked timer so the assertion
    // sets below only ever see timers the client itself created.
    await settled<void>(resolve => { originalSetTimeout(resolve, 60) })
    assert.equal(conn.states().at(-1), 'error')

    // Mid-backoff: the reconnect sleep and the staleness watchdog are both live.
    await client.close()
    assert.equal(conn.states().at(-1), 'closed')
    assert.equal(conn.count('closed'), 1)
    const statesAtClose = conn.states().join(',')

    await client.close()
    assert.equal(conn.count('closed'), 1)
    assert.equal(conn.states().join(','), statesAtClose)

    assert.deepEqual([...intervals], [])
    assert.deepEqual([...timeouts], [])
  } finally {
    for (const timer of timeouts) originalClearTimeout(timer as ReturnType<typeof setTimeout>)
    for (const timer of intervals) originalClearInterval(timer as ReturnType<typeof setInterval>)
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})

test('unsubscribing the last subscription stops the reconnect loop', async (t) => {
  const url = await unusedLoopbackUrl(t)
  if (!url) return
  const conn = connRecorder()
  const client = createDaemonRpcClient(url, {
    transport: 'node',
    reconnectBaseDelayMs: 250,
    requestTimeoutMs: 100,
    onConn: conn.onConn,
  })
  const unsubscribe = client.subscribeSnapshot(() => {})
  try {
    await waitFor(() => conn.count('error') >= 1, 'the first failed connect attempt')
    // The retry is now sleeping out its 250ms backoff; dropping the last
    // subscription must cancel it rather than let it fire.
    unsubscribe()
    const statesAtUnsubscribe = conn.states().join(',')
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(conn.states().join(','), statesAtUnsubscribe)
  } finally {
    await client.close()
  }
  assert.equal(conn.states().at(-1), 'closed')
})
