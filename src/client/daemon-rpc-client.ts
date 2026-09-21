import { Cause, Deferred, Duration, Effect, Exit, Fiber, Latch, Layer, Schedule, Schema, Scope, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import { RpcClientError } from 'effect/unstable/rpc/RpcClientError'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as Socket from 'effect/unstable/socket/Socket'
import { normalizeConfig } from '../config-schema'
import type { WebSnapshot } from '../web/contract'
import {
  ConfigStateSchema,
  ConfigUpdateConflictFailure,
  TYPED_READ_FAILURES_CAPABILITY,
  TOKMON_WS_METHODS,
  TOKMON_WS_PATH,
  TokmonRpcGroup,
  type ConfigState,
  type ConfigUpdateRequest,
  type FsListing,
  type RefreshScope,
  type SessionUsageRequest,
} from '../rpc/contract'
import { createSnapshotDeltaDecoder } from '../web/snapshot-delta'
import { materializeWebSnapshot } from '../web/snapshot-materialize'

export type RpcConnState = 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed'

export interface DaemonRpcClientOptions {
  readonly transport?: 'auto' | 'node' | 'browser'
  /** Maximum supervisor retries after the initial connection attempt. */
  readonly reconnectAttempts?: number
  readonly reconnectBaseDelayMs?: number
  readonly requestTimeoutMs?: number
  readonly snapshotStaleFloorMs?: number
  readonly onConn?: (state: RpcConnState, error?: unknown) => void
  readonly onSubscriberError?: (error: unknown) => void
}

export interface DaemonRpcClient {
  getConfig(): Promise<ConfigState>
  setConfig(update: ConfigUpdateRequest): Promise<ConfigState>
  refresh(scope?: RefreshScope): Promise<void>
  sessionUsage(request: SessionUsageRequest): Promise<WebSnapshot>
  browseFs(path: string): Promise<FsListing>
  subscribeSnapshot(onSnapshot: (snapshot: WebSnapshot) => void): () => void
  subscribeConfig(onConfig: (config: ConfigState) => void): () => void
  /**
   * Drop the current session (if any) and redial immediately. For wake-from-sleep:
   * a suspended machine leaves the socket half-open, and waiting for the stale
   * watchdog costs up to `snapshotStaleFloorMs` of frozen UI.
   */
  reconnectNow(): void
  close(): Promise<void>
}

export class DaemonRpcConnectionError extends Error {
  constructor(message = 'daemon RPC connection closed') {
    super(message)
    this.name = 'DaemonRpcConnectionError'
  }
}

export class DaemonRpcRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs}ms`)
    this.name = 'DaemonRpcRequestTimeoutError'
  }
}

type NodeSocketModule = typeof import('@effect/platform-node/NodeSocket')
type TokmonRpcs = RpcGroup.Rpcs<typeof TokmonRpcGroup>
type TokmonClient = RpcClient.RpcClient<TokmonRpcs, RpcClientError>
type WireConfigState = typeof ConfigStateSchema.Type

/** Why a session stopped, and therefore which state the client reports. */
interface SessionDeath {
  readonly state: Extract<RpcConnState, 'reconnecting' | 'error'>
  readonly error?: unknown
}

interface Session {
  readonly client: TokmonClient
  /** The attempt scope: parent of every subscription scope on this session. */
  readonly scope: Scope.Scope
  readonly dead: Deferred.Deferred<never, SessionDeath>
  readonly kill: (state: SessionDeath['state'], error?: unknown) => void
}

interface Subscription<A> {
  readonly streamFor: (client: TokmonClient) => Stream.Stream<A, unknown>
  readonly onValue: (value: A) => void
  readonly staleAfterFor?: (value: A) => number
  /** Closing it interrupts the pump and the watchdog; null means "not running". */
  runScope: Scope.Closeable | null
  /** Synchronous claim taken before the first yield in startSubscription, so
   * the two starters (subscribe()'s detached start and the supervisor's
   * startAllSubscriptions) can never both pass the runScope guard across the
   * Scope.fork op boundary and double-pump one subscription. */
  starting: boolean
  lastValueAt: number
  staleAfterMs: number
}

/** The single connection rendezvous. `connecting` coalesces every caller onto
 * one attempt; the deferred is what unary callers park on. */
type ConnSlot =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'connecting'; readonly deferred: Deferred.Deferred<Session, unknown> }
  | { readonly _tag: 'live'; readonly session: Session }

/** Failure channel of one supervisor cycle. Success means "abandoned, stop retrying". */
type CycleEnd =
  | { readonly _tag: 'connect-failed'; readonly error: unknown }
  | { readonly _tag: 'session-ended' }

type Command = 'stop' | 'idle' | 'attempt'

const RECONNECT_MAX_DELAY_MS = 2_500
const DEFAULT_STALE_FLOOR_MS = 90_000

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

function toWsUrl(baseUrl: string): string {
  const base = typeof window === 'undefined' ? undefined : window.location.origin
  const url = new URL(baseUrl, base)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported daemon RPC protocol: ${url.protocol}`)
  }
  url.hash = ''
  url.searchParams.delete('tokmonToken')
  url.searchParams.delete('wsToken')
  url.pathname = TOKMON_WS_PATH
  return url.toString()
}

function shouldUseNodeTransport(transport: DaemonRpcClientOptions['transport']): boolean {
  if (transport === 'node') return true
  if (transport === 'browser') return false
  return typeof window === 'undefined'
}

async function socketLayerFor(
  url: string,
  transport: DaemonRpcClientOptions['transport'],
  openTimeoutMs: number,
): Promise<Layer.Layer<Socket.Socket>> {
  const socketOptions = { openTimeout: Duration.millis(openTimeoutMs) }
  if (shouldUseNodeTransport(transport)) {
    const NodeSocket = await dynamicImport<NodeSocketModule>('@effect/platform-node/NodeSocket')
    return NodeSocket.layerWebSocket(url, socketOptions)
  }
  return Socket.layerWebSocket(url, socketOptions).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  )
}

function normalizeConfigState(state: WireConfigState): ConfigState {
  return {
    protocol: {
      version: state.protocol.version,
      capabilities: [...state.protocol.capabilities],
    },
    config: normalizeConfig(state.config),
  }
}

function normalizeRequestFailure(error: unknown): unknown {
  if (!error || typeof error !== 'object' || (error as { kind?: unknown }).kind !== 'conflict') return error
  const state = (error as { state?: WireConfigState }).state
  if (!state) return error
  const normalized = normalizeConfigState(state)
  if (error instanceof ConfigUpdateConflictFailure) {
    return new ConfigUpdateConflictFailure({ kind: 'conflict', state: normalized })
  }
  return { ...error, state: normalized }
}

function isSessionFailure(error: unknown): boolean {
  return error instanceof RpcClientError || Schema.isSchemaError(error)
}

/** Re-raise an interrupt without letting it widen the typed error channel. */
function rethrowCause<E>(cause: Cause.Cause<unknown>): Effect.Effect<never, E> {
  return Effect.failCause(cause as Cause.Cause<never>)
}

export function createDaemonRpcClient(baseUrl: string, options: DaemonRpcClientOptions = {}): DaemonRpcClient {
  const url = toWsUrl(baseUrl)
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000)
  // Backstop only: deliberately looser than the connect budget so it never races
  // the real connect error, and only ever converts a rendezvous bug into a reject.
  const rendezvousTimeoutMs = requestTimeoutMs * 2
  const reconnectBaseDelayMs = Math.max(1, options.reconnectBaseDelayMs ?? 250)
  const staleFloorMs = options.snapshotStaleFloorMs ?? DEFAULT_STALE_FLOOR_MS
  const attemptBudget = typeof options.reconnectAttempts === 'number' ? options.reconnectAttempts : undefined

  const subscriptions = new Set<Subscription<unknown>>()
  // Advisory wake-up edge for the supervisor. `connSlot`/`subscriptions` stay
  // authoritative, so a dropped open is always safe. The invariant that keeps it
  // honest: only the supervisor waits on it, and it retires the latch at the
  // instant it starts waiting (`nextCommand`, `preemptibleDelay`) — never after.
  // An open raised while the supervisor is busy (mid-attempt, in scope teardown,
  // or parked on a live session) has no waiter to serve, so it must not survive
  // into the next backoff rung and collapse it to zero.
  const gate = Latch.makeUnsafe(false)
  const rootScope = Scope.makeUnsafe('sequential')

  let connSlot: ConnSlot = { _tag: 'idle' }
  let hasConnected = false
  let closed = false
  // Written only by the supervisor fiber: the ladder resets on a successful
  // connect, which `Schedule`'s own per-execution attempt counter cannot express.
  let attemptsUsed = 0

  const closedError = () => new Error('daemon RPC client is closed')

  const reportSubscriberError = (error: unknown) => {
    if (options.onSubscriberError) {
      try { options.onSubscriberError(error) } catch (reportError) {
        console.error('[tokmon] daemon RPC subscriber error reporter failed', reportError)
      }
      return
    }
    console.error('[tokmon] daemon RPC subscriber failed', error)
  }

  const setConn = (state: RpcConnState, error?: unknown) => {
    if (closed && state !== 'closed') return
    try { options.onConn?.(state, error) } catch (callbackError) {
      reportSubscriberError(callbackError)
    }
  }

  /** Squash-equivalent that keeps error identity and never fabricates
   * `Error('All fibers interrupted without error')` for a pure interrupt. */
  const failureOf = (cause: Cause.Cause<unknown>): unknown => {
    const failure = cause.reasons.find(Cause.isFailReason)
    if (failure) return failure.error
    const die = cause.reasons.find(Cause.isDieReason)
    if (die) return die.defect
    return closed ? closedError() : new DaemonRpcConnectionError()
  }

  /** The only Effect → Promise seam. `runFork` (not `runPromise`) because the
   * seam needs a fiber handle to adopt: an unadopted request fiber would outlive
   * close() with its timeout timer still armed. */
  const settle = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      const fiber = Effect.runFork(effect, { onFiberStart: Fiber.runIn(rootScope) })
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) resolve(exit.value)
        else reject(failureOf(exit.cause))
      })
    })

  const detach = (effect: Effect.Effect<unknown, never>): void => {
    Effect.runFork(effect, { onFiberStart: Fiber.runIn(rootScope) })
  }

  const enterConnecting = (): Deferred.Deferred<Session, unknown> => {
    if (connSlot._tag === 'connecting') return connSlot.deferred
    const deferred = Deferred.makeUnsafe<Session, unknown>()
    connSlot = { _tag: 'connecting', deferred }
    setConn(hasConnected ? 'reconnecting' : 'connecting')
    return deferred
  }

  const requestConnect = (): Deferred.Deferred<Session, unknown> => {
    const deferred = enterConnecting()
    Latch.openUnsafe(gate)
    return deferred
  }

  const acquireSession: Effect.Effect<Session, unknown> = Effect.suspend(() => {
    if (closed) return Effect.fail(closedError())
    if (connSlot._tag === 'live') return Effect.succeed(connSlot.session)
    const deferred = requestConnect()
    return Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(rendezvousTimeoutMs),
        orElse: () => Effect.fail(
          new DaemonRpcConnectionError(`daemon RPC connection timed out after ${rendezvousTimeoutMs}ms`),
        ),
      }),
    )
  })

  const run = <A>(
    method: string,
    effectFor: (client: TokmonClient) => Effect.Effect<A, unknown>,
  ): Promise<A> =>
    settle(Effect.gen(function* () {
      const session = yield* acquireSession
      const abortOnDeath = Deferred.await(session.dead).pipe(
        Effect.mapError((death) => death.error ?? new DaemonRpcConnectionError()),
      )
      return yield* effectFor(session.client).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(requestTimeoutMs),
          orElse: () => Effect.fail(new DaemonRpcRequestTimeoutError(method, requestTimeoutMs)),
        }),
        // A dying session aborts its in-flight requests; raceFirst interrupts the
        // loser, so the request's timeout timer is cleared rather than abandoned.
        Effect.raceFirst(abortOnDeath),
        Effect.catchCause((cause): Effect.Effect<never, unknown> => {
          if (Cause.hasInterruptsOnly(cause)) return rethrowCause(cause)
          const error = normalizeRequestFailure(failureOf(cause))
          if (!closed && isSessionFailure(error)) session.kill('error', error)
          return Effect.fail(error)
        }),
      )
    }))

  const connect = (
    scope: Scope.Scope,
    onDeath: (death: SessionDeath) => void,
  ): Effect.Effect<Session, unknown> =>
    Effect.gen(function* () {
      const ready = Deferred.makeUnsafe<void>()
      const dead = Deferred.makeUnsafe<never, SessionDeath>()
      // doneUnsafe returns false on the second settle: that is the idempotence
      // guarantee that used to live in an explicit `invalidated` flag.
      const signal = (death: SessionDeath) => {
        if (Deferred.doneUnsafe(dead, Effect.fail(death))) onDeath(death)
      }

      const socketLayer = yield* Effect.tryPromise({
        try: () => socketLayerFor(url, options.transport, requestTimeoutMs),
        catch: (error: unknown) => error,
      })
      const connectionHooksLayer = Layer.succeed(
        RpcClient.ConnectionHooks,
        RpcClient.ConnectionHooks.of({
          onConnect: Effect.asVoid(Deferred.succeed(ready, undefined)),
          onDisconnect: Effect.sync(() => {
            signal({ state: 'reconnecting', error: new DaemonRpcConnectionError() })
          }),
        }),
      )
      const protocolLayer = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryPolicy: Schedule.recurs(0),
          retryTransientErrors: false,
        }),
      ).pipe(
        Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson, connectionHooksLayer)),
      )

      // Built into the attempt scope, so the socket finalizer is registered first
      // and — under sequential reverse-order finalization — released last.
      const context = yield* Layer.build(protocolLayer).pipe(Scope.provide(scope))
      const client = yield* RpcClient.make(TokmonRpcGroup).pipe(
        Effect.provide(context),
        Scope.provide(scope),
      )

      yield* Deferred.await(ready).pipe(
        Effect.raceFirst(
          Deferred.await(dead).pipe(
            Effect.mapError((death) => death.error ?? new DaemonRpcConnectionError()),
          ),
        ),
        Effect.timeoutOrElse({
          duration: Duration.millis(requestTimeoutMs),
          orElse: () => Effect.fail(
            new DaemonRpcConnectionError(`daemon RPC connection timed out after ${requestTimeoutMs}ms`),
          ),
        }),
      )

      const session: Session = {
        client,
        scope,
        dead,
        kill: (state, error) => { signal({ state, error }) },
      }
      return session
    })

  const watchdog = (subscription: Subscription<unknown>, session: Session) => {
    const checkEveryMs = Math.min(5_000, Math.max(10, staleFloorMs / 2))
    return Effect.sync(() => {
      if (Date.now() - subscription.lastValueAt <= subscription.staleAfterMs) return
      // Reset before killing so a slow reconnect does not refire immediately.
      subscription.lastValueAt = Date.now()
      session.kill('reconnecting')
    }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(checkEveryMs))))
  }

  const startSubscription = (
    subscription: Subscription<unknown>,
    session: Session,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (closed || !subscriptions.has(subscription) || subscription.runScope !== null || subscription.starting) return
      subscription.starting = true
      try {
        const subScope = yield* Scope.fork(session.scope)
        subscription.runScope = subScope
        subscription.lastValueAt = Date.now()
        subscription.staleAfterMs = staleFloorMs
        yield* Scope.addFinalizer(subScope, Effect.sync(() => {
          if (subscription.runScope === subScope) subscription.runScope = null
        }))

        const pump = yield* Effect.forkIn(
          subscription.streamFor(session.client).pipe(
            Stream.runForEach((value) =>
              Effect.sync(() => {
                subscription.lastValueAt = Date.now()
                if (subscription.staleAfterFor) subscription.staleAfterMs = subscription.staleAfterFor(value)
                try { subscription.onValue(value) } catch (error) { reportSubscriberError(error) }
              }),
            ),
          ),
          subScope,
        )
        pump.addObserver((exit) => {
          if (closed || !subscriptions.has(subscription)) return
          if (Exit.isSuccess(exit)) {
            session.kill('reconnecting')
            return
          }
          // An interrupt is scope teardown, never a transport failure.
          if (Cause.hasInterruptsOnly(exit.cause)) return
          session.kill('error', Cause.squash(exit.cause))
        })

        if (subscription.staleAfterFor) yield* Effect.forkIn(watchdog(subscription, session), subScope)
      } finally {
        subscription.starting = false
      }
    })

  const startAllSubscriptions = (session: Session): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const subscription of [...subscriptions]) yield* startSubscription(subscription, session)
    })

  /** Sleeps one backoff rung but yields the moment demand changes — a new unary
   * caller, or the last unsubscribe. Returns zero so the Schedule's own sleep
   * degrades to a yield and registers no timer. */
  const preemptibleDelay = (delayMs: number): Effect.Effect<Duration.Duration> =>
    Effect.suspend(() => {
      // Retiring the gate as this wait begins is load-bearing, and it has to
      // happen here rather than after the race: pokes raised while the previous
      // attempt was running or tearing down have already been served by
      // `connSlot`/`subscriptions`, and honouring one here would collapse this
      // rung to zero while still charging `attemptsUsed` for it. Close and
      // await are one synchronous step, so a poke can never be lost between
      // them — and an open that lands during the sleep still wins the race.
      Latch.closeUnsafe(gate)
      return Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.raceFirst(gate.await),
        Effect.as(Duration.zero),
      )
    })

  const backoff: Schedule.Schedule<number, CycleEnd> = Schedule.forever.pipe(
    Schedule.while(() =>
      !closed
      && subscriptions.size > 0
      && (attemptBudget === undefined || attemptsUsed < attemptBudget),
    ),
    Schedule.modifyDelay(() => {
      // Upward jitter: many clients dropped by the same daemon restart must not
      // redial in lockstep on identical exponential rungs. The rung is a floor
      // (callers rely on "at least one full backoff"), so spread goes above it.
      const rung = Math.min(RECONNECT_MAX_DELAY_MS, reconnectBaseDelayMs * 1.5 ** attemptsUsed)
      const delayMs = rung * (1 + Math.random() * 0.25)
      attemptsUsed += 1
      return preemptibleDelay(delayMs)
    }),
  )

  const runAttempt = (scope: Scope.Scope): Effect.Effect<void, CycleEnd> =>
    Effect.gen(function* () {
      if (closed) return
      // A purely retry-driven attempt needs live subscription demand. Returning
      // success stops the retry cleanly and parks the supervisor.
      if (connSlot._tag !== 'connecting' && subscriptions.size === 0) return

      let published: Session | null = null
      const deferred = enterConnecting()

      const onDeath = (death: SessionDeath) => {
        // Pre-publish deaths are reported by the connect failure path instead.
        if (published === null) return
        if (connSlot._tag === 'live' && connSlot.session === published) connSlot = { _tag: 'idle' }
        setConn(death.state, death.error)
      }

      const session = yield* connect(scope, onDeath).pipe(
        Effect.catchCause((cause): Effect.Effect<never, CycleEnd> => {
          if (Cause.hasInterruptsOnly(cause)) return rethrowCause(cause)
          const error = failureOf(cause)
          if (connSlot._tag === 'connecting' && connSlot.deferred === deferred) connSlot = { _tag: 'idle' }
          setConn('error', error)
          Deferred.doneUnsafe(deferred, Effect.fail(error))
          return Effect.fail<CycleEnd>({ _tag: 'connect-failed', error })
        }),
      )

      if (closed) return
      published = session
      hasConnected = true
      attemptsUsed = 0
      connSlot = { _tag: 'live', session }
      setConn('live')
      yield* startAllSubscriptions(session)
      Deferred.doneUnsafe(deferred, Effect.succeed(session))

      yield* Deferred.await(session.dead).pipe(
        Effect.mapError((): CycleEnd => ({ _tag: 'session-ended' })),
      )
    })

  /** Retires the gate on the way into the idle park. Closing it and reading the
   * slot must be one synchronous step, so a poke can never land between them
   * and be lost. */
  const nextCommand = Effect.sync((): Command => {
    Latch.closeUnsafe(gate)
    if (closed) return 'stop'
    return connSlot._tag === 'connecting' ? 'attempt' : 'idle'
  })

  const supervisorLoop = Effect.gen(function* () {
    for (;;) {
      const command = yield* nextCommand
      if (command === 'stop') return
      if (command === 'idle') {
        yield* gate.await
        continue
      }
      yield* Effect.scopedWith(runAttempt).pipe(
        Effect.retry(backoff),
        Effect.catchCause((cause): Effect.Effect<void> => {
          if (Cause.hasInterrupts(cause)) return rethrowCause(cause)
          const defect = cause.reasons.find(Cause.isDieReason)?.defect
          if (defect !== undefined) console.error('[tokmon] daemon RPC supervisor defect', defect)
          // The ladder gave up with demand still live. Connect failures emit
          // 'error' themselves, but a session that connected then died leaves
          // 'reconnecting' as the last emission — and a budgeted embedder
          // (desktop) only schedules its outer retry on 'error'. Without this,
          // budget exhaustion after a dropped session parks the client silently.
          if (!closed && subscriptions.size > 0 && attemptBudget !== undefined && attemptsUsed >= attemptBudget) {
            const end = cause.reasons.find(Cause.isFailReason)?.error as CycleEnd | undefined
            if (end?._tag === 'session-ended') {
              setConn('error', new DaemonRpcConnectionError('daemon RPC reconnect budget exhausted'))
            }
          }
          return Effect.void
        }),
      )
    }
  })

  Effect.runFork(supervisorLoop, { onFiberStart: Fiber.runIn(rootScope) })

  const subscribe = <A>(
    streamFor: (client: TokmonClient) => Stream.Stream<A, unknown>,
    onValue: (value: A) => void,
    staleAfterFor?: (value: A) => number,
  ): (() => void) => {
    if (closed) return () => {}
    const subscription: Subscription<A> = {
      streamFor,
      onValue,
      staleAfterFor,
      runScope: null,
      starting: false,
      lastValueAt: 0,
      staleAfterMs: staleFloorMs,
    }
    const registered = subscription as Subscription<unknown>
    subscriptions.add(registered)

    if (connSlot._tag === 'live') detach(startSubscription(registered, connSlot.session))
    else requestConnect()

    return () => {
      if (!subscriptions.delete(registered)) return
      const runScope = registered.runScope
      registered.runScope = null
      if (runScope) {
        const finalize = Scope.closeUnsafe(runScope, Exit.void)
        if (finalize) detach(finalize)
      }
      // Break a *sleeping* backoff rung: with no demand left it must not fire.
      // If no rung is sleeping the open is retired unread, which is correct —
      // the schedule re-reads `subscriptions.size` before every rung anyway.
      if (subscriptions.size === 0) Latch.openUnsafe(gate)
    }
  }

  return {
    getConfig: () =>
      run(TOKMON_WS_METHODS.getConfig, client => client[TOKMON_WS_METHODS.getConfig]({
        capabilities: [TYPED_READ_FAILURES_CAPABILITY],
      }))
        .then(normalizeConfigState),

    setConfig: (update) =>
      run(TOKMON_WS_METHODS.setConfig, client => client[TOKMON_WS_METHODS.setConfig](update))
        .then(normalizeConfigState),

    refresh: (scope = 'all') =>
      run(TOKMON_WS_METHODS.refresh, client => client[TOKMON_WS_METHODS.refresh]({ scope })),

    sessionUsage: request =>
      run(TOKMON_WS_METHODS.sessionUsage, client => client[TOKMON_WS_METHODS.sessionUsage](request))
        .then(materializeWebSnapshot),

    browseFs: (path) =>
      run(TOKMON_WS_METHODS.browseFs, client => client[TOKMON_WS_METHODS.browseFs]({
        path,
        capabilities: [TYPED_READ_FAILURES_CAPABILITY],
      })),

    subscribeSnapshot: (onSnapshot) =>
      subscribe(
        // A fresh decoder per session attempt: every reconnect starts with an
        // `init` frame, and a desync throw fails the pump, which kills the
        // session and redials into a clean init — self-healing by design.
        client => Stream.suspend(() => {
          const decoder = createSnapshotDeltaDecoder()
          return client[TOKMON_WS_METHODS.snapshot]({}).pipe(Stream.map(event => decoder.apply(event)))
        }),
        onSnapshot,
        snapshot => Math.max(staleFloorMs, snapshot.intervalMs * 3),
      ),

    subscribeConfig: (onConfig) =>
      subscribe(
        client => client[TOKMON_WS_METHODS.config]({}).pipe(Stream.map(normalizeConfigState)),
        onConfig,
      ),

    reconnectNow() {
      if (closed) return
      attemptsUsed = 0
      if (connSlot._tag === 'live') {
        // kill() tears the session down; the supervisor's retry ladder then
        // redials on the first (zeroed) rung.
        connSlot.session.kill('reconnecting')
        return
      }
      // Connecting: collapse the current backoff rung. Idle with demand: start.
      if (subscriptions.size > 0) requestConnect()
      Latch.openUnsafe(gate)
    },

    async close() {
      if (closed) return
      closed = true
      // Emitted before teardown, so teardown failures stay silent.
      setConn('closed')
      const slot = connSlot
      connSlot = { _tag: 'idle' }
      if (slot._tag === 'connecting') Deferred.doneUnsafe(slot.deferred, Effect.fail(closedError()))
      subscriptions.clear()
      Latch.openUnsafe(gate)
      await Effect.runPromise(Scope.close(rootScope, Exit.void)).catch(() => {})
    },
  }
}
