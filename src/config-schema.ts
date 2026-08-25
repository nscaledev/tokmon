// Node-free module: no node:fs/os/path imports (required for Vite SPA build compatibility).

import { PROVIDER_IDS, type ProviderId } from './providers/types'
import { DEFAULT_APPEARANCE, repairAppearance, type AppearanceConfig } from './theme'

export { PROVIDER_IDS } from './providers/types'
export { PROVIDER_META, PROVIDER_ORDER } from './provider-meta'
export {
  getTrackedAccountRows,
  removedRowCopy,
  type TrackedAccountCandidate,
  type TrackedAccountRow,
  type TrackedAccountSource,
} from './tracked-accounts'

export interface Account {
  id: string
  providerId: ProviderId
  name: string
  homeDir: string
  color?: string
  /** Manual account intent. Omitted means enabled for backwards compatibility. */
  enabled?: boolean
  /** Optional API-key-authenticated provider quota endpoint. The key itself stays in the environment. */
  /** `null` is a transient RPC deletion marker; normalized persisted config omits it. */
  quotaSource?: QuotaSourceConfig | null
}

export interface QuotaSourceConfig {
  url: string
  apiKeyEnv: string
}

export type MenuBarMode = 'auto' | 'custom'
export type MenuBarDensity = 'comfortable' | 'compact' | 'tight'

export interface MenuBarConfig {
  version: 1
  mode: MenuBarMode
  elements: {
    providerMark: boolean
    value: boolean
    progress: boolean
  }
  density: MenuBarDensity
  customSpacing: {
    edgePaddingPt: number
    markValueGapPt: number
    providerGapPt: number
  }
}

export interface TrayConfig {
  enabled: boolean
  /** Builder-owned menu-bar presentation. `showMenuBarText` mirrors `elements.value`. */
  menuBar: MenuBarConfig
  showMenuBarText: boolean
  menuBarValue: 'usage' | 'todayTokens'
  displayMetric: 'smartHeadroom' | 'tightestRemaining'
  pollIntervalSec: number
  activeTimeoutMin: number
  /** Minutes an account remains recently active and eligible for promotion. */
  graceMin: number
  /** Minimum minutes a promoted account remains selected before another can replace it. */
  promotionHoldMin: number
  lowWatermarkPct: number
  criticalWatermarkPct: number
  /** @deprecated Superseded by `pinnedProviders`; migrated at read time. Retained for older daemons. */
  pinnedAccount: string | null
  /** @deprecated Account-scoped pins; migrated to `pinnedProviders` (account→provider) at read time. */
  pins: string[]
  /** Menu-bar pins: provider ids, max 2, order = menu-bar order. The source of truth. */
  pinnedProviders: string[]
  launchAtLogin: boolean
  theme: 'dark'
}

/** Desktop-only preferences the tray/popover persists via the daemon config (CAS). */
export const DESKTOP_GRAPH_RANGES = [7, 14, 30] as const
export type DesktopGraphRange = typeof DESKTOP_GRAPH_RANGES[number]

export interface DesktopConfig {
  /** Provider ids whose popover card is expanded; multi-open, order-insensitive. */
  expandedProviders: string[]
  /** Number of trailing calendar days shown in desktop usage sparklines. */
  graphRangeDays: DesktopGraphRange
}

export interface DetectedAccountRef {
  providerId: ProviderId
  /** Provider home used by the detector. `~` represents the provider's default home. */
  homeDir: string
}

/** Controls automatic account discovery without affecting explicitly configured accounts. */
export interface AccountDetectionConfig {
  enabled: boolean
  disabledProviders: ProviderId[]
  excludedAccounts: DetectedAccountRef[]
}

/** Clamp/dedupe/trim persisted pins to the invariant (≤2 non-empty, unique) shape. */
export function normalizePins(raw: unknown, legacy?: string | null): string[] {
  const source = Array.isArray(raw)
    ? raw
    : legacy && typeof legacy === 'string' && legacy.trim() ? [legacy] : []
  return normalizeStringIdList(source, 2)
}

/** Dedupe/trim an id list to the invariant (non-empty strings, unique, ≤max) shape. */
export function normalizeStringIdList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

export const MAX_PINNED_PROVIDERS = 2

/** Keep only selectable provider ids, preserving first-seen order. */
export function cleanProviderSelection(
  values: readonly string[],
  knownProviderIds: ReadonlySet<string>,
  max = Number.POSITIVE_INFINITY,
): string[] {
  return normalizeStringIdList(values.filter(value => knownProviderIds.has(value)), max)
}

/** Toggle one provider while enforcing membership, uniqueness, order, and cap. */
export function toggleProviderSelection(
  values: readonly string[],
  providerId: string,
  knownProviderIds: ReadonlySet<string>,
  max = Number.POSITIVE_INFINITY,
): string[] {
  const current = cleanProviderSelection(values, knownProviderIds, max)
  if (current.includes(providerId)) return current.filter(id => id !== providerId)
  if (!knownProviderIds.has(providerId) || current.length >= max) return current
  return [...current, providerId]
}

/** Move one selected provider without changing membership. */
export function moveProviderSelection(values: readonly string[], providerId: string, direction: -1 | 1): string[] {
  const next = [...values]
  const index = next.indexOf(providerId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}

export interface Config {
  /** Monotonically increasing, daemon-owned revision used for compare-and-set updates. */
  revision: number
  interval: number
  billingInterval: number
  clearScreen: boolean
  privacyMode: boolean
  privacyToggleKey: string
  timezone: string | null
  accounts: Account[]
  activeAccountId: string | null
  disabledProviders: ProviderId[]
  onboarded: boolean
  dashboardLayout: 'grid' | 'single'
  defaultFocus: 'all' | 'last'
  ascii: 'auto' | 'on' | 'off'
  /** Bind the dashboard to all interfaces instead of loopback on next daemon start. */
  allowNetworkAccess: boolean
  /** Exact DNS hostnames accepted by the dashboard when network access is enabled. */
  allowedHosts: string[]
  resetDisplay: 'relative' | 'absolute'
  knownProviders: ProviderId[]
  /** Shared graphical and terminal appearance, persisted atomically by the daemon. */
  appearance: AppearanceConfig
  accountDetection: AccountDetectionConfig
  tray: TrayConfig
  desktop: DesktopConfig
}

export interface ConfigRepair {
  config: Config
  repaired: boolean
  reasons: string[]
}

export const DEFAULT_MENU_BAR_CONFIG: MenuBarConfig = {
  version: 1,
  mode: 'auto',
  elements: {
    providerMark: true,
    value: true,
    progress: false,
  },
  density: 'comfortable',
  customSpacing: {
    edgePaddingPt: 1,
    markValueGapPt: 3,
    providerGapPt: 8,
  },
}

export const DEFAULT_TRAY_CONFIG: TrayConfig = {
  enabled: true,
  menuBar: DEFAULT_MENU_BAR_CONFIG,
  showMenuBarText: true,
  menuBarValue: 'usage',
  displayMetric: 'smartHeadroom',
  pollIntervalSec: 30,
  activeTimeoutMin: 10,
  graceMin: 30,
  promotionHoldMin: 5,
  lowWatermarkPct: 20,
  criticalWatermarkPct: 5,
  pinnedAccount: null,
  pins: [],
  pinnedProviders: [],
  launchAtLogin: false,
  theme: 'dark',
}

/** Bound the persisted expansion set to the known provider count with room to spare. */
const MAX_EXPANDED_PROVIDERS = 32

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  expandedProviders: [],
  graphRangeDays: 14,
}

export const DEFAULT_ACCOUNT_DETECTION_CONFIG: AccountDetectionConfig = {
  enabled: true,
  disabledProviders: [],
  excludedAccounts: [],
}

export const DEFAULTS: Config = {
  revision: 0,
  interval: 2,
  billingInterval: 5,
  clearScreen: true,
  privacyMode: true,
  privacyToggleKey: 'p',
  timezone: null,
  accounts: [],
  activeAccountId: null,
  disabledProviders: [],
  onboarded: false,
  dashboardLayout: 'grid',
  defaultFocus: 'all',
  ascii: 'auto',
  allowNetworkAccess: false,
  allowedHosts: [],
  resetDisplay: 'relative',
  knownProviders: [],
  appearance: { ...DEFAULT_APPEARANCE },
  accountDetection: { ...DEFAULT_ACCOUNT_DETECTION_CONFIG },
  tray: { ...DEFAULT_TRAY_CONFIG },
  desktop: { ...DEFAULT_DESKTOP_CONFIG },
}

const LEGACY_KNOWN: ProviderId[] = ['claude', 'codex', 'cursor']

export const ACCENT_COLORS = ['cyan', 'magenta', 'green', 'yellow', 'blue', 'red'] as const

export const COLOR_PALETTE = [
  'cyan', 'magenta', 'green', 'yellow', 'blue', 'red',
  'cyanBright', 'magentaBright', 'greenBright',
] as const

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const EMAIL_RE_GLOBAL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

export function containsEmail(value: string | null | undefined): boolean {
  return typeof value === 'string' && EMAIL_RE.test(value)
}

export function redactEmail(value: string): string {
  return value.replace(EMAIL_RE_GLOBAL, '[redacted]')
}

export function providerDetectionEnabled(config: AccountDetectionConfig, providerId: ProviderId): boolean {
  return config.enabled && !config.disabledProviders.includes(providerId)
}

/**
 * Enable or disable all tracking for one provider without discarding any of
 * its account, desktop, menu-bar, or discovery preferences.
 */
export function setProviderTrackingEnabled(
  config: Config,
  providerId: ProviderId,
  enabled: boolean,
): Config {
  const disabledProviders = config.disabledProviders.filter(id => id !== providerId)
  return {
    ...config,
    knownProviders: config.knownProviders.includes(providerId)
      ? config.knownProviders
      : [...config.knownProviders, providerId],
    disabledProviders: enabled ? disabledProviders : [...disabledProviders, providerId],
  }
}

export function setProviderDetectionEnabled(
  config: AccountDetectionConfig,
  providerId: ProviderId,
  enabled: boolean,
): AccountDetectionConfig {
  const without = config.disabledProviders.filter(id => id !== providerId)
  return {
    ...config,
    disabledProviders: enabled ? without : [...without, providerId],
  }
}

export function setDetectedAccountExcluded(
  config: AccountDetectionConfig,
  ref: DetectedAccountRef,
  excluded: boolean,
): AccountDetectionConfig {
  const homeDir = ref.homeDir.trim() || '~'
  const matches = (candidate: DetectedAccountRef) =>
    candidate.providerId === ref.providerId && candidate.homeDir === homeDir
  const without = config.excludedAccounts.filter(candidate => !matches(candidate))
  return {
    ...config,
    excludedAccounts: excluded ? [...without, { providerId: ref.providerId, homeDir }] : without,
  }
}

export type MenuBarElement = keyof MenuBarConfig['elements']
export type MenuBarSpacingField = keyof MenuBarConfig['customSpacing']

/** Upper bound in points for each custom spacing value; steps are half points. */
export const MENU_BAR_SPACING_MAX_PT: Record<MenuBarSpacingField, number> = {
  edgePaddingPt: 6,
  markValueGapPt: 8,
  providerGapPt: 16,
}

/**
 * Show or hide one menu-bar element. Hiding the last visible one is refused so
 * the strip never renders empty, and `showMenuBarText` keeps mirroring
 * `elements.value` for older desktop and CLI clients.
 */
export function setMenuBarElementVisibility(config: Config, element: MenuBarElement, visible: boolean): Config {
  const elements = config.tray.menuBar.elements
  if (!visible && elements[element] && Object.values(elements).filter(Boolean).length === 1) return config
  const nextElements = { ...elements, [element]: visible }
  return {
    ...config,
    tray: {
      ...config.tray,
      menuBar: { ...config.tray.menuBar, elements: nextElements },
      showMenuBarText: nextElements.value,
    },
  }
}

export function patchMenuBarPresentation(
  config: Config,
  patch: Partial<Omit<MenuBarConfig, 'elements' | 'customSpacing'>> & {
    elements?: Partial<MenuBarConfig['elements']>
    customSpacing?: Partial<MenuBarConfig['customSpacing']>
  },
): Config {
  return {
    ...config,
    tray: {
      ...config.tray,
      menuBar: {
        ...config.tray.menuBar,
        ...patch,
        elements: { ...config.tray.menuBar.elements, ...patch.elements },
        customSpacing: { ...config.tray.menuBar.customSpacing, ...patch.customSpacing },
      },
    },
  }
}

/** Nudge one spacing value by a half point; spacing only applies to the custom layout. */
export function adjustMenuBarSpacing(config: Config, field: MenuBarSpacingField, direction: -1 | 1): Config {
  const current = config.tray.menuBar.customSpacing[field]
  const stepped = Math.round((current + direction * 0.5) * 2) / 2
  const value = Math.min(MENU_BAR_SPACING_MAX_PT[field], Math.max(0, stepped))
  return patchMenuBarPresentation(config, { mode: 'custom', customSpacing: { [field]: value } })
}

export function setMenuBarValue(config: Config, menuBarValue: TrayConfig['menuBarValue']): Config {
  return { ...config, tray: { ...config.tray, menuBarValue } }
}

/** Restore the shipped presentation while leaving pins and the value choice alone. */
export function resetMenuBarPresentation(config: Config): Config {
  return {
    ...config,
    tray: {
      ...config.tray,
      menuBar: {
        ...DEFAULT_MENU_BAR_CONFIG,
        elements: { ...DEFAULT_MENU_BAR_CONFIG.elements },
        customSpacing: { ...DEFAULT_MENU_BAR_CONFIG.customSpacing },
      },
      showMenuBarText: DEFAULT_MENU_BAR_CONFIG.elements.value,
    },
  }
}

export function clampNum(v: unknown, fallback: number, min: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback
}

function finiteInRange(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback
}

function halfPointInRange(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v * 2) / 2))
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validProvider(value: unknown): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId)
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** Normalize the additive menu-bar builder block, migrating the legacy value toggle when absent. */
export function repairMenuBarConfig(
  input: unknown,
  legacyShowMenuBarText = DEFAULT_TRAY_CONFIG.showMenuBarText,
): MenuBarConfig {
  if (!isRecord(input)) {
    return {
      ...DEFAULT_MENU_BAR_CONFIG,
      elements: {
        ...DEFAULT_MENU_BAR_CONFIG.elements,
        value: legacyShowMenuBarText,
      },
      customSpacing: { ...DEFAULT_MENU_BAR_CONFIG.customSpacing },
    }
  }

  const elements = isRecord(input.elements) ? input.elements : {}
  const spacing = isRecord(input.customSpacing) ? input.customSpacing : {}
  return {
    version: 1,
    mode: input.mode === 'custom' ? 'custom' : 'auto',
    elements: {
      providerMark: typeof elements.providerMark === 'boolean'
        ? elements.providerMark
        : DEFAULT_MENU_BAR_CONFIG.elements.providerMark,
      value: typeof elements.value === 'boolean'
        ? elements.value
        : DEFAULT_MENU_BAR_CONFIG.elements.value,
      progress: typeof elements.progress === 'boolean'
        ? elements.progress
        : DEFAULT_MENU_BAR_CONFIG.elements.progress,
    },
    density: input.density === 'compact' || input.density === 'tight'
      ? input.density
      : DEFAULT_MENU_BAR_CONFIG.density,
    customSpacing: {
      edgePaddingPt: halfPointInRange(
        spacing.edgePaddingPt,
        DEFAULT_MENU_BAR_CONFIG.customSpacing.edgePaddingPt,
        0,
        MENU_BAR_SPACING_MAX_PT.edgePaddingPt,
      ),
      markValueGapPt: halfPointInRange(
        spacing.markValueGapPt,
        DEFAULT_MENU_BAR_CONFIG.customSpacing.markValueGapPt,
        0,
        MENU_BAR_SPACING_MAX_PT.markValueGapPt,
      ),
      providerGapPt: halfPointInRange(
        spacing.providerGapPt,
        DEFAULT_MENU_BAR_CONFIG.customSpacing.providerGapPt,
        0,
        MENU_BAR_SPACING_MAX_PT.providerGapPt,
      ),
    },
  }
}

/** Canonicalize one exact DNS hostname. Schemes, ports, paths, and wildcards are rejected. */
export function normalizeAllowedHost(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (!candidate) return null
  try {
    const url = new URL(`http://${candidate}`)
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!hostname || hostname.length > 253 || hostname.includes('*')) return null
    const labels = hostname.split('.')
    if (labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null
    return hostname
  } catch {
    return null
  }
}

export function normalizeAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts = value.map(normalizeAllowedHost).filter((host): host is string => host !== null)
  return [...new Set(hosts)]
}

const API_KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

export function normalizeQuotaSource(value: unknown, providerId: ProviderId): QuotaSourceConfig | null {
  if ((providerId !== 'claude' && providerId !== 'codex') || !isRecord(value)) return null
  if (typeof value.url !== 'string' || typeof value.apiKeyEnv !== 'string') return null
  const apiKeyEnv = value.apiKeyEnv.trim()
  if (!API_KEY_ENV_RE.test(apiKeyEnv)) return null
  try {
    const url = new URL(value.url.trim())
    const expectedPath = providerId === 'claude' ? '/api/oauth/usage' : '/backend-api/wham/usage'
    if (url.pathname !== expectedPath || url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHostname(url.hostname))) return null
    return { url: url.toString(), apiKeyEnv }
  } catch {
    return null
  }
}

export function repairConfig(input: unknown): ConfigRepair {
  const reasons: string[] = []
  const parsed = isRecord(input) ? input : {}
  if (parsed !== input) reasons.push('config root was not an object')

  const rawAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
  if (!Array.isArray(parsed.accounts) && parsed.accounts !== undefined) reasons.push('accounts was not an array')
  const accounts: Account[] = []
  const accountIds = new Set<string>()
  rawAccounts.forEach((raw, index) => {
    if (!isRecord(raw)) {
      reasons.push(`accounts[${index}] was not an object`)
      return
    }
    const providerId = raw.providerId ?? 'claude'
    if (!validProvider(providerId)) {
      reasons.push(`accounts[${index}].providerId was invalid`)
      return
    }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : ''
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : ''
    if (!id || !name) {
      reasons.push(`accounts[${index}] was missing id or name`)
      return
    }
    if (accountIds.has(id)) {
      reasons.push(`accounts[${index}].id was duplicated`)
      return
    }
    accountIds.add(id)
    const quotaSource = normalizeQuotaSource(raw.quotaSource, providerId)
    if (raw.quotaSource !== undefined && quotaSource === null) reasons.push(`accounts[${index}].quotaSource was invalid`)
    accounts.push({
      id,
      providerId,
      name,
      homeDir: typeof raw.homeDir === 'string' && raw.homeDir.trim() ? raw.homeDir : '~',
      ...(typeof raw.color === 'string' && raw.color.trim() ? { color: raw.color } : {}),
      // An explicit `true` has to survive: the daemon re-applies a sticky disable to any
      // account that arrives without the key (web/config-control.ts), so dropping it here
      // turned "enable this account" into a no-op for callers that normalize before writing.
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      ...(quotaSource ? { quotaSource } : {}),
    })
  })

  const disabledProviders = (Array.isArray(parsed.disabledProviders) ? parsed.disabledProviders : [])
    .filter(validProvider)
  if (parsed.disabledProviders !== undefined && !Array.isArray(parsed.disabledProviders)) {
    reasons.push('disabledProviders was not an array')
  }

  const knownProviders = Array.isArray(parsed.knownProviders)
    ? parsed.knownProviders.filter(validProvider)
    : (parsed.onboarded === true ? [...LEGACY_KNOWN] : [])
  if (parsed.knownProviders !== undefined && !Array.isArray(parsed.knownProviders)) {
    reasons.push('knownProviders was not an array')
  }

  const allowedHosts = normalizeAllowedHosts(parsed.allowedHosts)
  if (parsed.allowedHosts !== undefined && !sameJson(parsed.allowedHosts, allowedHosts)) {
    reasons.push('allowedHosts contained invalid or duplicate hostnames')
  }

  const appearanceRepair = repairAppearance(parsed.appearance)
  if (parsed.appearance !== undefined && appearanceRepair.repaired) {
    reasons.push(...appearanceRepair.reasons)
  }
  const rawAccountDetection = isRecord(parsed.accountDetection) ? parsed.accountDetection : {}
  if (parsed.accountDetection !== undefined && !isRecord(parsed.accountDetection)) {
    reasons.push('accountDetection was not an object')
  }
  const detectionDisabledProviders = Array.isArray(rawAccountDetection.disabledProviders)
    ? [...new Set(rawAccountDetection.disabledProviders.filter(validProvider))]
    : []
  const excludedAccounts: DetectedAccountRef[] = []
  const excludedKeys = new Set<string>()
  if (Array.isArray(rawAccountDetection.excludedAccounts)) {
    rawAccountDetection.excludedAccounts.forEach((raw, index) => {
      if (!isRecord(raw) || !validProvider(raw.providerId) || typeof raw.homeDir !== 'string' || !raw.homeDir.trim()) {
        reasons.push(`accountDetection.excludedAccounts[${index}] was invalid`)
        return
      }
      const homeDir = raw.homeDir.trim()
      const key = `${raw.providerId}:${homeDir}`
      if (excludedKeys.has(key)) return
      excludedKeys.add(key)
      excludedAccounts.push({ providerId: raw.providerId, homeDir })
    })
  } else if (rawAccountDetection.excludedAccounts !== undefined) {
    reasons.push('accountDetection.excludedAccounts was not an array')
  }
  const accountDetection: AccountDetectionConfig = {
    enabled: typeof rawAccountDetection.enabled === 'boolean'
      ? rawAccountDetection.enabled
      : DEFAULT_ACCOUNT_DETECTION_CONFIG.enabled,
    disabledProviders: detectionDisabledProviders,
    excludedAccounts,
  }
  if (parsed.accountDetection !== undefined && !sameJson(parsed.accountDetection, accountDetection)) {
    reasons.push('accountDetection contained invalid settings')
  }

  const rawTray = isRecord(parsed.tray) ? parsed.tray : {}
  if (parsed.tray !== undefined && !isRecord(parsed.tray)) reasons.push('tray was not an object')
  const legacyShowMenuBarText = typeof rawTray.showMenuBarText === 'boolean'
    ? rawTray.showMenuBarText
    : DEFAULT_TRAY_CONFIG.showMenuBarText
  const menuBar = repairMenuBarConfig(rawTray.menuBar, legacyShowMenuBarText)
  const tray: TrayConfig = {
    enabled: typeof rawTray.enabled === 'boolean' ? rawTray.enabled : DEFAULT_TRAY_CONFIG.enabled,
    menuBar,
    // Keep the legacy field canonical for older desktop and CLI clients.
    showMenuBarText: menuBar.elements.value,
    menuBarValue: rawTray.menuBarValue === 'todayTokens' || rawTray.menuBarValue === 'usage'
      ? rawTray.menuBarValue
      : DEFAULT_TRAY_CONFIG.menuBarValue,
    displayMetric: rawTray.displayMetric === 'tightestRemaining' || rawTray.displayMetric === 'smartHeadroom'
      ? rawTray.displayMetric
      : DEFAULT_TRAY_CONFIG.displayMetric,
    pollIntervalSec: finiteInRange(rawTray.pollIntervalSec, DEFAULT_TRAY_CONFIG.pollIntervalSec, 1, 86_400),
    activeTimeoutMin: finiteInRange(rawTray.activeTimeoutMin, DEFAULT_TRAY_CONFIG.activeTimeoutMin, 1, 1_440),
    graceMin: finiteInRange(rawTray.graceMin, DEFAULT_TRAY_CONFIG.graceMin, 1, 10_080),
    promotionHoldMin: finiteInRange(rawTray.promotionHoldMin, DEFAULT_TRAY_CONFIG.promotionHoldMin, 0, 1_440),
    lowWatermarkPct: finiteInRange(rawTray.lowWatermarkPct, DEFAULT_TRAY_CONFIG.lowWatermarkPct, 0, 100),
    criticalWatermarkPct: finiteInRange(rawTray.criticalWatermarkPct, DEFAULT_TRAY_CONFIG.criticalWatermarkPct, 0, 100),
    pinnedAccount: typeof rawTray.pinnedAccount === 'string' && rawTray.pinnedAccount.trim()
      ? rawTray.pinnedAccount.trim()
      : null,
    pins: normalizePins(rawTray.pins, typeof rawTray.pinnedAccount === 'string' ? rawTray.pinnedAccount : null),
    // Provider-scoped pins are the source of truth. The account→provider migration
    // needs the live snapshot, so it happens in the renderer; here we only enforce
    // the persisted invariant (unique non-empty strings, ≤2, order preserved).
    pinnedProviders: normalizeStringIdList(rawTray.pinnedProviders, MAX_PINNED_PROVIDERS),
    launchAtLogin: typeof rawTray.launchAtLogin === 'boolean'
      ? rawTray.launchAtLogin
      : DEFAULT_TRAY_CONFIG.launchAtLogin,
    theme: rawTray.theme === 'dark' ? rawTray.theme : DEFAULT_TRAY_CONFIG.theme,
  }
  if (tray.graceMin < tray.activeTimeoutMin) {
    tray.graceMin = Math.max(DEFAULT_TRAY_CONFIG.graceMin, tray.activeTimeoutMin)
  }
  if (tray.criticalWatermarkPct > tray.lowWatermarkPct) {
    tray.criticalWatermarkPct = Math.min(DEFAULT_TRAY_CONFIG.criticalWatermarkPct, tray.lowWatermarkPct)
  }
  if (parsed.tray !== undefined && !sameJson(parsed.tray, tray)) reasons.push('tray contained invalid settings')

  const rawDesktop = isRecord(parsed.desktop) ? parsed.desktop : {}
  if (parsed.desktop !== undefined && !isRecord(parsed.desktop)) reasons.push('desktop was not an object')
  const desktop: DesktopConfig = {
    expandedProviders: normalizeStringIdList(rawDesktop.expandedProviders, MAX_EXPANDED_PROVIDERS),
    graphRangeDays: DESKTOP_GRAPH_RANGES.includes(rawDesktop.graphRangeDays as DesktopGraphRange)
      ? rawDesktop.graphRangeDays as DesktopGraphRange
      : DEFAULT_DESKTOP_CONFIG.graphRangeDays,
  }
  if (parsed.desktop !== undefined && !sameJson(parsed.desktop, desktop)) reasons.push('desktop contained invalid settings')

  // Auto-discovered ids are daemon-owned and are not persisted in `accounts`.
  // Preserve any non-empty selection so alternate homes remain selectable.
  const activeAccountId = typeof parsed.activeAccountId === 'string' && parsed.activeAccountId.trim()
    ? parsed.activeAccountId.trim()
    : null
  if (parsed.activeAccountId !== undefined && parsed.activeAccountId !== null && activeAccountId === null) {
    reasons.push('activeAccountId did not match a known account/provider')
  }

  const timezone = typeof parsed.timezone === 'string' && parsed.timezone.trim() && isValidTimezone(parsed.timezone.trim())
    ? parsed.timezone.trim()
    : null
  if (parsed.timezone !== undefined && parsed.timezone !== null && timezone === null) {
    reasons.push('timezone was invalid')
  }

  const config: Config = {
    ...DEFAULTS,
    revision: typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0
      ? parsed.revision
      : DEFAULTS.revision,
    interval: clampNum(parsed.interval, DEFAULTS.interval, 1),
    billingInterval: clampNum(parsed.billingInterval, DEFAULTS.billingInterval, 1),
    clearScreen: typeof parsed.clearScreen === 'boolean' ? parsed.clearScreen : DEFAULTS.clearScreen,
    privacyMode: typeof parsed.privacyMode === 'boolean' ? parsed.privacyMode : DEFAULTS.privacyMode,
    privacyToggleKey: typeof parsed.privacyToggleKey === 'string' && parsed.privacyToggleKey.length === 1
      ? parsed.privacyToggleKey
      : DEFAULTS.privacyToggleKey,
    timezone,
    accounts,
    activeAccountId,
    disabledProviders,
    onboarded: parsed.onboarded === true,
    dashboardLayout: parsed.dashboardLayout === 'single' ? 'single' : 'grid',
    defaultFocus: parsed.defaultFocus === 'last' ? 'last' : 'all',
    ascii: parsed.ascii === 'on' ? 'on' : parsed.ascii === 'off' ? 'off' : 'auto',
    allowNetworkAccess: parsed.allowNetworkAccess === true,
    allowedHosts,
    resetDisplay: parsed.resetDisplay === 'absolute' ? 'absolute' : 'relative',
    knownProviders,
    appearance: appearanceRepair.appearance,
    accountDetection,
    tray,
    desktop,
  }

  for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
    if (!(key in parsed)) reasons.push(`missing ${key}`)
  }

  return { config, repaired: reasons.length > 0 || !sameJson(parsed, config), reasons }
}

export function normalizeConfig(parsed: unknown): Config {
  try {
    return repairConfig(parsed).config
  } catch {
    return {
      ...DEFAULTS,
      appearance: { ...DEFAULT_APPEARANCE },
      accountDetection: { ...DEFAULT_ACCOUNT_DETECTION_CONFIG },
      tray: { ...DEFAULT_TRAY_CONFIG },
      desktop: { ...DEFAULT_DESKTOP_CONFIG },
    }
  }
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
}

export function generateAccountId(name: string, existing: Account[]): string {
  const base = slugify(name) || 'account'
  const taken = new Set(existing.map(a => a.id))
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}_${Date.now()}`
}

export function pickAccentColor(existing: Account[]): string {
  const used = new Set(existing.map(a => a.color).filter(Boolean))
  for (const c of ACCENT_COLORS) {
    if (!used.has(c)) return c
  }
  return ACCENT_COLORS[existing.length % ACCENT_COLORS.length]
}

export function sanitizeTyped(input: string): string {
  if (!input) return ''
  return input
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1bO./g, '')
    .replace(/\x1b/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/\[20[01]~/g, '')
}
