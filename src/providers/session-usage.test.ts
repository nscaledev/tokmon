import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PROVIDERS } from './index'
import { cursorStateDb } from './cursor/billing'
import { createDataEngine } from '../web/data-engine'
import { DEFAULTS } from '../config-schema'

const timestamp = '2026-07-10T12:00:00Z'
const target = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const claude = (sessionId: string, input: number) => ({
  timestamp, sessionId, type: 'assistant',
  message: { id: sessionId, model: 'claude-sonnet-5', usage: {
    input_tokens: input, output_tokens: 7, cache_read_input_tokens: 30, cache_creation_input_tokens: 11,
  } },
})

test('Claude session totals ignore unrelated and child transcripts', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-session-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  const project = join(homeDir, '.claude', 'projects', 'project')
  await mkdir(join(project, target, 'subagents'), { recursive: true })
  await writeFile(join(project, `${target}.jsonl`), JSON.stringify(claude(target, 5)) + '\n')
  const account = { id: 'work', providerId: 'claude' as const, name: 'Work', color: 'cyan', homeDir }
  assert.ok(PROVIDERS.claude.fetchSessionTable, 'provider must support session queries')
  const before = await PROVIDERS.claude.fetchSessionTable(account, 'UTC', target)
  await writeFile(join(project, `${other}.jsonl`), JSON.stringify(claude(other, 9000)) + '\n')
  await writeFile(join(project, target, 'subagents', 'agent-child.jsonl'), JSON.stringify(claude(target, 7000)) + '\n')
  const after = await PROVIDERS.claude.fetchSessionTable(account, 'UTC', target)
  assert.deepEqual(after, before)
  assert.equal(after?.daily[0].total, 53)
  assert.equal(after?.daily[0].cacheCreate, 11)
  assert.equal(after?.daily[0].cacheRead, 30)
  assert.equal(await PROVIDERS.claude.fetchSessionTable(account, 'UTC', 'missing'), null)
})

test('Codex session totals keep cached input as a subset and reject the wrong identity', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-session-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  const sessions = join(homeDir, '.codex', 'sessions')
  await mkdir(sessions, { recursive: true })
  const records = (id: string, input: number) => [
    { type: 'session_meta', payload: { id } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: input, cached_input_tokens: 31, output_tokens: 13 },
    } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  const path = join(sessions, `rollout-2026-07-10-${target}.jsonl`)
  await writeFile(path, records(target, 100))
  await writeFile(join(sessions, `rollout-2026-07-10-${other}.jsonl`), records(other, 8000))
  const account = { id: 'work', providerId: 'codex' as const, name: 'Work', color: 'cyan', homeDir }
  assert.ok(PROVIDERS.codex.fetchSessionTable, 'provider must support session queries')
  const table = await PROVIDERS.codex.fetchSessionTable(account, 'UTC', target)
  assert.equal(table?.daily[0].input, 69)
  assert.equal(table?.daily[0].cacheRead, 31)
  assert.equal(table?.daily[0].total, 113)
  await writeFile(path, records(other, 8000))
  await assert.rejects(PROVIDERS.codex.fetchSessionTable(account, 'UTC', target), /identity/)
})

test('Cursor conversation queries preserve cache writes, refresh, and fail closed', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-session-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  const path = cursorStateDb(homeDir)
  await mkdir(dirname(path), { recursive: true })
  const sql = "CREATE TABLE ItemTable (key TEXT, value TEXT); INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'test-token');"
  let DB: typeof import('node:sqlite').DatabaseSync | undefined
  try { DB = (await import('node:sqlite')).DatabaseSync } catch {}
  if (DB) {
    const db = new DB(path)
    try { db.exec(sql) } finally { db.close() }
  } else {
    execFileSync('sqlite3', [path, sql])
  }
  const event = (conversationId: string, inputTokens: number) => ({
    timestamp, conversationId, model: 'grok-4.7', chargedCents: 12,
    tokenUsage: { inputTokens, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 11 },
  })
  let body: unknown = { usageEventsDisplay: [event(target, 5), event(other, 9000), {
    timestamp, conversationId: target, model: 'grok-4.7', tokenUsage: { cacheWriteTokens: 17 },
  }] }
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(body) })
  const account = { id: 'work', providerId: 'cursor' as const, name: 'Work', color: 'cyan', homeDir }
  const read = PROVIDERS.cursor.fetchSessionTable!
  const first = await read(account, 'UTC', target)
  assert.equal(first?.daily[0].total, 70)
  assert.equal(first?.daily[0].cacheCreate, 28)
  assert.equal(first?.daily[0].cacheRead, 30)
  assert.equal(first?.daily[0].count, 2)
  assert.equal(await read(account, 'UTC', 'missing'), null)
  assert.equal(requests, 1)
  body = { usageEventsDisplay: [event(target, 105)] }
  assert.deepEqual(await read(account, 'UTC', target), first)
  assert.equal((await read(account, 'UTC', target, true))?.daily[0].total, 153)
  assert.equal(requests, 2)
  body = { error: 'unavailable' }
  await assert.rejects(read(account, 'UTC', target, true), /unavailable or incomplete/)
  await assert.rejects(read({ ...account, homeDir: join(homeDir, 'no-login') }, 'UTC', target), /unavailable or incomplete/)
})

test('daemon session cache never falls back to account or other-session totals', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-session-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  const project = join(homeDir, '.claude', 'projects', 'project')
  await mkdir(project, { recursive: true })
  const path = join(project, `${target}.jsonl`)
  await writeFile(path, JSON.stringify(claude(target, 5)) + '\n')
  const account = { id: 'work', providerId: 'claude' as const, name: 'Work', color: 'cyan', homeDir }
  const engine = createDataEngine({ version: 'test', config: { ...DEFAULTS }, tz: 'UTC',
    summaryIntervalMs: 8000, billingIntervalMs: 300000,
    resolved: [{ account, hasUsage: true, hasBilling: false, color: 'cyan' }],
  })
  t.after(() => engine.stop())
  const request = { sessionId: target, provider: 'claude' as const, cached: false, refresh: false }
  const cold = await engine.sessionUsage({ ...request, cached: true })
  assert.match(cold.accounts[0].tableError!, /No cached session usage/)
  assert.equal(cold.accounts[0].table, null)
  const first = await engine.sessionUsage(request)
  assert.equal(first.sessionId, target)
  assert.equal(first.accounts[0].table?.daily[0].total, 53)
  await writeFile(path, JSON.stringify(claude(target, 105)) + '\n')
  const cached = await engine.sessionUsage({ ...request, cached: true })
  assert.equal(cached.generatedAt, first.generatedAt)
  assert.equal(cached.accounts[0].table?.daily[0].total, 53)
  const fresh = await engine.sessionUsage({ ...request, refresh: true })
  assert.equal(fresh.accounts[0].table?.daily[0].total, 153)
  const otherCache = await engine.sessionUsage({ ...request, sessionId: other, cached: true })
  assert.equal(otherCache.accounts[0].table, null)
  assert.match(otherCache.accounts[0].tableError!, /No cached session usage/)
  await writeFile(path, JSON.stringify(claude(other, 9000)) + '\n')
  const failed = await engine.sessionUsage(request)
  assert.equal(failed.accounts[0].tableState, 'error')
  assert.match(failed.accounts[0].tableError!, /identity/)
  assert.equal(failed.accounts[0].table?.daily[0].total, 153)
})
