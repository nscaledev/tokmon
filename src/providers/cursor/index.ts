import { PROVIDER_META } from '../../config-schema'
import type { Provider } from '../types'
import { detectCursor, cursorBilling } from './billing'
import { cursorDashboard, cursorTableFull, cursorSessionTable } from './usage'

export const cursorProvider: Provider = {
  id: 'cursor',
  ...PROVIDER_META.cursor,
  hasUsage: true,
  hasBilling: true,
  detect: (homeDir) => detectCursor(homeDir),
  fetchSummary: (account, tz) => cursorDashboard(tz, account.homeDir),
  fetchTable: (account, tz) => cursorTableFull(tz, account.homeDir),
  fetchSessionTable: (account, tz, sessionId, refresh) => cursorSessionTable(tz, sessionId, account.homeDir, refresh),
  fetchBilling: (account, tz) => cursorBilling(account, tz),
}
