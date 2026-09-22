import { withTimeout } from './async'
import { attachOrSpawn } from './client/daemon-handle'
import { createDaemonRpcClient } from './client/daemon-rpc-client'
import {
  buildProvidersReport,
  buildUsageReport,
  formatProvidersReport,
  formatUsageReport,
  type UsageFilters,
} from './cli-query'
import { parseQueryArgs } from './cli-command-args'
import { configLocation } from './config'
import { PROVIDER_IDS } from './providers/types'
import type { WebSnapshot } from './web/contract'
import { SESSION_USAGE_CAPABILITY, type SessionUsageRequest } from './rpc/contract'

export { parseQueryArgs, type ParsedQueryArgs } from './cli-command-args'

export type QueryCommand = 'usage' | 'models' | 'query' | 'providers' | 'snapshot'

export interface QueryCommandDependencies {
  fetchSnapshot?: typeof fetchDaemonSnapshot
  configPath?: () => string
}

const QUERY_HELP = `tokmon usage - Query model usage without opening the TUI

Usage:
  tokmon usage [options]
  tokmon models [options]       Alias for usage
  tokmon query [options]        Alias for usage

Options:
      --period <value>          today | week | month | all (default: all with --session, otherwise month)
      --provider <id>           Filter by provider (${PROVIDER_IDS.join(', ')})
      --account <id-or-name>    Filter by account id, name, or email
      --model <substring>       Filter model names
  -s, --session <id>            Exact Claude/Codex session or Cursor conversation only (no children)
      --json                    Stable machine-readable JSON (schemaVersion: 1)
      --compact                 Emit compact JSON instead of pretty JSON
      --cached                  Skip the default local-history refresh
      --refresh                 Refresh all usage and billing before reading
      --timeout <seconds>       Startup/refresh timeout (default: 45)
  -h, --help                    Show this help

Examples:
  tokmon usage
  tokmon usage --period week --provider codex
  tokmon usage --model opus --json
  tokmon usage --period all --json --compact
  tokmon usage --session SESSION_ID --provider codex --json --compact
`

const PROVIDERS_HELP = `tokmon providers - Show detected accounts and their local data/config locations

Usage:
  tokmon providers [options]

Options:
      --json                    Stable machine-readable JSON (schemaVersion: 1)
      --compact                 Emit compact JSON instead of pretty JSON
      --refresh                 Refresh usage and billing before reading
      --timeout <seconds>       Startup/refresh timeout (default: 45)
  -h, --help                    Show this help

Examples:
  tokmon providers
  tokmon providers --json
`

const SNAPSHOT_HELP = `tokmon snapshot - Print the daemon's complete raw snapshot as JSON

Usage:
  tokmon snapshot [options]

Options:
      --refresh                 Refresh all usage and billing before reading
      --compact                 Emit compact JSON instead of pretty JSON
      --timeout <seconds>       Startup/refresh timeout (default: 45)
  -h, --help                    Show this help
`

function isSnapshot(value: unknown): value is WebSnapshot {
  const snapshot = value as Partial<WebSnapshot> | null
  return !!snapshot
    && typeof snapshot.generatedAt === 'number'
    && typeof snapshot.tz === 'string'
    && Array.isArray(snapshot.accounts)
    && Array.isArray(snapshot.providers)
}

const delay = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

export async function fetchDaemonSnapshot(
  timeoutMs: number,
  refresh: 'table' | 'all' | null,
  session?: Pick<SessionUsageRequest, 'sessionId' | 'provider' | 'account'>,
): Promise<WebSnapshot> {
  const handle = await attachOrSpawn({ timeoutMs })
  if (handle.kind !== 'spawned' || !handle.baseUrl) throw new Error(handle.issue?.message ?? 'tokmon daemon is unavailable')
  const deadline = Date.now() + timeoutMs

  if (refresh || session) {
    const client = createDaemonRpcClient(handle.baseUrl, {
      transport: 'node',
      reconnectAttempts: 2,
      reconnectBaseDelayMs: 100,
      requestTimeoutMs: timeoutMs,
    })
    try {
      // A provider failure still leaves useful partial data in the snapshot.
      // Query commands report per-source states instead of discarding all data.
      if (session) {
        const state = await client.getConfig()
        if (!state.protocol.capabilities.includes(SESSION_USAGE_CAPABILITY)) {
          throw new Error('The running daemon does not support session queries; update/restart Tokmon')
        }
      }
      if (refresh && (!session || refresh === 'all')) {
        await withTimeout(client.refresh(refresh), timeoutMs).catch(() => {})
      }
      if (session) return await withTimeout(client.sessionUsage({ ...session,
        cached: refresh === null, refresh: refresh === 'all',
      }), timeoutMs)
    } finally {
      await client.close().catch(() => {})
    }
  }

  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now())
      const response = await fetch(`${handle.baseUrl}/api/data`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(2_000, remaining)),
      })
      if (response.ok) {
        const body = await response.json() as unknown
        if (isSnapshot(body)) return body
      }
    } catch {}
    await delay(100)
  }
  throw new Error(`snapshot unavailable after ${timeoutMs / 1_000}s`)
}

function json(value: unknown, compact: boolean): string {
  return JSON.stringify(value, null, compact ? undefined : 2) + '\n'
}

function rejectsOption(args: string[], names: string[]): string | null {
  for (const arg of args) {
    const name = names.find(candidate => arg === candidate || arg.startsWith(`${candidate}=`))
    if (name) return name
  }
  return null
}

export function queryHelp(command: QueryCommand): string {
  if (command === 'providers') return PROVIDERS_HELP
  if (command === 'snapshot') return SNAPSHOT_HELP
  return QUERY_HELP
}

export async function runQueryCommand(
  command: QueryCommand,
  args: string[],
  dependencies: QueryCommandDependencies = {},
): Promise<string> {
  const parsed = parseQueryArgs(args)
  if (parsed.help) return queryHelp(command)
  const getConfigPath = dependencies.configPath ?? configLocation

  if (command === 'providers' || command === 'snapshot') {
    const invalid = rejectsOption(args, ['--period', '--provider', '--account', '--model', '--session', '-s', '--cached', '--no-refresh'])
    if (invalid) throw new Error(`${invalid} is only valid for tokmon usage`)
  }
  if (parsed.positionals.length) throw new Error(`unexpected argument: ${parsed.positionals[0]}`)

  const usageCommand = command === 'usage' || command === 'models' || command === 'query'
  const refresh = parsed.refresh ? 'all' : usageCommand && !parsed.cached ? 'table' : null
  const session = parsed.session ? {
    sessionId: parsed.session,
    ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
    ...(parsed.account === undefined ? {} : { account: parsed.account }),
  } : undefined
  const snapshot = await (dependencies.fetchSnapshot ?? fetchDaemonSnapshot)(parsed.timeoutMs, refresh, session)

  if (command === 'snapshot') return json(snapshot, parsed.compact)
  if (command === 'providers') {
    const report = await buildProvidersReport(snapshot, getConfigPath())
    return parsed.json ? json(report, parsed.compact) : `${formatProvidersReport(report)}\n`
  }

  const filters: UsageFilters = {
    period: parsed.period,
    provider: parsed.provider,
    account: parsed.account,
    model: parsed.model,
    session: parsed.session,
  }
  const report = await buildUsageReport(snapshot, filters, Date.now(), getConfigPath())
  return parsed.json ? json(report, parsed.compact) : `${formatUsageReport(report)}\n`
}
