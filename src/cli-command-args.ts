import { USAGE_PERIODS, type UsagePeriod } from './cli-query'
import { PROVIDER_IDS, type ProviderId } from './providers/types'

export interface ParsedQueryArgs {
  help: boolean
  json: boolean
  compact: boolean
  refresh: boolean
  cached: boolean
  timeoutMs: number
  period: UsagePeriod
  provider?: ProviderId
  account?: string
  model?: string
  session?: string
  positionals: string[]
}

function valueAfter(args: string[], index: number, name: string): [string, number] {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`)
  return [value, index + 1]
}

export function parseQueryArgs(args: string[]): ParsedQueryArgs {
  const parsed: ParsedQueryArgs = {
    help: false,
    json: false,
    compact: false,
    refresh: false,
    cached: false,
    timeoutMs: 45_000,
    period: 'month',
    positionals: [],
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--compact') parsed.compact = true
    else if (arg === '--refresh') parsed.refresh = true
    else if (arg === '--cached' || arg === '--no-refresh') parsed.cached = true
    else if (arg === '--period') {
      const [value, next] = valueAfter(args, index, '--period'); index = next
      if (!USAGE_PERIODS.includes(value as UsagePeriod)) {
        throw new Error(`--period must be one of: ${USAGE_PERIODS.join(', ')}`)
      }
      parsed.period = value as UsagePeriod
    } else if (arg.startsWith('--period=')) {
      const value = arg.slice('--period='.length)
      if (!USAGE_PERIODS.includes(value as UsagePeriod)) {
        throw new Error(`--period must be one of: ${USAGE_PERIODS.join(', ')}`)
      }
      parsed.period = value as UsagePeriod
    } else if (arg === '--provider') {
      const [value, next] = valueAfter(args, index, '--provider'); index = next
      if (!PROVIDER_IDS.includes(value as ProviderId)) throw new Error(`unknown provider: ${value}`)
      parsed.provider = value as ProviderId
    } else if (arg.startsWith('--provider=')) {
      const value = arg.slice('--provider='.length)
      if (!PROVIDER_IDS.includes(value as ProviderId)) throw new Error(`unknown provider: ${value}`)
      parsed.provider = value as ProviderId
    } else if (arg === '--account') {
      [parsed.account, index] = valueAfter(args, index, '--account')
    } else if (arg.startsWith('--account=')) {
      parsed.account = arg.slice('--account='.length)
      if (!parsed.account) throw new Error('--account requires a value')
    }
    else if (arg === '--session' || arg === '-s') {
      [parsed.session, index] = valueAfter(args, index, arg)
    } else if (arg.startsWith('--session=')) {
      parsed.session = arg.slice('--session='.length)
    }
    else if (arg === '--model') {
      [parsed.model, index] = valueAfter(args, index, '--model')
    } else if (arg.startsWith('--model=')) {
      parsed.model = arg.slice('--model='.length)
      if (!parsed.model) throw new Error('--model requires a value')
    }
    else if (arg === '--timeout') {
      const [value, next] = valueAfter(args, index, '--timeout'); index = next
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) throw new Error('--timeout must be greater than 0 and at most 300 seconds')
      parsed.timeoutMs = seconds * 1_000
    } else if (arg.startsWith('--timeout=')) {
      const seconds = Number(arg.slice('--timeout='.length))
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) throw new Error('--timeout must be greater than 0 and at most 300 seconds')
      parsed.timeoutMs = seconds * 1_000
    } else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else parsed.positionals.push(arg)
  }
  if (parsed.compact) parsed.json = true
  if (parsed.session !== undefined && !/^\S{1,200}$/.test(parsed.session)) {
    throw new Error('--session requires an ID of 1–200 non-whitespace characters')
  }
  if (parsed.refresh && parsed.cached) throw new Error('--refresh and --cached cannot be used together')
  return parsed
}
