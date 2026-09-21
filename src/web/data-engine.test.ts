import assert from 'node:assert/strict'
import test from 'node:test'
import {
  billingNeedsCatchUp,
  createDataEngine,
  engineConfigKey,
  forEachProviderSequentially,
  throwIfRefreshFailures,
} from './data-engine'
import { createRefreshQueue, settleRefreshTasks } from './refresh-queue'
import { DEFAULTS } from '../config-schema'
import { MIN_STALE_AFTER_MS } from '../usage-semantics'
import { decodeWebSnapshot } from './snapshot-schema'
import { PROVIDERS } from '../providers'
import { tabulate } from '../providers/usage-core'

function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const settleEngine = async () => { for (let i = 0; i < 8; i++) await turn() }

test('cached snapshots decode wholly or fall back to a cold start', () => {
  const snapshot = {
    version: 'test',
    generatedAt: Date.now(),
    tz: 'UTC',
    intervalMs: 1_000,
    providers: [],
    accounts: [],
    seeded: true,
    peak: null,
    futureField: true,
  }
  assert.ok(decodeWebSnapshot(snapshot))
  assert.equal(decodeWebSnapshot({
    ...snapshot,
    accounts: [{ id: 'old-cache-without-required-account-fields' }],
  }), null)
  assert.equal(decodeWebSnapshot({
    ...snapshot,
    generatedAt: 'recently',
  }), null)
})

test('a new viewer catches up missing or stale quota data', () => {
  const accounts = [{ account: { id: 'codex' } }] as never
  assert.equal(billingNeedsCatchUp(accounts, new Map(), 1_000_000), true)
  assert.equal(billingNeedsCatchUp(
    accounts,
    new Map([['codex', 1_000_000 - MIN_STALE_AFTER_MS + 1]]),
    1_000_000,
  ), false)
  assert.equal(billingNeedsCatchUp(
    accounts,
    new Map([['codex', 1_000_000 - MIN_STALE_AFTER_MS]]),
    1_000_000,
  ), true)
  assert.equal(billingNeedsCatchUp(
    accounts,
    new Map([['codex', 1_000_000 - 2 * 60_000]]),
    1_000_000,
    5 * 60_000,
  ), false)
})

test('billing accounts run sequentially per provider while different providers overlap', async () => {
  const firstClaude = deferred()
  const codex = deferred()
  const started: string[] = []
  const accounts = [
    { account: { providerId: 'claude', id: 'claude-1' } },
    { account: { providerId: 'claude', id: 'claude-2' } },
    { account: { providerId: 'codex', id: 'codex-1' } },
  ]
  const task = forEachProviderSequentially(accounts, async value => {
    started.push(value.account.id)
    if (value.account.id === 'claude-1') await firstClaude.promise
    if (value.account.id === 'codex-1') await codex.promise
  })
  await turn()
  assert.deepEqual(started, ['claude-1', 'codex-1'])
  firstClaude.resolve()
  await turn()
  assert.deepEqual(started, ['claude-1', 'codex-1', 'claude-2'])
  codex.resolve()
  await task
})

test('forced refreshes coalesce behind a busy pass and await the queued pass', async () => {
  const gates = [deferred(), deferred()]
  let runs = 0
  const queue = createRefreshQueue(() => gates[runs++].promise)

  const first = queue.run(true)
  await turn()
  const forced = queue.run(true)
  const duplicate = queue.run(true)
  assert.equal(forced, duplicate)
  assert.equal(runs, 1)

  let settled = false
  void forced.then(() => { settled = true })
  gates[0].resolve()
  await turn()
  assert.equal(runs, 2)
  assert.equal(settled, false)

  gates[1].resolve()
  await Promise.all([first, forced, duplicate])
  assert.equal(settled, true)
})

test('rate-limited queues join forced requests to active work without a second pass', async () => {
  const gate = deferred()
  let runs = 0
  const queue = createRefreshQueue(async () => { runs++; await gate.promise }, undefined, {
    forceWhileActive: 'join',
  })
  const first = queue.run(true)
  await turn()
  const second = queue.run(true)
  assert.equal(second, first)
  assert.equal(runs, 1)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(runs, 1)
})

test('a force arriving during the queued pass schedules one further pass', async () => {
  const gates = [deferred(), deferred(), deferred()]
  let runs = 0
  const queue = createRefreshQueue(() => gates[runs++].promise)

  const first = queue.run(true)
  await turn()
  const second = queue.run(true)
  gates[0].resolve()
  await turn()
  assert.equal(runs, 2)

  const third = queue.run(true)
  gates[1].resolve()
  await turn()
  assert.equal(runs, 3)

  gates[2].resolve()
  await Promise.all([first, second, third])
})

test('automatic refreshes join active work, respect idle skipping, and never queue', async () => {
  const gate = deferred()
  let runs = 0
  let idle = false
  const queue = createRefreshQueue(async () => { runs++; await gate.promise }, () => idle)

  const active = queue.run()
  await turn()
  assert.equal(queue.run(), active)
  gate.resolve()
  await active
  assert.equal(runs, 1)

  idle = true
  await queue.run()
  assert.equal(runs, 1)
  await queue.run(true)
  assert.equal(runs, 2)
})

test('a failed active pass still runs the queued force and stop drains waiters', async () => {
  const firstGate = deferred()
  let runs = 0
  const queue = createRefreshQueue(async () => {
    runs++
    if (runs === 1) {
      await firstGate.promise
      throw new Error('first pass failed')
    }
  })

  const first = queue.run(true)
  const firstFailure = assert.rejects(first, /first pass failed/)
  await turn()
  const queued = queue.run(true)
  firstGate.resolve()
  await Promise.all([firstFailure, queued])
  assert.equal(runs, 2)

  const stopGate = deferred()
  let stoppedRuns = 0
  const stoppedQueue = createRefreshQueue(() => { stoppedRuns++; return stopGate.promise })
  const active = stoppedQueue.run(true)
  await turn()
  const waiting = stoppedQueue.run(true)
  stoppedQueue.stop()
  await Promise.all([active, waiting])
  stopGate.resolve()
  await turn()
  assert.equal(stoppedRuns, 1)
})

test('refresh task settlement waits for every scope before propagating a failure', async () => {
  const slow = deferred()
  let settled = false
  const pending = settleRefreshTasks([
    Promise.reject(new Error('summary failed')),
    slow.promise,
  ]).finally(() => { settled = true })
  const rejection = assert.rejects(pending, /summary failed/)

  await turn()
  assert.equal(settled, false)
  slow.resolve()
  await rejection
  assert.equal(settled, true)
})

test('partial account failures become a manual-refresh error after results are applied', () => {
  assert.doesNotThrow(() => throwIfRefreshFailures('summary', []))
  assert.throws(
    () => throwIfRefreshFailures('summary', [new Error('account A failed'), new Error('account B failed')]),
    (cause: unknown) => {
      assert.ok(cause instanceof AggregateError)
      assert.equal(cause.errors.length, 2)
      assert.match(cause.message, /summary refresh failed for 2 accounts/)
      return true
    },
  )
})

const resolvedAccount = (over: Partial<{
  id: string; providerId: string; homeDir: string; name: string
  hasUsage: boolean; hasBilling: boolean; color: string
}> = {}) => ({
  account: {
    id: over.id ?? 'claude',
    providerId: over.providerId ?? 'claude',
    homeDir: over.homeDir ?? '/home/a/.claude',
    name: over.name ?? 'Claude',
  },
  hasUsage: over.hasUsage ?? true,
  hasBilling: over.hasBilling ?? true,
  color: over.color ?? 'orange',
}) as never

const baseEngineConfig = () => ({
  resolved: [resolvedAccount()],
  installedProviders: ['claude'] as never,
  tz: 'UTC',
  summaryIntervalMs: 8_000,
  billingIntervalMs: 300_000,
})

test('an unchanged resolution produces an identical engine configuration key', () => {
  assert.equal(engineConfigKey(baseEngineConfig()), engineConfigKey(baseEngineConfig()))
})

test('every field the engine or snapshot reads changes the configuration key', () => {
  const base = engineConfigKey(baseEngineConfig())
  const differing: Record<string, ReturnType<typeof baseEngineConfig>> = {
    // installedProviders feeds assembleSnapshot, so an inventory-only delta
    // must still reconfigure even when the account set is untouched.
    installedProviders: { ...baseEngineConfig(), installedProviders: ['claude', 'codex'] as never },
    tz: { ...baseEngineConfig(), tz: 'Europe/Bucharest' },
    summaryIntervalMs: { ...baseEngineConfig(), summaryIntervalMs: 30_000 },
    billingIntervalMs: { ...baseEngineConfig(), billingIntervalMs: 60_000 },
    id: { ...baseEngineConfig(), resolved: [resolvedAccount({ id: 'claude_auto' })] },
    providerId: { ...baseEngineConfig(), resolved: [resolvedAccount({ providerId: 'codex' })] },
    homeDir: { ...baseEngineConfig(), resolved: [resolvedAccount({ homeDir: '/home/b/.claude' })] },
    name: { ...baseEngineConfig(), resolved: [resolvedAccount({ name: 'Claude work' })] },
    hasUsage: { ...baseEngineConfig(), resolved: [resolvedAccount({ hasUsage: false })] },
    hasBilling: { ...baseEngineConfig(), resolved: [resolvedAccount({ hasBilling: false })] },
    color: { ...baseEngineConfig(), resolved: [resolvedAccount({ color: 'blue' })] },
    accountCount: { ...baseEngineConfig(), resolved: [] },
  }
  for (const [field, config] of Object.entries(differing)) {
    assert.notEqual(engineConfigKey(config), base, `${field} must change the key`)
  }
})

test('a silent reconfiguration applies the new sources without starting fetches', async () => {
  // No resolved accounts: every loop body is a no-op fetch-wise, so the only
  // observable effect of a pass is the rebuild it publishes to subscribers.
  const engine = createDataEngine({
    version: 'test',
    config: { ...DEFAULTS },
    tz: 'UTC',
    summaryIntervalMs: 8_000,
    billingIntervalMs: 300_000,
    resolved: [],
    installedProviders: [],
  })
  try {
    let rebuilds = 0
    engine.subscribe(() => { rebuilds++ })
    // Subscribing to an empty engine starts the initial summary, table, and
    // billing passes. Let those finish before measuring the reconfiguration;
    // otherwise a slow runner can attribute their rebuilds to setConfig().
    await settleEngine()
    rebuilds = 0

    engine.setConfig({
      resolved: [], installedProviders: ['codex'] as never,
      tz: 'Europe/Bucharest', summaryIntervalMs: 8_000, billingIntervalMs: 300_000,
    }, { startRefresh: false })
    await settleEngine()

    // Exactly the reconfiguration's own rebuild — no summary or history pass.
    assert.equal(rebuilds, 1)
    assert.equal(engine.snapshot()?.tz, 'Europe/Bucharest')
    assert.deepEqual(engine.snapshot()?.installedProviders, ['codex'])

    rebuilds = 0
    engine.setConfig({
      resolved: [], installedProviders: ['codex'] as never,
      tz: 'UTC', summaryIntervalMs: 8_000, billingIntervalMs: 300_000,
    })
    await settleEngine()

    // The default still fetches: the reconfiguration rebuild plus one rebuild
    // per background pass it starts.
    assert.ok(rebuilds > 1, `expected background passes, saw ${rebuilds} rebuild(s)`)
  } finally {
    engine.stop()
  }
})

test('the engine reports a configuration key that tracks what it applied', () => {
  const engine = createDataEngine({
    version: 'test',
    config: { ...DEFAULTS },
    tz: 'UTC',
    summaryIntervalMs: 8_000,
    billingIntervalMs: 300_000,
    resolved: [],
    installedProviders: [],
  })
  try {
    const applied = {
      resolved: [], installedProviders: ['codex'] as never,
      tz: 'UTC', summaryIntervalMs: 8_000, billingIntervalMs: 300_000,
    }
    assert.notEqual(engine.configKey?.(), engineConfigKey(applied))
    engine.setConfig(applied, { startRefresh: false })
    assert.equal(engine.configKey?.(), engineConfigKey(applied))
  } finally {
    engine.stop()
  }
})

test('a forced session refresh queues behind a weaker read and coalesces equal-strength callers', async t => {
  const gates = [deferred(), deferred()]
  const tables = [53, 153].map(input => tabulate([{
    ts: Date.UTC(2026, 6, 10), model: 'test', input, output: 0,
    cacheRead: 0, cacheCreate: 0, cacheSavings: 0, cost: 1,
  }], 'UTC'))
  const flags: boolean[] = []
  let active = 0
  const reader = PROVIDERS.cursor.fetchSessionTable
  t.after(() => { PROVIDERS.cursor.fetchSessionTable = reader })
  PROVIDERS.cursor.fetchSessionTable = async (_account, _tz, _session, refresh) => {
    const index = flags.length
    flags.push(refresh ?? false)
    assert.equal(++active, 1, 'session readers must never race cache writes')
    try { await gates[index].promise; return tables[index] } finally { active-- }
  }
  const engine = createDataEngine({
    version: 'test', config: { ...DEFAULTS }, ...baseEngineConfig(),
    resolved: [resolvedAccount({ providerId: 'cursor' })],
  })
  t.after(() => { for (const gate of gates) gate.resolve(); engine.stop() })
  const request = { sessionId: 'session-one', cached: false, refresh: false }
  const first = engine.sessionUsage(request)
  const sameWeak = engine.sessionUsage(request)
  const forced = engine.sessionUsage({ ...request, refresh: true })
  const sameForced = engine.sessionUsage({ ...request, refresh: true })
  let forcedSettled = false
  void forced.then(() => { forcedSettled = true })
  await turn()
  assert.deepEqual(flags, [false])
  gates[0].resolve()
  const weakResults = await Promise.all([first, sameWeak])
  await turn()
  assert.deepEqual(flags, [false, true])
  assert.equal(forcedSettled, false)
  assert.deepEqual(weakResults.map(result => result.accounts[0].table?.daily[0].total), [53, 53])
  assert.equal((await engine.sessionUsage({ ...request, cached: true })).accounts[0].table?.daily[0].total, 53)
  const joined = engine.sessionUsage(request)
  gates[1].resolve()
  const strongResults = await Promise.all([forced, sameForced, joined])
  assert.deepEqual(strongResults.map(result => result.accounts[0].table?.daily[0].total), [153, 153, 153])
  assert.deepEqual(flags, [false, true])
  assert.equal((await engine.sessionUsage({ ...request, cached: true })).accounts[0].table?.daily[0].total, 153)
})

for (const invalidate of ['config', 'stop']) {
  test(`a queued session refresh is discarded on ${invalidate} invalidation`, async t => {
    const gate = deferred()
    const flags: boolean[] = []
    const reader = PROVIDERS.cursor.fetchSessionTable
    t.after(() => { PROVIDERS.cursor.fetchSessionTable = reader })
    PROVIDERS.cursor.fetchSessionTable = async (_account, _tz, _session, refresh) => {
      flags.push(refresh ?? false)
      await gate.promise
      return { daily: [], weekly: [], monthly: [] }
    }
    const config = { ...baseEngineConfig(), resolved: [resolvedAccount({ providerId: 'cursor' })] }
    const engine = createDataEngine({ version: 'test', config: { ...DEFAULTS }, ...config })
    t.after(() => { gate.resolve(); engine.stop() })
    const request = { sessionId: 'session-one', cached: false, refresh: false }
    const first = assert.rejects(engine.sessionUsage(request), /configuration changed/)
    const forced = assert.rejects(engine.sessionUsage({ ...request, refresh: true }), /configuration changed/)
    await turn()
    if (invalidate === 'config') engine.setConfig(config, { startRefresh: false })
    else engine.stop()
    gate.resolve()
    await Promise.all([first, forced])
    assert.deepEqual(flags, [false])
    if (invalidate === 'config') {
      const cached = await engine.sessionUsage({ ...request, cached: true })
      assert.equal(cached.accounts[0].table, null)
      assert.match(cached.accounts[0].tableError!, /No cached session usage/)
    }
  })
}
