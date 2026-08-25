import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { type Config, type DetectedAccountRef, expandHome, slugify } from './config'
import { PROVIDER_ORDER, PROVIDERS } from './providers'
import { readClaudeIdentity } from './providers/claude/identity'
import { isClaudeSessionFile } from './providers/claude/usage'
import { codexAuthPaths, readCodexIdentity } from './providers/codex/identity'
import type { Account, ProviderId } from './providers/types'

interface DiscoveredAccount {
  id: string
  providerId: ProviderId
  name: string
  color: string
  homeDir?: string
  source: 'auto'
}

function accountHomeKey(providerId: ProviderId, homeDir?: string): string {
  return `${providerId}:${homeDir ? resolve(expandHome(homeDir)) : homedir()}`
}

function accountKey(providerId: ProviderId, homeDir?: string, quotaSource?: Account['quotaSource']): string {
  const source = quotaSource ? `${quotaSource.url}\0${quotaSource.apiKeyEnv}` : 'provider'
  return `${accountHomeKey(providerId, homeDir)}:${source}`
}

function runtimeHomeDir(homeDir: string): string | undefined {
  const expanded = resolve(expandHome(homeDir))
  return expanded === resolve(homedir()) ? undefined : expanded
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Stable across ordering/config collisions so cache and active-account references do not drift. */
function discoveredId(providerId: ProviderId, homeDir: string): string {
  const label = slugify(basename(homeDir).replace(new RegExp(`^\\.${providerId}[_-]?`), '')) || 'account'
  return `${providerId}_${label}_${stableHash(resolve(homeDir))}`
}

// Synchronous on purpose: buildAccounts is called from a React useMemo in the
// TUI, so this shares detectClaude's predicate but not its async walker.
function containsClaudeSession(root: string): boolean {
  if (!existsSync(root)) return false
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isFile() && isClaudeSessionFile(entry.name)) return true
        if (entry.isDirectory()) pending.push(join(current, entry.name))
      }
    } catch {}
  }
  return false
}

function hasClaudeState(homeDir: string): boolean {
  return existsSync(join(homeDir, '.claude', '.credentials.json'))
    || existsSync(join(homeDir, '.config', 'claude', '.credentials.json'))
    || containsClaudeSession(join(homeDir, '.claude', 'projects'))
    || containsClaudeSession(join(homeDir, '.config', 'claude', 'projects'))
}

function candidateAlternateHomes(prefix: string): string[] {
  const home = homedir()
  let entries: string[]
  try {
    entries = readdirSync(home)
  } catch {
    return []
  }
  const out: string[] = []
  const pattern = new RegExp(`^\\.${prefix}[_-]`)
  for (const name of entries) {
    if (!pattern.test(name)) continue
    const path = join(home, name)
    try {
      if (!statSync(path).isDirectory()) continue
      out.push(path)
    } catch {}
  }
  return out.sort()
}

function labelForClaudeHome(homeDir: string): string {
  const identity = readClaudeIdentity(homeDir)
  if (identity.email) return `Claude ${identity.email}`
  if (identity.displayName) return `Claude ${identity.displayName}`
  const raw = basename(homeDir).replace(/^\.claude[_-]?/, '').replace(/[_-]+/g, ' ').trim()
  return raw ? `Claude ${raw}` : 'Claude'
}

function hasCodexAuth(homeDir: string): boolean {
  for (const path of codexAuthPaths(homeDir)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      const accessToken = parsed?.tokens?.access_token
      if (typeof accessToken === 'string' && accessToken.trim()) return true
    } catch {}
  }
  return false
}

function labelForCodexHome(homeDir: string): string {
  const identity = readCodexIdentity(homeDir)
  if (identity.email) return `Codex ${identity.email}`
  if (identity.displayName) return `Codex ${identity.displayName}`
  const raw = basename(homeDir).replace(/^\.codex[_-]?/, '').replace(/[_-]+/g, ' ').trim()
  return raw ? `Codex ${raw}` : 'Codex'
}

function discoverClaudeAccounts(): DiscoveredAccount[] {
  const provider = PROVIDERS.claude
  const out: DiscoveredAccount[] = []
  for (const homeDir of candidateAlternateHomes('claude')) {
    if (!hasClaudeState(homeDir)) continue
    out.push({
      id: discoveredId('claude', homeDir),
      providerId: 'claude',
      name: labelForClaudeHome(homeDir),
      color: provider.color,
      homeDir,
      source: 'auto',
    })
  }
  return out
}

function discoverCodexAccounts(): DiscoveredAccount[] {
  const provider = PROVIDERS.codex
  const out: DiscoveredAccount[] = []
  for (const homeDir of candidateAlternateHomes('codex')) {
    if (!hasCodexAuth(homeDir)) continue
    out.push({
      id: discoveredId('codex', homeDir),
      providerId: 'codex',
      name: labelForCodexHome(homeDir),
      color: provider.color,
      homeDir,
      source: 'auto',
    })
  }
  return out
}

function discoverProviderAccounts(providerId: ProviderId): DiscoveredAccount[] {
  if (providerId === 'claude') return discoverClaudeAccounts()
  if (providerId === 'codex') return discoverCodexAccounts()
  return []
}

export interface CollectedAccounts {
  accounts: Account[]
  /**
   * Exclusions whose home was actually discovered this pass. An exclusion that
   * matches nothing is a tombstone for a home that has been renamed or deleted,
   * and cannot be restored into anything.
   */
  suppressed: DetectedAccountRef[]
}

/**
 * Resolves the tracked account set, reporting which exclusions did real work.
 * Single pass: liveness is only knowable while the candidates are in hand.
 */
export function collectAccounts(config: Config, detected: ProviderId[]): CollectedAccounts {
  const out: Account[] = []
  const seenKeys = new Set<string>()
  const seenIds = new Set<string>()
  const suppressed: DetectedAccountRef[] = []
  const suppressedKeys = new Set<string>()
  const excludedByKey = new Map(
    config.accountDetection.excludedAccounts.map(ref => [accountHomeKey(ref.providerId, ref.homeDir), ref] as const),
  )
  const excludedKeys = new Set(excludedByKey.keys())

  /** Records that this exclusion suppressed a candidate that really exists. */
  const noteSuppressed = (key: string): void => {
    const ref = excludedByKey.get(key)
    if (!ref || suppressedKeys.has(key)) return
    suppressedKeys.add(key)
    suppressed.push(ref)
  }

  const add = (account: Account): void => {
    const key = accountKey(account.providerId, account.homeDir, account.quotaSource)
    if (seenKeys.has(key)) return
    let id = account.id
    if (seenIds.has(id)) {
      const base = `${id}_auto`
      id = base
      for (let suffix = 2; seenIds.has(id); suffix++) id = `${base}_${suffix}`
    }
    seenKeys.add(key)
    seenIds.add(id)
    out.push(id === account.id ? account : { ...account, id })
  }

  for (const pid of PROVIDER_ORDER) {
    if (config.disabledProviders.includes(pid)) continue
    const provider = PROVIDERS[pid]
    const configured = config.accounts.filter(a => a.providerId === pid)
    const configuredHomes = new Set(configured.map(a => accountHomeKey(a.providerId, a.homeDir)))
    for (const a of configured) {
      if (a.enabled === false) {
        seenKeys.add(accountKey(a.providerId, a.homeDir, a.quotaSource ?? undefined))
        seenIds.add(a.id)
        continue
      }
      add({
        id: a.id,
        providerId: pid,
        name: a.name,
        color: a.color || provider.color,
        homeDir: runtimeHomeDir(a.homeDir || '~'),
        source: 'configured',
        quotaSource: a.quotaSource ?? undefined,
      })
    }

    if (!config.accountDetection.enabled || config.accountDetection.disabledProviders.includes(pid)) continue
    const discovered = discoverProviderAccounts(pid)
    if (detected.includes(pid)) {
      const account: Account = {
        id: pid, providerId: pid, name: provider.name, color: provider.color,
        homeDir: undefined, source: 'auto',
      }
      const homeKey = accountHomeKey(pid)
      const key = accountKey(pid)
      if (configuredHomes.has(homeKey)) continue
      if (excludedKeys.has(homeKey)) noteSuppressed(homeKey)
      else add(account)
    }
    for (const account of discovered) {
      const homeKey = accountHomeKey(account.providerId, account.homeDir)
      if (configuredHomes.has(homeKey)) continue
      if (excludedKeys.has(homeKey)) { noteSuppressed(homeKey); continue }
      add(account)
    }
  }
  return { accounts: out, suppressed }
}

export function buildAccounts(config: Config, detected: ProviderId[]): Account[] {
  return collectAccounts(config, detected).accounts
}

export function accountsByProvider(accounts: Account[]): { provider: ProviderId; accounts: Account[] }[] {
  const groups: { provider: ProviderId; accounts: Account[] }[] = []
  for (const pid of PROVIDER_ORDER) {
    const list = accounts.filter(a => a.providerId === pid)
    if (list.length > 0) groups.push({ provider: pid, accounts: list })
  }
  return groups
}
