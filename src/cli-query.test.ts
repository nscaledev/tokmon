import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUsageReport, formatUsageReport } from './cli-query'
import type { WebSnapshot } from './web/contract'

const detail = (name: string, cost: number, count: number) => ({
  name,
  input: 100,
  output: 20,
  cacheCreate: 10,
  cacheRead: 50,
  cacheSavings: 0.5,
  cost,
  count,
})

const row = (label: string, breakdown: ReturnType<typeof detail>[]) => ({
  label,
  models: breakdown.map(model => model.name),
  input: breakdown.reduce((sum, model) => sum + model.input, 0),
  output: breakdown.reduce((sum, model) => sum + model.output, 0),
  cacheCreate: breakdown.reduce((sum, model) => sum + model.cacheCreate, 0),
  cacheRead: breakdown.reduce((sum, model) => sum + model.cacheRead, 0),
  cacheSavings: breakdown.reduce((sum, model) => sum + model.cacheSavings, 0),
  total: breakdown.reduce((sum, model) => sum + model.input + model.output + model.cacheCreate + model.cacheRead, 0),
  cost: breakdown.reduce((sum, model) => sum + model.cost, 0),
  count: breakdown.reduce((sum, model) => sum + model.count, 0),
  breakdown,
})

const snapshot: WebSnapshot = {
  version: 'test',
  generatedAt: Date.UTC(2026, 6, 10, 12),
  tz: 'UTC',
  intervalMs: 8_000,
  billingIntervalMs: 300_000,
  providers: [{ id: 'codex', name: 'Codex', color: '#00ffff' }],
  seeded: false,
  peak: null,
  accounts: [{
    id: 'work',
    providerId: 'codex',
    name: 'Work',
    color: '#00ffff',
    homeDir: '/tmp/tokmon-cli-work',
    hasUsage: true,
    hasBilling: true,
    email: 'work@example.com',
    displayName: 'Work',
    plan: 'Pro',
    lastActivityAt: null,
    dashboard: null,
    table: {
      daily: [
        row('2026-06-30', [detail('gpt-old', 1, 1)]),
        row('2026-07-09', [detail('gpt-5.6-terra', 2, 2)]),
        row('2026-07-10', [detail('gpt-5.6-terra', 3, 3), detail('gpt-5.6-luna', 1, 4)]),
      ],
      weekly: [],
      monthly: [],
    },
    billing: { plan: 'Pro', metrics: [], error: null },
    summaryState: 'ready',
    billingState: 'ready',
    tableState: 'ready',
    summaryUpdatedAt: null,
    billingUpdatedAt: null,
    tableUpdatedAt: null,
  }],
}

test('usage report aggregates daily model rows for the requested period', async () => {
  const report = await buildUsageReport(snapshot, { period: 'month' }, Date.UTC(2026, 6, 10, 12))
  assert.deepEqual(report.models.map(model => [model.model, model.cost, model.calls]), [
    ['gpt-5.6-terra', 5, 5],
    ['gpt-5.6-luna', 1, 4],
  ])
  assert.equal(report.totals.cost, 6)
  assert.equal(report.totals.tokens, 540)
  assert.equal(report.sources[0].providerId, 'codex')
  assert.ok(report.sources[0].locations.some(item => item.kind === 'usage'))
})

test('usage filters compose and human output remains agent-readable', async () => {
  const report = await buildUsageReport(snapshot, {
    period: 'today',
    provider: 'codex',
    account: 'work',
    model: 'luna',
  }, Date.UTC(2026, 6, 10, 12))
  assert.equal(report.models.length, 1)
  assert.equal(report.models[0].model, 'gpt-5.6-luna')
  const text = formatUsageReport(report)
  assert.match(text, /PROVIDER\s+ACCOUNT\s+MODEL/)
  assert.match(text, /gpt-5\.6-luna/)
  assert.match(text, /Sources:/)
})

test('session reports reject unscoped snapshots and expose scope and source failures', async () => {
  const filters = { session: 'session-one', period: 'all' as const }
  await assert.rejects(buildUsageReport(snapshot, filters), /not scoped/)
  await assert.rejects(buildUsageReport({ ...snapshot, sessionId: 'other' }, filters), /not scoped/)
  const report = await buildUsageReport({ ...snapshot, sessionId: 'session-one',
    accounts: snapshot.accounts.map(account => ({ ...account, tableState: 'error', tableError: 'Refresh failed' })),
  }, filters)
  assert.equal(report.filters.session, 'session-one')
  assert.equal(report.errors[0].message, 'Refresh failed')
  assert.match(formatUsageReport(report), /Session: session-one \(excludes child sessions\)/)
  assert.match(formatUsageReport(report), /Refresh failed/)
})
