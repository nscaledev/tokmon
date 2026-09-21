import type { DashboardData, TableData } from '../types'
import type { BillingResult, ProviderId } from '../providers/types'
import type { DetectedAccountRef } from '../config-schema'
import type { AccountIdentityView, HeadroomView, QuotaView } from '../usage-semantics'

export type {
  DashboardData,
  TableData,
  TableRow,
  ModelDetail,
  UsageSummary,
} from '../types'
export type {
  BillingResult,
  Metric,
  MetricFormat,
  ProviderId,
} from '../providers/types'
export type { AccountIdentityView, HeadroomFactor, HeadroomView, MetricRole, QuotaView } from '../usage-semantics'
export { usageFromHeadroom } from '../usage-semantics'
export type { Severity } from '../usage-semantics'
export { severity, severityTag, percentText, accountIdentityText, accountProviderOrdinals, projectAccountIdentity } from '../usage-semantics'
export { MONTHS } from '../shared/format'
export { dayKey, mondayDayIndex, systemTimezone, weekStartDayKey } from '../tz'

export type {
  Config, Account, QuotaSourceConfig, TrayConfig, MenuBarConfig, MenuBarMode, MenuBarDensity,
  MenuBarElement, MenuBarSpacingField,
  AccountDetectionConfig, DetectedAccountRef, DesktopGraphRange,
  TrackedAccountRow, TrackedAccountSource,
} from '../config-schema'
export type { TrackedAccountCandidate } from '../config-schema'
export {
  normalizeConfig,
  normalizeAllowedHost,
  normalizeAllowedHosts,
  normalizeQuotaSource,
  repairConfig,
  repairMenuBarConfig,
  DEFAULTS,
  DEFAULT_TRAY_CONFIG,
  DEFAULT_MENU_BAR_CONFIG,
  DEFAULT_ACCOUNT_DETECTION_CONFIG,
  DESKTOP_GRAPH_RANGES,
  generateAccountId,
  pickAccentColor,
  isValidTimezone,
  COLOR_PALETTE,
  PROVIDER_META,
  PROVIDER_ORDER,
  getTrackedAccountRows,
  removedRowCopy,
  providerDetectionEnabled,
  setProviderTrackingEnabled,
  setProviderDetectionEnabled,
  setDetectedAccountExcluded,
  MENU_BAR_SPACING_MAX_PT,
  setMenuBarElementVisibility,
  patchMenuBarPresentation,
  adjustMenuBarSpacing,
  setMenuBarValue,
  resetMenuBarPresentation,
  sanitizeTyped,
  containsEmail,
  redactEmail,
  MAX_PINNED_PROVIDERS,
  cleanProviderSelection,
  toggleProviderSelection,
  moveProviderSelection,
} from '../config-schema'
export { describeConfigUpdateFailure, reconcileSettingsDraft } from '../config-sync'
export { TOKMON_PROTOCOL_VERSION } from '../rpc/contract'
export type { ConfigState } from '../rpc/contract'
export type { PrivacyShortcutEvent } from '../privacy-shortcut'
export { matchesPrivacyShortcut } from '../privacy-shortcut'
export type {
  AppearanceConfig,
  AppearanceMode,
  BuiltInThemePreset,
  ThemePreset,
  ThemePresetOption,
  EditableThemeTokens,
  ResolvedThemeTokens,
  TerminalThemePolicy,
} from '../theme'
export {
  BUILT_IN_THEME_PRESET_IDS,
  DEFAULT_APPEARANCE,
  IMPORTED_THEME_CATALOG,
  IMPORTED_THEME_IDS,
  THEME_PRESET_IDS,
  THEME_PRESET_OPTIONS,
  isBuiltInThemePreset,
  isDarkOnlyThemePreset,
  isThemePreset,
  themePresetOption,
  resolveTheme,
  resolveTerminalTheme,
  repairAppearance,
  normalizeAppearance,
  normalizeHexColor,
  relativeLuminance,
  contrastRatio,
  validateThemeContrast,
} from '../theme'

export type AccountFetchState = 'pending' | 'ready' | 'error'

export interface PeakStatus {
  state: 'peak' | 'off-peak' | 'weekend'
  label: string
  minutesUntilChange: number | null
  changesAt?: string | null
}

export interface WebAccount {
  id: string
  providerId: ProviderId
  name: string
  color: string
  homeDir: string | null
  /** Daemon-owned provenance for account lifecycle actions. Optional for cached/older snapshots. */
  source?: 'auto' | 'configured'
  hasUsage: boolean
  hasBilling: boolean
  email?: string | null
  displayName?: string | null
  /** Daemon-produced render contract. Optional for cached/older snapshots. */
  identity?: AccountIdentityView
  quotas?: QuotaView[]
  headroom?: HeadroomView
  plan?: string | null
  /** Newest real usage event for this account, as Unix milliseconds. */
  lastActivityAt: number | null
  dashboard: DashboardData | null
  table: TableData | null
  billing: BillingResult | null
  summaryState: AccountFetchState
  billingState: AccountFetchState
  tableState: AccountFetchState
  tableError?: string
  summaryUpdatedAt: number | null
  billingUpdatedAt: number | null
  tableUpdatedAt: number | null
}

export interface WebProviderInfo {
  id: ProviderId
  name: string
  color: string
  headroom?: HeadroomView
}

export interface WebSnapshot {
  /** Present only on an explicitly session-scoped query, never on account snapshots. */
  sessionId?: string
  version: string
  generatedAt: number
  tz: string
  intervalMs: number
  /** Optional only for snapshots from daemons predating the split billing cadence. */
  billingIntervalMs?: number
  /** Installed harnesses are separate from reconciled runtime accounts. */
  installedProviders?: readonly ProviderId[]
  providers: WebProviderInfo[]
  accounts: WebAccount[]
  /**
   * Exclusions whose home was still discovered on this pass. Absent on daemons
   * predating the field, in which case clients cannot tell a live suppression
   * from a tombstone and must treat every removed row as restorable.
   */
  suppressedAccounts?: readonly DetectedAccountRef[]
  seeded: boolean
  peak: PeakStatus | null
}
