import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir } from 'node:os'
import { buildAccounts, collectAccounts } from './accounts'
import {
  canonicalizeConfigHomeRefs,
  DEFAULTS,
  getTrackedAccountRows,
  normalizeConfig,
  removedRowCopy,
  setDetectedAccountExcluded,
  type Config,
} from './config'

const manual = {
  id: 'manual-claude', providerId: 'claude' as const, name: 'Manual Claude',
  homeDir: '/tmp/manual-claude', color: 'green',
}

function config(overrides: Partial<Config>): Config {
  return {
    ...DEFAULTS,
    accounts: [],
    accountDetection: { ...DEFAULTS.accountDetection },
    ...overrides,
  }
}

test('global discovery off keeps explicit accounts and performs no automatic assembly', () => {
  const accounts = buildAccounts(config({
    accounts: [manual],
    accountDetection: { ...DEFAULTS.accountDetection, enabled: false },
  }), ['claude', 'codex'])
  assert.deepEqual(accounts.map(account => account.id), ['manual-claude'])
})

test('a provider detector can be disabled without disabling its manual accounts', () => {
  const accounts = buildAccounts(config({
    accounts: [manual],
    accountDetection: { ...DEFAULTS.accountDetection, disabledProviders: ['claude'] },
  }), ['claude'])
  assert.deepEqual(
    accounts.filter(account => account.providerId === 'claude').map(account => account.id),
    ['manual-claude'],
  )
})

test('configured accounts sharing a home remain distinct when their quota sources differ', () => {
  const accounts = buildAccounts(config({
    accounts: [
      {
        ...manual, id: 'team-a',
        quotaSource: { url: 'https://proxy-a.example/api/oauth/usage', apiKeyEnv: 'TEAM_A_KEY' },
      },
      {
        ...manual, id: 'team-b',
        quotaSource: { url: 'https://proxy-b.example/api/oauth/usage', apiKeyEnv: 'TEAM_B_KEY' },
      },
    ],
  }), ['claude'])

  assert.deepEqual(accounts.filter(account => account.source === 'configured').map(account => account.id), ['team-a', 'team-b'])
  assert.equal(accounts.filter(account => account.homeDir === manual.homeDir).some(account => account.source === 'auto'), false)
})

test('a disabled manual account stays registered without being fetched or auto-recreated', () => {
  const disabled = { ...manual, homeDir: '~', enabled: false }
  const next = config({ accounts: [disabled] })
  const accounts = buildAccounts(next, ['claude'])

  assert.equal(accounts.some(account => account.homeDir === '~'), false)
  const row = getTrackedAccountRows(next, ['claude'], accounts)
    .find(candidate => candidate.id === manual.id)
  assert.deepEqual(
    row && { id: row.id, source: row.source, enabled: row.enabled },
    { id: manual.id, source: 'configured', enabled: false },
  )
})

test('an excluded default account is not fetched but remains restorable in settings', () => {
  const next = config({
    accountDetection: {
      ...DEFAULTS.accountDetection,
      excludedAccounts: [{ providerId: 'claude', homeDir: '~' }],
    },
  })
  const accounts = buildAccounts(next, ['claude'])
  assert.equal(accounts.some(account => account.id === 'claude'), false)

  const rows = getTrackedAccountRows(next, ['claude'], accounts)
  const ignored = rows.find(row => row.source === 'ignored')
  assert.deepEqual(ignored?.excludedRef, { providerId: 'claude', homeDir: '~' })
})

test('snapshot-backed settings do not invent default accounts absent from daemon truth', () => {
  const rows = getTrackedAccountRows(config({}), undefined, [])
  assert.deepEqual(rows, [])
})

test('alternate auto account ids remain selected through config normalization', () => {
  const repaired = normalizeConfig({ ...DEFAULTS, activeAccountId: 'claude_other_stable' })
  assert.equal(repaired.activeAccountId, 'claude_other_stable')
})

test('a configured id collision disambiguates rather than dropping the detected account', () => {
  const accounts = buildAccounts(config({
    accounts: [{ ...manual, id: 'claude' }],
  }), ['claude'])
  assert.equal(accounts.find(account => account.id === 'claude')?.source, 'configured')
  assert.deepEqual(
    accounts.find(account => account.id === 'claude_auto'),
    {
      id: 'claude_auto',
      providerId: 'claude',
      name: 'Claude',
      color: 'green',
      homeDir: undefined,
      source: 'auto',
    },
  )
})

test('default-home spelling does not duplicate a configured account as removed', () => {
  const next = canonicalizeConfigHomeRefs(config({
    accounts: [{ ...manual, homeDir: homedir(), enabled: false }],
    accountDetection: {
      ...DEFAULTS.accountDetection,
      excludedAccounts: [{ providerId: 'claude', homeDir: '~' }],
    },
  }))
  const accounts = buildAccounts(next, [])
  const rows = getTrackedAccountRows(next, [], accounts)
  assert.equal(rows.some(row => row.source === 'ignored'), false)
  assert.equal(rows.filter(row => row.source === 'configured').length, 1)
  assert.equal(rows[0]?.enabled, false)
})

test('detector exclusions toggle idempotently and malformed persisted policy repairs safely', () => {
  const excluded = setDetectedAccountExcluded(DEFAULTS.accountDetection, {
    providerId: 'codex', homeDir: ' /tmp/codex-old ',
  }, true)
  assert.deepEqual(excluded.excludedAccounts, [{ providerId: 'codex', homeDir: '/tmp/codex-old' }])
  assert.deepEqual(setDetectedAccountExcluded(excluded, {
    providerId: 'codex', homeDir: '/tmp/codex-old',
  }, true).excludedAccounts, excluded.excludedAccounts)
  assert.deepEqual(setDetectedAccountExcluded(excluded, {
    providerId: 'codex', homeDir: '/tmp/codex-old',
  }, false).excludedAccounts, [])

  const repaired = normalizeConfig({
    ...DEFAULTS,
    accountDetection: {
      enabled: false,
      disabledProviders: ['claude', 'claude', 'invalid'],
      excludedAccounts: [
        { providerId: 'codex', homeDir: ' /tmp/codex-old ' },
        { providerId: 'codex', homeDir: '/tmp/codex-old' },
        { providerId: 'invalid', homeDir: '/tmp/nope' },
      ],
    },
  })
  assert.deepEqual(repaired.accountDetection, {
    enabled: false,
    disabledProviders: ['claude'],
    excludedAccounts: [{ providerId: 'codex', homeDir: '/tmp/codex-old' }],
  })
})

const strandedRef = { providerId: 'claude' as const, homeDir: '/tmp/deleted-claude' }

const withExclusion = (overrides: Partial<Config> = {}) => config({
  accountDetection: {
    ...DEFAULTS.accountDetection,
    excludedAccounts: [strandedRef],
    ...(overrides.accountDetection ?? {}),
  },
  ...overrides,
})

test('a removed account is not listed while nothing is being discovered', () => {
  // Global discovery off, the provider's detector off, and the provider
  // untracked all mean the exclusion is suppressing nothing; claiming a
  // removal that is not in effect would be a lie about current state.
  const cases: Config[] = [
    withExclusion({ accountDetection: { ...DEFAULTS.accountDetection, enabled: false, excludedAccounts: [strandedRef] } }),
    withExclusion({ accountDetection: { ...DEFAULTS.accountDetection, disabledProviders: ['claude'], excludedAccounts: [strandedRef] } }),
    withExclusion({ disabledProviders: ['claude'] }),
  ]
  for (const next of cases) {
    assert.deepEqual(getTrackedAccountRows(next, ['claude'], []).filter(row => row.source === 'ignored'), [])
    // The exclusion itself is never discarded; only its row is withheld.
    assert.deepEqual(next.accountDetection.excludedAccounts, [strandedRef])
  }

  const listed = getTrackedAccountRows(withExclusion(), ['claude'], [])
  assert.equal(listed.filter(row => row.source === 'ignored').length, 1)
})

test('a removed row reads as restorable only while its source is still found', () => {
  const next = withExclusion()

  const live = getTrackedAccountRows(next, ['claude'], [], [strandedRef])
    .find(row => row.source === 'ignored')
  assert.equal(live?.live, true)
  assert.deepEqual(removedRowCopy(live?.live), { status: 'Removed · not tracked', action: 'Restore' })

  const stranded = getTrackedAccountRows(next, ['claude'], [], [])
    .find(row => row.source === 'ignored')
  assert.equal(stranded?.live, false)
  assert.deepEqual(removedRowCopy(stranded?.live), { status: 'Removed · source not found', action: 'Forget' })

  // Both offer the same un-exclude mutation; only the promise differs.
  assert.deepEqual(stranded?.excludedRef, strandedRef)
})

test('a daemon that cannot report liveness renders exactly the previous output', () => {
  const next = withExclusion()

  const unknown = getTrackedAccountRows(next, ['claude'], [])
  assert.deepEqual(unknown, getTrackedAccountRows(next, ['claude'], [], undefined))
  const row = unknown.find(candidate => candidate.source === 'ignored')
  assert.equal(Object.prototype.hasOwnProperty.call(row!, 'live'), false)
  assert.deepEqual(removedRowCopy(row?.live), { status: 'Removed · not tracked', action: 'Restore' })
})

test('forgetting a stranded exclusion removes both the reference and its row', () => {
  const next = withExclusion()

  const forgotten: Config = {
    ...next,
    accountDetection: setDetectedAccountExcluded(next.accountDetection, strandedRef, false),
  }

  assert.deepEqual(forgotten.accountDetection.excludedAccounts, [])
  assert.deepEqual(getTrackedAccountRows(forgotten, ['claude'], [], []), [])
})

test('discovery reports which exclusions actually suppressed something', () => {
  const next = config({
    accountDetection: {
      ...DEFAULTS.accountDetection,
      excludedAccounts: [{ providerId: 'claude', homeDir: '~' }, strandedRef],
    },
  })

  const { accounts, suppressed } = collectAccounts(next, ['claude'])

  // The default home was detected and suppressed; the deleted home matched
  // nothing, so it is a tombstone rather than a live suppression.
  assert.equal(accounts.some(account => account.id === 'claude'), false)
  assert.deepEqual(suppressed, [{ providerId: 'claude', homeDir: '~' }])
  assert.deepEqual(collectAccounts(next, []).suppressed, [])
})
