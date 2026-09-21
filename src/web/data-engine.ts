import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { Duration, Effect, Fiber } from 'effect'
import type { DashboardData, TableData } from '../types'
import type { BillingResult, ProviderId } from '../providers/types'
import { cacheDir, snapshotCacheFile } from '../config'
import { withTimeout } from '../async'
import { fetchPeak } from '../peak'
import {
  assembleSnapshot, fetchAccountBilling, fetchAccountSummary, fetchAccountTable,
  type ResolvedAccount,
} from './data'
import type { WebSnapshot, AccountFetchState, PeakStatus } from './contract'
import type { Config, DetectedAccountRef } from '../config-schema'
import { MIN_STALE_AFTER_MS } from '../usage-semantics'
import { createRefreshQueue, settleRefreshTasks, type RefreshQueue } from './refresh-queue'
import { decodeWebSnapshot } from './snapshot-schema'
import { PROVIDERS } from '../providers'
import { matchesAccount } from '../providers/types'
import type { SessionUsageRequest } from '../rpc/contract'

const TABLE_INTERVAL_MS = 300_000
const PEAK_INTERVAL_MS = 300_000
const IDLE_PAUSE_MS = 60_000
const SNAPSHOT_CACHE_THROTTLE_MS = 20_000
const REVEAL_THROTTLE_MS = 500
const FETCH_TIMEOUT_MS = 30_000

export function billingNeedsCatchUp(
  accounts: readonly ResolvedAccount[],
  updatedAt: ReadonlyMap<string, number>,
  now = Date.now(),
  maxAgeMs = MIN_STALE_AFTER_MS,
): boolean {
  return accounts.some(({ account }) => now - (updatedAt.get(account.id) ?? 0) >= maxAgeMs)
}

export type RefreshScope = 'all' | 'summary' | 'table' | 'billing' | 'peak'

export interface EngineConfig {
  resolved: ResolvedAccount[]
  installedProviders: ProviderId[]
  /** Optional: a resolution that cannot report liveness leaves the field unset. */
  suppressedAccounts?: readonly DetectedAccountRef[]
  tz: string
  summaryIntervalMs: number
  billingIntervalMs: number
}

/**
 * Identity of an applied engine configuration. Equal keys mean setConfig would
 * change nothing observable, so the caller can skip it. Covers every field the
 * engine or assembleSnapshot reads — an installedProviders-only or colour-only
 * delta still renders differently and must reconfigure.
 */
export function engineConfigKey(next: EngineConfig): string {
  return JSON.stringify([
    next.tz,
    next.summaryIntervalMs,
    next.billingIntervalMs,
    next.installedProviders,
    next.suppressedAccounts ?? [],
    next.resolved.map(r => [
      r.account.id, r.account.providerId, r.account.homeDir, r.account.name,
      r.hasUsage, r.hasBilling, r.color,
    ]),
  ])
}

interface DataEngineOptions {
  version: string
  config: Config
  tz: string
  summaryIntervalMs: number
  billingIntervalMs: number
  resolved: ResolvedAccount[]
  installedProviders?: ProviderId[]
  suppressedAccounts?: readonly DetectedAccountRef[]
}

export interface DataEngine {
  snapshot(): WebSnapshot | null
  sessionUsage(request: SessionUsageRequest): Promise<WebSnapshot>
  start(): void
  subscribe(onSnapshot: (snapshot: WebSnapshot) => void): () => void
  subscribeConfig(onConfig: (config: Config) => void): () => void
  touch(): void
  refresh(scope?: RefreshScope): Promise<void>
  /**
   * Applies a resolved configuration. `startRefresh: false` reconfigures
   * silently, for callers that follow with their own explicit refresh.
   */
  setConfig(next: EngineConfig, options?: { startRefresh?: boolean }): void
  /**
   * Key of the currently applied configuration, for skipping no-op setConfig
   * calls. Optional: a double that omits it simply forgoes the optimization.
   */
  configKey?(): string
  broadcastConfig(config: Config): void
  stop(): void
}

export async function forEachProviderSequentially<T extends { account: { providerId: string } }>(
  values: readonly T[],
  task: (value: T) => Promise<void>,
): Promise<void> {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const group = groups.get(value.account.providerId) ?? []
    group.push(value)
    groups.set(value.account.providerId, group)
  }
  await Promise.all([...groups.values()].map(async group => {
    for (const value of group) await task(value)
  }))
}

function reportBackgroundFailure(error: unknown): void {
  // Per-account refresh failures already land in the fetch-state maps that feed
  // the snapshot; only a genuinely unexpected defect would otherwise vanish here.
  if (error instanceof AggregateError) return
  console.error('[tokmon] background refresh failed', error)
}

function runInBackground(task: Promise<void>): void {
  void task.catch(reportBackgroundFailure)
}

export function throwIfRefreshFailures(scope: string, failures: readonly unknown[]): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, `${scope} refresh failed for ${failures.length} account${failures.length === 1 ? '' : 's'}`)
  }
}

export function createDataEngine(opts: DataEngineOptions): DataEngine {
  const { version } = opts
  let tz = opts.tz
  let summaryIntervalMs = opts.summaryIntervalMs
  let billingIntervalMs = opts.billingIntervalMs
  let resolved = opts.resolved
  let installedProviders = opts.installedProviders ?? []
  let suppressedAccounts = opts.suppressedAccounts
  let currentConfig = opts.config

  const usage = new Map<string, { dashboard: DashboardData | null; table: TableData | null }>()
  const billing = new Map<string, BillingResult | null>()
  const summaryState = new Map<string, AccountFetchState>()
  const billingState = new Map<string, AccountFetchState>()
  const tableState = new Map<string, AccountFetchState>()
  const summaryUpdatedAt = new Map<string, number>()
  const billingUpdatedAt = new Map<string, number>()
  const tableUpdatedAt = new Map<string, number>()
  let peak: PeakStatus | null = null
  let seeded = false
  let current: WebSnapshot | null = null
  const snapshotSubscribers = new Set<(snapshot: WebSnapshot) => void>()
  const configSubscribers = new Set<(config: Config) => void>()
  let lastActivity = Date.now()
  let stopped = false
  let loopFibers: Fiber.Fiber<unknown, unknown>[] = []

  let lastPersist = 0
  let lastReveal = 0

  // Bumped on setConfig(); in-flight loops bail if epoch changed to avoid clobbering reconciled maps.
  let configEpoch = 0
  type SessionResult = { table: TableData | null; at: number }
  const sessionCache = new Map<string, SessionResult>()
  const sessionInflight = new Map<string, { refresh: boolean; promise: Promise<SessionResult> }>()

  let hasClaude = resolved.some(r => r.account.providerId === 'claude')

  const idle = () => snapshotSubscribers.size === 0 && Date.now() - lastActivity > IDLE_PAUSE_MS

  const usageEntry = (id: string) => {
    let u = usage.get(id)
    if (!u) { u = { dashboard: null, table: null }; usage.set(id, u) }
    return u
  }

  const buildSnapshot = (): WebSnapshot => assembleSnapshot({
    version, tz, intervalMs: summaryIntervalMs,
    billingIntervalMs, resolved, installedProviders, suppressedAccounts, usage, billing,
    summaryState, billingState, tableState,
    summaryUpdatedAt, billingUpdatedAt, tableUpdatedAt, seeded, peak, config: currentConfig,
  })

  const hydrateFromCache = () => {
    try {
      const cached = decodeWebSnapshot(JSON.parse(readFileSync(snapshotCacheFile(), 'utf-8')))
      if (!cached) return
      for (const a of cached.accounts) {
        if (a.dashboard || a.table) {
          usage.set(a.id, { dashboard: a.dashboard, table: a.table })
          if (a.dashboard) {
            summaryState.set(a.id, 'ready')
            if (typeof a.summaryUpdatedAt === 'number') summaryUpdatedAt.set(a.id, a.summaryUpdatedAt)
          }
          if (a.table) {
            tableState.set(a.id, 'ready')
            if (typeof a.tableUpdatedAt === 'number') tableUpdatedAt.set(a.id, a.tableUpdatedAt)
          }
        }
        if (a.billing) {
          billing.set(a.id, a.billing)
          billingState.set(a.id, 'ready')
          if (typeof a.billingUpdatedAt === 'number') billingUpdatedAt.set(a.id, a.billingUpdatedAt)
        }
      }
      seeded = true
      current = buildSnapshot()
    } catch {}
  }

  const persist = () => {
    if (!current) return
    if (!current.accounts.some(a => a.hasUsage && a.table != null)) return
    if (Date.now() - lastPersist < SNAPSHOT_CACHE_THROTTLE_MS) return
    lastPersist = Date.now()
    try {
      mkdirSync(cacheDir(), { recursive: true, mode: 0o700 }) // 0o700: owner-only usage data
      const tmp = `${snapshotCacheFile()}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(current), { mode: 0o600 })
      renameSync(tmp, snapshotCacheFile())
    } catch {}
  }

  const rebuild = () => {
    if (stopped) return
    seeded = false
    current = buildSnapshot()
    persist()
    for (const onSnapshot of snapshotSubscribers) {
      try { onSnapshot(current) } catch {}
    }
  }

  const reveal = () => {
    if (stopped) return
    if (Date.now() - lastReveal < REVEAL_THROTTLE_MS) return
    lastReveal = Date.now()
    rebuild()
  }

  let usageAccounts = resolved.filter(r => r.hasUsage)
  let billingAccounts = resolved.filter(r => r.hasBilling)

  // In-flight results are dropped when the config epoch moves; the queue then
  // reruns against the latest account set before forced waiters settle.
  const makeRefreshLoop = <T,>(opts: {
    scope: string
    accounts: () => ResolvedAccount[]
    fetch: (r: ResolvedAccount) => Promise<T>
    apply: (id: string, value: T) => void
    state: Map<string, AccountFetchState>
    updatedAt: Map<string, number>
    concurrent?: boolean | 'provider'
    forceWhileActive?: 'queue' | 'join'
  }): RefreshQueue => createRefreshQueue(
    async () => {
      if (stopped) return
      const epoch = configEpoch
      const fetchOne = async (r: ResolvedAccount) => {
        try {
          return { r, ok: true as const, value: await withTimeout(opts.fetch(r), FETCH_TIMEOUT_MS) }
        } catch (cause) {
          return { r, ok: false as const, cause }
        }
      }
      const failures: unknown[] = []
      const applyResult = (result: Awaited<ReturnType<typeof fetchOne>>) => {
        const id = result.r.account.id
        if (result.ok) {
          opts.apply(id, result.value)
          opts.state.set(id, 'ready')
          opts.updatedAt.set(id, Date.now())
        } else {
          opts.state.set(id, 'error')
          failures.push(result.cause)
        }
        reveal()
      }

      if (opts.concurrent === 'provider') {
        await forEachProviderSequentially(opts.accounts(), async r => {
          const result = await fetchOne(r)
          if (stopped || epoch !== configEpoch) return
          applyResult(result)
        })
        if (stopped || epoch !== configEpoch) return
      } else if (opts.concurrent) {
        await Promise.all(opts.accounts().map(async r => {
          const result = await fetchOne(r)
          if (stopped || epoch !== configEpoch) return
          applyResult(result)
        }))
        if (stopped || epoch !== configEpoch) return
      } else {
        for (const r of opts.accounts()) {
          if (stopped) return
          const result = await fetchOne(r)
          if (stopped || epoch !== configEpoch) return
          applyResult(result)
        }
      }
      rebuild()
      throwIfRefreshFailures(opts.scope, failures)
    },
    idle,
    { forceWhileActive: opts.forceWhileActive },
  )

  const refreshSummary = makeRefreshLoop({
    scope: 'summary',
    accounts: () => usageAccounts,
    fetch: r => fetchAccountSummary(r.account, tz),
    apply: (id, dashboard) => { usageEntry(id).dashboard = dashboard },
    state: summaryState,
    updatedAt: summaryUpdatedAt,
  })

  const refreshTable = makeRefreshLoop({
    scope: 'history',
    accounts: () => usageAccounts,
    fetch: r => fetchAccountTable(r.account, tz),
    apply: (id, table) => { usageEntry(id).table = table },
    state: tableState,
    updatedAt: tableUpdatedAt,
  })

  const refreshBilling = makeRefreshLoop({
    scope: 'billing',
    accounts: () => billingAccounts,
    fetch: r => fetchAccountBilling(r.account, tz),
    apply: (id, result) => { billing.set(id, result) },
    state: billingState,
    updatedAt: billingUpdatedAt,
    concurrent: 'provider',
    forceWhileActive: 'join',
  })

  const refreshBillingIfStale = (): Promise<void> =>
    billingNeedsCatchUp(billingAccounts, billingUpdatedAt, Date.now(), billingIntervalMs)
      ? refreshBilling.run(true)
      : Promise.resolve()

  const refreshPeak = createRefreshQueue(
    async () => {
      if (stopped || !hasClaude) return
      const epoch = configEpoch
      const next = await fetchPeak()
      if (stopped || epoch !== configEpoch || !hasClaude) return
      if (next) { peak = next; rebuild() }
    },
    () => !hasClaude || idle(),
  )

  // Loop period is interval + tick duration rather than setInterval's fixed
  // rate; the refresh queues coalesce passes, so back-to-back ticks were
  // already collapsing — this just stops scheduling them at all.
  const loopFiber = (everyMs: number, tick: () => Promise<void>) =>
    Effect.runFork(
      Effect.sleep(Duration.millis(everyMs)).pipe(
        Effect.andThen(Effect.tryPromise({ try: tick, catch: (error) => error })),
        Effect.catch((error) => Effect.sync(() => reportBackgroundFailure(error))),
        Effect.forever,
      ),
    )

  const stopLoops = () => {
    for (const fiber of loopFibers) Effect.runFork(Fiber.interrupt(fiber))
    loopFibers = []
  }

  const startLoops = () => {
    loopFibers = [
      loopFiber(summaryIntervalMs, () => refreshSummary.run()),
      loopFiber(TABLE_INTERVAL_MS, () => refreshTable.run()),
      loopFiber(billingIntervalMs, () => refreshBilling.run()),
    ]
    if (hasClaude) loopFibers.push(loopFiber(PEAK_INTERVAL_MS, () => refreshPeak.run()))
  }

  hydrateFromCache()

  return {
    snapshot: () => current,

    async sessionUsage(request) {
      if (stopped) throw new Error('Data engine stopped')
      if (request.cached && request.refresh) throw new Error('Cannot refresh a cached-only session query')
      if (request.provider && !PROVIDERS[request.provider].fetchSessionTable) {
        throw new Error(`Session queries are not supported for ${request.provider}`)
      }
      lastActivity = Date.now()
      const epoch = configEpoch
      const snapshot = buildSnapshot()
      const candidates = snapshot.accounts.filter(account =>
        (!request.provider || account.providerId === request.provider)
        && matchesAccount(account, request.account)
        && PROVIDERS[account.providerId].fetchSessionTable)
      const accounts = await Promise.all(candidates.map(async account => {
        const key = JSON.stringify([account.providerId, account.id, account.homeDir, tz, request.sessionId])
        const cached = sessionCache.get(key)
        try {
          let result = cached
          if (!request.cached) {
            let pending = sessionInflight.get(key)
            if (!pending || (request.refresh && !pending.refresh)) {
              const reader = PROVIDERS[account.providerId].fetchSessionTable!
              const read = async () => {
                if (stopped || epoch !== configEpoch) throw new Error('Account configuration changed; retry the session query')
                const table = await reader({ ...account, homeDir: account.homeDir ?? undefined },
                  tz, request.sessionId, request.refresh)
                const value = { table, at: Date.now() }
                if (!stopped && epoch === configEpoch) {
                  sessionCache.delete(key)
                  sessionCache.set(key, value)
                  if (sessionCache.size > 128) sessionCache.delete(sessionCache.keys().next().value!)
                }
                return value
              }
              // A force must run after a weaker read, including its cache write.
              // Keep tracking the reader even if an individual caller times out.
              const promise = (pending ? pending.promise.catch(() => {}).then(read) : read()).finally(() => {
                if (sessionInflight.get(key) === pending) sessionInflight.delete(key)
              })
              pending = { refresh: request.refresh, promise }
              sessionInflight.set(key, pending)
            }
            result = await withTimeout(pending.promise, FETCH_TIMEOUT_MS)
          }
          if (!result) throw new Error('No cached session usage; run without --cached first')
          if (!result.table) return null
          return { ...account, dashboard: null, table: result.table, tableState: 'ready' as const,
            tableUpdatedAt: result.at }
        } catch (error) {
          return { ...account, dashboard: null, table: cached?.table ?? null, tableState: 'error' as const,
            tableUpdatedAt: cached?.at ?? null,
            tableError: error instanceof Error ? error.message : 'Session usage unavailable' }
        }
      }))
      if (stopped || epoch !== configEpoch) throw new Error('Account configuration changed; retry the session query')
      const selected = accounts.filter(account => account !== null)
      const timestamps = selected.flatMap(account => account.tableUpdatedAt === null ? [] : [account.tableUpdatedAt])
      return { ...snapshot, sessionId: request.sessionId, accounts: selected,
        generatedAt: timestamps.length ? Math.min(...timestamps) : Date.now() }
    },

    start() {
      runInBackground(refreshSummary.run(true))
      runInBackground(refreshTable.run(true))
      runInBackground(refreshBilling.run(true))
      if (hasClaude) runInBackground(refreshPeak.run(true))
      startLoops()
    },

    touch() { lastActivity = Date.now() },

    refresh(scope = 'all') {
      if (stopped) return Promise.resolve()
      const tasks: Promise<void>[] = []
      if (scope === 'all' || scope === 'summary') tasks.push(refreshSummary.run(true))
      if (scope === 'all' || scope === 'table') tasks.push(refreshTable.run(true))
      // Explicit refreshes are user intent. Focus/viewer attachment uses the
      // freshness gate above, while R/CLI --refresh may deliberately re-query.
      if (scope === 'all' || scope === 'billing') tasks.push(refreshBilling.run(true))
      if ((scope === 'all' || scope === 'peak') && hasClaude) tasks.push(refreshPeak.run(true))
      return settleRefreshTasks(tasks)
    },

    configKey: () => engineConfigKey({
      resolved, installedProviders, suppressedAccounts, tz, summaryIntervalMs, billingIntervalMs,
    }),

    setConfig(next, options) {
      if (stopped) return
      stopLoops()
      configEpoch++
      sessionCache.clear()
      sessionInflight.clear()
      tz = next.tz
      summaryIntervalMs = next.summaryIntervalMs
      billingIntervalMs = next.billingIntervalMs
      const sourceKey = (r: ResolvedAccount) => `${r.account.providerId}:${r.account.homeDir ?? ''}`
      const prevSources = new Map(resolved.map(r => [r.account.id, sourceKey(r)]))
      resolved = next.resolved
      installedProviders = next.installedProviders
      suppressedAccounts = next.suppressedAccounts
      hasClaude = resolved.some(r => r.account.providerId === 'claude')
      if (!hasClaude) peak = null
      usageAccounts = resolved.filter(r => r.hasUsage)
      billingAccounts = resolved.filter(r => r.hasBilling)

      // Drop cached data for removed ids AND for ids whose account was repointed
      // at a different provider or home — otherwise the old source's numbers keep
      // rendering under the new identity until the next refresh completes.
      const survivors = new Set(
        resolved
          .filter(r => !prevSources.has(r.account.id) || prevSources.get(r.account.id) === sourceKey(r))
          .map(r => r.account.id),
      )
      for (const id of [...usage.keys()]) if (!survivors.has(id)) usage.delete(id)
      for (const id of [...billing.keys()]) if (!survivors.has(id)) billing.delete(id)
      for (const map of [summaryState, billingState, tableState]) {
        for (const id of [...map.keys()]) if (!survivors.has(id)) map.delete(id)
      }
      for (const map of [summaryUpdatedAt, billingUpdatedAt, tableUpdatedAt]) {
        for (const id of [...map.keys()]) if (!survivors.has(id)) map.delete(id)
      }

      rebuild()
      // Reconfiguring normally implies "fetch against the new sources". Callers
      // that own an explicit refresh opt out so the work happens exactly once.
      if (options?.startRefresh !== false) {
        runInBackground(refreshSummary.run(true))
        runInBackground(refreshTable.run(true))
        runInBackground(refreshBillingIfStale())
        if (hasClaude) runInBackground(refreshPeak.run(true))
      }
      startLoops()
    },

    broadcastConfig(config) {
      if (stopped) return
      currentConfig = config
      rebuild()
      for (const onConfig of configSubscribers) {
        try { onConfig(config) } catch {}
      }
    },

    subscribe(onSnapshot) {
      if (current) {
        try { onSnapshot(current) } catch {}
      }
      snapshotSubscribers.add(onSnapshot)
      lastActivity = Date.now()
      if (!current || Date.now() - current.generatedAt > summaryIntervalMs) {
        runInBackground(refreshSummary.run(true))
        runInBackground(refreshTable.run(true))
      }
      runInBackground(refreshBillingIfStale())
      return () => { snapshotSubscribers.delete(onSnapshot) }
    },

    subscribeConfig(onConfig) {
      try { onConfig(currentConfig) } catch {}
      configSubscribers.add(onConfig)
      return () => { configSubscribers.delete(onConfig) }
    },

    stop() {
      sessionCache.clear()
      sessionInflight.clear()
      stopped = true
      stopLoops()
      refreshSummary.stop()
      refreshTable.stop()
      refreshBilling.stop()
      refreshPeak.stop()
      snapshotSubscribers.clear()
      configSubscribers.clear()
    },
  }
}
