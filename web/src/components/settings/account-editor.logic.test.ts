import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS, getTrackedAccountRows, type Config } from '@shared'
import { applyAccountSubmission, buildAccountFromDraft, newDraft, toDraft } from './account-editor.logic'

const autoRow = {
  id: 'claude_alt_1a2b3c', providerId: 'claude' as const,
  name: 'Claude alt', homeDir: '/home/jane/.claude-alt', color: 'green',
}

const configure = (cfg: Config) => newDraft(cfg, { ...autoRow, convertedFromId: autoRow.id })

function submit(cfg: Config, draft = configure(cfg)): Config {
  const result = buildAccountFromDraft(draft, cfg.accounts)
  assert.ok(result.ok, 'draft must be valid')
  return applyAccountSubmission(cfg, result)
}

test('converting the active detected account keeps it selected under its new id', () => {
  const cfg: Config = { ...structuredClone(DEFAULTS), activeAccountId: autoRow.id }

  const next = submit(cfg)

  const added = next.accounts.at(-1)!
  assert.notEqual(added.id, autoRow.id, 'conversion mints a fresh id')
  assert.equal(next.activeAccountId, added.id)
  // One row for that home, even while the snapshot still lists the auto account.
  assert.deepEqual(
    getTrackedAccountRows(next, ['claude'], [{ ...autoRow, source: 'auto' }])
      .filter(row => row.homeDir === autoRow.homeDir).map(row => row.source),
    ['configured'],
  )
})

test('the configure editor prefills the registered name, not a privacy placeholder', () => {
  const cfg: Config = { ...structuredClone(DEFAULTS), privacyMode: true }

  const draft = configure(cfg)

  assert.equal(draft.name, 'Claude alt')
  assert.equal(draft.homeDir, autoRow.homeDir)
  assert.equal(draft.convertedFromId, autoRow.id)
})

test('a non-converting add or edit leaves the active selection alone', () => {
  const cfg: Config = {
    ...structuredClone(DEFAULTS),
    accounts: [{ id: 'work', providerId: 'claude', name: 'Work', homeDir: '~', color: 'green', enabled: false }],
    activeAccountId: 'work',
  }

  const added = submit(cfg, newDraft(cfg, { providerId: 'claude', name: 'Second', homeDir: '/tmp/second' }))
  assert.equal(added.activeAccountId, 'work')

  const edited = submit(cfg, { ...toDraft(cfg.accounts[0]!), name: 'Renamed' })
  assert.equal(edited.activeAccountId, 'work')
  assert.equal(edited.accounts.length, 1)
  // The edit path preserves the disabled intent it does not own.
  assert.equal(edited.accounts[0]?.enabled, false)
})

test('an unset active selection is not captured by a conversion', () => {
  const cfg: Config = { ...structuredClone(DEFAULTS), activeAccountId: null }

  assert.equal(submit(cfg).activeAccountId, null)
})

test('the account editor round-trips custom quota endpoint configuration', () => {
  const cfg: Config = { ...structuredClone(DEFAULTS) }
  const added = submit(cfg, {
    ...newDraft(cfg, { providerId: 'codex', name: 'Proxy', homeDir: '~' }),
    quotaUrl: 'https://proxy.example/backend-api/wham/usage',
    apiKeyEnv: 'CLIPROXY_API_KEY',
  })
  assert.deepEqual(added.accounts[0]?.quotaSource, {
    url: 'https://proxy.example/backend-api/wham/usage', apiKeyEnv: 'CLIPROXY_API_KEY',
  })
  const draft = toDraft(added.accounts[0]!)
  assert.equal(draft.quotaUrl, 'https://proxy.example/backend-api/wham/usage')
  assert.equal(draft.apiKeyEnv, 'CLIPROXY_API_KEY')
})

test('the account editor rejects a quota URL for the wrong provider endpoint', () => {
  const cfg: Config = { ...structuredClone(DEFAULTS) }
  const result = buildAccountFromDraft({
    ...newDraft(cfg, { providerId: 'codex', name: 'Proxy' }),
    quotaUrl: 'https://proxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_API_KEY',
  }, [])
  assert.deepEqual(result, { ok: false, error: 'Quota endpoint or API key environment variable is invalid' })
})

test('ordinary accounts omit the deletion marker sent only when a source is cleared', () => {
  const cfg: Config = { ...structuredClone(DEFAULTS) }
  const ordinary = buildAccountFromDraft(newDraft(cfg, { providerId: 'claude', name: 'Ordinary' }), [])
  assert.ok(ordinary.ok)
  assert.equal(Object.prototype.hasOwnProperty.call(ordinary.account, 'quotaSource'), false)
  assert.equal(ordinary.account.quotaSource, undefined)

  const withSource = {
    id: 'proxy', providerId: 'claude' as const, name: 'Proxy', homeDir: '~', color: 'green',
    quotaSource: { url: 'https://proxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY' },
  }
  const cleared = buildAccountFromDraft({ ...toDraft(withSource), quotaUrl: '', apiKeyEnv: '' }, [withSource])
  assert.ok(cleared.ok)
  assert.equal(cleared.account.quotaSource, null)
})
