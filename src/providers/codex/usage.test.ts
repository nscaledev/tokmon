import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexPriceFor, codexSessionTable, codexTable } from './usage'

test('Codex priority service tier doubles every token class', () => {
  const standard = codexPriceFor('gpt-5.6-sol')
  assert.deepEqual(codexPriceFor('gpt-5.6-sol', 'priority'), {
    in: standard.in * 2, cr: standard.cr * 2, out: standard.out * 2,
  })
  assert.deepEqual(codexPriceFor('gpt-5.6-sol', 'default'), standard)
  assert.deepEqual(codexPriceFor('gpt-5.6-sol', undefined), standard)
})

test('Codex pricing matches current short-context standard rates', () => {
  assert.deepEqual(codexPriceFor('gpt-5.6-sol'), { in: 5e-6, cr: 0.5e-6, out: 30e-6 })
  assert.deepEqual(codexPriceFor('gpt-5.6-terra'), { in: 2.5e-6, cr: 0.25e-6, out: 15e-6 })
  assert.deepEqual(codexPriceFor('gpt-5.6-luna'), { in: 1e-6, cr: 0.1e-6, out: 6e-6 })
  assert.deepEqual(codexPriceFor('gpt-5.5-pro'), { in: 30e-6, cr: 30e-6, out: 180e-6 })
  assert.deepEqual(codexPriceFor('gpt-5.4-mini'), { in: 0.75e-6, cr: 0.075e-6, out: 4.5e-6 })
  assert.deepEqual(codexPriceFor('gpt-5.4-nano'), { in: 0.2e-6, cr: 0.02e-6, out: 1.25e-6 })
  assert.deepEqual(codexPriceFor('gpt-5.4-pro'), { in: 30e-6, cr: 30e-6, out: 180e-6 })
})

test('Codex pricing does not let a shorter family prefix claim a newer model', () => {
  assert.deepEqual(codexPriceFor('openai/gpt-5.6-terra-2026-07-09'), { in: 2.5e-6, cr: 0.25e-6, out: 15e-6 })
})

test('Codex spawned sessions exclude replayed history that crosses a timestamp second', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tokmon-codex-replay-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const sessions = join(home, '.codex', 'sessions')
  await mkdir(sessions, { recursive: true })

  const second = Math.floor(Date.now() / 1000) * 1000 - 10_000
  const replayFirst = second + 999
  const replaySpill = second + 1_000
  const liveStart = second + 2_000
  const tokenCount = (timestamp: number, input: number, cached: number, output: number) => ({
    timestamp: new Date(timestamp).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      },
    },
  })
  const lines = [
    {
      timestamp: new Date(second).toISOString(),
      type: 'session_meta',
      payload: {
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
        forked_from_id: 'parent',
      },
    },
    { timestamp: new Date(second).toISOString(), type: 'session_meta', payload: { source: 'vscode' } },
    {
      timestamp: new Date(second).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', started_at: Math.floor(second / 1000) - 60, turn_id: 'replayed' },
    },
    tokenCount(replayFirst, 100, 80, 10),
    tokenCount(replayFirst, 200, 160, 20),
    tokenCount(replaySpill, 300, 240, 30),
    {
      timestamp: new Date(liveStart).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', started_at: liveStart / 1000, turn_id: 'live' },
    },
    { timestamp: new Date(liveStart + 1).toISOString(), type: 'turn_context', payload: { model: 'gpt-5.5' } },
    tokenCount(liveStart + 2, 40, 30, 5),
  ]
  await writeFile(join(sessions, 'spawned.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')

  const table = await codexTable('UTC', home)
  assert.equal(table.daily.length, 1)
  assert.equal(table.daily[0].total, 45)
  assert.equal(table.daily[0].count, 1)
})

for (const format of ['record-first', 'count-first', 'records-only', 'record-first-total-only', 'count-first-total-only']) {
  test(`Codex ${format} usage records share cumulative deduplication with token counts`, async t => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-codex-pairs-'))
    t.after(() => rm(homeDir, { recursive: true, force: true }))
    const sessions = join(homeDir, '.codex', 'sessions')
    await mkdir(sessions, { recursive: true })
    const sessionId = 'paired-usage-fixture'
    const start = Date.UTC(2026, 0, 2)
    const timestamp = (offset: number) => new Date(start + offset).toISOString()
    const usage = (input: number, cached: number, output: number, reasoning = 1) => ({
      input_tokens: input, cached_input_tokens: cached, output_tokens: output,
      reasoning_output_tokens: reasoning, total_tokens: input + output,
    })
    const kinds = format === 'records-only' ? ['record']
      : format.startsWith('record-first') ? ['record', 'count'] : ['count', 'record']
    const rows = [
      { type: 'session_meta', payload: { id: sessionId } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
      ...[1, 2].flatMap(n => kinds.map((kind, index) => ({
        timestamp: timestamp(n * 1000 + index * 400),
        type: kind === 'record' ? 'token_usage_record' : 'event_msg',
        payload: kind === 'record' ? {
          thread_id: 'fixture-thread', turn_id: `turn-${n}`, session_id: sessionId,
          root_turn_id: `turn-${n}`, response_id: `response-${n}`,
          usage: usage(17, 5, 3),
          thread_token_usage: usage(17 * n, 5 * n, 3 * n, n),
          turn_token_usage: usage(17, 5, 3),
        } : { type: 'token_count', info: {
          ...(format.endsWith('total-only') ? {} : { last_token_usage: usage(17, 5, 3) }),
          total_token_usage: usage(17 * n, 5 * n, 3 * n, n),
        } },
      }))),
      // With no last delta, only 5 input (2 cached) + 3 output are new.
      { timestamp: timestamp(3000), type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: usage(39, 12, 9, 3),
      } } },
      // Other generic usage records still retain their existing ingestion path.
      { timestamp: timestamp(4000), type: 'response_completed', payload: { usage: usage(11, 4, 1) } },
      // A counter reset starts a new baseline; the following increment is a delta.
      { timestamp: timestamp(5000), type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: usage(5, 2, 2),
      } } },
      { timestamp: timestamp(6000), type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: usage(9, 3, 3),
      } } },
    ]
    await writeFile(join(sessions, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    for (const table of [await codexTable('UTC', homeDir), await codexSessionTable('UTC', sessionId, homeDir)]) {
      assert.ok(table)
      assert.equal(table.daily.length, 1)
      const row = table.daily[0]
      assert.deepEqual({ input: row.input, cached: row.cacheRead, output: row.output, total: row.total, count: row.count },
        { input: 40, cached: 19, output: 13, total: 72, count: 6 })
    }
  })
}

test('Codex structured records without cumulative totals retain distinct requests with equal usage', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-codex-independent-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  const sessions = join(homeDir, '.codex', 'sessions')
  await mkdir(sessions, { recursive: true })
  const sessionId = 'independent-usage-fixture'
  const rows = [
    { type: 'session_meta', payload: { id: sessionId } },
    ...[1, 2].map(n => ({
      timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, n)).toISOString(), type: 'token_usage_record',
      payload: { response_id: `response-${n}`, usage: {
        input_tokens: 17, cached_input_tokens: 5, output_tokens: 3, total_tokens: 20,
      } },
    })),
  ]
  await writeFile(join(sessions, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  for (const table of [await codexTable('UTC', homeDir), await codexSessionTable('UTC', sessionId, homeDir)]) {
    assert.ok(table)
    assert.equal(table.daily[0].total, 40)
    assert.equal(table.daily[0].count, 2)
  }
})

for (const field of ['invalid', 'created_at', 'createdAt', 'time']) {
  test(`Codex ${field} record timestamps do not lose valid cumulative usage`, async t => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-codex-timestamps-'))
    t.after(() => rm(homeDir, { recursive: true, force: true }))
    const sessions = join(homeDir, '.codex', 'sessions')
    await mkdir(sessions, { recursive: true })
    const sessionId = 'timestamp-usage-fixture'
    const timestamp = '2026-01-02T00:00:00Z'
    const usage = { input_tokens: 17, cached_input_tokens: 5, output_tokens: 3, total_tokens: 20 }
    const rows = [
      { type: 'session_meta', payload: { id: sessionId } },
      { ...(field === 'invalid' ? { timestamp: 'bad timestamp' } : { [field]: timestamp }),
        type: 'token_usage_record', payload: { usage, thread_token_usage: usage } },
      ...(field === 'invalid' ? [{ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: usage, total_token_usage: usage,
      } } }] : []),
      { timestamp: '2026-01-02T00:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 21, cached_input_tokens: 8, output_tokens: 4, total_tokens: 25 },
      } } },
    ]
    await writeFile(join(sessions, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    for (const table of [await codexTable('UTC', homeDir), await codexSessionTable('UTC', sessionId, homeDir)]) {
      assert.ok(table)
      assert.equal(table.daily[0].total, 25)
      assert.equal(table.daily[0].count, 2)
    }
  })
}

for (const scenario of ['usage alias', 'duplicate model metadata']) {
  test(`Codex structured records preserve ${scenario}`, async t => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-codex-fields-'))
    t.after(() => rm(homeDir, { recursive: true, force: true }))
    const sessions = join(homeDir, '.codex', 'sessions')
    await mkdir(sessions, { recursive: true })
    const sessionId = 'field-usage-fixture'
    const usage = { input_tokens: 17, cached_input_tokens: 5, output_tokens: 3, total_tokens: 20 }
    const rows = [
      { type: 'session_meta', payload: { id: sessionId } },
      ...(scenario === 'usage alias' ? [
        { timestamp: '2026-01-02T00:00:00Z', type: 'token_usage_record', usage,
          payload: { thread_token_usage: { input_tokens: 102, cached_input_tokens: 30, output_tokens: 18, total_tokens: 120 } } },
      ] : [
        { timestamp: '2026-01-02T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
          last_token_usage: usage, total_token_usage: usage,
        } } },
        { timestamp: '2026-01-02T00:00:00.400Z', type: 'token_usage_record',
          payload: { usage, thread_token_usage: usage, model: 'gpt-5.6-terra' } },
        { timestamp: '2026-01-02T00:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: {
          last_token_usage: usage,
          total_token_usage: { input_tokens: 34, cached_input_tokens: 10, output_tokens: 6, total_tokens: 40 },
        } } },
      ]),
    ]
    await writeFile(join(sessions, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    for (const table of [await codexTable('UTC', homeDir), await codexSessionTable('UTC', sessionId, homeDir)]) {
      assert.ok(table)
      const row = table.daily[0]
      assert.equal(row.total, scenario === 'usage alias' ? 20 : 40)
      assert.deepEqual(Object.fromEntries(row.breakdown.map(model => [model.name, model.count])),
        scenario === 'usage alias' ? { 'gpt-5': 1 } : { 'gpt-5': 1, 'gpt-5.6-terra': 1 })
    }
  })
}
