import type { DashboardData, TableData } from '../types'
import type { QuotaSourceConfig } from '../config-schema'

export const PROVIDER_IDS = ['claude', 'codex', 'cursor', 'copilot', 'pi', 'opencode', 'antigravity', 'gemini', 'grok'] as const

export type ProviderId = typeof PROVIDER_IDS[number]

export interface Account {
  id: string
  providerId: ProviderId
  name: string
  color: string
  homeDir?: string
  /** Runtime provenance. Provider readers stay source-agnostic; clients use it for lifecycle actions. */
  source?: 'auto' | 'configured'
  quotaSource?: QuotaSourceConfig
}

export type MetricFormat =
  | { kind: 'percent' }
  | { kind: 'dollars'; currency?: string }
  | { kind: 'count'; suffix?: string }

export interface Metric {
  /** Optional semantic metadata preserved from providers for shared headroom. */
  key?: string
  role?: 'session' | 'weekly' | 'model' | 'other' | 'unbounded'
  modelId?: string | null
  active?: boolean
  label: string
  used: number
  limit: number | null
  format: MetricFormat
  /** ISO-8601 instant; clients choose relative or absolute presentation. */
  resetsAt?: string | null
  primary?: boolean
}

export interface BillingResult {
  plan: string | null
  metrics: Metric[]
  error: string | null
  email?: string | null
  displayName?: string | null
  activity?: { series: number[]; summary: string } | null
  modelSpend?: { name: string; usd: number; requests: number }[] | null
  /** When the metrics were actually observed, when older than the fetch itself
   * (e.g. served from an offline snapshot) — lets the UI flag stale data. */
  asOfMs?: number
}

export interface Provider {
  id: ProviderId
  name: string
  color: string
  hasUsage: boolean
  hasBilling: boolean
  detect(homeDir?: string): Promise<boolean>
  fetchSummary?(account: Account, tz: string): Promise<DashboardData>
  fetchTable?(account: Account, tz: string): Promise<TableData>
  fetchBilling?(account: Account, tz: string): Promise<BillingResult>
}
