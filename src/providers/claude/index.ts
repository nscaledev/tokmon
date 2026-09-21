import { PROVIDER_META } from '../../config-schema'
import type { Provider } from '../types'
import { detectClaude, claudeDashboard, claudeTable, claudeSessionTable } from './usage'
import { claudeBilling } from './billing'

export const claudeProvider: Provider = {
  id: 'claude',
  ...PROVIDER_META.claude,
  hasUsage: true,
  hasBilling: true,
  detect: (homeDir) => detectClaude(homeDir),
  fetchSummary: (account, tz) => claudeDashboard(tz, account.homeDir),
  fetchTable: (account, tz) => claudeTable(tz, account.homeDir),
  fetchSessionTable: (account, tz, sessionId) => claudeSessionTable(tz, sessionId, account.homeDir),
  fetchBilling: (account) => claudeBilling(account),
}
