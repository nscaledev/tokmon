import { cursorStateDb } from './billing'
import { runSqlite } from './sqlite'
import { type Entry, summarize, tabulate, safeNum, dashboardSince, tableSince } from '../usage-core'
import { dayKey } from '../../tz'
import { cursorUsageTable } from './composer'
import type { DashboardData, TableData, TableRow } from '../../types'
import { timestampMs } from '../_shared/time'

const EVENTS_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents'
const WINDOW_DAYS = 90
const PAGE_SIZE = 1000
const MAX_PAGES = 12
const CACHE_TTL_MS = 60_000

const SKIP_KINDS = new Set(['USAGE_EVENT_KIND_ABORTED_NOT_CHARGED', 'USAGE_EVENT_KIND_ERRORED_NOT_CHARGED'])

interface TokenUsage { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalCents?: number }
interface UsageEvent { timestamp?: string; model?: string; kind?: string; conversationId?: string; chargedCents?: number; tokenUsage?: TokenUsage }
interface EventsResponse { totalUsageEventsCount?: number; usageEventsDisplay?: UsageEvent[] }

type CursorEntry = Entry & { conversationId?: string }
type ApiResult = { entries: CursorEntry[]; complete: boolean }
type CacheSlot = ApiResult & { at: number }
const apiCache = new Map<string, CacheSlot>()
const apiInflight = new Map<string, { refresh: boolean; promise: Promise<ApiResult> }>()

async function readToken(homeDir?: string): Promise<string | null> {
  const r = await runSqlite(cursorStateDb(homeDir), "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1;")
  const raw = r.status === 'ok' ? r.rows[0]?.value : undefined
  if (typeof raw !== 'string' || !raw.trim()) return null
  return raw.trim().replace(/^"|"$/g, '')
}

async function fetchPage(token: string, startMs: number, endMs: number, page: number): Promise<EventsResponse | null> {
  try {
    const res = await fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'User-Agent': 'tokmon',
      },
      body: JSON.stringify({ startDate: String(startMs), endDate: String(endMs), page, pageSize: PAGE_SIZE }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    return await res.json() as EventsResponse
  } catch {
    return null
  }
}

function eventToEntry(e: UsageEvent): CursorEntry | null {
  if (e.kind && SKIP_KINDS.has(e.kind)) return null
  const rawTs = e.timestamp
  const ts = timestampMs(rawTs)
  if (ts === null) return null
  const tu = e.tokenUsage ?? {}
  const input = safeNum(tu.inputTokens)
  const output = safeNum(tu.outputTokens)
  const cacheRead = safeNum(tu.cacheReadTokens)
  const cacheCreate = safeNum(tu.cacheWriteTokens)
  const charged = Number(e.chargedCents)
  const totalCents = Number(tu.totalCents)
  const cents = Number.isFinite(charged) && charged > 0
    ? charged
    : (Number.isFinite(totalCents) && totalCents > 0 ? totalCents : 0)
  const cost = cents > 0 ? cents / 100 : 0
  if (cost <= 0 && input + output + cacheRead + cacheCreate === 0) return null
  return {
    ts,
    id: `${e.conversationId ?? ''}|${ts}|${e.model ?? ''}|${input}|${output}|${cacheRead}|${cacheCreate}|${cents}`,
    conversationId: e.conversationId,
    model: String(e.model ?? 'unknown'),
    cost,
    input,
    output,
    cacheCreate,
    cacheRead,
    cacheSavings: 0,
    count: 1,
  }
}

async function fetchApiEntries(homeDir?: string, refresh = false): Promise<ApiResult> {
  const cacheKey = homeDir ?? ''
  const hit = apiCache.get(cacheKey)
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return { entries: hit.entries, complete: hit.complete }

  const existing = apiInflight.get(cacheKey)
  if (existing && (!refresh || existing.refresh)) return existing.promise

  const read = async (): Promise<ApiResult> => {
    const token = await readToken(homeDir)
    if (!token) return { entries: [] as CursorEntry[], complete: false }

    const endMs = Date.now()
    const startMs = endMs - WINDOW_DAYS * 86_400_000
    const events: UsageEvent[] = []
    let complete = true
    for (let page = 1; page <= MAX_PAGES; page++) {
      const resp = await fetchPage(token, startMs, endMs, page)
      if (!resp) {
        // Transient failure mid-pagination — do not treat as authoritative.
        complete = false
        break
      }
      if (!Array.isArray(resp.usageEventsDisplay)) { complete = false; break }
      const batch = resp.usageEventsDisplay
      events.push(...batch)
      if (batch.length < PAGE_SIZE) break
      if (page === MAX_PAGES) complete = false // hit ceiling; may be truncated
    }

    const entries: CursorEntry[] = []
    for (const e of events) {
      const entry = eventToEntry(e)
      if (entry) entries.push(entry)
    }
    // Only cache complete fetches so a blip can't suppress local composer rows for 60s.
    if (complete) apiCache.set(cacheKey, { at: Date.now(), entries, complete: true })
    return { entries, complete }
  }

  // Serialize a force after a weaker read, including its cache write. Different
  // conversations share this account pull, so equal-strength callers coalesce.
  const promise = existing ? existing.promise.catch(() => {}).then(read) : read()
  const pending = { refresh, promise }
  apiInflight.set(cacheKey, pending)
  try {
    return await promise
  } finally {
    if (apiInflight.get(cacheKey) === pending) apiInflight.delete(cacheKey)
  }
}

export interface LocalDayEntry {
  /** Timezone-local day label from composer (YYYY-MM-DD) — keep as-is for overlay. */
  day: string
  entry: Entry
}

export function localDayTimestamp(label: string, tz: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return null
  const [year, month, date] = label.split('-').map(Number)
  const base = Date.UTC(year, month - 1, date)
  if (!Number.isFinite(base)) return null
  for (let hour = -14; hour <= 26; hour += 2) {
    const ts = base + hour * 3_600_000
    if (dayKey(ts, tz) === label) return ts
  }
  return null
}

/** Local composer spend as Entry[] (cost + request count; no token breakdown). */
async function fetchLocalEntries(tz: string, homeDir?: string): Promise<LocalDayEntry[]> {
  const table = await cursorUsageTable(tz, homeDir)
  if (!table) return []
  // composer table is already bucketed by tz-local dayKey. Keep the label for overlay
  // instead of round-tripping through Date.UTC noon (breaks UTC+12…+14).
  const out: LocalDayEntry[] = []
  for (const day of table.daily) {
    const ts = localDayTimestamp(day.label, tz)
    if (ts === null) continue
    for (const b of day.breakdown) {
      out.push({
        day: day.label,
        entry: {
          ts,
          model: b.name,
          cost: b.cost,
          count: Math.max(1, b.count),
          input: 0,
          output: 0,
          cacheCreate: 0,
          cacheRead: 0,
          cacheSavings: 0,
        },
      })
    }
  }
  return out
}

export function overlayEntries(api: Entry[], local: LocalDayEntry[], tz: string): Entry[] {
  if (api.length === 0) return local.map(l => l.entry)
  if (local.length === 0) return api
  // The API is authoritative for the window it actually covers. It buckets every
  // charged request by real event time, so any conversation whose usage lands in
  // that window is already counted there. Local composer rows, by contrast, bucket
  // a conversation's whole-lifetime spend onto its createdAt day. Suppressing local
  // rows only on days that happen to carry an API event (the old behaviour) double-
  // counted a conversation created on a quiet day but billed by the API on later
  // days inside the window. So treat [minApiDay, maxApiDay] as authoritative and let
  // local rows contribute only for days entirely outside it (older history the API
  // window predates, or very recent days the API hasn't caught up on yet).
  //
  // NOTE (documented limitation): local spend is still bucketed by createdAt because
  // composer usageData is a per-model lifetime aggregate with no per-usage timestamp,
  // so a single conversation straddling the window edge can still be partially
  // double-counted. The overlay bound above removes the common in-window case.
  let apiMin = Infinity
  let apiMax = -Infinity
  for (const e of api) {
    if (e.ts < apiMin) apiMin = e.ts
    if (e.ts > apiMax) apiMax = e.ts
  }
  const minDay = dayKey(apiMin, tz)
  const maxDay = dayKey(apiMax, tz)
  // day labels are YYYY-MM-DD, so lexicographic compare == chronological compare.
  return [...api, ...local.filter(l => l.day < minDay || l.day > maxDay).map(l => l.entry)]
}

async function cursorEntries(since: number, tz: string, homeDir?: string): Promise<Entry[]> {
  const [apiResult, local] = await Promise.all([fetchApiEntries(homeDir), fetchLocalEntries(tz, homeDir)])
  // Incomplete fetches still contribute the days they cover; they just aren't cached
  // and only suppress local rows for those days (not the whole window).
  return overlayEntries(apiResult.entries, local, tz).filter(e => e.ts >= since)
}

export async function cursorDashboard(tz: string, homeDir?: string): Promise<DashboardData> {
  return summarize(await cursorEntries(dashboardSince(tz), tz, homeDir), tz)
}

export async function cursorTableFull(tz: string, homeDir?: string): Promise<TableData> {
  return tabulate(await cursorEntries(tableSince(tz), tz, homeDir), tz)
}

export async function cursorSessionTable(tz: string, sessionId: string, homeDir?: string, refresh = false): Promise<TableData | null> {
  const result = await fetchApiEntries(homeDir, refresh)
  if (!result.complete) throw new Error('Cursor session usage unavailable or incomplete; check login and retry')
  const entries = result.entries.filter(entry => entry.conversationId === sessionId)
  return entries.length > 0 ? tabulate(entries, tz) : null
}
