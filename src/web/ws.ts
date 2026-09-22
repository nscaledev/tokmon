import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { NodeWS } from '@effect/platform-node/NodeSocket'
import { Effect, Exit, Layer, Queue, Scope, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import type { Config } from '../config'
import { loadConfig } from '../config'
import {
  BrowseFsFailure,
  ConfigPersistenceFailure as ConfigPersistenceRpcFailure,
  ConfigReadFailure,
  ConfigUpdateConflictFailure,
  RefreshFailure,
  SessionUsageFailure,
  TYPED_READ_FAILURES_CAPABILITY,
  TOKMON_WS_METHODS,
  TOKMON_WS_PATH,
  TokmonRpcGroup,
} from '../rpc/contract'
import {
  applyConfigUpdate,
  ConfigConflictError,
  ConfigPersistenceError as ConfigPersistenceWriteError,
  rediscoverEngineAccounts,
  toConfigState,
} from './config-control'
import type { DataEngine } from './data-engine'
import { createSnapshotDeltaEncoder } from './snapshot-delta'
import { listHomeDirectory } from './fs'
import { isAllowedLocalRequest } from './request-guard'

interface MountWsRpcDeps {
  readonly engine: DataEngine
  readonly state: { config: Config }
  /** Test seam for the config read boundary. */
  readonly readConfig?: () => Promise<Config>
  /** Test seam for the filesystem read boundary. */
  readonly browseHome?: typeof listHomeDirectory
}

function isWsPath(req: IncomingMessage): boolean {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname === TOKMON_WS_PATH
  } catch {
    return false
  }
}

function rejectUpgrade(socket: Duplex, status = 403, message = 'Forbidden'): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    )
  } catch {}
  try { socket.destroy() } catch {}
}

function snapshotStream(engine: DataEngine) {
  const raw = Stream.callback<ReturnType<DataEngine['snapshot']> extends infer S ? NonNullable<S> : never>((queue) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const unsubscribe = engine.subscribe((snapshot) => {
        if (snapshot != null) Queue.offerUnsafe(queue, snapshot)
      })
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe))
    }), { bufferSize: 16, strategy: 'sliding' })
  // One encoder per stream, applied downstream of the sliding buffer: a delta
  // is always relative to the previous frame this client actually dequeued,
  // so slow consumers that drop intermediate snapshots can never desync.
  return Stream.suspend(() => {
    const encoder = createSnapshotDeltaEncoder()
    return raw.pipe(Stream.map((snapshot) => encoder.next(snapshot)))
  })
}

function configStream(engine: DataEngine) {
  return Stream.callback<Config>((queue) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const unsubscribe = engine.subscribeConfig((config) => {
        Queue.offerUnsafe(queue, config)
      })
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe))
    }), { bufferSize: 16, strategy: 'sliding' })
}

type ConfigRpcFailure = ConfigUpdateConflictFailure | ConfigPersistenceRpcFailure

function configUpdateFailureEffect(error: unknown): Effect.Effect<never, ConfigRpcFailure> {
  if (error instanceof ConfigConflictError) {
    return Effect.fail(new ConfigUpdateConflictFailure({ kind: 'conflict', state: error.state }))
  }
  if (error instanceof ConfigPersistenceWriteError) {
    return Effect.fail(new ConfigPersistenceRpcFailure({ kind: 'persistence', message: error.message }))
  }
  return Effect.die(error)
}

function configUpdateEffect(
  engine: DataEngine,
  state: { config: Config },
  input: Parameters<typeof applyConfigUpdate>[2],
): Effect.Effect<Awaited<ReturnType<typeof applyConfigUpdate>>, ConfigRpcFailure> {
  return Effect.tryPromise({
    try: () => applyConfigUpdate(engine, state, input),
    catch: error => error,
  }).pipe(Effect.matchEffect({
    onFailure: configUpdateFailureEffect,
    onSuccess: Effect.succeed,
  }))
}

function refreshFailureEffect(error: unknown): Effect.Effect<never, RefreshFailure> {
  return error instanceof AggregateError
    ? Effect.fail(new RefreshFailure({ kind: 'refresh', message: error.message }))
    : Effect.die(error)
}

function refreshEffect(
  engine: DataEngine,
  state: { config: Config },
  scope: Parameters<DataEngine['refresh']>[0],
): Effect.Effect<void, RefreshFailure> {
  return Effect.tryPromise({
    try: async () => {
      if (scope === 'all') await rediscoverEngineAccounts(engine, state)
      await engine.refresh(scope)
    },
    catch: error => error,
  }).pipe(Effect.matchEffect({
    onFailure: refreshFailureEffect,
    onSuccess: Effect.succeed,
  }))
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function supportsTypedReadFailures(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(TYPED_READ_FAILURES_CAPABILITY) ?? false
}

function readEffect<A, E>(
  tryPromise: () => PromiseLike<A>,
  failure: (error: unknown) => E,
  typedFailures: boolean,
): Effect.Effect<A, E> {
  const effect = Effect.tryPromise({
    try: tryPromise,
    catch: failure,
  })
  // A pre-capability client has Schema.Never as this method's error decoder.
  // Preserve its historical defect response instead of making it treat a
  // request-local read error as a protocol/schema failure.
  return typedFailures
    ? effect
    : effect.pipe(Effect.matchEffect({
        onFailure: Effect.die,
        onSuccess: Effect.succeed,
      }))
}

/** Interval for server-initiated pings; a peer missing one full interval is half-open. */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000

interface HeartbeatSocket {
  isAlive?: boolean
  ping(): void
  terminate(): void
  on(event: 'pong', listener: () => void): void
}

/**
 * A laptop sleeping mid-session leaves the daemon holding half-open sockets that
 * never error and never close: the peer's TCP stack is gone but ours still counts
 * the client as live, keeping idle-pause off and streams pumping into the void.
 * Standard ws heartbeat — mark, ping, reap on the next tick if no pong came back.
 *
 * Pong listeners are attached lazily off `clients`: under noServer upgrades the
 * Effect handler adopts sockets without ever emitting `connection`, so an
 * on('connection') hook would never fire and the reaper would kill live peers.
 */
function startHeartbeat(wss: { clients: Set<unknown> }): () => void {
  const seen = new WeakSet<object>()
  const timer = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as HeartbeatSocket
      if (!seen.has(socket)) {
        seen.add(socket)
        socket.isAlive = true
        try { socket.on('pong', () => { socket.isAlive = true }) } catch { continue }
      }
      if (socket.isAlive === false) {
        try { socket.terminate() } catch {}
        continue
      }
      socket.isAlive = false
      try { socket.ping() } catch {}
    }
  }, WS_HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

export async function mountWsRpc(server: Server, deps: MountWsRpcDeps): Promise<() => Promise<void>> {
  const scope = await Effect.runPromise(Scope.make())
  const wss = new NodeWS.WebSocketServer({ noServer: true })
  const stopHeartbeat = startHeartbeat(wss as never)

  const handlersLayer = TokmonRpcGroup.toLayer(
    TokmonRpcGroup.of({
      [TOKMON_WS_METHODS.getConfig]: ({ capabilities }) =>
        readEffect(
          () => (deps.readConfig
            ? deps.readConfig()
            : Promise.resolve(deps.state.config ?? loadConfig())
          ).then(toConfigState),
          error => new ConfigReadFailure({
            kind: 'config-read',
            message: failureMessage(error, 'config could not be read'),
          }),
          supportsTypedReadFailures(capabilities),
        ),
      [TOKMON_WS_METHODS.setConfig]: (config) =>
        configUpdateEffect(deps.engine, deps.state, config as never),
      [TOKMON_WS_METHODS.refresh]: ({ scope }) =>
        refreshEffect(deps.engine, deps.state, scope),
      [TOKMON_WS_METHODS.sessionUsage]: request =>
        Effect.tryPromise({
          try: () => deps.engine.sessionUsage(request),
          catch: error => new SessionUsageFailure({
            kind: 'session-usage', message: failureMessage(error, 'Session usage unavailable'),
          }),
        }),
      [TOKMON_WS_METHODS.browseFs]: ({ path, capabilities }) =>
        readEffect(
          () => (deps.browseHome ?? listHomeDirectory)(path),
          error => new BrowseFsFailure({
            kind: 'browse-fs',
            message: failureMessage(error, 'filesystem could not be browsed'),
          }),
          supportsTypedReadFailures(capabilities),
        ),
      [TOKMON_WS_METHODS.snapshot]: () => snapshotStream(deps.engine),
      [TOKMON_WS_METHODS.config]: () => configStream(deps.engine).pipe(Stream.map(toConfigState)),
    }),
  )

  const httpEffect = await Effect.runPromise(
    RpcServer.toHttpEffectWebsocket(TokmonRpcGroup, {
      spanPrefix: 'tokmon.rpc',
      spanAttributes: {
        'rpc.transport': 'websocket',
        'rpc.system': 'effect-rpc',
      },
    }).pipe(
      Effect.provide(handlersLayer.pipe(Layer.provideMerge(RpcSerialization.layerJson))),
      Scope.provide(scope),
    ),
  )

  const upgradeHandler = await Effect.runPromise(
    NodeHttpServer.makeUpgradeHandler(Effect.succeed(wss), httpEffect, { scope }).pipe(
      Scope.provide(scope),
    ),
  )

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isAllowedLocalRequest(req, deps.state.config.allowNetworkAccess, deps.state.config.allowedHosts)) {
      rejectUpgrade(socket)
      return
    }
    // Vite owns its HMR upgrade path in dev mode. Only intercept tokmon RPC;
    // rejecting every other upgrade here destroys valid HMR connections.
    if (!isWsPath(req)) return
    upgradeHandler(req, socket, head)
  }

  server.prependListener('upgrade', onUpgrade)

  return async () => {
    stopHeartbeat()
    server.off('upgrade', onUpgrade)
    // ws.close waits for peers to close voluntarily; a browser with a suspended tab
    // must not keep the daemon alive forever.
    for (const client of wss.clients) {
      try { client.terminate() } catch {}
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 750)
      timer.unref?.()
      try { wss.close(() => { clearTimeout(timer); resolve() }) } catch { clearTimeout(timer); resolve() }
    })
    await Promise.race([
      Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {}),
      new Promise<void>(resolve => { const timer = setTimeout(resolve, 750); timer.unref?.() }),
    ])
  }
}
