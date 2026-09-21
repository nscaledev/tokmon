import { access, open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DashboardData, TableData } from '../../types'
import { envDir } from '../../config'
import { type Entry, summarize, tabulate, loadCachedEntries, safeNum, dashboardSince, tableSince, collectSessionFiles } from '../usage-core'
import { readJsonLines } from '../_shared/jsonl'
import { modelKeyMatches } from '../_shared/metric'
import { makePriceResolver } from '../_shared/pricing'
import { timestampMs } from '../_shared/time'
import { sessionFiles } from '../_shared/session'
import { dedupe } from '../usage-core'

const PRICING: Record<string, { in: number; cr: number; out: number }> = {
  // Bare 'gpt-5.6' (no tier suffix) appears in real session logs; without an
  // explicit key it drifted to the flagship fallback, which happened to match
  // today but silently breaks the moment either price moves.
  'gpt-5.6': { in: 5e-6, cr: 0.5e-6, out: 30e-6 },
  'gpt-5.6-terra': { in: 2.5e-6, cr: 0.25e-6, out: 15e-6 },
  'gpt-5.6-luna': { in: 1e-6, cr: 0.1e-6, out: 6e-6 },
  'gpt-5.6-sol': { in: 5e-6, cr: 0.5e-6, out: 30e-6 },
  'gpt-5.5-pro': { in: 30e-6, cr: 30e-6, out: 180e-6 },
  'gpt-5.5-codex': { in: 5e-6, cr: 0.5e-6, out: 30e-6 },
  'gpt-5.5': { in: 5e-6, cr: 0.5e-6, out: 30e-6 },
  'gpt-5.4-mini': { in: 0.75e-6, cr: 0.075e-6, out: 4.5e-6 },
  'gpt-5.4-nano': { in: 0.2e-6, cr: 0.02e-6, out: 1.25e-6 },
  'gpt-5.4-pro': { in: 30e-6, cr: 30e-6, out: 180e-6 },
  'gpt-5.4-codex': { in: 2.5e-6, cr: 0.25e-6, out: 15e-6 },
  'gpt-5.4': { in: 2.5e-6, cr: 0.25e-6, out: 15e-6 },
  'gpt-5.3-codex': { in: 1.75e-6, cr: 0.175e-6, out: 14e-6 },
  'gpt-5.3': { in: 1.75e-6, cr: 0.175e-6, out: 14e-6 },
  'gpt-5.2-codex': { in: 1.75e-6, cr: 0.175e-6, out: 14e-6 },
  'gpt-5.2': { in: 1.75e-6, cr: 0.175e-6, out: 14e-6 },
  'gpt-5.1': { in: 1.25e-6, cr: 0.125e-6, out: 10e-6 },
  'gpt-5-codex': { in: 1.25e-6, cr: 0.125e-6, out: 10e-6 },
  'gpt-5-mini': { in: 0.25e-6, cr: 0.025e-6, out: 2e-6 },
  'gpt-5-nano': { in: 0.05e-6, cr: 0.005e-6, out: 0.4e-6 },
  'gpt-5': { in: 1.25e-6, cr: 0.125e-6, out: 10e-6 },
  'o4-mini': { in: 1.1e-6, cr: 0.275e-6, out: 4.4e-6 },
}
// Unknown/new model families are priced at the current flagship rate rather than
// $0 — a slightly-wrong estimate beats silently free usage when OpenAI ships a
// model this table doesn't know yet (the gpt-5.5 launch was 4x under-priced this way).
const FALLBACK_PRICE = PRICING['gpt-5.5']
const resolvePrice = makePriceResolver(PRICING, { fallback: FALLBACK_PRICE, matches: modelKeyMatches })

export function codexHomes(homeDir?: string): string[] {
  if (homeDir) return [...new Set([join(homeDir, '.codex'), homeDir])]
  const homes: string[] = []
  const codexHome = envDir('CODEX_HOME')
  if (codexHome) homes.push(codexHome)
  homes.push(join(homedir(), '.codex'))
  homes.push(join(homedir(), '.config', 'codex'))
  return [...new Set(homes)]
}

export async function detectCodex(homeDir?: string): Promise<boolean> {
  for (const home of codexHomes(homeDir)) {
    try { await access(join(home, 'sessions')); return true } catch {}
    try { await access(join(home, 'archived_sessions')); return true } catch {}
  }
  return false
}

// Priority processing (`service_tier: "priority"`, Codex's fast lane) bills at
// a flat multiplier over standard rates for the gpt-5 family. Sessions record
// tier changes in thread_settings_applied events, not per token_count.
const PRIORITY_TIER_MULTIPLIER = 2

export function codexPriceFor(model: string, serviceTier?: string) {
  const base = resolvePrice(model)
  if (serviceTier !== 'priority') return base
  return { in: base.in * PRIORITY_TIER_MULTIPLIER, cr: base.cr * PRIORITY_TIER_MULTIPLIER, out: base.out * PRIORITY_TIER_MULTIPLIER }
}

function extractModel(obj: any): string | null {
  const p = obj?.payload ?? obj
  return p?.model
    || p?.model_name
    || p?.collaboration_mode?.settings?.model
    || p?.model_slug
    || p?.config?.model
    || p?.info?.model
    || p?.info?.model_name
    || p?.info?.model_slug
    || p?.metadata?.model
    || p?.info?.metadata?.model
    || null
}

interface CodexDelta {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

function subtractClamped(cur: CodexDelta, prev: CodexDelta | null): CodexDelta {
  const sub = (a?: number, b?: number) => Math.max(0, (a ?? 0) - (b ?? 0))
  return {
    input_tokens: sub(cur.input_tokens, prev?.input_tokens),
    cached_input_tokens: sub(cur.cached_input_tokens, prev?.cached_input_tokens),
    output_tokens: sub(cur.output_tokens, prev?.output_tokens),
    reasoning_output_tokens: sub(cur.reasoning_output_tokens, prev?.reasoning_output_tokens),
    total_tokens: sub(cur.total_tokens, prev?.total_tokens),
  }
}

function tokenNumber(obj: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = obj?.[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return undefined
}

function normalizeUsage(obj: any): CodexDelta | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const input = tokenNumber(obj, ['input_tokens', 'prompt_tokens', 'input'])
  const cached = tokenNumber(obj, ['cached_input_tokens', 'cache_read_input_tokens', 'cached_tokens'])
  const output = tokenNumber(obj, ['output_tokens', 'completion_tokens', 'output'])
  const reasoning = tokenNumber(obj, ['reasoning_output_tokens', 'reasoning_tokens'])
  let total = tokenNumber(obj, ['total_tokens'])
  const hasUsage = [input, cached, output, reasoning, total].some(v => v !== undefined)
  if (!hasUsage) return undefined
  if (total === undefined || (total === 0 && (input ?? 0) + (output ?? 0) + (reasoning ?? 0) > 0)) {
    total = (input ?? 0) + (output ?? 0) + (reasoning ?? 0)
  }
  return {
    input_tokens: input ?? 0,
    cached_input_tokens: cached ?? 0,
    output_tokens: output ?? 0,
    reasoning_output_tokens: reasoning ?? 0,
    total_tokens: total,
  }
}

function eventSig(last: CodexDelta | undefined, total: CodexDelta | undefined): string {
  const f = (x: CodexDelta | undefined) =>
    x ? `${x.input_tokens ?? 0},${x.cached_input_tokens ?? 0},${x.output_tokens ?? 0},${x.reasoning_output_tokens ?? 0},${x.total_tokens ?? 0}` : '-'
  return `${f(last)}|${f(total)}`
}

function timestampSecond(value: unknown): string | null {
  const ts = timestampMs(value)
  return ts === null ? null : new Date(ts).toISOString().slice(0, 19)
}

async function hasForkedHistory(path: string, ignoreReadErrors: boolean): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null
  try {
    handle = await openFile(path, 'r')
    const buffer = Buffer.alloc(16 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const prefix = buffer.subarray(0, bytesRead).toString('utf8')
    return prefix.includes('thread_spawn') && /"forked_from_id"\s*:\s*"[^"]+"/.test(prefix)
  } catch (error) {
    if (!ignoreReadErrors) throw error
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

function isLiveTaskStart(obj: any): boolean {
  if ((obj?.payload?.type ?? obj?.type) !== 'task_started') return false
  const eventSecond = timestampSecond(obj?.timestamp ?? obj?.payload?.timestamp)
  const startedSecond = timestampSecond(obj?.payload?.started_at)
  return eventSecond !== null && eventSecond === startedSecond
}

function findUsage(obj: any): CodexDelta | undefined {
  return normalizeUsage(obj?.usage)
    ?? normalizeUsage(obj?.payload?.usage)
    ?? normalizeUsage(obj?.payload?.info?.usage)
    ?? normalizeUsage(obj?.result?.usage)
    ?? normalizeUsage(obj?.response?.usage)
    ?? normalizeUsage(obj?.token_usage)
    ?? normalizeUsage(obj)
}

function findTimestamp(obj: any): number | null {
  return timestampMs(obj?.timestamp ?? obj?.payload?.timestamp ?? obj?.created_at ?? obj?.createdAt ?? obj?.time)
}

async function parseFile(path: string, ignoreReadErrors = true): Promise<Entry[]> {
  const entries: Entry[] = []
  let model = 'gpt-5'
  let serviceTier: string | undefined
  let prevTotal: CodexDelta | null = null
  let prevSig: string | null = null
  let skipReplay = await hasForkedHistory(path, ignoreReadErrors)
  const relevantLine = (line: string) =>
    line.includes('token_count')
    || line.includes('task_started')
    || line.includes('turn_context')
    || line.includes('thread_settings')
    || line.includes('"usage"')
    || line.includes('input_tokens')
    || line.includes('prompt_tokens')
  for await (const obj of readJsonLines(path, relevantLine, { ignoreReadErrors })) {
    try {
      const payloadType = obj?.payload?.type ?? obj?.type
      if (skipReplay) {
        if (isLiveTaskStart(obj)) skipReplay = false
        continue
      }
      if (payloadType === 'turn_context') {
        const m = extractModel(obj)
        if (typeof m === 'string' && m.trim()) model = m
        continue
      }
      if (payloadType === 'thread_settings_applied') {
        const tier = obj?.payload?.thread_settings?.service_tier
        if (typeof tier === 'string') serviceTier = tier
        continue
      }
      if (payloadType !== 'token_count') {
        const usage = findUsage(obj)
        if (!usage) continue
        const m = extractModel(obj)
        if (typeof m === 'string' && m.trim()) model = m
        const ts = findTimestamp(obj)
        if (ts === null) continue
        const inputTotal = safeNum(usage.input_tokens)
        const cached = Math.min(safeNum(usage.cached_input_tokens), inputTotal)
        const inputTokens = inputTotal - cached
        const output = safeNum(usage.output_tokens)
        if (inputTokens + output + cached === 0) continue
        const p = codexPriceFor(model, serviceTier)
        entries.push({
          id: `${ts}|${model}|${inputTotal}|${cached}|${output}|${safeNum(usage.reasoning_output_tokens)}|${safeNum(usage.total_tokens)}`,
          ts,
          model: serviceTier === 'priority' ? `${model} (priority)` : model,
          cost: inputTokens * p.in + cached * p.cr + output * p.out,
          input: inputTokens,
          output,
          cacheCreate: 0,
          cacheRead: cached,
          cacheSavings: cached * (p.in - p.cr),
        })
        continue
      }

      const info = obj?.payload?.info
      const total = normalizeUsage(info?.total_token_usage)
      const last = normalizeUsage(info?.last_token_usage)
      const tsValue = obj.timestamp ?? obj?.payload?.timestamp

      const sig = eventSig(last, total)
      if (sig === prevSig) continue
      prevSig = sig

      let d: CodexDelta | undefined = last
      if (!d && total) {
        const reset = !!prevTotal && (total.input_tokens ?? 0) < (prevTotal.input_tokens ?? 0)
        d = reset ? total : subtractClamped(total, prevTotal)
      }
      if (total) prevTotal = total
      if (!d) continue

      const ts = timestampMs(tsValue)
      if (ts === null) continue

      const m = extractModel(obj)
      if (typeof m === 'string' && m.trim()) model = m
      const inputTotal = safeNum(d.input_tokens)
      const cached = Math.min(safeNum(d.cached_input_tokens), inputTotal)
      const inputTokens = inputTotal - cached
      const output = safeNum(d.output_tokens)
      if (inputTokens + output + cached === 0) continue

      const p = codexPriceFor(model, serviceTier)
      entries.push({
        id: `${ts}|${model}|${inputTotal}|${cached}|${output}|${safeNum(d.reasoning_output_tokens)}|${safeNum(d.total_tokens)}`,
        ts,
        model: serviceTier === 'priority' ? `${model} (priority)` : model,
        cost: inputTokens * p.in + cached * p.cr + output * p.out,
        input: inputTokens,
        output,
        cacheCreate: 0,
        cacheRead: cached,
        cacheSavings: cached * (p.in - p.cr),
      })
    } catch {}
  }
  return entries
}

async function loadEntries(since: number, homeDir?: string): Promise<Entry[]> {
  const roots = codexHomes(homeDir).flatMap(home => [join(home, 'sessions'), join(home, 'archived_sessions')])
  const files = await collectSessionFiles(roots, path => path.endsWith('.jsonl'), since)
  return loadCachedEntries(files, parseFile, since)
}

export async function codexDashboard(tz: string, homeDir?: string): Promise<DashboardData> {
  const entries = await loadEntries(dashboardSince(tz), homeDir)
  return summarize(entries, tz)
}

export async function codexTable(tz: string, homeDir?: string): Promise<TableData> {
  const entries = await loadEntries(tableSince(tz), homeDir)
  return tabulate(entries, tz)
}

export async function codexSessionTable(tz: string, sessionId: string, homeDir?: string): Promise<TableData | null> {
  const roots = codexHomes(homeDir).flatMap(home => [join(home, 'sessions'), join(home, 'archived_sessions')])
  const files = await sessionFiles(roots, 'codex', sessionId)
  if (files.length === 0) return null
  return tabulate(dedupe((await Promise.all(files.map(path => parseFile(path, false)))).flat()), tz)
}
