import { Schema } from 'effect'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import { PROVIDER_IDS } from '../providers/types'
import { DESKTOP_GRAPH_RANGES, type Config } from '../config-schema'
import { BUILT_IN_THEME_PRESET_IDS, THEME_PRESET_IDS } from '../theme'

export const TOKMON_WS_PATH = '/ws'

/** Bump only for an incompatible wire change. Capabilities gate additive features. */
// v5: tokmon.snapshot streams SnapshotEvent (init + deltas) instead of full
// WebSnapshot frames. Not expressible as a capability — the stream's success
// schema itself changed shape, so v4 peers cannot decode any frame.
// v6: quotaSource null is an explicit account-field deletion marker. Older
// daemons cannot decode it, so a newer client must replace them before editing.
export const TOKMON_PROTOCOL_VERSION = 6
export const TOKMON_CAPABILITIES = ['config-cas', 'config-revision', 'allowed-hosts', 'tray-config', 'usage-activity', 'tray-pins', 'provider-pins', 'desktop-disclosure', 'desktop-graph-range', 'provider-headroom', 'canonical-identity', 'appearance-v1', 'theme-engine', 'account-detection-v1', 'account-provenance-v1', 'installed-harnesses-v1', 'discovery-refresh-v1', 'menu-bar-today-tokens', 'menu-bar-builder-v1', 'typed-read-failures-v1', 'snapshot-deltas-v1', 'custom-quota-source-v1', 'session-usage-v1'] as const
export const TYPED_READ_FAILURES_CAPABILITY = 'typed-read-failures-v1'
export const SESSION_USAGE_CAPABILITY = 'session-usage-v1'

export const TOKMON_WS_METHODS = {
  getConfig: 'tokmon.getConfig',
  setConfig: 'tokmon.setConfig',
  refresh: 'tokmon.refresh',
  sessionUsage: 'tokmon.sessionUsage',
  browseFs: 'tokmon.browseFs',
  snapshot: 'tokmon.snapshot',
  config: 'tokmon.config',
} as const

export const RefreshScopeSchema = Schema.Literals([
  'all',
  'summary',
  'table',
  'billing',
  'peak',
] as const)

export type RefreshScope = typeof RefreshScopeSchema.Type

const ProviderIdSchema = Schema.Literals(PROVIDER_IDS)
export const SessionUsageRequestSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^\S{1,200}$/)),
  provider: Schema.optionalKey(ProviderIdSchema),
  account: Schema.optionalKey(Schema.String),
  cached: Schema.Boolean,
  refresh: Schema.Boolean,
})
export type SessionUsageRequest = typeof SessionUsageRequestSchema.Type

export class SessionUsageFailure extends Schema.TaggedErrorClass<SessionUsageFailure>()(
  'SessionUsageFailure', { kind: Schema.Literal('session-usage'), message: Schema.String },
) {}
const NonNegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))

const AccountSchema = Schema.Struct({
  id: Schema.String,
  providerId: ProviderIdSchema,
  name: Schema.String,
  homeDir: Schema.String,
  color: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
  quotaSource: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    url: Schema.String,
    apiKeyEnv: Schema.String,
  }))),
})

export const TrayConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  // Additive under `menu-bar-builder-v1`; old peers omit it and repair from
  // `showMenuBarText`, while the daemon's CAS boundary preserves newer state.
  menuBar: Schema.optionalKey(Schema.Struct({
    version: Schema.Literal(1),
    mode: Schema.Literals(['auto', 'custom'] as const),
    elements: Schema.Struct({
      providerMark: Schema.Boolean,
      value: Schema.Boolean,
      progress: Schema.Boolean,
    }),
    density: Schema.Literals(['comfortable', 'compact', 'tight'] as const),
    customSpacing: Schema.Struct({
      edgePaddingPt: Schema.Finite
        .check(Schema.isBetween({ minimum: 0, maximum: 6 }))
        .check(Schema.isMultipleOf(0.5)),
      markValueGapPt: Schema.Finite
        .check(Schema.isBetween({ minimum: 0, maximum: 8 }))
        .check(Schema.isMultipleOf(0.5)),
      providerGapPt: Schema.Finite
        .check(Schema.isBetween({ minimum: 0, maximum: 16 }))
        .check(Schema.isMultipleOf(0.5)),
    }),
  })),
  showMenuBarText: Schema.Boolean,
  menuBarValue: Schema.optionalKey(Schema.Literals(['usage', 'todayTokens'] as const)),
  displayMetric: Schema.Literals(['smartHeadroom', 'tightestRemaining'] as const),
  pollIntervalSec: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 86_400 })),
  activeTimeoutMin: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 1_440 })),
  graceMin: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 10_080 })),
  promotionHoldMin: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1_440 })),
  lowWatermarkPct: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  criticalWatermarkPct: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  pinnedAccount: Schema.NullOr(Schema.String),
  pins: Schema.Array(Schema.String),
  // Additive since `tray-pins`: older daemons omit it, so tolerate absence and let
  // `repairConfig` materialise the empty default rather than failing the decode.
  pinnedProviders: Schema.optionalKey(Schema.Array(Schema.String)),
  launchAtLogin: Schema.Boolean,
  theme: Schema.Literal('dark'),
})

/** Desktop-only preferences; additive and optional so pre-disclosure daemons validate. */
export const DesktopConfigSchema = Schema.Struct({
  expandedProviders: Schema.Array(Schema.String),
  graphRangeDays: Schema.optionalKey(Schema.Literals(DESKTOP_GRAPH_RANGES)),
})

const DetectedAccountRefSchema = Schema.Struct({
  providerId: ProviderIdSchema,
  homeDir: Schema.String,
})

export const AccountDetectionConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  disabledProviders: Schema.Array(ProviderIdSchema),
  excludedAccounts: Schema.Array(DetectedAccountRefSchema),
})

const HexColorSchema = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i))
const ThemeOverridesSchema = Schema.Struct({
  canvas: Schema.optionalKey(HexColorSchema),
  panel: Schema.optionalKey(HexColorSchema),
  inset: Schema.optionalKey(HexColorSchema),
  insetStrong: Schema.optionalKey(HexColorSchema),
  chrome: Schema.optionalKey(HexColorSchema),
  line: Schema.optionalKey(HexColorSchema),
  lineStrong: Schema.optionalKey(HexColorSchema),
  lineFaint: Schema.optionalKey(HexColorSchema),
  text: Schema.optionalKey(HexColorSchema),
  textDim: Schema.optionalKey(HexColorSchema),
  textFaint: Schema.optionalKey(HexColorSchema),
  textStrong: Schema.optionalKey(HexColorSchema),
  accent: Schema.optionalKey(HexColorSchema),
  cost: Schema.optionalKey(HexColorSchema),
  positive: Schema.optionalKey(HexColorSchema),
})

export const AppearanceConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literals(['auto', 'light', 'dark'] as const),
  preset: Schema.Literals(THEME_PRESET_IDS),
  terminal: Schema.Literals(['ansi', 'dark', 'light', 'off'] as const),
  custom: Schema.optionalKey(Schema.Struct({
    base: Schema.Literals(BUILT_IN_THEME_PRESET_IDS),
    light: ThemeOverridesSchema,
    dark: ThemeOverridesSchema,
  })),
})

/** The persisted config shape. This is deliberately strict at every RPC boundary. */
export const ConfigSchema = Schema.Struct({
  revision: NonNegativeIntegerSchema,
  interval: PositiveFiniteSchema,
  billingInterval: PositiveFiniteSchema,
  clearScreen: Schema.Boolean,
  privacyMode: Schema.Boolean,
  privacyToggleKey: Schema.String,
  timezone: Schema.NullOr(Schema.String),
  accounts: Schema.Array(AccountSchema),
  activeAccountId: Schema.NullOr(Schema.String),
  disabledProviders: Schema.Array(ProviderIdSchema),
  onboarded: Schema.Boolean,
  dashboardLayout: Schema.Literals(['grid', 'single'] as const),
  defaultFocus: Schema.Literals(['all', 'last'] as const),
  ascii: Schema.Literals(['auto', 'on', 'off'] as const),
  allowNetworkAccess: Schema.Boolean,
  allowedHosts: Schema.Array(Schema.String),
  resetDisplay: Schema.Literals(['relative', 'absolute'] as const),
  knownProviders: Schema.Array(ProviderIdSchema),
  // Additive under `appearance-v1`; omission is accepted for old clients and
  // preserved by the daemon's CAS boundary rather than resetting the theme.
  appearance: Schema.optionalKey(AppearanceConfigSchema),
  // Additive: older clients omit detector policy, so the daemon preserves its
  // current value and repairConfig supplies legacy current-behaviour defaults.
  accountDetection: Schema.optionalKey(AccountDetectionConfigSchema),
  // The complete tray block was added within protocol v3. Accept omission from
  // older peers and normalize it at the client / preserve it at the CAS boundary.
  tray: Schema.optionalKey(TrayConfigSchema),
  desktop: Schema.optionalKey(DesktopConfigSchema),
})

export const ProtocolInfoSchema = Schema.Struct({
  version: Schema.Literal(TOKMON_PROTOCOL_VERSION),
  // Capabilities are additive within a protocol version. Older clients must
  // preserve forward compatibility when a newer daemon advertises one they do
  // not understand yet.
  capabilities: Schema.Array(Schema.String),
})

export interface ProtocolInfo {
  version: typeof TOKMON_PROTOCOL_VERSION
  capabilities: readonly string[]
}

export interface ConfigState {
  protocol: ProtocolInfo
  config: Config
}

export const ConfigStateSchema = Schema.Struct({
  protocol: ProtocolInfoSchema,
  config: ConfigSchema,
})

export interface ConfigUpdateRequest {
  /** The server revision the editor was based on. */
  expectedRevision: number
  config: Config
}

export const ConfigUpdateRequestSchema = Schema.Struct({
  expectedRevision: NonNegativeIntegerSchema,
  config: ConfigSchema,
})

const LegacyConfigUpdateConflictSchema = Schema.Struct({
  kind: Schema.Literal('conflict'),
  state: ConfigStateSchema,
})

export class ConfigUpdateConflictFailure extends Schema.TaggedErrorClass<ConfigUpdateConflictFailure>()(
  'ConfigUpdateConflictFailure',
  {
    kind: Schema.Literal('conflict'),
    state: ConfigStateSchema,
  },
) {}

const LegacyConfigPersistenceFailureSchema = Schema.Struct({
  kind: Schema.Literal('persistence'),
  message: Schema.String,
})

export class ConfigPersistenceFailure extends Schema.TaggedErrorClass<ConfigPersistenceFailure>()(
  'ConfigPersistenceFailure',
  {
    kind: Schema.Literal('persistence'),
    message: Schema.String,
  },
) {}

// Protocol-v3 daemons predating schema-backed errors emitted the legacy plain
// objects. New clients accept both; old clients ignore the additive `_tag` key.
export const ConfigUpdateConflictSchema = Schema.Union([
  ConfigUpdateConflictFailure,
  LegacyConfigUpdateConflictSchema,
])

export const ConfigPersistenceFailureSchema = Schema.Union([
  ConfigPersistenceFailure,
  LegacyConfigPersistenceFailureSchema,
])

export class RefreshFailure extends Schema.TaggedErrorClass<RefreshFailure>()(
  'RefreshFailure',
  {
    kind: Schema.Literal('refresh'),
    message: Schema.String,
  },
) {}

const LegacyConfigReadFailureSchema = Schema.Struct({
  kind: Schema.Literal('config-read'),
  message: Schema.String,
})

export class ConfigReadFailure extends Schema.TaggedErrorClass<ConfigReadFailure>()(
  'ConfigReadFailure',
  {
    kind: Schema.Literal('config-read'),
    message: Schema.String,
  },
) {}

export const ConfigReadFailureSchema = Schema.Union([
  ConfigReadFailure,
  LegacyConfigReadFailureSchema,
])

const LegacyBrowseFsFailureSchema = Schema.Struct({
  kind: Schema.Literal('browse-fs'),
  message: Schema.String,
})

export class BrowseFsFailure extends Schema.TaggedErrorClass<BrowseFsFailure>()(
  'BrowseFsFailure',
  {
    kind: Schema.Literal('browse-fs'),
    message: Schema.String,
  },
) {}

export const BrowseFsFailureSchema = Schema.Union([
  BrowseFsFailure,
  LegacyBrowseFsFailureSchema,
])

export const FsEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  dir: Schema.Boolean,
})

export const FsListingSchema = Schema.Struct({
  path: Schema.String,
  parent: Schema.NullOr(Schema.String),
  entries: Schema.Array(FsEntrySchema),
})

export type FsListing = typeof FsListingSchema.Type

const UsageSummarySchema = Schema.Struct({
  cost: Schema.Finite,
  tokens: Schema.Finite,
  input: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheSavings: Schema.Finite,
})

const ModelDetailSchema = Schema.Struct({
  name: Schema.String,
  input: Schema.Finite,
  output: Schema.Finite,
  cacheCreate: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheSavings: Schema.Finite,
  cost: Schema.Finite,
  count: Schema.Finite,
})

const TableRowSchema = Schema.Struct({
  label: Schema.String,
  models: Schema.Array(Schema.String),
  input: Schema.Finite,
  output: Schema.Finite,
  cacheCreate: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheSavings: Schema.Finite,
  total: Schema.Finite,
  cost: Schema.Finite,
  count: Schema.Finite,
  breakdown: Schema.Array(ModelDetailSchema),
})

const DashboardDataSchema = Schema.Struct({
  today: UsageSummarySchema,
  week: UsageSummarySchema,
  month: UsageSummarySchema,
  burnRate: Schema.Finite,
  series: Schema.Array(Schema.Finite),
  lastActivityAt: Schema.NullOr(NonNegativeIntegerSchema),
})

const TableDataSchema = Schema.Struct({
  daily: Schema.Array(TableRowSchema),
  weekly: Schema.Array(TableRowSchema),
  monthly: Schema.Array(TableRowSchema),
})

const MetricFormatSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('percent') }),
  Schema.Struct({ kind: Schema.Literal('dollars'), currency: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal('count'), suffix: Schema.optionalKey(Schema.String) }),
])

const MetricSchema = Schema.Struct({
  key: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.Literals(['session', 'weekly', 'model', 'other', 'unbounded'] as const)),
  modelId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  active: Schema.optionalKey(Schema.Boolean),
  label: Schema.String,
  used: Schema.Finite,
  limit: Schema.NullOr(Schema.Finite),
  format: MetricFormatSchema,
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  primary: Schema.optionalKey(Schema.Boolean),
})

const MetricRoleSchema = Schema.Literals(['session', 'weekly', 'model', 'other', 'unbounded'] as const)
const AccountIdentityViewSchema = Schema.Struct({
  title: Schema.String,
  subtitle: Schema.NullOr(Schema.String),
  accessibleLabel: Schema.String,
  redacted: Schema.Boolean,
})
const QuotaViewSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  role: MetricRoleSchema,
  modelId: Schema.NullOr(Schema.String),
  usedPct: Schema.NullOr(Schema.Finite),
  remainingPct: Schema.NullOr(Schema.Finite),
  resetsAt: Schema.NullOr(NonNegativeIntegerSchema),
  bounded: Schema.Boolean,
  primary: Schema.Boolean,
  active: Schema.Boolean,
  displayOrder: NonNegativeIntegerSchema,
  valueText: Schema.String,
  value: Schema.optionalKey(Schema.Struct({
    kind: Schema.Literal('money'),
    used: Schema.Finite,
    limit: Schema.NullOr(Schema.Finite),
    remaining: Schema.NullOr(Schema.Finite),
    currency: Schema.String,
  })),
})
const HeadroomFactorSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  role: MetricRoleSchema,
  remainingPct: Schema.Finite,
  included: Schema.Boolean,
  reason: Schema.Literals(['session', 'active-model', 'weekly-cap', 'primary', 'fallback-floor'] as const),
})
const HeadroomViewSchema = Schema.Struct({
  value: Schema.NullOr(Schema.Finite),
  unit: Schema.Literal('index-100'),
  mode: Schema.Literals(['smart', 'single-window', 'fallback-floor', 'unavailable'] as const),
  basis: Schema.Literals(['active', 'idle-runway', 'unavailable'] as const),
  representativeAccountId: Schema.NullOr(Schema.String),
  activeAccountIds: Schema.Array(Schema.String),
  factors: Schema.Array(HeadroomFactorSchema),
  explanation: Schema.String,
})

const BillingResultSchema = Schema.Struct({
  plan: Schema.NullOr(Schema.String),
  metrics: Schema.Array(MetricSchema),
  error: Schema.NullOr(Schema.String),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  activity: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    series: Schema.Array(Schema.Finite),
    summary: Schema.String,
  }))),
  modelSpend: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({
    name: Schema.String,
    usd: Schema.Finite,
    requests: Schema.Finite,
  })))),
  // Finite, not Int: the app type is plain `number` and one producer derived
  // this from fractional fs mtimeMs. A wire schema stricter than its producer
  // type turns a stray fraction into a failed encode for the whole stream.
  asOfMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})

/**
 * The account splits into a light "shell" (identity, quota views, fetch state —
 * rebuilt every snapshot) and three heavy sections (dashboard/table/billing —
 * referentially stable in the engine between refetches). The delta protocol
 * ships the shell whenever an account changes and each heavy section only when
 * its content actually changed.
 */
const WebAccountShellFields = {
  id: Schema.String,
  providerId: ProviderIdSchema,
  name: Schema.String,
  color: Schema.String,
  homeDir: Schema.NullOr(Schema.String),
  source: Schema.optionalKey(Schema.Literals(['auto', 'configured'] as const)),
  hasUsage: Schema.Boolean,
  hasBilling: Schema.Boolean,
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  identity: Schema.optionalKey(AccountIdentityViewSchema),
  quotas: Schema.optionalKey(Schema.Array(QuotaViewSchema)),
  headroom: Schema.optionalKey(HeadroomViewSchema),
  plan: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastActivityAt: Schema.NullOr(NonNegativeIntegerSchema),
  summaryState: Schema.Literals(['pending', 'ready', 'error'] as const),
  billingState: Schema.Literals(['pending', 'ready', 'error'] as const),
  tableState: Schema.Literals(['pending', 'ready', 'error'] as const),
  tableError: Schema.optionalKey(Schema.String),
  summaryUpdatedAt: Schema.optionalKey(Schema.NullOr(NonNegativeIntegerSchema)),
  billingUpdatedAt: Schema.optionalKey(Schema.NullOr(NonNegativeIntegerSchema)),
  tableUpdatedAt: Schema.optionalKey(Schema.NullOr(NonNegativeIntegerSchema)),
} as const

export const WebAccountShellSchema = Schema.Struct(WebAccountShellFields)

const WebAccountSchema = Schema.Struct({
  ...WebAccountShellFields,
  dashboard: Schema.NullOr(DashboardDataSchema),
  table: Schema.NullOr(TableDataSchema),
  billing: Schema.NullOr(BillingResultSchema),
})

/** Runtime validation for streamed dashboard state; unknown JSON is never trusted. */
export const WebSnapshotSchema = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  version: Schema.String,
  generatedAt: NonNegativeIntegerSchema,
  tz: Schema.String,
  intervalMs: PositiveFiniteSchema,
  billingIntervalMs: Schema.optionalKey(PositiveFiniteSchema),
  installedProviders: Schema.optionalKey(Schema.Array(ProviderIdSchema)),
  providers: Schema.Array(Schema.Struct({
    id: ProviderIdSchema,
    name: Schema.String,
    color: Schema.String,
    headroom: Schema.optionalKey(HeadroomViewSchema),
  })),
  accounts: Schema.Array(WebAccountSchema),
  suppressedAccounts: Schema.optionalKey(Schema.Array(DetectedAccountRefSchema)),
  seeded: Schema.Boolean,
  peak: Schema.NullOr(Schema.Struct({
    state: Schema.Literals(['peak', 'off-peak', 'weekend'] as const),
    label: Schema.String,
    // The upstream clock is only normalized to a finite number; do not make
    // the wire contract narrower than the producer's declared type.
    minutesUntilChange: Schema.NullOr(Schema.Finite),
    changesAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  })),
})

/**
 * Everything in a snapshot except the per-account heavy sections. Small enough
 * to ship on every delta; `accountIds` is the authoritative account order, so
 * membership and ordering never need separate remove events.
 */
export const SnapshotMetaSchema = Schema.Struct({
  version: Schema.String,
  generatedAt: NonNegativeIntegerSchema,
  tz: Schema.String,
  intervalMs: PositiveFiniteSchema,
  billingIntervalMs: Schema.optionalKey(PositiveFiniteSchema),
  installedProviders: Schema.optionalKey(Schema.Array(ProviderIdSchema)),
  providers: Schema.Array(Schema.Struct({
    id: ProviderIdSchema,
    name: Schema.String,
    color: Schema.String,
    headroom: Schema.optionalKey(HeadroomViewSchema),
  })),
  suppressedAccounts: Schema.optionalKey(Schema.Array(DetectedAccountRefSchema)),
  seeded: Schema.Boolean,
  peak: Schema.NullOr(Schema.Struct({
    state: Schema.Literals(['peak', 'off-peak', 'weekend'] as const),
    label: Schema.String,
    minutesUntilChange: Schema.NullOr(Schema.Finite),
    changesAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  })),
  accountIds: Schema.Array(Schema.String),
})

/**
 * One changed account. The shell is always present (it is cheap and rebuilt per
 * snapshot); each heavy section is tri-state — key absent means "unchanged
 * since the previous frame on this stream", present (including null) replaces.
 */
export const AccountUpsertSchema = Schema.Struct({
  shell: WebAccountShellSchema,
  dashboard: Schema.optionalKey(Schema.NullOr(DashboardDataSchema)),
  table: Schema.optionalKey(Schema.NullOr(TableDataSchema)),
  billing: Schema.optionalKey(Schema.NullOr(BillingResultSchema)),
})

/**
 * The tokmon.snapshot stream protocol (v5). Every subscription starts with an
 * `init` carrying the full snapshot; subsequent frames are `delta`s relative to
 * the previous frame emitted on the same stream. Deltas are encoded after the
 * server's backpressure buffer, so frame N+1 is always relative to frame N as
 * the client received it — dropped intermediate snapshots cannot desync.
 */
export const SnapshotInitEventSchema = Schema.Struct({
  _tag: Schema.Literal('init'),
  snapshot: WebSnapshotSchema,
})

export const SnapshotDeltaEventSchema = Schema.Struct({
  _tag: Schema.Literal('delta'),
  meta: SnapshotMetaSchema,
  upserts: Schema.Array(AccountUpsertSchema),
})

export const SnapshotEventSchema = Schema.Union([
  SnapshotInitEventSchema,
  SnapshotDeltaEventSchema,
])

export type SnapshotMetaWire = typeof SnapshotMetaSchema.Type
export type AccountUpsertWire = typeof AccountUpsertSchema.Type
export type SnapshotEventWire = typeof SnapshotEventSchema.Type

const EmptyPayloadSchema = Schema.Struct({})
const ReadFailurePayloadFields = {
  // The payload opt-in keeps failures request-local for clients whose older
  // contract can only decode defects. New clients send this additive key;
  // old daemons ignore it and old clients retain the previous wire shape.
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
}

export const GetConfigRpc = Rpc.make(TOKMON_WS_METHODS.getConfig, {
  payload: Schema.Struct(ReadFailurePayloadFields),
  success: ConfigStateSchema,
  error: ConfigReadFailureSchema,
})

export const SetConfigRpc = Rpc.make(TOKMON_WS_METHODS.setConfig, {
  payload: ConfigUpdateRequestSchema,
  success: ConfigStateSchema,
  error: Schema.Union([ConfigUpdateConflictSchema, ConfigPersistenceFailureSchema]),
})

export const RefreshRpc = Rpc.make(TOKMON_WS_METHODS.refresh, {
  payload: Schema.Struct({ scope: RefreshScopeSchema }),
  success: Schema.Void,
  error: RefreshFailure,
})

export const SessionUsageRpc = Rpc.make(TOKMON_WS_METHODS.sessionUsage, {
  payload: SessionUsageRequestSchema,
  success: WebSnapshotSchema,
  error: SessionUsageFailure,
})

export const BrowseFsRpc = Rpc.make(TOKMON_WS_METHODS.browseFs, {
  payload: Schema.Struct({ path: Schema.String, ...ReadFailurePayloadFields }),
  success: FsListingSchema,
  error: BrowseFsFailureSchema,
})

export const SnapshotRpc = Rpc.make(TOKMON_WS_METHODS.snapshot, {
  payload: EmptyPayloadSchema,
  success: SnapshotEventSchema,
  stream: true,
})

export const ConfigRpc = Rpc.make(TOKMON_WS_METHODS.config, {
  payload: EmptyPayloadSchema,
  success: ConfigStateSchema,
  stream: true,
})

export const TokmonRpcGroup = RpcGroup.make(
  GetConfigRpc,
  SetConfigRpc,
  RefreshRpc,
  SessionUsageRpc,
  BrowseFsRpc,
  SnapshotRpc,
  ConfigRpc,
)
