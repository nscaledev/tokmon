import { dayKey, startOfMonth, startOfWeek } from './tz'
import { PROVIDERS } from './providers'
import { providerLocations, type ProviderLocation } from './provider-locations'
import { matchesAccount, type Metric, type ProviderId } from './providers/types'
import type { WebAccount, WebSnapshot } from './web/contract'
import { configLocation } from './config'

export const CLI_SCHEMA_VERSION = 1
export const USAGE_PERIODS = ['today', 'week', 'month', 'all'] as const
export type UsagePeriod = typeof USAGE_PERIODS[number]

export interface UsageFilters {
  period: UsagePeriod
  provider?: ProviderId
  account?: string
  model?: string
  session?: string
}

export interface CliSource {
  id: string
  providerId: ProviderId
  provider: string
  accountId: string
  account: string
  homeDir: string | null
  locations: ProviderLocation[]
}

export interface CliUsageTotals {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  tokens: number
  cacheSavings: number
  cost: number
  calls: number
}

export interface CliModelUsage extends CliUsageTotals {
  sourceId: string
  providerId: ProviderId
  accountId: string
  model: string
}

export interface UsageReport {
  schemaVersion: number
  generatedAt: string
  timezone: string
  tokmonConfig: string
  period: UsagePeriod
  filters: {
    provider: ProviderId | null
    account: string | null
    model: string | null
    session?: string
  }
  totals: CliUsageTotals
  models: CliModelUsage[]
  sources: CliSource[]
  errors: Array<{ sourceId: string; tableState: string; message?: string }>
}

export interface ProvidersReport {
  schemaVersion: number
  generatedAt: string
  timezone: string
  tokmonConfig: string
  providers: Array<CliSource & {
    hasUsage: boolean
    hasBilling: boolean
    plan: string | null
    summaryState: string
    tableState: string
    billingState: string
    billingError: string | null
    metrics: Metric[]
  }>
}

function sourceId(account: Pick<WebAccount, 'providerId' | 'id'>): string {
  return `${account.providerId}:${account.id}`
}

function firstDayFor(period: UsagePeriod, now: number, tz: string): string | null {
  if (period === 'all') return null
  if (period === 'today') return dayKey(now, tz)
  if (period === 'week') return dayKey(startOfWeek(now, tz), tz)
  return dayKey(startOfMonth(now, tz), tz)
}

function accountMatches(account: WebAccount, filters: UsageFilters): boolean {
  if (filters.provider && account.providerId !== filters.provider) return false
  return matchesAccount(account, filters.account)
}

async function cliSource(account: WebAccount): Promise<CliSource> {
  return {
    id: sourceId(account),
    providerId: account.providerId,
    provider: PROVIDERS[account.providerId].name,
    accountId: account.id,
    account: account.identity?.accessibleLabel ?? (account.email || account.displayName || account.name),
    homeDir: account.homeDir,
    locations: await providerLocations(account.providerId, account.homeDir ?? undefined),
  }
}

function addUsage(target: CliUsageTotals, value: CliUsageTotals): void {
  target.input += value.input
  target.output += value.output
  target.cacheCreate += value.cacheCreate
  target.cacheRead += value.cacheRead
  target.tokens += value.tokens
  target.cacheSavings += value.cacheSavings
  target.cost += value.cost
  target.calls += value.calls
}

const ZERO_TOTALS = () => ({
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  tokens: 0,
  cacheSavings: 0,
  cost: 0,
  calls: 0,
})

export async function buildUsageReport(
  snapshot: WebSnapshot,
  filters: UsageFilters,
  now = Date.now(),
  tokmonConfig = configLocation(),
): Promise<UsageReport> {
  if (filters.session && snapshot.sessionId !== filters.session) {
    throw new Error('Snapshot is not scoped to the requested session')
  }
  const firstDay = firstDayFor(filters.period, now, snapshot.tz)
  const accounts = snapshot.accounts.filter(account => accountMatches(account, filters))
  const sources = await Promise.all(accounts.map(cliSource))
  const models = new Map<string, CliModelUsage>()
  const modelNeedle = filters.model?.toLowerCase()

  for (const account of accounts) {
    for (const row of account.table?.daily ?? []) {
      if (firstDay && row.label < firstDay) continue
      for (const model of row.breakdown) {
        if (modelNeedle && !model.name.toLowerCase().includes(modelNeedle)) continue
        const key = `${sourceId(account)}\0${model.name}`
        let current = models.get(key)
        if (!current) {
          current = {
            sourceId: sourceId(account),
            providerId: account.providerId,
            accountId: account.id,
            model: model.name,
            ...ZERO_TOTALS(),
          }
          models.set(key, current)
        }
        addUsage(current, {
          input: model.input,
          output: model.output,
          cacheCreate: model.cacheCreate,
          cacheRead: model.cacheRead,
          tokens: model.input + model.output + model.cacheCreate + model.cacheRead,
          cacheSavings: model.cacheSavings,
          cost: model.cost,
          calls: model.count,
        })
      }
    }
  }

  const sorted = [...models.values()].sort((a, b) =>
    b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model))
  const totals = ZERO_TOTALS()
  for (const model of sorted) addUsage(totals, model)

  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    timezone: snapshot.tz,
    tokmonConfig,
    period: filters.period,
    filters: {
      provider: filters.provider ?? null,
      account: filters.account ?? null,
      model: filters.model ?? null,
      ...(filters.session ? { session: filters.session } : {}),
    },
    totals,
    models: sorted,
    sources,
    errors: accounts
      .filter(account => account.tableState === 'error')
      .map(account => ({ sourceId: sourceId(account), tableState: account.tableState,
        ...(account.tableError ? { message: account.tableError } : {}),
      })),
  }
}

export async function buildProvidersReport(snapshot: WebSnapshot, tokmonConfig: string): Promise<ProvidersReport> {
  const providers = await Promise.all(snapshot.accounts.map(async account => ({
    ...await cliSource(account),
    hasUsage: account.hasUsage,
    hasBilling: account.hasBilling,
    plan: account.plan ?? null,
    summaryState: account.summaryState,
    tableState: account.tableState,
    billingState: account.billingState,
    billingError: account.billing?.error ?? null,
    metrics: account.billing?.metrics ?? [],
  })))
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    timezone: snapshot.tz,
    tokmonConfig,
    providers,
  }
}

const compact = (value: number): string => {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return Math.round(value).toString()
}

const fit = (value: string, width: number): string =>
  value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value.padEnd(width)

export function formatUsageReport(report: UsageReport): string {
  const sourceMap = new Map(report.sources.map(source => [source.id, source]))
  const lines = [
    `tokmon usage · ${report.period} · ${report.generatedAt} · ${report.timezone}`,
    `Tokmon config: ${report.tokmonConfig}`,
    ...(report.filters.session ? [`Session: ${report.filters.session} (excludes child sessions)`] : []),
    `${fit('PROVIDER', 12)} ${fit('ACCOUNT', 22)} ${fit('MODEL', 32)} ${'TOKENS'.padStart(10)} ${'CALLS'.padStart(7)} ${'COST'.padStart(10)}`,
  ]
  if (report.models.length === 0) lines.push('No matching model usage.')
  for (const model of report.models) {
    const source = sourceMap.get(model.sourceId)
    lines.push([
      fit(source?.provider ?? model.providerId, 12),
      fit(source?.account ?? model.accountId, 22),
      fit(model.model, 32),
      compact(model.tokens).padStart(10),
      compact(model.calls).padStart(7),
      `$${model.cost.toFixed(2)}`.padStart(10),
    ].join(' '))
  }
  lines.push('')
  lines.push(`Total: ${compact(report.totals.tokens)} tokens · ${compact(report.totals.calls)} calls · $${report.totals.cost.toFixed(2)}`)
  lines.push('Sources:')
  for (const source of report.sources) {
    const paths = source.locations.filter(item => item.exists).map(item => item.path)
    lines.push(`  ${source.id}  ${paths.join(', ') || source.homeDir || '(no local path found)'}`)
  }
  if (report.errors.length) lines.push(`Warnings: ${report.errors.map(error => `${error.sourceId} ${error.message ?? error.tableState}`).join(', ')}`)
  return lines.join('\n')
}

export function formatProvidersReport(report: ProvidersReport): string {
  const lines = [
    `tokmon providers · ${report.generatedAt}`,
    `Tokmon config: ${report.tokmonConfig}`,
  ]
  for (const provider of report.providers) {
    lines.push('')
    lines.push(`${provider.provider} · ${provider.account} (${provider.id})`)
    lines.push(`  usage=${provider.hasUsage ? provider.tableState : 'n/a'} billing=${provider.hasBilling ? provider.billingState : 'n/a'} plan=${provider.plan ?? 'unknown'}`)
    for (const item of provider.locations) {
      lines.push(`  ${item.exists ? '✓' : '·'} ${item.kind.padEnd(6)} ${item.path}`)
    }
    if (provider.billingError) lines.push(`  warning ${provider.billingError}`)
  }
  return lines.join('\n')
}
