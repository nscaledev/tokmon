import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readJson } from '../../http'
import { expandHome } from '../../config'
import type { Account, BillingResult, Metric } from '../types'
import { identityFields } from '../_shared/identity'
import { finite, numberValue, percentMetric } from '../_shared/metric'
import { epochMilliseconds, msToIso } from '../_shared/time'
import { readMacKeychainFileRaw, readMacKeychainRaw } from '../_shared/keychain'
import { readClaudeIdentity } from './identity'
import { claudeConfigDirs } from './usage'
import { fetchQuotaSource } from '../_shared/quota-source'

interface UsageWindow {
  utilization?: unknown
  resets_at?: unknown
}

interface OAuthLimit {
  kind?: unknown
  group?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: {
    model?: {
      id?: unknown
      display_name?: unknown
    } | null
    surface?: unknown
  } | null
  severity?: unknown
  is_active?: unknown
}

interface OAuthResponse {
  limits?: OAuthLimit[] | null
  extra_usage?: {
    is_enabled?: unknown
    monthly_limit?: unknown
    used_credits?: unknown
    decimal_places?: unknown
    currency?: string | null
  } | null
  spend?: unknown
  [key: string]: unknown
}

interface ClaudeAuth {
  token: string
  subscriptionType?: string
  rateLimitTier?: string
  expiresAt?: number
}

function parseAuth(raw: string): ClaudeAuth | null {
  try {
    const creds = JSON.parse(raw)
    const o = creds?.claudeAiOauth ?? creds
    const token = typeof o?.accessToken === 'string' ? o.accessToken.trim() : ''
    if (!token) return null
    return {
      token,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
      rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : undefined,
      expiresAt: typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : undefined,
    }
  } catch {
    return null
  }
}

async function readCredentialsFile(homeDir?: string): Promise<ClaudeAuth | null> {
  for (const dir of claudeConfigDirs(homeDir)) {
    try {
      const auth = parseAuth(await readFile(join(dir, '.credentials.json'), 'utf-8'))
      if (auth) return auth
    } catch {}
  }
  return null
}

async function readMacKeychain(): Promise<ClaudeAuth | null> {
  const raw = await readMacKeychainRaw('Claude Code-credentials')
  return raw ? parseAuth(raw) : null
}

// Alternate accounts are typically launched with HOME=<altHome> and an isolated
// login keychain inside that home (so Claude Code's keychain writes don't fight
// over the single machine-wide slot). On macOS Claude Code prefers the keychain
// over .credentials.json, so that per-home keychain file is often the ONLY
// place the account's OAuth token lives.
async function readHomeKeychain(homeDir: string): Promise<ClaudeAuth | null> {
  if (process.platform !== 'darwin') return null
  const keychainPath = join(homeDir, 'Library', 'Keychains', 'login.keychain-db')
  try {
    await access(keychainPath)
  } catch {
    return null
  }
  const raw = await readMacKeychainFileRaw('Claude Code-credentials', keychainPath)
  return raw ? parseAuth(raw) : null
}

interface AuthCandidate {
  auth: ClaudeAuth
  // The keychain item is a single machine-wide slot shared by every Claude Code
  // instance, so a keychain token may belong to a different account than the
  // one being polled; file creds live inside the account's own home dir.
  shared: boolean
}

async function authCandidates(homeDir?: string): Promise<AuthCandidate[]> {
  const expandedHomeDir = homeDir ? expandHome(homeDir) : undefined
  const isDefault = !expandedHomeDir || expandedHomeDir === homedir()
  const out: AuthCandidate[] = []
  const file = await readCredentialsFile(isDefault ? undefined : expandedHomeDir)
  const keychain = process.platform === 'darwin' ? await readMacKeychain() : null
  const homeKeychain = !isDefault && expandedHomeDir ? await readHomeKeychain(expandedHomeDir) : null
  // Default account: keychain first (Claude Code keeps it fresher than the file).
  // Alt accounts: their own home's keychain first (same freshness argument), then
  // their own file creds, then the shared machine slot as a last resort.
  const ordered = isDefault
    ? [keychain && { auth: keychain, shared: false }, file && { auth: file, shared: false }]
    : [
        homeKeychain && { auth: homeKeychain, shared: false },
        file && { auth: file, shared: false },
        keychain && { auth: keychain, shared: true },
      ]
  for (const c of ordered) if (c) out.push(c)
  return out
}

interface TokenIdentity {
  accountUuid: string
  email: string | null
}

// A token's binding to its account never changes, so cache verdicts for the process lifetime.
const tokenIdentityCache = new Map<string, TokenIdentity | null>()

async function tokenIdentity(token: string): Promise<TokenIdentity | null | undefined> {
  if (tokenIdentityCache.has(token)) return tokenIdentityCache.get(token)
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'tokmon',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (res.status === 401 || res.status === 403) {
      tokenIdentityCache.set(token, null)
      return null
    }
    if (!res.ok) return undefined // transient — do not cache
    const data = await readJson<{ account?: { uuid?: unknown; email?: unknown } }>(res)
    const uuid = data?.account?.uuid
    if (typeof uuid !== 'string' || !uuid) return undefined
    const identity: TokenIdentity = {
      accountUuid: uuid,
      email: typeof data?.account?.email === 'string' ? data.account.email : null,
    }
    if (tokenIdentityCache.size > 64) tokenIdentityCache.clear()
    tokenIdentityCache.set(token, identity)
    return identity
  } catch {
    return undefined // transient — do not cache
  }
}

interface ResolvedAuth {
  auth: ClaudeAuth | null
  // Set when the shared macOS keychain holds a credential for another account.
  sharedAccountEmail?: string | null
  expired?: boolean
}

export function sharedClaudeCredentialMatches(expectedUuid: string | undefined, identity: TokenIdentity | null | undefined): boolean {
  return typeof expectedUuid === 'string' && expectedUuid.length > 0 && identity?.accountUuid === expectedUuid
}

async function getAuth(homeDir: string | undefined, expectedUuid: string | undefined): Promise<ResolvedAuth> {
  const candidates = await authCandidates(homeDir)
  let sharedAccountEmail: string | null | undefined
  let sawExpired = false
  let sawExpiredOwn = false
  for (const { auth, shared } of candidates) {
    if (auth.expiresAt !== undefined && auth.expiresAt < Date.now() - 60_000) {
      sawExpired = true
      if (!shared) sawExpiredOwn = true
      continue
    }
    // Account-scoped file creds are trusted as-is; the shared keychain slot must
    // prove it holds THIS account's token before we attribute its data here.
    if (!shared) return { auth }
    const identity = await tokenIdentity(auth.token)
    if (sharedClaudeCredentialMatches(expectedUuid, identity)) return { auth }
    if (!identity) continue
    sharedAccountEmail = identity.email
  }
  // The account's OWN (non-shared) creds being expired is the actionable state;
  // reporting the shared keychain's foreign identity instead would mis-diagnose.
  if (sawExpiredOwn) return { auth: null, expired: true }
  if (sharedAccountEmail !== undefined) return { auth: null, sharedAccountEmail }
  return { auth: null, expired: sawExpired }
}

function planLabel(auth: ClaudeAuth): string | null {
  const sub = auth.subscriptionType
  if (!sub) return null
  const base = sub.charAt(0).toUpperCase() + sub.slice(1)
  const tier = (auth.rateLimitTier ?? '').match(/(\d+)x/)
  return tier ? `${base} ${tier[1]}x` : base
}

const pct = (used: number, resets?: string | null, primary?: boolean): Metric =>
  percentMetric('', used, resets ?? null, primary)

function boolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true' || value.trim() === '1'
  return false
}

export function resetFrom(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
  }
  const n = numberValue(value)
  if (n === undefined) return null
  return msToIso(epochMilliseconds(n))
}

export function usageMetric(label: string, window: UsageWindow | null | undefined, primary?: boolean): Metric | null {
  const used = numberValue(window?.utilization)
  if (used === undefined) return null
  return { ...pct(used, resetFrom(window?.resets_at), primary), label }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function titleCaseWords(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function limitLabel(entry: Record<string, unknown>): string | null {
  const scope = recordValue(entry.scope)
  const model = recordValue(scope?.model)
  const displayName = nonEmptyString(model?.display_name)
  if (displayName) return displayName

  const kind = nonEmptyString(entry.kind)
  const normalizedKind = kind?.toLowerCase()
  if (normalizedKind === 'session') return 'Session'
  if (normalizedKind === 'weekly_all') return 'Weekly'

  const source = kind ?? nonEmptyString(entry.group)
  return source ? titleCaseWords(source) : null
}

function limitIsSession(entry: unknown): boolean {
  const o = recordValue(entry)
  if (!o) return false
  return nonEmptyString(o.group)?.toLowerCase() === 'session'
    || nonEmptyString(o.kind)?.toLowerCase() === 'session'
}

export function limitMetric(entry: unknown, primary?: boolean): Metric | null {
  const o = recordValue(entry)
  if (!o) return null
  const used = numberValue(o.percent)
  if (used === undefined) return null
  const label = limitLabel(o)
  if (!label) return null
  const scope = recordValue(o.scope)
  const model = recordValue(scope?.model)
  const modelId = nonEmptyString(model?.id)
  const kind = nonEmptyString(o.kind)?.toLowerCase() ?? ''
  const scopedModel = kind === 'weekly_scoped' || kind.startsWith('weekly_model')
  const role: Metric['role'] = kind === 'session' || nonEmptyString(o.group)?.toLowerCase() === 'session'
    ? 'session'
    : kind === 'weekly_all' ? 'weekly' : modelId || scopedModel ? 'model' : 'other'
  return {
    ...percentMetric(label, used, resetFrom(o.resets_at), primary),
    key: modelId ? `model:${modelId}` : kind || label.toLowerCase(),
    role,
    modelId: modelId ?? (scopedModel ? label.toLowerCase().replace(/\s+/g, '-') : null),
    active: boolValue(o.is_active),
  }
}

function limitMetrics(limits: unknown): Metric[] {
  if (!Array.isArray(limits)) return []
  const metrics: Metric[] = []
  let sawSession = false
  for (const entry of limits) {
    const primary = limitIsSession(entry) && !sawSession
    const metric = limitMetric(entry, primary ? true : undefined)
    if (limitIsSession(entry)) sawSession = true
    if (metric) metrics.push(metric)
  }
  return metrics
}

function usageLabelFromKey(key: string): string {
  if (key === 'five_hour') return 'Session'
  if (key === 'seven_day') return 'Weekly'
  if (key.startsWith('seven_day_')) return titleCaseWords(key.slice('seven_day_'.length))
  return titleCaseWords(key)
}

function topLevelUsageMetrics(data: OAuthResponse): Metric[] {
  const metrics: Metric[] = []
  for (const [key, value] of Object.entries(data)) {
    if (key === 'extra_usage' || key === 'spend') continue
    const window = recordValue(value)
    if (!window || numberValue(window.utilization) === undefined) continue
    const metric = usageMetric(usageLabelFromKey(key), window, key === 'five_hour' ? true : undefined)
    if (metric) metrics.push({
      ...metric,
      key,
      role: key === 'five_hour' ? 'session' : key === 'seven_day' ? 'weekly' : key.startsWith('seven_day_') ? 'model' : 'other',
      modelId: key.startsWith('seven_day_') ? key.slice('seven_day_'.length) : null,
    })
  }
  return metrics
}

function decimalScale(value: unknown): number {
  const n = numberValue(value)
  const places = n !== undefined && Number.isInteger(n) ? Math.min(4, Math.max(0, n)) : 2
  return 10 ** places
}

export async function claudeBilling(account: Account): Promise<BillingResult> {
  const identity = readClaudeIdentity(account.homeDir)
  if (account.quotaSource) {
    const fetched = await fetchQuotaSource(account.quotaSource, { 'anthropic-beta': 'oauth-2025-04-20' })
    const plan = identity.plan ?? null
    if (!fetched.ok) return { plan, metrics: [], error: fetched.error, ...identityFields(identity) }
    return claudeUsageResponse(fetched.response, plan, identity, 'API key rejected')
  }
  const { auth, sharedAccountEmail, expired } = await getAuth(account.homeDir, identity.accountUuid)
  if (!auth) {
    const error = sharedAccountEmail !== undefined
      ? `This Claude home is logged out — shared keychain is ${sharedAccountEmail ?? 'another account'}; run claude here`
      : expired
        ? 'Token expired — run claude to refresh'
        : 'No OAuth token — run claude and log in'
    return { plan: identity.plan ?? null, metrics: [], error, ...identityFields(identity) }
  }
  const plan = identity.plan ?? planLabel(auth)

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${auth.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'tokmon',
      },
      signal: AbortSignal.timeout(10000),
    })

    return claudeUsageResponse(res, plan, identity, 'Token expired — run claude to refresh')
  } catch {
    return { plan, metrics: [], error: 'Network error', ...identityFields(identity) }
  }
}

async function claudeUsageResponse(
  res: Response,
  plan: string | null,
  identity: ReturnType<typeof readClaudeIdentity>,
  unauthorizedError: string,
): Promise<BillingResult> {
  if (res.status === 429) {
    const retryAfter = numberValue(res.headers.get('retry-after'))
    const retryText = retryAfter !== undefined ? ` — retry in ~${Math.ceil(retryAfter / 60)}m` : ' — retrying next poll'
    return { plan, metrics: [], error: `Rate limited${retryText}`, ...identityFields(identity) }
  }
  if (res.status === 401) return { plan, metrics: [], error: unauthorizedError, ...identityFields(identity) }
  if (!res.ok) return { plan, metrics: [], error: `API ${res.status}`, ...identityFields(identity) }

  const data = await readJson<OAuthResponse>(res)
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { plan, metrics: [], error: 'Unexpected API response', ...identityFields(identity) }
  const metrics: Metric[] = limitMetrics(data.limits)
  if (metrics.length === 0) metrics.push(...topLevelUsageMetrics(data))
  if (boolValue(data.extra_usage?.is_enabled)) {
    const usedCredits = numberValue(data.extra_usage?.used_credits)
    const monthlyLimit = numberValue(data.extra_usage?.monthly_limit)
    if (usedCredits !== undefined && (usedCredits > 0 || (monthlyLimit !== undefined && monthlyLimit > 0))) {
      const scale = decimalScale(data.extra_usage?.decimal_places)
      metrics.push({
        key: 'extra_usage', role: 'unbounded', label: 'Extra', used: finite(usedCredits) / scale,
        limit: monthlyLimit !== undefined && monthlyLimit > 0 ? monthlyLimit / scale : null,
        format: { kind: 'dollars', currency: data.extra_usage?.currency ?? 'USD' },
      })
    }
  }
  return { plan, metrics, error: null, ...identityFields(identity) }
}
