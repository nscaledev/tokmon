import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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

async function cursorAccount(t: TestContext) {
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
  return { id: 'work', providerId: 'cursor' as const, name: 'Work', color: 'cyan', homeDir }
}

test('Cursor conversation queries preserve cache writes, refresh, and fail closed', async t => {
  const account = await cursorAccount(t)
  const event = (conversationId: string, inputTokens: number) => ({
    timestamp, conversationId, model: 'grok-4.7', chargedCents: 12,
    tokenUsage: { inputTokens, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 11 },
  })
  let body: unknown = { usageEventsDisplay: [event(target, 5), event(other, 9000), {
    timestamp, conversationId: target, model: 'grok-4.7', tokenUsage: { cacheWriteTokens: 17 },
  }] }
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(body) })
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
  body = { usageEventsDisplay: {} }
  await assert.rejects(read(account, 'UTC', target, true), /unavailable or incomplete/)
  await assert.rejects(read({ ...account, homeDir: join(account.homeDir, 'no-login') }, 'UTC', target), /unavailable or incomplete/)
})

// One-event production excerpt captured 2026-09-21 from GetFilteredUsageEvents.
// IDs, model, timestamp, counts and money replaced; unrelated metadata removed.
// Field names and wire types (notably the millisecond timestamp string) retained.
const cursorFixture = () => fsPromises.readFile(new URL('./cursor/fixtures/usage-events.sanitized.json', import.meta.url), 'utf8')
  .then(text => JSON.parse(text))

test('captured Cursor wire shape preserves account and session cache-write totals', async t => {
  const account = await cursorAccount(t)
  const body = await cursorFixture()
  t.mock.method(globalThis, 'fetch', async () => Response.json(body))
  const whole = await PROVIDERS.cursor.fetchTable!(account, 'UTC')
  const session = await PROVIDERS.cursor.fetchSessionTable!(account, 'UTC', target)
  for (const table of [whole, session]) {
    assert.equal(table?.daily[0].total, 53)
    assert.equal(table?.daily[0].cacheCreate, 11)
    assert.equal(table?.daily[0].cacheRead, 30)
    assert.equal(table?.daily[0].cost, 0.12)
    assert.equal(table?.daily[0].count, 1)
  }
})

// A live empty page captured 2026-09-22 omitted the field. The full first page
// below is synthetic, expanded from the sanitized one-event production fixture.
for (const [name, body, complete] of [
  ['omitted', {}, true],
  ['null', { usageEventsDisplay: null }, true],
  ['empty array', { usageEventsDisplay: [] }, true],
  ['object', { usageEventsDisplay: {} }, false],
  ['false', { usageEventsDisplay: false }, false],
  ['zero', { usageEventsDisplay: 0 }, false],
  ['empty string', { usageEventsDisplay: '' }, false],
] as const) {
  test(`Cursor pagination: ${name} terminal field preserves cache completeness`, async t => {
    const account = await cursorAccount(t)
    const event = (await cursorFixture()).usageEventsDisplay[0]
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000
    const firstPage = { usageEventsDisplay: Array.from({ length: 1000 }, (_, i) => ({
      ...event, timestamp: String(day + i),
    })) }
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      requests++
      const { page, pageSize } = JSON.parse(String(init?.body))
      assert.equal(pageSize, 1000)
      assert.ok(page === 1 || page === 2, 'the terminal page must end pagination')
      return Response.json(page === 1 ? firstPage : body)
    })
    const readAccount = () => PROVIDERS.cursor.fetchTable!(account, 'UTC')
    const readSession = () => PROVIDERS.cursor.fetchSessionTable!(account, 'UTC', target)
    const whole = await readAccount()
    assert.equal(whole?.daily[0].total, 53_000)
    assert.equal(whole?.daily[0].cacheCreate, 11_000)
    assert.equal(whole?.daily[0].count, 1000)
    assert.equal(requests, 2)
    if (complete) {
      assert.deepEqual(await readSession(), whole)
      assert.deepEqual(await readAccount(), whole)
      assert.equal(requests, 2, 'complete pages must populate the shared account cache')
    } else {
      await assert.rejects(readSession(), /unavailable or incomplete/)
      assert.equal(requests, 4, 'malformed pages must not populate the account cache')
      await readAccount()
      assert.equal(requests, 6)
    }
  })
}

for (const firstSucceeds of [true, false]) {
  test(`Cursor force queues behind an ordinary account fetch (${firstSucceeds ? 'success' : 'failure'})`, async t => {
    const account = await cursorAccount(t)
    const body = await cursorFixture()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const firstStarted = new Promise<void>(resolve => { started = resolve })
    t.after(() => release())
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      const number = ++requests
      if (number === 1) {
        started()
        await gate
        if (!firstSucceeds) return new Response(null, { status: 503 })
      }
      const event = body.usageEventsDisplay[0]
      return Response.json({ usageEventsDisplay: [
        { ...event, tokenUsage: { ...event.tokenUsage, inputTokens: number === 1 ? 5 : 105 } },
        { ...event, conversationId: other, tokenUsage: { ...event.tokenUsage, inputTokens: number === 1 ? 17 : 117 } },
      ] })
    })
    const ordinary = PROVIDERS.cursor.fetchTable!(account, 'UTC')
    await firstStarted
    const read = PROVIDERS.cursor.fetchSessionTable!
    const forced = read(account, 'UTC', target, true)
    const otherForced = read(account, 'UTC', other, true)
    assert.equal(requests, 1, 'forced requests must queue, not race the ordinary cache write')
    release()
    const [, fresh, otherFresh] = await Promise.all([ordinary, forced, otherForced])
    assert.equal(fresh?.daily[0].total, 153)
    assert.equal(otherFresh?.daily[0].total, 165)
    assert.equal(requests, 2, 'forced requests for different sessions share one fresh account pull')
    assert.equal((await read(account, 'UTC', target))?.daily[0].total, 153)
    assert.equal(requests, 2, 'the cached API result must be the newer forced result')
  })
}

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

for (const providerId of ['claude', 'codex'] as const) {
  test(`${providerId} session filesystem failures preserve cached totals and aggregate tolerance`, async t => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tokmon-session-fault-'))
    t.after(() => rm(homeDir, { recursive: true, force: true }))
    const root = join(homeDir, `.${providerId}`, providerId === 'claude' ? 'projects' : 'sessions')
    const directory = join(root, 'project')
    const path = join(directory, `${target}.jsonl`)
    await mkdir(directory, { recursive: true })
    const rows = providerId === 'claude' ? [claude(target, 5)] : [
      { type: 'session_meta', payload: { id: target } },
      { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 31, output_tokens: 13 },
      } } },
    ]
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const account = { id: 'work', providerId, name: 'Work', color: 'cyan', homeDir }
    const engine = createDataEngine({ version: 'test', config: { ...DEFAULTS }, tz: 'UTC',
      summaryIntervalMs: 8000, billingIntervalMs: 300000,
      resolved: [{ account, hasUsage: true, hasBilling: false, color: 'cyan' }],
    })
    t.after(() => engine.stop())
    const request = { sessionId: target, provider: providerId, cached: false, refresh: false }
    const first = await engine.sessionUsage(request)
    const total = providerId === 'claude' ? 53 : 113
    assert.equal(first.accounts[0].table?.daily[0].total, total, 'absent optional roots are harmless')
    const faults = [
      ['root', 'EACCES'], ['directory', 'EACCES'], ['directory', 'ENOENT'],
      ['stat', 'EACCES'], ['stat', 'ENOENT'], ['parse', 'EACCES'], ['parse', 'ENOENT'],
      ...(providerId === 'codex' ? [['prefix', 'EACCES'], ['prefix', 'ENOENT']] : []),
    ]
    for (const [boundary, code] of faults) {
      await t.test(`${boundary} ${code}`, async t => {
        const before = await engine.sessionUsage(request)
        assert.equal(before.accounts[0].table?.daily[0].total, total)
        const error = Object.assign(new Error(`${code}: injected ${boundary} failure`), { code })
        const readdir = fsPromises.readdir
        const stat = fsPromises.stat
        const open = fsPromises.open
        const createReadStream = fs.createReadStream
        let reads = 0
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
        if (boundary === 'root' || boundary === 'directory') {
          t.mock.method(fsPromises, 'readdir', async (...args: Parameters<typeof readdir>) => {
            if (args[0] === (boundary === 'root' ? root : directory)) throw error
            return readdir(...args)
          })
        } else if (boundary === 'stat') {
          t.mock.method(fsPromises, 'stat', async (...args: Parameters<typeof stat>) => {
            if (args[0] === path) throw error
            return stat(...args)
          })
        } else if (boundary === 'prefix') {
          t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
            if (args[0] === path) throw error
            return open(...args)
          })
        } else {
          t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof createReadStream>) => {
            const stream = createReadStream(...args)
            // The identity read succeeds; the later usage parse loses the file.
            if (args[0] === path && ++reads >= 2) queueMicrotask(() => stream.destroy(error))
            return stream
          })
        }
        syncBuiltinESMExports()
        const failed = await engine.sessionUsage(request)
        assert.equal(failed.accounts[0]?.tableState, 'error')
        assert.match(failed.accounts[0].tableError!, new RegExp(code))
        assert.equal(failed.accounts[0].table?.daily[0].total, total)
        assert.equal(failed.generatedAt, before.generatedAt)
        if (boundary === 'parse') assert.equal(reads, 2)
        const cached = await engine.sessionUsage({ ...request, cached: true })
        assert.equal(cached.accounts[0].table?.daily[0].total, total)
        assert.equal(cached.generatedAt, before.generatedAt)
        await assert.doesNotReject(PROVIDERS[providerId].fetchTable!(account, 'UTC'))
      })
    }
  })
}
