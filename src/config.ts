import { chmod, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULTS, normalizeConfig, repairConfig, type Config, type Account } from './config-schema'

export type {
  Config, Account, QuotaSourceConfig, TrayConfig, MenuBarConfig, MenuBarMode, MenuBarDensity,
  MenuBarElement, MenuBarSpacingField,
  AccountDetectionConfig, DetectedAccountRef, DesktopGraphRange,
} from './config-schema'
export type { TrackedAccountRow, TrackedAccountSource } from './config-schema'
export {
  DEFAULTS,
  DEFAULT_TRAY_CONFIG,
  DEFAULT_MENU_BAR_CONFIG,
  DEFAULT_ACCOUNT_DETECTION_CONFIG,
  DESKTOP_GRAPH_RANGES,
  ACCENT_COLORS,
  PROVIDER_IDS,
  COLOR_PALETTE,
  PROVIDER_META,
  getTrackedAccountRows,
  providerDetectionEnabled,
  removedRowCopy,
  setProviderTrackingEnabled,
  setProviderDetectionEnabled,
  setDetectedAccountExcluded,
  MENU_BAR_SPACING_MAX_PT,
  setMenuBarElementVisibility,
  patchMenuBarPresentation,
  adjustMenuBarSpacing,
  setMenuBarValue,
  resetMenuBarPresentation,
  clampNum,
  normalizeConfig,
  repairConfig,
  repairMenuBarConfig,
  normalizeAllowedHost,
  normalizeAllowedHosts,
  normalizeQuotaSource,
  slugify,
  generateAccountId,
  pickAccentColor,
  sanitizeTyped,
  containsEmail,
  redactEmail,
  MAX_PINNED_PROVIDERS,
  cleanProviderSelection,
  toggleProviderSelection,
  moveProviderSelection,
} from './config-schema'

export function envDir(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() && isAbsolute(v.trim()) ? v.trim() : undefined
}

function configDir(): string {
  if (process.platform === 'win32') {
    return join(envDir('APPDATA') ?? join(homedir(), 'AppData', 'Roaming'), 'tokmon')
  }
  return join(envDir('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'tokmon')
}

export function configLocation(): string {
  return join(configDir(), 'config.json')
}

export function cacheDir(): string {
  if (process.platform === 'win32') {
    return join(envDir('LOCALAPPDATA') ?? envDir('APPDATA') ?? join(homedir(), 'AppData', 'Local'), 'tokmon', 'cache')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'tokmon')
  }
  return join(envDir('XDG_CACHE_HOME') ?? join(homedir(), '.cache'), 'tokmon')
}

export function snapshotCacheFile(): string {
  return join(cacheDir(), 'web-snapshot.json')
}

export async function loadConfig(): Promise<Config> {
  let raw: string
  try {
    raw = await readFile(configLocation(), 'utf-8')
  } catch {
    return { ...DEFAULTS }
  }
  // Tighten files created by older releases even when their contents need no
  // repair. Failure here must not make an otherwise readable config unusable.
  try {
    await chmod(configDir(), 0o700)
    await chmod(configLocation(), 0o600)
  } catch {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    try {
      const dir = configDir()
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      const backup = configLocation() + '.bak'
      await writeFile(backup, raw, { mode: 0o600 })
      await chmod(backup, 0o600)
    } catch {}
    return { ...DEFAULTS }
  }
  const repaired = repairConfig(parsed)
  const config = canonicalizeConfigHomeRefs(repaired.config)
  if (repaired.repaired || JSON.stringify(config) !== JSON.stringify(repaired.config)) {
    try { await saveConfig(config) } catch {}
  }
  return config
}

let saveQueue: Promise<void> = Promise.resolve()
let tempSequence = 0

function configTempFile(dir: string): string {
  tempSequence = (tempSequence + 1) % Number.MAX_SAFE_INTEGER
  return join(dir, `config.json.${process.pid}.${Date.now()}.${tempSequence}.tmp`)
}

function configJson(config: Config): string {
  return JSON.stringify(canonicalizeConfigHomeRefs(normalizeConfig(config)), null, 2) + '\n'
}

export function saveConfig(config: Config): Promise<void> {
  const write = async () => {
    const dir = configDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // mkdir does not tighten an already-existing directory.
    await chmod(dir, 0o700)
    const tmp = configTempFile(dir)
    try {
      await writeFile(tmp, configJson(config), { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, configLocation())
    } catch (error) {
      // Do not leave a readable partial config behind on a failed atomic write.
      try { await unlink(tmp) } catch {}
      throw error
    }
  }
  // A rejected write must reject its caller, but must not poison later saves.
  const operation = saveQueue.catch(() => undefined).then(write)
  saveQueue = operation
  return operation
}

export function saveConfigSync(config: Config): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const tmp = configTempFile(dir)
  try {
    writeFileSync(tmp, configJson(config), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, configLocation())
  } catch (error) {
    try { unlinkSync(tmp) } catch {}
    throw error
  }
}

export function expandHome(p: string): string {
  if (!p) return homedir()
  if (p === '~' || p === '~/' || p === '~\\') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** Persist the real user home with one portable spelling across accounts and exclusions. */
export function canonicalizeConfigHomeRefs(config: Config): Config {
  const defaultHome = resolve(homedir())
  const canonical = (value: string): string =>
    resolve(expandHome(value)) === defaultHome ? '~' : value
  return {
    ...config,
    accounts: config.accounts.map(account => ({
      ...account,
      homeDir: canonical(account.homeDir || '~'),
    })),
    accountDetection: {
      ...config.accountDetection,
      excludedAccounts: config.accountDetection.excludedAccounts.map(ref => ({
        ...ref,
        homeDir: canonical(ref.homeDir),
      })),
    },
  }
}

export function findAccount(config: Config, id: string | null): Account | null {
  if (!id) return null
  return config.accounts.find(a => a.id === id) ?? null
}
