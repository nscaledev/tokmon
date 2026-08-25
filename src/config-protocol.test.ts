import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Schema } from 'effect'
import { listenOrSkip } from './test-helpers'
import {
  cleanProviderSelection,
  DEFAULT_MENU_BAR_CONFIG,
  DEFAULTS,
  DEFAULT_TRAY_CONFIG,
  loadConfig,
  MAX_PINNED_PROVIDERS,
  moveProviderSelection,
  normalizeConfig,
  PROVIDER_IDS,
  repairConfig,
  repairMenuBarConfig,
  saveConfig,
  toggleProviderSelection,
  type Config,
} from './config'
import {
  describeConfigUpdateFailure,
  reconcileDaemonConfig,
  reconcileSettingsDraft,
} from './config-sync'
import {
  AppearanceConfigSchema,
  ConfigSchema,
  ConfigStateSchema,
  TOKMON_CAPABILITIES,
  TOKMON_PROTOCOL_VERSION,
  WebSnapshotSchema,
  type ConfigState,
} from './rpc/contract'
import {
  applyConfigUpdate,
  configAffectsEngine,
  ConfigConflictError,
  ConfigPersistenceError,
  rediscoverEngineAccounts,
} from './web/config-control'
import { engineConfigKey, type EngineConfig } from './web/data-engine'
import { assembleSnapshot } from './web/data'
import { createDaemonRpcClient } from './client/daemon-rpc-client'
import { startWebServer } from './web/server'

test('the RPC config schema rejects malformed config documents', () => {
  assert.throws(() => Schema.decodeUnknownSync(ConfigSchema)({ ...DEFAULTS, interval: 'fast' }))
  assert.throws(() => Schema.decodeUnknownSync(ConfigSchema)({
    ...DEFAULTS,
    accounts: [{ id: 'a', name: 'A', homeDir: '~', providerId: 'not-a-provider' }],
  }))
  assert.throws(() => Schema.decodeUnknownSync(ConfigSchema)({
    ...DEFAULTS,
    tray: { ...DEFAULT_TRAY_CONFIG, activeTimeoutMin: 'recently' },
  }))
})

test('custom quota sources accept only the provider endpoint on a safe URL', () => {
  const claude = normalizeConfig({
    ...DEFAULTS,
    accounts: [{
      id: 'proxy-claude', providerId: 'claude', name: 'Proxy Claude', homeDir: '~',
      quotaSource: { url: 'https://cliproxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY' },
    }],
  })
  assert.deepEqual(claude.accounts[0]?.quotaSource, {
    url: 'https://cliproxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY',
  })

  const codex = normalizeConfig({
    ...DEFAULTS,
    accounts: [{
      id: 'proxy-codex', providerId: 'codex', name: 'Proxy Codex', homeDir: '~',
      quotaSource: { url: 'http://127.0.0.1:8317/backend-api/wham/usage', apiKeyEnv: 'CLIPROXY_KEY_2' },
    }],
  })
  assert.equal(codex.accounts[0]?.quotaSource?.url, 'http://127.0.0.1:8317/backend-api/wham/usage')

  for (const url of [
    'http://cliproxy.example/api/oauth/usage',
    'https://user:pass@cliproxy.example/api/oauth/usage',
    'https://cliproxy.example/api/oauth/usage?leak=1',
    'https://cliproxy.example/api/oauth/usage#fragment',
    'https://cliproxy.example/wrong',
  ]) {
    const repaired = normalizeConfig({
      ...DEFAULTS,
      accounts: [{
        id: 'unsafe', providerId: 'claude', name: 'Unsafe', homeDir: '~',
        quotaSource: { url, apiKeyEnv: 'CLIPROXY_KEY' },
      }],
    })
    assert.equal(repaired.accounts[0]?.quotaSource, undefined, url)
  }
})

test('custom quota sources reject unsafe environment variable names and unsupported providers', () => {
  for (const account of [
    {
      id: 'bad-env', providerId: 'claude', name: 'Bad env', homeDir: '~',
      quotaSource: { url: 'https://cliproxy.example/api/oauth/usage', apiKeyEnv: 'KEY=value' },
    },
    {
      id: 'cursor', providerId: 'cursor', name: 'Cursor', homeDir: '~',
      quotaSource: { url: 'https://cliproxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY' },
    },
  ]) {
    const repaired = normalizeConfig({ ...DEFAULTS, accounts: [account] })
    assert.equal(repaired.accounts[0]?.quotaSource, undefined)
  }
})

test('tray config defaults and repairs are stable', () => {
  assert.deepEqual(normalizeConfig({ ...DEFAULTS, tray: undefined }).tray, DEFAULT_TRAY_CONFIG)

  const { menuBar: _legacyMenuBar, ...legacyTray } = DEFAULT_TRAY_CONFIG
  const repaired = repairConfig({
    ...DEFAULTS,
    tray: {
      ...legacyTray,
      enabled: false,
      showMenuBarText: false,
      pollIntervalSec: 0,
      activeTimeoutMin: 60,
      graceMin: 10,
      promotionHoldMin: -1,
      lowWatermarkPct: 3,
      criticalWatermarkPct: 9,
      pinnedAccount: '  claude-work  ',
      launchAtLogin: true,
      theme: 'light',
    },
  })

  assert.equal(repaired.repaired, true)
  assert.deepEqual(repaired.config.tray, {
    ...DEFAULT_TRAY_CONFIG,
    enabled: false,
    menuBar: {
      ...DEFAULT_MENU_BAR_CONFIG,
      elements: { ...DEFAULT_MENU_BAR_CONFIG.elements, value: false },
    },
    showMenuBarText: false,
    activeTimeoutMin: 60,
    graceMin: 60,
    lowWatermarkPct: 3,
    criticalWatermarkPct: 3,
    pinnedAccount: 'claude-work',
    launchAtLogin: true,
  })
})

test('menu-bar builder migrates legacy text visibility and mirrors the compatibility field', () => {
  const { menuBar: _menuBar, ...legacyTray } = DEFAULT_TRAY_CONFIG
  const migrated = normalizeConfig({
    ...DEFAULTS,
    tray: { ...legacyTray, showMenuBarText: false },
  })
  assert.deepEqual(migrated.tray.menuBar, {
    ...DEFAULT_MENU_BAR_CONFIG,
    elements: { ...DEFAULT_MENU_BAR_CONFIG.elements, value: false },
  })
  assert.equal(migrated.tray.showMenuBarText, false)

  const explicit = normalizeConfig({
    ...DEFAULTS,
    tray: {
      ...DEFAULT_TRAY_CONFIG,
      showMenuBarText: true,
      menuBar: {
        ...DEFAULT_MENU_BAR_CONFIG,
        mode: 'custom',
        elements: { providerMark: false, value: false, progress: true },
      },
    },
  })
  assert.equal(explicit.tray.menuBar.mode, 'custom')
  assert.deepEqual(explicit.tray.menuBar.elements, { providerMark: false, value: false, progress: true })
  assert.equal(explicit.tray.showMenuBarText, false)
})

test('menu-bar builder repair bounds and half-point normalizes custom spacing', () => {
  const repaired = repairMenuBarConfig({
    version: 99,
    mode: 'custom',
    elements: { providerMark: false, value: true, progress: true },
    density: 'tight',
    customSpacing: {
      edgePaddingPt: -2,
      markValueGapPt: 2.26,
      providerGapPt: 99,
    },
  })
  assert.deepEqual(repaired, {
    version: 1,
    mode: 'custom',
    elements: { providerMark: false, value: true, progress: true },
    density: 'tight',
    customSpacing: { edgePaddingPt: 0, markValueGapPt: 2.5, providerGapPt: 16 },
  })

  assert.deepEqual(repairMenuBarConfig({
    mode: 'invalid',
    elements: { value: 'yes' },
    density: 'spacious',
    customSpacing: { edgePaddingPt: Number.NaN, markValueGapPt: Number.POSITIVE_INFINITY },
  }), DEFAULT_MENU_BAR_CONFIG)
})

test('shared provider selection contract enforces membership, order, and pin cap', () => {
  const known = new Set(['claude', 'codex', 'cursor'])
  assert.deepEqual(
    cleanProviderSelection(['codex', 'missing', 'claude', 'codex'], known, MAX_PINNED_PROVIDERS),
    ['codex', 'claude'],
  )
  assert.deepEqual(toggleProviderSelection(['claude'], 'codex', known, MAX_PINNED_PROVIDERS), ['claude', 'codex'])
  assert.deepEqual(toggleProviderSelection(['claude', 'codex'], 'cursor', known, MAX_PINNED_PROVIDERS), ['claude', 'codex'])
  assert.deepEqual(moveProviderSelection(['claude', 'codex'], 'codex', -1), ['codex', 'claude'])
})

test('provider pins and desktop disclosure state normalize and survive the RPC schema', () => {
  const repaired = repairConfig({
    ...DEFAULTS,
    tray: { ...DEFAULT_TRAY_CONFIG, pinnedProviders: ['claude', 'claude', 'codex', 'cursor'] },
    desktop: { expandedProviders: ['claude', '  ', 'claude', 'codex'] },
  })
  assert.deepEqual(repaired.config.tray.pinnedProviders, ['claude', 'codex']) // dedupe + cap 2
  assert.deepEqual(repaired.config.desktop.expandedProviders, ['claude', 'codex']) // dedupe, drop blanks
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ConfigSchema)(repaired.config))

  // Additive & tolerant: a pre-disclosure daemon omitting the new keys still validates.
  const { desktop: _desktop, ...withoutDesktop } = DEFAULTS
  const { pinnedProviders: _pins, ...trayWithoutProviders } = DEFAULT_TRAY_CONFIG
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ConfigSchema)({
    ...withoutDesktop, tray: trayWithoutProviders,
  }))
})

test('the strict RPC tray schema accepts only the normalized shape', () => {
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ConfigSchema)(DEFAULTS))
  assert.throws(() => Schema.decodeUnknownSync(ConfigSchema)({
    ...DEFAULTS,
    tray: { ...DEFAULT_TRAY_CONFIG, lowWatermarkPct: 101 },
  }))
  assert.throws(() => Schema.decodeUnknownSync(ConfigSchema)({
    ...DEFAULTS,
    tray: { ...DEFAULT_TRAY_CONFIG, theme: 'system' },
  }))
  assert.throws(() => Schema.decodeUnknownSync(ConfigSchema)({
    ...DEFAULTS,
    tray: {
      ...DEFAULT_TRAY_CONFIG,
      menuBar: {
        ...DEFAULT_MENU_BAR_CONFIG,
        customSpacing: { ...DEFAULT_MENU_BAR_CONFIG.customSpacing, providerGapPt: 2.25 },
      },
    },
  }))
})

test('the snapshot delta stream has a distinct protocol version', () => {
  // v5 changed the tokmon.snapshot stream's success schema from full
  // WebSnapshot frames to SnapshotEvent (init + deltas) — v4 peers cannot
  // decode any frame. Keeping this assertion explicit prevents a packaged app
  // from silently attaching to an older daemon and reconnect-looping.
  assert.equal(TOKMON_PROTOCOL_VERSION, 6)
  assert.ok(TOKMON_CAPABILITIES.includes('snapshot-deltas-v1'))
  assert.ok(TOKMON_CAPABILITIES.includes('appearance-v1'))
  assert.ok(TOKMON_CAPABILITIES.includes('theme-engine'))
  assert.ok(TOKMON_CAPABILITIES.includes('menu-bar-builder-v1'))
  assert.doesNotThrow(() => Schema.decodeUnknownSync(AppearanceConfigSchema)(DEFAULTS.appearance))
  assert.doesNotThrow(() => Schema.decodeUnknownSync(AppearanceConfigSchema)({
    ...DEFAULTS.appearance,
    preset: 'monokai',
  }))
  assert.doesNotThrow(() => Schema.decodeUnknownSync(AppearanceConfigSchema)({
    ...DEFAULTS.appearance,
    preset: 'custom',
    custom: { base: 'dracula', light: {}, dark: { accent: '#ff79c6' } },
  }))
  assert.throws(() => Schema.decodeUnknownSync(AppearanceConfigSchema)({
    ...DEFAULTS.appearance,
    mode: 'sepia',
  }))
  assert.throws(() => Schema.decodeUnknownSync(AppearanceConfigSchema)({
    ...DEFAULTS.appearance,
    preset: 'custom',
    custom: { base: 'tokmon', light: { accent: '#fff' }, dark: {} },
  }))

  // An older config document without the additive field still decodes.
  const { appearance: _appearance, ...oldConfig } = DEFAULTS
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ConfigSchema)(oldConfig))
})

test('appearance repair is deterministic and keeps truth colors out of persisted overrides', () => {
  const repaired = repairConfig({
    ...DEFAULTS,
    appearance: {
      version: 1,
      mode: 'dark',
      preset: 'custom',
      terminal: 'light',
      custom: {
        base: 'tokmon',
        light: { accent: '#006622', ok: '#ff00ff' },
        dark: { accent: '#00FF77', text: '#101011' },
      },
    },
  })
  assert.equal(repaired.config.appearance.custom?.light.accent, '#006622')
  assert.equal(repaired.config.appearance.custom?.dark.accent, '#00ff77')
  assert.equal(repaired.config.appearance.custom?.dark.text, undefined)
  assert.equal('ok' in (repaired.config.appearance.custom?.light ?? {}), false)
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ConfigSchema)(repaired.config))
})

test('allowed hosts are normalized as exact DNS hostnames', () => {
  assert.deepEqual(normalizeConfig({
    ...DEFAULTS,
    allowedHosts: [' Tokmon.Example.COM ', 'tokmon.example.com', 'bad/path', '', 42],
  }).allowedHosts, ['tokmon.example.com'])
})

test('the RPC snapshot schema rejects incomplete streamed snapshots', () => {
  assert.throws(() => Schema.decodeUnknownSync(WebSnapshotSchema)({
    version: 'test', generatedAt: Date.now(), tz: 'UTC', intervalMs: 1000,
  }))
  assert.doesNotThrow(() => Schema.decodeUnknownSync(WebSnapshotSchema)({
    version: 'test',
    generatedAt: Date.now(),
    tz: 'UTC',
    intervalMs: 1000,
    providers: [],
    accounts: [],
    seeded: true,
    peak: { state: 'off-peak', label: 'Off-Peak', minutesUntilChange: 1.5 },
  }))
})

test('the streamed account activity contract is required and integer-normalized', () => {
  const account = {
    id: 'claude',
    providerId: 'claude',
    name: 'Claude',
    color: '#00ff00',
    homeDir: null,
    hasUsage: true,
    hasBilling: false,
    lastActivityAt: 1_720_000_000_000,
    dashboard: null,
    table: null,
    billing: null,
    summaryState: 'ready',
    billingState: 'ready',
    tableState: 'ready',
  }
  const snapshot = {
    version: 'test',
    generatedAt: Date.now(),
    tz: 'UTC',
    intervalMs: 1_000,
    providers: [{ id: 'claude', name: 'Claude', color: '#00ff00' }],
    accounts: [account],
    seeded: false,
    peak: null,
  }

  assert.doesNotThrow(() => Schema.decodeUnknownSync(WebSnapshotSchema)(snapshot))
  const { lastActivityAt: _missing, ...withoutActivity } = account
  assert.throws(() => Schema.decodeUnknownSync(WebSnapshotSchema)({ ...snapshot, accounts: [withoutActivity] }))
  assert.throws(() => Schema.decodeUnknownSync(WebSnapshotSchema)({
    ...snapshot,
    accounts: [{ ...account, lastActivityAt: 1.5 }],
  }))

  const usage = { cost: 0, tokens: 0, input: 0, cacheRead: 0, cacheSavings: 0 }
  const dashboard = {
    today: usage,
    week: usage,
    month: usage,
    burnRate: 0,
    series: [],
    lastActivityAt: account.lastActivityAt,
  }
  assert.doesNotThrow(() => Schema.decodeUnknownSync(WebSnapshotSchema)({
    ...snapshot,
    accounts: [{ ...account, dashboard }],
  }))
  const { lastActivityAt: _missingDashboardActivity, ...dashboardWithoutActivity } = dashboard
  assert.throws(() => Schema.decodeUnknownSync(WebSnapshotSchema)({
    ...snapshot,
    accounts: [{ ...account, dashboard: dashboardWithoutActivity }],
  }))
})

test('canonical account identity and quota views survive the streamed snapshot schema', () => {
  const decoded = Schema.decodeUnknownSync(WebSnapshotSchema)({
    version: 'test', generatedAt: Date.now(), tz: 'UTC', intervalMs: 1_000,
    providers: [], seeded: false, peak: null,
    accounts: [{
      id: 'claude', providerId: 'claude', name: 'Claude', color: '#0f0', homeDir: null,
      hasUsage: true, hasBilling: true, lastActivityAt: null, dashboard: null, table: null, billing: null,
      summaryState: 'ready', billingState: 'ready', tableState: 'ready',
      identity: { title: 'Claude account 1', subtitle: null, accessibleLabel: 'Claude account 1', redacted: true },
      quotas: [
        { key: 'session', label: 'Session', role: 'session', modelId: null, usedPct: 3, remainingPct: 97, resetsAt: null, bounded: true, primary: true, active: false, displayOrder: 0, valueText: '3% used' },
        { key: 'extra', label: 'Extra', role: 'unbounded', modelId: null, usedPct: 3, remainingPct: 97, resetsAt: null, bounded: true, primary: false, active: false, displayOrder: 1, valueText: '$3.00 used · $97.00 left', value: { kind: 'money', used: 3, limit: 100, remaining: 97, currency: 'USD' } },
      ],
    }],
  })
  assert.equal(decoded.accounts[0]?.identity?.title, 'Claude account 1')
  assert.equal(decoded.accounts[0]?.quotas?.[0]?.remainingPct, 97)
  assert.equal(decoded.accounts[0]?.quotas?.[1]?.value?.currency, 'USD')
})

test('the RPC config state rejects incompatible protocol versions', () => {
  assert.throws(() => Schema.decodeUnknownSync(ConfigStateSchema)({
    protocol: { version: 2, capabilities: ['config-cas', 'config-revision'] },
    config: DEFAULTS,
  }))
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ConfigStateSchema)({
    protocol: { version: TOKMON_PROTOCOL_VERSION, capabilities: ['config-cas', 'config-revision', 'allowed-hosts', 'future-addition'] },
    config: DEFAULTS,
  }))
})

test('saveConfig surfaces failures and later writes can recover', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-config-test-'))
  const blocked = join(root, 'blocked')
  await writeFile(blocked, 'not a directory')
  try {
    process.env.XDG_CONFIG_HOME = blocked
    await assert.rejects(saveConfig(DEFAULTS))

    const writable = join(root, 'config')
    process.env.XDG_CONFIG_HOME = writable
    await saveConfig({ ...DEFAULTS, revision: 1 })
    const dir = join(writable, 'tokmon')
    const file = join(dir, 'config.json')
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)

    // Loading a config written by an older release tightens its permissions
    // even when the document itself needs no repair.
    await chmod(dir, 0o755)
    await chmod(file, 0o644)
    await loadConfig()
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('stale config revisions conflict before persistence or broadcast', async () => {
  const state = { config: { ...DEFAULTS, revision: 4 } }
  let configured = false
  let broadcast = false
  const engine = {
    setConfig: () => { configured = true },
    broadcastConfig: () => { broadcast = true },
  } as never

  await assert.rejects(
    applyConfigUpdate(engine, state, { expectedRevision: 3, config: state.config }),
    ConfigConflictError,
  )
  assert.equal(state.config.revision, 4)
  assert.equal(configured, false)
  assert.equal(broadcast, false)
})

test('presentation preferences are hot while source and timing changes affect the engine', () => {
  const hot = [
    { ...DEFAULTS, privacyMode: !DEFAULTS.privacyMode },
    { ...DEFAULTS, tray: { ...DEFAULTS.tray, pinnedProviders: ['claude'] } },
    { ...DEFAULTS, tray: { ...DEFAULTS.tray, displayMetric: 'tightestRemaining' as const } },
    {
      ...DEFAULTS,
      tray: {
        ...DEFAULTS.tray,
        menuBar: { ...DEFAULTS.tray.menuBar, density: 'tight' as const },
      },
    },
    { ...DEFAULTS, desktop: { ...DEFAULTS.desktop, expandedProviders: ['claude'] } },
    { ...DEFAULTS, desktop: { ...DEFAULTS.desktop, graphRangeDays: 30 as const } },
    { ...DEFAULTS, appearance: { ...DEFAULTS.appearance, mode: 'light' as const } },
  ]
  for (const next of hot) assert.equal(configAffectsEngine(DEFAULTS, next), false)
  assert.equal(configAffectsEngine(DEFAULTS, { ...DEFAULTS, interval: 9 }), true)
  assert.equal(configAffectsEngine(DEFAULTS, { ...DEFAULTS, timezone: 'UTC' }), true)
  assert.equal(configAffectsEngine(DEFAULTS, { ...DEFAULTS, disabledProviders: ['claude'] }), true)
  assert.equal(configAffectsEngine(DEFAULTS, {
    ...DEFAULTS,
    accountDetection: { ...DEFAULTS.accountDetection, disabledProviders: ['claude'] },
  }), true)
})

test('an old full-document CAS update preserves every capability-gated config field', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-config-old-client-'))
  const currentAppearance = {
    ...DEFAULTS.appearance,
    mode: 'dark' as const,
    preset: 'custom' as const,
    custom: {
      base: 'tokmon' as const,
      light: {},
      dark: { accent: '#00ff77' },
    },
  }
  const currentPins = ['claude', 'codex']
  const currentExpanded = ['claude']
  const currentDetection: Config['accountDetection'] = {
    enabled: true,
    disabledProviders: ['codex'],
    excludedAccounts: [{ providerId: 'claude' as const, homeDir: '/tmp/old-claude' }],
  }
  const currentMenuBar: Config['tray']['menuBar'] = {
    ...DEFAULTS.tray.menuBar,
    mode: 'custom',
    elements: { providerMark: false, value: true, progress: true },
    density: 'compact',
  }
  const state: { config: Config } = {
    config: {
      ...DEFAULTS,
      accounts: [{
        id: 'disabled-manual',
        providerId: 'claude',
        name: 'Disabled manual',
        homeDir: '/tmp/disabled-manual',
        enabled: false,
        quotaSource: { url: 'https://proxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY' },
      }],
      appearance: currentAppearance,
      tray: {
        ...DEFAULTS.tray,
        menuBar: currentMenuBar,
        pinnedProviders: currentPins,
        menuBarValue: 'todayTokens',
      },
      desktop: { ...DEFAULTS.desktop, expandedProviders: currentExpanded, graphRangeDays: 30 },
      accountDetection: currentDetection,
    },
  }
  const broadcasts: Config[] = []
  const engine = {
    setConfig: () => assert.fail('appearance must be a hot update'),
    broadcastConfig: (config: Config) => { broadcasts.push(config) },
  } as never
  const {
    appearance: _unsupportedAppearance,
    accountDetection: _unsupportedDetection,
    desktop: _unsupportedDesktop,
    ...oldClientTopLevel
  } = state.config
  const {
    menuBar: _unsupportedMenuBar,
    pinnedProviders: _unsupportedProviderPins,
    menuBarValue: _unsupportedMenuBarValue,
    ...oldClientTray
  } = oldClientTopLevel.tray
  const oldClientConfig = {
    ...oldClientTopLevel,
    accounts: oldClientTopLevel.accounts.map(({ enabled: _unsupportedEnabled, quotaSource: _unsupportedQuotaSource, ...account }) => account),
    tray: oldClientTray,
  }

  try {
    process.env.XDG_CONFIG_HOME = root
    const saved = await applyConfigUpdate(engine, state, {
      expectedRevision: 0,
      config: { ...oldClientConfig, privacyMode: false } as unknown as Config,
    })
    assert.equal(saved.config.revision, 1)
    assert.equal(saved.config.privacyMode, false)
    assert.deepEqual(saved.config.appearance, currentAppearance)
    assert.deepEqual(saved.config.tray.pinnedProviders, currentPins)
    assert.deepEqual(saved.config.tray.menuBar, currentMenuBar)
    assert.equal(saved.config.tray.menuBarValue, 'todayTokens')
    assert.deepEqual(saved.config.desktop.expandedProviders, currentExpanded)
    assert.equal(saved.config.desktop.graphRangeDays, 30)
    assert.deepEqual(saved.config.accountDetection, currentDetection)
    assert.equal(saved.config.accounts[0]?.enabled, false)
    assert.deepEqual(saved.config.accounts[0]?.quotaSource, state.config.accounts[0]?.quotaSource)
    assert.deepEqual(broadcasts[0]?.appearance, currentAppearance)
    assert.deepEqual(broadcasts[0]?.tray.pinnedProviders, currentPins)
    assert.deepEqual(broadcasts[0]?.tray.menuBar, currentMenuBar)
    assert.equal(broadcasts[0]?.tray.menuBarValue, 'todayTokens')
    assert.deepEqual(broadcasts[0]?.desktop.expandedProviders, currentExpanded)
    assert.deepEqual(broadcasts[0]?.accountDetection, currentDetection)
    const persisted = await loadConfig()
    assert.deepEqual(persisted.appearance, currentAppearance)
    assert.deepEqual(persisted.tray.pinnedProviders, currentPins)
    assert.deepEqual(persisted.tray.menuBar, currentMenuBar)
    assert.equal(persisted.tray.menuBarValue, 'todayTokens')
    assert.deepEqual(persisted.desktop.expandedProviders, currentExpanded)
    assert.equal(persisted.desktop.graphRangeDays, 30)
    assert.deepEqual(persisted.accountDetection, currentDetection)
    assert.equal(persisted.accounts[0]?.enabled, false)
    assert.deepEqual(persisted.accounts[0]?.quotaSource, state.config.accounts[0]?.quotaSource)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a quota-source-aware client clears a source with an explicit null marker', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-config-clear-quota-source-'))
  const account = {
    id: 'proxy', providerId: 'claude' as const, name: 'Proxy', homeDir: '~',
    quotaSource: { url: 'https://proxy.example/api/oauth/usage', apiKeyEnv: 'CLIPROXY_KEY' },
  }
  const state = { config: { ...structuredClone(DEFAULTS), accounts: [account] } }
  const engine = { setConfig: () => {}, broadcastConfig: () => {} } as never
  try {
    process.env.XDG_CONFIG_HOME = root
    const applied = await applyConfigUpdate(engine, state, {
      expectedRevision: 0,
      config: { ...state.config, accounts: [{ ...account, quotaSource: null }] },
    })
    assert.equal(applied.config.accounts[0]?.quotaSource, undefined)
    assert.equal((await loadConfig()).accounts[0]?.quotaSource, undefined)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('full-refresh rediscovery retries instead of applying an older config revision', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const state = { config: { ...DEFAULTS, revision: 0 } }
  const applied: string[] = []
  let calls = 0
  const engine = {
    setConfig: (next: { tz: string }) => { applied.push(next.tz) },
  } as never

  const rediscovery = rediscoverEngineAccounts(engine, state, async config => {
    calls++
    if (calls === 1) await firstGate
    return {
      resolved: [],
      installedProviders: [],
      tz: `revision-${config.revision}`,
      summaryIntervalMs: 8_000,
      billingIntervalMs: 300_000,
    }
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  state.config = { ...state.config, revision: 1 }
  releaseFirst()
  await rediscovery

  assert.equal(calls, 2)
  assert.deepEqual(applied, ['revision-1'])
})

function recordingEngine(current: EngineConfig) {
  const calls: { next: EngineConfig; options?: { startRefresh?: boolean } }[] = []
  return {
    calls,
    engine: {
      configKey: () => engineConfigKey(current),
      setConfig: (next: EngineConfig, options?: { startRefresh?: boolean }) => {
        calls.push({ next, options })
      },
    } as never,
  }
}

const engineConfigFor = (installedProviders: readonly string[]): EngineConfig => ({
  resolved: [{
    account: { id: 'claude', providerId: 'claude', name: 'Claude', homeDir: '/home/a/.claude' },
    hasUsage: true,
    hasBilling: true,
    color: 'orange',
  }] as never,
  installedProviders: [...installedProviders] as never,
  tz: 'UTC',
  summaryIntervalMs: 8_000,
  billingIntervalMs: 300_000,
})

test('full-refresh rediscovery leaves the engine alone when nothing was rediscovered', async () => {
  const current = engineConfigFor(['claude'])
  const { calls, engine } = recordingEngine(current)
  const state = { config: { ...DEFAULTS, revision: 3 } }

  await rediscoverEngineAccounts(engine, state, async () => engineConfigFor(['claude']))

  // Reconfiguring here would bump the config epoch, prune caches and restart
  // timers on every manual refresh for no gain.
  assert.deepEqual(calls, [])
})

test('full-refresh rediscovery reconfigures without starting a second refresh', async () => {
  const current = engineConfigFor(['claude'])
  const { calls, engine } = recordingEngine(current)
  const state = { config: { ...DEFAULTS, revision: 3 } }

  // An installed-harness inventory delta carries no account change, but it
  // feeds assembleSnapshot, so it must still reach the engine.
  await rediscoverEngineAccounts(engine, state, async () => engineConfigFor(['claude', 'codex']))

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.next.installedProviders, ['claude', 'codex'])
  // ws.ts follows this with engine.refresh(scope); that is the only pass.
  assert.equal(calls[0]?.options?.startRefresh, false)
})

test('re-enabling a disabled manual account survives normalize and the sticky-disable merge', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-account-enable-'))
  const disabled = { id: 'work', providerId: 'claude' as const, name: 'Work', homeDir: '~/w', enabled: false }
  const state = { config: { ...DEFAULTS, accounts: [disabled] } }
  const engine = { setConfig: () => undefined, broadcastConfig: () => undefined } as never

  try {
    process.env.XDG_CONFIG_HOME = root
    // The TUI normalizes its outgoing document; the daemon re-applies a sticky disable to
    // any account that arrives without the key, so an erased `true` silently reverted.
    const enabling = normalizeConfig({
      ...state.config,
      accounts: [{ ...disabled, enabled: true }],
      revision: state.config.revision,
    })
    assert.equal(enabling.accounts[0]?.enabled, true)

    const applied = await applyConfigUpdate(engine, state, { expectedRevision: 0, config: enabling })
    assert.equal(applied.config.accounts[0]?.enabled, true)

    // Sticky-disable must still fire for a client that predates the field: previous
    // is disabled and the incoming account omits the key entirely.
    const { enabled: _absent, ...withoutKey } = disabled
    const legacyState = { config: { ...DEFAULTS, accounts: [disabled] } }
    const sticky = await applyConfigUpdate(engine, legacyState, {
      expectedRevision: 0,
      config: { ...legacyState.config, accounts: [withoutKey] } as unknown as Config,
    })
    assert.equal(sticky.config.accounts[0]?.enabled, false)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy and builder-aware CAS updates reconcile menu-bar value visibility', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-menu-bar-cas-'))
  const initialMenuBar = {
    ...DEFAULT_MENU_BAR_CONFIG,
    mode: 'custom' as const,
    elements: { providerMark: false, value: true, progress: true },
  }
  const state = {
    config: {
      ...DEFAULTS,
      tray: { ...DEFAULTS.tray, menuBar: initialMenuBar, showMenuBarText: true },
    },
  }
  const engine = {
    setConfig: () => assert.fail('menu-bar settings must remain hot'),
    broadcastConfig: () => undefined,
  } as never

  try {
    process.env.XDG_CONFIG_HOME = root
    const { menuBar: _unsupported, ...legacyTray } = state.config.tray
    const folded = await applyConfigUpdate(engine, state, {
      expectedRevision: 0,
      config: {
        ...state.config,
        tray: { ...legacyTray, showMenuBarText: false },
      } as unknown as Config,
    })
    assert.deepEqual(folded.config.tray.menuBar, {
      ...initialMenuBar,
      elements: { ...initialMenuBar.elements, value: false },
    })
    assert.equal(folded.config.tray.showMenuBarText, false)

    const explicitMenuBar = {
      ...folded.config.tray.menuBar,
      elements: { providerMark: true, value: true, progress: false },
      density: 'tight' as const,
    }
    const explicit = await applyConfigUpdate(engine, state, {
      expectedRevision: 1,
      config: {
        ...folded.config,
        tray: {
          ...folded.config.tray,
          menuBar: explicitMenuBar,
          // An explicit builder object wins over a stale compatibility mirror.
          showMenuBarText: false,
        },
      },
    })
    assert.deepEqual(explicit.config.tray.menuBar, explicitMenuBar)
    assert.equal(explicit.config.tray.showMenuBarText, true)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('privacy and desktop preference updates persist without reconfiguring the engine', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-config-hot-'))
  const state = { config: { ...DEFAULTS } }
  let configured = 0
  let broadcasts = 0
  const engine = {
    setConfig: () => { configured++ },
    broadcastConfig: () => { broadcasts++ },
  } as never
  try {
    process.env.XDG_CONFIG_HOME = root
    await applyConfigUpdate(engine, state, {
      expectedRevision: 0,
      config: { ...DEFAULTS, privacyMode: false, desktop: { ...DEFAULTS.desktop, expandedProviders: ['claude'] } },
    })
    assert.equal(configured, 0)
    assert.equal(broadcasts, 1)
    assert.equal(state.config.privacyMode, false)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('failed persistence leaves daemon state and subscribers untouched', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-config-failure-'))
  const blocked = join(root, 'blocked')
  await writeFile(blocked, 'not a directory')
  const state = { config: { ...DEFAULTS } }
  let configured = false
  let broadcast = false
  const engine = {
    setConfig: () => { configured = true },
    broadcastConfig: () => { broadcast = true },
  } as never

  try {
    process.env.XDG_CONFIG_HOME = blocked
    await assert.rejects(
      applyConfigUpdate(engine, state, {
        expectedRevision: 0,
        config: { ...DEFAULTS, privacyMode: false },
      }),
      ConfigPersistenceError,
    )
    assert.equal(state.config.revision, 0)
    assert.equal(configured, false)
    assert.equal(broadcast, false)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent updates from the same revision have exactly one winner', async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'tokmon-config-cas-'))
  await mkdir(root, { recursive: true })
  const state = { config: { ...DEFAULTS } }
  let broadcasts = 0
  const engine = {
    setConfig: () => {},
    broadcastConfig: () => { broadcasts++ },
  } as never

  try {
    process.env.XDG_CONFIG_HOME = root
    const results = await Promise.allSettled([
      applyConfigUpdate(engine, state, {
        expectedRevision: 0,
        config: { ...DEFAULTS, privacyMode: false },
      }),
      applyConfigUpdate(engine, state, {
        expectedRevision: 0,
        config: { ...DEFAULTS, interval: 9 },
      }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.ok(rejected.reason instanceof ConfigConflictError)
    assert.equal(state.config.revision, 1)
    assert.equal(broadcasts, 1)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('RPC transports revisions and typed conflicts end to end', async (t) => {
  const previousConfigHome = process.env.XDG_CONFIG_HOME
  const previousWebMode = process.env.TOKMON_WEB_MODE
  const root = await mkdtemp(join(tmpdir(), 'tokmon-config-rpc-'))
  const token = 'r'.repeat(43)
  let server: Awaited<ReturnType<typeof startWebServer>> | null = null
  let client: ReturnType<typeof createDaemonRpcClient> | null = null
  let unsubscribeConfig: (() => void) | null = null
  try {
    process.env.XDG_CONFIG_HOME = root
    process.env.TOKMON_WEB_MODE = 'prod'
    const started = await listenOrSkip(t, () => startWebServer({
      config: { ...DEFAULTS, disabledProviders: [...PROVIDER_IDS] },
      port: 0,
      wsToken: token,
    }))
    if (!started) return
    server = started.value
    const connStates: string[] = []
    client = createDaemonRpcClient(server.url, {
      transport: 'node',
      onConn: state => { connStates.push(state) },
    })
    const initial = await client.getConfig()
    assert.equal(initial.protocol.version, TOKMON_PROTOCOL_VERSION)
    assert.equal(initial.config.revision, 0)

    let resolveInitialStream!: () => void
    let resolveSavedStream!: () => void
    const initialStream = new Promise<void>(resolve => { resolveInitialStream = resolve })
    const savedStream = new Promise<void>(resolve => { resolveSavedStream = resolve })
    unsubscribeConfig = client.subscribeConfig(state => {
      if (state.config.revision === 0) resolveInitialStream()
      if (state.config.revision === 1) resolveSavedStream()
    })
    await initialStream
    connStates.length = 0

    const saved = await client.setConfig({
      expectedRevision: 0,
      config: { ...initial.config, privacyMode: false },
    })
    assert.equal(saved.config.revision, 1)
    assert.equal(saved.config.privacyMode, false)
    await savedStream
    assert.deepEqual(connStates, [])

    await assert.rejects(
      client.setConfig({
        expectedRevision: 0,
        config: { ...initial.config, interval: 9 },
      }),
      (cause: unknown) => {
        assert.equal((cause as { kind?: unknown }).kind, 'conflict')
        assert.equal((cause as { state?: { config?: { revision?: unknown } } }).state?.config?.revision, 1)
        assert.equal(describeConfigUpdateFailure(cause).conflictState?.config.revision, 1)
        return true
      },
    )
    assert.deepEqual(connStates, [])
    assert.equal((await client.getConfig()).config.revision, 1)
    assert.deepEqual(connStates, [])
  } finally {
    unsubscribeConfig?.()
    await client?.close()
    await server?.stop()
    await rm(root, { recursive: true, force: true })
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    if (previousWebMode === undefined) delete process.env.TOKMON_WEB_MODE
    else process.env.TOKMON_WEB_MODE = previousWebMode
  }
})

test('reconciliation accepts the daemon acknowledgement and discards stale drafts', () => {
  const local = { ...DEFAULTS, revision: 6, privacyMode: false }
  const saved = { ...local, revision: 7 }
  const acknowledged = reconcileDaemonConfig(local, saved, { config: local, expectedRevision: 6 })
  assert.equal(acknowledged.pendingLocalConfig, null)
  assert.equal(acknowledged.conflict, false)
  assert.equal(acknowledged.config?.revision, 7)

  const remote = { ...DEFAULTS, revision: 8, privacyMode: true }
  const conflict = reconcileDaemonConfig(local, remote, { config: local, expectedRevision: 6 })
  assert.equal(conflict.pendingLocalConfig, null)
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.config?.revision, 8)
})

test('a recovered settings stream clears an initial-load dead end without overwriting a dirty draft', () => {
  const remote = { ...DEFAULTS, revision: 2, privacyMode: false }
  const state: ConfigState = {
    protocol: { version: TOKMON_PROTOCOL_VERSION, capabilities: ['config-cas', 'config-revision', 'allowed-hosts'] },
    config: remote,
  }
  const recovered = reconcileSettingsDraft(null, null, false, state)
  assert.equal(recovered.draft, remote)
  assert.equal(recovered.revision, 2)

  const draft = { ...DEFAULTS, revision: 1, privacyMode: true }
  const dirty = reconcileSettingsDraft(draft, 1, true, state)
  assert.equal(dirty.draft, draft)
  assert.equal(dirty.conflict, true)

  const stale = reconcileSettingsDraft(remote, 2, false, {
    ...state,
    config: { ...remote, revision: 1 },
  })
  assert.equal(stale.draft, remote)
  assert.equal(stale.revision, 2)
})

test('suppressed detections travel as an optional field in both directions', () => {
  const base = {
    version: 'test', generatedAt: Date.now(), tz: 'UTC', intervalMs: 1_000,
    providers: [], accounts: [], seeded: true, peak: null,
  }

  // An older daemon simply omits it, and clients must still accept the stream.
  const legacy = Schema.decodeUnknownSync(WebSnapshotSchema)(base)
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'suppressedAccounts'), false)

  const current = Schema.decodeUnknownSync(WebSnapshotSchema)({
    ...base,
    suppressedAccounts: [{ providerId: 'claude', homeDir: '/tmp/claude-alt' }],
  })
  assert.deepEqual(current.suppressedAccounts, [{ providerId: 'claude', homeDir: '/tmp/claude-alt' }])

  assert.throws(() => Schema.decodeUnknownSync(WebSnapshotSchema)({
    ...base,
    suppressedAccounts: [{ providerId: 'not-a-provider', homeDir: '/tmp/x' }],
  }))
})

test('the assembled snapshot reports suppressed detections only when it knows them', () => {
  const assemble = (suppressedAccounts?: readonly { providerId: 'claude'; homeDir: string }[]) => assembleSnapshot({
    version: 'test', tz: 'UTC', intervalMs: 1_000, billingIntervalMs: 300_000,
    resolved: [], usage: new Map(), billing: new Map(),
    suppressedAccounts, config: { ...DEFAULTS },
  })

  assert.equal(Object.prototype.hasOwnProperty.call(assemble(), 'suppressedAccounts'), false)
  assert.deepEqual(
    assemble([{ providerId: 'claude', homeDir: '~' }]).suppressedAccounts,
    [{ providerId: 'claude', homeDir: '~' }],
  )
})
