import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'
import { DEFAULTS } from '../config'
import { createDaemonRpcClient } from '../client/daemon-rpc-client'
import { BrowseFsFailure, ConfigReadFailure, RefreshFailure, SessionUsageFailure, SESSION_USAGE_CAPABILITY } from '../rpc/contract'
import { listenOrSkip } from '../test-helpers'
import type { DataEngine } from './data-engine'
import type { WebSnapshot } from './contract'
import { mountWsRpc } from './ws'

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function websocketUpgradeStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('websocket upgrade timed out'))
    }, 1_000)
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk.toString('utf8')
      if (!response.includes('\r\n\r\n')) return
      clearTimeout(timer)
      socket.destroy()
      resolve(Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0))
    })
    socket.once('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '', '',
      ].join('\r\n'))
    })
  })
}

test('loopback dashboard websocket requires no browser token', async (t) => {
  const engine: DataEngine = {
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
  }
  const server = createServer()
  const closeRpc = await mountWsRpc(server, {
    engine,
    state: { config: { ...DEFAULTS } },
  })
  try {
    if (!await listenOrSkip(t, server)) return
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    assert.equal(await websocketUpgradeStatus(address.port), 101)
  } finally {
    await closeRpc()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('client normalizes additive config omissions from older protocol-v3 daemons', async (t) => {
  const {
    appearance: _appearance,
    desktop: _desktop,
    tray: _tray,
    ...preTrayConfig
  } = DEFAULTS
  const oldConfig = preTrayConfig as unknown as typeof DEFAULTS
  const engine: DataEngine = {
    snapshot: () => null,
    sessionUsage: async () => { throw new Error('session usage not configured') },
    start: () => {},
    subscribe: () => () => {},
    subscribeConfig: (onConfig) => {
      onConfig(oldConfig)
      return () => {}
    },
    touch: () => {},
    refresh: async () => {},
    setConfig: () => {},
    broadcastConfig: () => {},
    stop: () => {},
  }
  const server = createServer()
  const closeRpc = await mountWsRpc(server, { engine, state: { config: oldConfig } })
  let client: ReturnType<typeof createDaemonRpcClient> | null = null
  let unsubscribe: (() => void) | null = null
  let resolveSubscriberError!: (error: unknown) => void
  const subscriberError = new Promise<unknown>(resolve => { resolveSubscriberError = resolve })
  try {
    if (!await listenOrSkip(t, server)) return
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    client = createDaemonRpcClient(`http://127.0.0.1:${address.port}`, {
      transport: 'node',
      onSubscriberError: resolveSubscriberError,
    })

    const fetched = await client.getConfig()
    assert.deepEqual(fetched.config.tray, DEFAULTS.tray)
    assert.deepEqual(fetched.config.desktop, DEFAULTS.desktop)
    assert.deepEqual(fetched.config.appearance, DEFAULTS.appearance)

    const streamed = await new Promise<typeof fetched>((resolve) => {
      unsubscribe = client!.subscribeConfig((state) => {
        resolve(state)
        throw new Error('subscriber callback failed')
      })
    })
    assert.match(String(await subscriberError), /subscriber callback failed/)
    assert.deepEqual(streamed.config.tray, DEFAULTS.tray)
    assert.deepEqual(streamed.config.desktop, DEFAULTS.desktop)
    assert.deepEqual(streamed.config.appearance, DEFAULTS.appearance)
    assert.equal((await client.getConfig()).config.revision, DEFAULTS.revision)
  } finally {
    ;(unsubscribe as (() => void) | null)?.()
    await client?.close()
    await closeRpc()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('negotiated config and filesystem failures stay typed and request-local', async (t) => {
  let configFailure = false
  let browseFailure = false
  const engine: DataEngine = {
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
  }
  const server = createServer()
  const closeRpc = await mountWsRpc(server, {
    engine,
    state: { config: { ...DEFAULTS } },
    readConfig: async () => {
      if (configFailure) throw new Error('config disk unavailable')
      return { ...DEFAULTS }
    },
    browseHome: async path => {
      if (browseFailure) throw new Error('home directory unavailable')
      return { path, parent: null, entries: [] }
    },
  })
  let client: ReturnType<typeof createDaemonRpcClient> | null = null
  try {
    if (!await listenOrSkip(t, server)) return
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const connStates: string[] = []
    client = createDaemonRpcClient(`http://127.0.0.1:${address.port}`, {
      transport: 'node',
      onConn: state => { connStates.push(state) },
    })

    await client.getConfig()
    connStates.length = 0

    configFailure = true
    await assert.rejects(client.getConfig(), (error: unknown) => {
      assert.ok(error instanceof ConfigReadFailure)
      assert.equal(error.kind, 'config-read')
      assert.match(error.message, /config disk unavailable/)
      return true
    })
    assert.deepEqual(connStates, [])
    configFailure = false
    await client.getConfig()

    browseFailure = true
    await assert.rejects(client.browseFs('~'), (error: unknown) => {
      assert.ok(error instanceof BrowseFsFailure)
      assert.equal(error.kind, 'browse-fs')
      assert.match(error.message, /home directory unavailable/)
      return true
    })
    assert.deepEqual(connStates, [])
    browseFailure = false
    assert.deepEqual(await client.browseFs('~'), { path: '~', parent: null, entries: [] })
  } finally {
    await client?.close()
    await closeRpc()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('refresh RPC acknowledges only after the data engine pass completes', async (t) => {
  let release!: () => void
  const refreshGate = new Promise<void>(resolve => { release = resolve })
  let failRefresh = false
  let defectRefresh = false
  const engine: DataEngine = {
    snapshot: () => null,
    sessionUsage: async () => { throw new Error('session usage not configured') },
    start: () => {},
    subscribe: () => () => {},
    subscribeConfig: () => () => {},
    touch: () => {},
    refresh: () => defectRefresh
      ? Promise.reject(new Error('legacy refresh defect'))
      : failRefresh
        ? Promise.reject(new AggregateError([new Error('provider unavailable')], 'provider refresh failed'))
        : refreshGate,
    setConfig: () => {},
    broadcastConfig: () => {},
    stop: () => {},
  }
  const server = createServer()
  const closeRpc = await mountWsRpc(server, { engine, state: { config: { ...DEFAULTS } } })
  let client: ReturnType<typeof createDaemonRpcClient> | null = null
  try {
    if (!await listenOrSkip(t, server)) return
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    // A dashboard served from loopback must be able to speak to its daemon
    // directly. Browser URLs are intentionally capability-free.
    const connStates: string[] = []
    client = createDaemonRpcClient(`http://127.0.0.1:${address.port}`, {
      transport: 'node',
      reconnectAttempts: 0,
      onConn: state => { connStates.push(state) },
    })

    let settled = false
    const pending = client.refresh('all').then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(settled, false)
    release()
    await pending
    assert.equal(settled, true)

    connStates.length = 0
    failRefresh = true
    await assert.rejects(client.refresh('all'), (error: unknown) => {
      assert.ok(error instanceof RefreshFailure)
      assert.equal(error.kind, 'refresh')
      assert.match(error.message, /provider refresh failed/)
      return true
    })
    assert.deepEqual(connStates, [])
    assert.equal((await client.getConfig()).config.revision, DEFAULTS.revision)
    assert.deepEqual(connStates, [])

    // Protocol-v3 daemons predating RefreshFailure sent refresh rejections as
    // defects. They remain request-local in the new client.
    failRefresh = false
    defectRefresh = true
    await assert.rejects(client.refresh('all'), /legacy refresh defect/)
    assert.deepEqual(connStates, [])
    assert.equal((await client.getConfig()).config.revision, DEFAULTS.revision)
    assert.deepEqual(connStates, [])
  } finally {
    release()
    await client?.close()
    await closeRpc()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('a stale snapshot stream is restarted instead of remaining falsely live', async (t) => {
  const snapshot: WebSnapshot = {
    version: 'test',
    generatedAt: Date.now(),
    tz: 'UTC',
    intervalMs: 5,
    billingIntervalMs: 60_000,
    providers: [],
    accounts: [],
    seeded: false,
    peak: null,
  }
  let subscriptions = 0
  let configSubscriptions = 0
  const engine: DataEngine = {
    snapshot: () => snapshot,
    sessionUsage: async request => {
      if (request.cached) throw new Error('No cached session usage')
      return { ...snapshot, sessionId: request.sessionId }
    },
    start: () => {},
    subscribe: (onSnapshot) => {
      subscriptions++
      onSnapshot({ ...snapshot, generatedAt: Date.now() })
      return () => {}
    },
    subscribeConfig: (onConfig) => {
      configSubscriptions++
      onConfig({ ...DEFAULTS })
      return () => {}
    },
    touch: () => {},
    refresh: async () => {},
    setConfig: () => {},
    broadcastConfig: () => {},
    stop: () => {},
  }
  const server = createServer()
  const closeRpc = await mountWsRpc(server, { engine, state: { config: { ...DEFAULTS } } })
  let client: ReturnType<typeof createDaemonRpcClient> | null = null
  let unsubscribe: (() => void) | null = null
  let unsubscribeConfig: (() => void) | null = null
  try {
    if (!await listenOrSkip(t, server)) return
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    client = createDaemonRpcClient(`http://127.0.0.1:${address.port}`, {
      transport: 'node',
      reconnectBaseDelayMs: 5,
      snapshotStaleFloorMs: 30,
    })
    assert.ok((await client.getConfig()).protocol.capabilities.includes(SESSION_USAGE_CAPABILITY))
    const session = { sessionId: 'session-one', cached: false, refresh: true }
    assert.equal((await client.sessionUsage(session)).sessionId, 'session-one')
    await assert.rejects(client.sessionUsage({ ...session, cached: true, refresh: false }), error => {
      assert.ok(error instanceof SessionUsageFailure)
      assert.match(error.message, /No cached session usage/)
      return true
    })
    let values = 0
    let configValues = 0
    unsubscribe = client.subscribeSnapshot(() => { values++ })
    unsubscribeConfig = client.subscribeConfig(() => { configValues++ })
    await waitFor(() =>
      subscriptions >= 2 && values >= 2
      && configSubscriptions >= 2 && configValues >= 2,
    )
  } finally {
    unsubscribe?.()
    unsubscribeConfig?.()
    await client?.close()
    await closeRpc()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
