import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { codexBilling, codexWindowMetrics, creditBalanceMetric } from './billing'

test('Codex credits remain provider credits instead of invented dollars', () => {
  assert.deepEqual(creditBalanceMetric({ credits: { balance: 314 } }), {
    key: 'credits', role: 'unbounded', label: 'Credits', used: 314, limit: null,
    format: { kind: 'count', suffix: 'available' },
  })
  assert.equal(creditBalanceMetric({ credits: { balance: -1 } }), null)
  assert.equal(creditBalanceMetric({}), null)
})

test('Codex ignores fallback percentage headers when the plan exposes no quota windows', () => {
  const metrics = codexWindowMetrics({}, () => 0)

  assert.deepEqual(metrics, [])
})

test('Codex still uses a fallback percentage header for a real quota window', () => {
  const metrics = codexWindowMetrics({
    primary_window: { limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
  }, name => name === 'x-codex-primary-used-percent' ? 23 : undefined)

  assert.equal(metrics.length, 1)
  assert.equal(metrics[0]?.label, 'Session')
  assert.equal(metrics[0]?.used, 23)
})

test('Codex reset timestamps use the shared epoch boundary and sign heuristic', () => {
  const boundary = 10_000_000_000
  const boundaryMetric = codexWindowMetrics({
    primary_window: { used_percent: 20, reset_at: boundary },
  })[0]
  assert.equal(boundaryMetric?.resetsAt, new Date(boundary).toISOString())

  const negativeMillis = -1_700_000_000_000
  const negativeMetric = codexWindowMetrics({
    primary_window: { used_percent: 20, reset_at: negativeMillis },
  })[0]
  assert.equal(negativeMetric?.resetsAt, new Date(negativeMillis).toISOString())
})

test('Codex custom quota source uses native quota windows without local OAuth', async () => {
  const originalSecret = process.env.TOKMON_CODEX_PROXY_KEY
  process.env.TOKMON_CODEX_PROXY_KEY = 'codex-secret'
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer codex-secret')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      plan_type: 'team',
      rate_limit: {
        primary_window: { used_percent: 15, reset_at: 1_787_623_200 },
        secondary_window: { used_percent: 35, reset_at: 1_788_228_000 },
      },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const result = await codexBilling({
      id: 'proxy', providerId: 'codex', name: 'Proxy', color: 'cyan',
      quotaSource: {
        url: `http://127.0.0.1:${address.port}/backend-api/wham/usage`,
        apiKeyEnv: 'TOKMON_CODEX_PROXY_KEY',
      },
    })
    assert.equal(result.error, null)
    assert.equal(result.plan, 'ChatGPT Team')
    assert.deepEqual(result.metrics.map(metric => [metric.label, metric.used]), [['Session', 15], ['Weekly', 35]])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (originalSecret === undefined) delete process.env.TOKMON_CODEX_PROXY_KEY
    else process.env.TOKMON_CODEX_PROXY_KEY = originalSecret
  }
})
