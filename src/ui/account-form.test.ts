import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS, getTrackedAccountRows, normalizeConfig, repairConfig, type Config } from '../config'
import { applyAccountForm } from './hooks/use-account-form'
import type { AccountForm } from './account-form'

const formFor = (row: { providerId: 'claude' | 'codex'; name: string; homeDir: string; color: string; id: string }): AccountForm => ({
  mode: 'add', field: 'name', providerId: row.providerId,
  name: row.name, homeDir: row.homeDir, color: row.color,
  caret: row.name.length, editingId: null, convertedFromId: row.id, error: null,
})

const autoRow = {
  id: 'claude_alt_1a2b3c', providerId: 'claude' as const,
  name: 'Claude alt', homeDir: '/home/jane/.claude-alt', color: 'green',
}

test('converting the active detected account keeps it selected under its new id', () => {
  const config: Config = { ...structuredClone(DEFAULTS), activeAccountId: autoRow.id }

  const next = applyAccountForm(config, formFor(autoRow))

  const added = next.accounts.at(-1)!
  assert.equal(next.accounts.length, 1)
  assert.equal(added.homeDir, autoRow.homeDir)
  assert.notEqual(added.id, autoRow.id, 'conversion mints a fresh id')
  assert.equal(next.activeAccountId, added.id)
})

test('converting a different account leaves the active selection alone', () => {
  const config: Config = { ...structuredClone(DEFAULTS), activeAccountId: 'claude_main_9f8e7d' }

  const next = applyAccountForm(config, formFor(autoRow))

  assert.equal(next.activeAccountId, 'claude_main_9f8e7d')
})

test('a plain add never captures the active selection', () => {
  const config: Config = { ...structuredClone(DEFAULTS), activeAccountId: null }
  const form: AccountForm = { ...formFor(autoRow), convertedFromId: null }

  const next = applyAccountForm(config, form)

  // convertedFromId and activeAccountId are both null; that must not read as a
  // match and hand the new account an unrequested selection.
  assert.equal(next.activeAccountId, null)
})

test('editing an account touches neither the active selection nor the account list length', () => {
  const config: Config = {
    ...structuredClone(DEFAULTS),
    accounts: [{ id: 'work', providerId: 'claude', name: 'Work', homeDir: '~', color: 'green' }],
    activeAccountId: 'work',
  }
  const next = applyAccountForm(config, {
    ...formFor(autoRow), mode: 'edit', editingId: 'work', convertedFromId: null, name: 'Renamed',
  })

  assert.equal(next.accounts.length, 1)
  assert.equal(next.accounts[0]?.name, 'Renamed')
  assert.equal(next.activeAccountId, 'work')
})

test('account form stores and clears a valid custom quota source without storing a key', () => {
  const config: Config = { ...structuredClone(DEFAULTS) }
  const added = applyAccountForm(config, {
    ...formFor(autoRow), quotaUrl: 'https://proxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY',
  })
  assert.deepEqual(added.accounts[0]?.quotaSource, {
    url: 'https://proxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY',
  })
  assert.equal(JSON.stringify(added).includes('actual-secret'), false)

  const cleared = applyAccountForm(added, {
    ...formFor(autoRow), mode: 'edit', editingId: added.accounts[0]!.id, convertedFromId: null,
    quotaUrl: '', apiKeyEnv: '', hadQuotaSource: true,
  })
  assert.equal(cleared.accounts[0]?.quotaSource, null)
})

test('the conversion produces exactly one row for the converted home', () => {
  const config: Config = { ...structuredClone(DEFAULTS), activeAccountId: autoRow.id }
  const next = applyAccountForm(config, formFor(autoRow))

  // Even while the daemon inventory still carries the pre-conversion auto
  // account, the manual account suppresses it by home key, so settings shows
  // one row rather than the account beside its own conversion.
  const rows = getTrackedAccountRows(next, ['claude'], [{ ...autoRow, source: 'auto' }])
  assert.deepEqual(
    rows.filter(row => row.homeDir === autoRow.homeDir).map(row => row.source),
    ['configured'],
  )
  assert.equal(rows.filter(row => row.source === 'ignored').length, 0)
})

/**
 * F5 fence, not a fix. Auto ids are daemon-owned and never persisted in
 * `accounts`, so repairConfig must keep an unknown `activeAccountId`. A
 * detector that transiently reports nothing — a home briefly unreadable, a
 * daemon still starting — must not be able to clear the user's selection.
 */
test('a selection the current resolution cannot see survives that resolution', () => {
  const config: Config = { ...structuredClone(DEFAULTS), activeAccountId: 'claude_alt_1a2b3c' }

  // An empty resolution renders no rows, and neither normalization nor repair
  // may take that as licence to drop the id.
  assert.deepEqual(getTrackedAccountRows(config, [], []), [])
  assert.equal(normalizeConfig(config).activeAccountId, 'claude_alt_1a2b3c')
  const repaired = repairConfig(config)
  assert.equal(repaired.config.activeAccountId, 'claude_alt_1a2b3c')
  assert.deepEqual(repaired.reasons.filter(reason => reason.includes('active')), [])

  // And the selection is still honoured once the detector recovers.
  const recovered = applyAccountForm(config, formFor(autoRow))
  assert.equal(recovered.activeAccountId, recovered.accounts.at(-1)!.id)
})
