import { readFile, readdir, stat as fsStat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { readJson } from '../../http'
import type { Account, BillingResult, Metric } from '../types'
import { identityFields } from '../_shared/identity'
import { identityFromIdToken } from '../_shared/jwt'
import { numberValue, percentMetric } from '../_shared/metric'
import { epochMilliseconds, msToIso } from '../_shared/time'
import { readMacKeychainRaw } from '../_shared/keychain'
import { codexHomes } from './usage'
import { fetchQuotaSource } from '../_shared/quota-source'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'

interface CodexAuth {
  accessToken: string
  accountId?: string
  email?: string
  displayName?: string
  plan?: string
}

function chatGptPlanLabel(planType: unknown): string | null {
  if (typeof planType !== 'string' || !planType.trim()) return null
  const p = planType.trim().toLowerCase()
  const labels: Record<string, string> = {
    free: 'ChatGPT Free',
    plus: 'ChatGPT Plus',
    pro: 'ChatGPT Pro',
    team: 'ChatGPT Team',
    enterprise: 'ChatGPT Enterprise',
    edu: 'ChatGPT Edu',
  }
  if (labels[p]) return labels[p]
  return `ChatGPT ${p.charAt(0).toUpperCase()}${p.slice(1)}`
}

function codexIdentity(idToken: unknown): Pick<CodexAuth, 'email' | 'displayName' | 'plan'> {
  const { email, displayName, payload } = identityFromIdToken(idToken)
  if (!payload) return {}
  const plan = chatGptPlanLabel(payload['https://api.openai.com/auth']?.chatgpt_plan_type)
  return { email, displayName, plan: plan ?? undefined }
}

async function readAuthFile(home: string): Promise<CodexAuth | null> {
  try {
    const raw = await readFile(join(home, 'auth.json'), 'utf-8')
    const auth = JSON.parse(raw)
    const accessToken = typeof auth?.tokens?.access_token === 'string' ? auth.tokens.access_token.trim() : ''
    if (!accessToken) return null
    const accountId = typeof auth?.tokens?.account_id === 'string' && auth.tokens.account_id.trim()
      ? auth.tokens.account_id.trim()
      : undefined
    return { accessToken, accountId, ...codexIdentity(auth?.tokens?.id_token) }
  } catch {
    return null
  }
}

async function readKeychainAuth(): Promise<CodexAuth | null> {
  try {
    const raw = await readMacKeychainRaw('Codex Auth')
    if (!raw) return null
    const auth = JSON.parse(raw)
    const accessToken = typeof auth?.tokens?.access_token === 'string' ? auth.tokens.access_token.trim() : ''
    if (!accessToken) return null
    const accountId = typeof auth?.tokens?.account_id === 'string' && auth.tokens.account_id.trim()
      ? auth.tokens.account_id.trim()
      : undefined
    return { accessToken, accountId, ...codexIdentity(auth?.tokens?.id_token) }
  } catch {
    return null
  }
}

async function getAuth(homeDir?: string): Promise<CodexAuth | null> {
  for (const home of codexHomes(homeDir)) {
    const auth = await readAuthFile(home)
    if (auth) return auth
  }
  // The keychain "Codex Auth" item is a single machine-wide slot that belongs to
  // the default account — never attribute it to a custom-home (alt) account.
  if (!homeDir && process.platform === 'darwin') return readKeychainAuth()
  return null
}

function planLabel(planType: unknown): string | null {
  if (typeof planType !== 'string' || !planType.trim()) return null
  const p = planType.trim().toLowerCase()
  if (p === 'prolite') return 'Pro 5x'
  if (p === 'pro') return 'Pro 20x'
  return planType.charAt(0).toUpperCase() + planType.slice(1)
}

function resetDateMs(window: any): number | null {
  if (!window) return null
  const absolute = numberValue(window.reset_at ?? window.resets_at)
  if (absolute !== undefined) return epochMilliseconds(absolute)
  const after = numberValue(window.reset_after_seconds)
  if (after !== undefined) return Date.now() + after * 1000
  for (const key of ['reset_at', 'resets_at']) {
    const raw = window[key]
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = new Date(raw).getTime()
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function resetFrom(window: any): string | null {
  const ms = resetDateMs(window)
  return ms === null ? null : msToIso(ms)
}

function windowSeconds(window: any): number | undefined {
  const seconds = numberValue(window?.limit_window_seconds ?? window?.period_seconds ?? window?.window_seconds)
  if (seconds !== undefined) return seconds
  const minutes = numberValue(window?.limit_window_minutes ?? window?.window_minutes ?? window?.period_minutes)
  return minutes === undefined ? undefined : minutes * 60
}

function normalizedUsedPercent(window: any, percent: unknown): number | undefined {
  const used = numberValue(percent)
  if (used === undefined) return undefined
  const periodSeconds = windowSeconds(window)
  const resetMs = resetDateMs(window)
  if (periodSeconds && resetMs) {
    const elapsedMs = periodSeconds * 1000 - Math.max(0, resetMs - Date.now())
    if (elapsedMs <= 60_000 && used <= 1) return 0
  }
  return Math.max(0, used)
}

function metricLabelForAdditional(window: any): string | null {
  const name = String(window?.limit_name ?? window?.name ?? window?.metered_feature ?? window?.feature ?? '').toLowerCase()
  if (!name.includes('spark')) return null
  const seconds = windowSeconds(window)
  return name.includes('week') || (seconds !== undefined && seconds >= 6 * 24 * 60 * 60) ? 'Spark Weekly' : 'Spark'
}

function additionalRateLimits(rl: any): any[] {
  const raw = rl?.additional_rate_limits ?? rl?.additionalRateLimits ?? rl?.additional
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw)
  return []
}

export function codexWindowMetrics(rl: any, headerPct?: (name: string) => number | undefined): Metric[] {
  const metrics: Metric[] = []
  const primary = rl?.primary_window ?? rl?.primary ?? null
  const secondary = rl?.secondary_window ?? rl?.secondary ?? null
  // Some unlimited plans expose generic zero-valued headers without exposing
  // quota windows. A header can fill a missing percentage on a real window,
  // but it must never manufacture a bounded quota from an absent window.
  const primaryPct = normalizedUsedPercent(
    primary,
    primary?.used_percent ?? primary?.percent_used
      ?? (primary ? headerPct?.('x-codex-primary-used-percent') : undefined),
  )
  const secondaryPct = normalizedUsedPercent(
    secondary,
    secondary?.used_percent ?? secondary?.percent_used
      ?? (secondary ? headerPct?.('x-codex-secondary-used-percent') : undefined),
  )

  if (primaryPct !== undefined) metrics.push(percentMetric('Session', primaryPct, resetFrom(primary), true))
  if (secondaryPct !== undefined) metrics.push(percentMetric('Weekly', secondaryPct, resetFrom(secondary)))

  for (const item of additionalRateLimits(rl)) {
    const label = metricLabelForAdditional(item)
    if (!label) continue
    const used = normalizedUsedPercent(item, item?.used_percent ?? item?.percent_used)
    if (used === undefined) continue
    metrics.push(percentMetric(label, used, resetFrom(item)))
  }
  return metrics
}

export function creditBalanceMetric(source: any): Metric | null {
  const balance = numberValue(source?.credits?.balance ?? source?.credit_balance)
  return balance !== undefined && balance >= 0
    ? { key: 'credits', role: 'unbounded', label: 'Credits', used: balance, limit: null, format: { kind: 'count', suffix: 'available' } }
    : null
}

function appendCredits(metrics: Metric[], source: any): void {
  const metric = creditBalanceMetric(source)
  if (metric) metrics.push(metric)
}

async function fetchResetCredits(headers: Record<string, string>): Promise<number | undefined> {
  try {
    const res = await fetch(RESET_CREDITS_URL, {
      headers: {
        ...headers,
        'OpenAI-Beta': 'codex-1',
        'originator': 'Codex Desktop',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return undefined
    const data = await readJson<any>(res)
    return numberValue(data?.available_count ?? data?.available ?? data?.remaining)
  } catch {
    return undefined
  }
}

async function liveBilling(auth: CodexAuth, failure?: { status?: number }): Promise<BillingResult | null> {
  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'tokmon',
    }
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId

    const res = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      if (failure) failure.status = res.status
      return null
    }
    const data = await readJson<any>(res)
    if (!data) return null

    const headerPct = (name: string): number | undefined => {
      const h = res.headers.get(name)
      if (h === null || h.trim() === '') return undefined
      const n = Number(h)
      return Number.isFinite(n) ? n : undefined
    }

    const metrics: Metric[] = []
    metrics.push(...codexWindowMetrics(data.rate_limit ?? data, headerPct))
    appendCredits(metrics, data)

    // Prefer the value already in the usage response; only pay for a second round-trip when absent.
    const resetCredits = numberValue(data?.rate_limit_reset_credits?.available_count ?? data?.rate_limit_reset_credits?.available)
      ?? await fetchResetCredits(headers)
    if (resetCredits !== undefined && resetCredits >= 0) {
      metrics.push({ label: 'Resets', used: resetCredits, limit: null, format: { kind: 'count', suffix: 'available' } })
    }

    if (metrics.length === 0) return null
    return { plan: auth.plan ?? planLabel(data.plan_type), metrics, error: null, ...identityFields(auth) }
  } catch {
    return null
  }
}

const SNAPSHOT_CANDIDATES = 8
const SNAPSHOT_STALE_MS = 24 * 3_600_000
const MAX_SNAPSHOT_SCAN_DIRS = 512
const MAX_SNAPSHOT_SCAN_FILES = 4096
const MAX_SNAPSHOT_TAIL_BYTES = 8 * 1024 * 1024

async function newestRolloutFiles(homeDir?: string): Promise<{ path: string; mtime: number }[]> {
  const all: { path: string; mtime: number }[] = []
  for (const home of codexHomes(homeDir)) {
    const stack = [join(home, 'sessions')]
    let visitedDirs = 0
    let visitedFiles = 0
    while (stack.length > 0 && visitedDirs < MAX_SNAPSHOT_SCAN_DIRS && visitedFiles < MAX_SNAPSHOT_SCAN_FILES) {
      const dir = stack.pop()!
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      visitedDirs++
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(path)
          continue
        }
        visitedFiles++
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.includes('rollout-')) continue
        try {
          const s = await fsStat(path)
          // Floored: mtimeMs is fractional, and asOfMs crosses the RPC boundary
          // whose wire schema requires an integer — a fraction would fail the
          // snapshot encode for every subscriber, not just this account.
          all.push({ path, mtime: Math.floor(s.mtimeMs) })
        } catch {}
        if (visitedFiles >= MAX_SNAPSHOT_SCAN_FILES) break
      }
    }
  }
  return all.sort((a, b) => b.mtime - a.mtime).slice(0, SNAPSHOT_CANDIDATES)
}

async function lastRateLimits(path: string): Promise<any | null> {
  let last: any = null
  try {
    const size = (await fsStat(path)).size
    const input = createReadStream(path, { start: Math.max(0, size - MAX_SNAPSHOT_TAIL_BYTES) })
    input.on('error', () => {})
    const rl = createInterface({ input, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('rate_limits')) continue
      try {
        const obj = JSON.parse(line)
        if (obj?.payload?.rate_limits) last = obj.payload.rate_limits
      } catch {}
    }
  } catch {
    return null
  }
  return last
}

// A brand-new session file has no rate_limits yet, so walk newest-first until one does.
async function snapshotBilling(homeDir?: string, auth: CodexAuth | null = null): Promise<(BillingResult & { asOfMs: number }) | null> {
  for (const file of await newestRolloutFiles(homeDir)) {
    const last = await lastRateLimits(file.path)
    if (!last) continue

    const metrics: Metric[] = []
    metrics.push(...codexWindowMetrics(last.rate_limit ?? last))
    appendCredits(metrics, last)
    const resetCredits = numberValue(last?.rate_limit_reset_credits?.available_count ?? last?.rate_limit_reset_credits?.available)
    if (resetCredits !== undefined && resetCredits >= 0) {
      metrics.push({ label: 'Resets', used: resetCredits, limit: null, format: { kind: 'count', suffix: 'available' } })
    }
    if (metrics.length === 0) continue
    return { plan: auth?.plan ?? planLabel(last.plan_type), metrics, error: null, asOfMs: file.mtime, ...identityFields(auth) }
  }
  return null
}

export async function codexBilling(account: Account): Promise<BillingResult> {
  if (account.quotaSource) {
    const fetched = await fetchQuotaSource(account.quotaSource, {
      'OpenAI-Beta': 'codex-1',
      originator: 'Codex Desktop',
    })
    if (!fetched.ok) return { plan: null, metrics: [], error: fetched.error }
    const res = fetched.response
    if (res.status === 429) return { plan: null, metrics: [], error: 'Rate limited — retrying next poll' }
    if (res.status === 401) return { plan: null, metrics: [], error: 'API key rejected' }
    if (!res.ok) return { plan: null, metrics: [], error: `API ${res.status}` }
    const data = await readJson<any>(res)
    if (!data) return { plan: null, metrics: [], error: 'Unexpected API response' }
    const metrics = codexWindowMetrics(data.rate_limit ?? data)
    appendCredits(metrics, data)
    if (metrics.length === 0) return { plan: chatGptPlanLabel(data.plan_type), metrics: [], error: 'Unexpected API response' }
    return { plan: chatGptPlanLabel(data.plan_type), metrics, error: null }
  }
  const auth = await getAuth(account.homeDir)
  const failure: { status?: number } = {}
  if (auth) {
    const live = await liveBilling(auth, failure)
    if (live) return live
  }
  const snap = await snapshotBilling(account.homeDir, auth)
  // Serve offline snapshots while they're plausibly current; a day-old snapshot
  // behind a failing live API is misinformation, not data. asOfMs stays on the
  // result so the UI can flag how old the served numbers really are.
  if (snap && Date.now() - snap.asOfMs < SNAPSHOT_STALE_MS) {
    return snap
  }
  return {
    plan: auth?.plan ?? snap?.plan ?? null,
    metrics: [],
    error: auth
      ? `Usage API failed${failure.status ? ` (HTTP ${failure.status})` : ''} — run codex to refresh`
      : 'Not logged in — run codex',
    ...identityFields(auth),
  }
}
