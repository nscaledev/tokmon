import {
  generateAccountId, pickAccentColor,
  normalizeQuotaSource,
  COLOR_PALETTE, PROVIDER_META, PROVIDER_ORDER,
  type Account, type Config, type ProviderId,
} from '@shared'

export interface AccountDraft {
  mode: 'add' | 'edit'
  editingId: string | null
  /** Auto row this draft is converting to a manual account, if any. */
  convertedFromId: string | null
  providerId: ProviderId
  name: string
  homeDir: string
  color: string
  quotaUrl: string
  apiKeyEnv: string
  hadQuotaSource: boolean
}

export interface AccountDraftDefaults {
  providerId?: ProviderId
  name?: string
  homeDir?: string
  color?: string
  convertedFromId?: string | null
}

export function newDraft(cfg: Config, defaults: AccountDraftDefaults = {}): AccountDraft {
  return {
    mode: 'add', editingId: null,
    convertedFromId: defaults.convertedFromId ?? null,
    providerId: defaults.providerId ?? PROVIDER_ORDER[0],
    name: defaults.name ?? '',
    homeDir: defaults.homeDir ?? '~',
    color: defaults.color ?? pickAccentColor(cfg.accounts),
    quotaUrl: '', apiKeyEnv: '', hadQuotaSource: false,
  }
}

export function toDraft(a: Account): AccountDraft {
  return {
    mode: 'edit', editingId: a.id,
    convertedFromId: null,
    providerId: a.providerId,
    name: a.name, homeDir: a.homeDir,
    color: a.color || PROVIDER_META[a.providerId].color,
    quotaUrl: a.quotaSource?.url ?? '', apiKeyEnv: a.quotaSource?.apiKeyEnv ?? '', hadQuotaSource: Boolean(a.quotaSource),
  }
}

export function previewAccountId(editor: AccountDraft, accounts: Account[]): string {
  const others = editor.mode === 'edit' ? accounts.filter(a => a.id !== editor.editingId) : accounts
  return editor.mode === 'edit'
    ? (editor.editingId ?? '')
    : generateAccountId(editor.name.trim() || 'account', others)
}

export interface AccountSubmission {
  ok: true
  account: Account
  mode: 'add' | 'edit'
  editingId: string | null
  convertedFromId: string | null
}

export type BuildAccountResult = AccountSubmission | { ok: false; error: string }

export function buildAccountFromDraft(editor: AccountDraft, accounts: Account[]): BuildAccountResult {
  const name = editor.name.trim()
  const homeDir = editor.homeDir.trim() || '~'
  if (!name) return { ok: false, error: 'Name required' }
  const hasQuotaSource = Boolean(editor.quotaUrl.trim() || editor.apiKeyEnv.trim())
  const quotaSource = hasQuotaSource
    ? normalizeQuotaSource({ url: editor.quotaUrl, apiKeyEnv: editor.apiKeyEnv }, editor.providerId)
    : editor.hadQuotaSource ? null : undefined
  if (hasQuotaSource && !quotaSource) return { ok: false, error: 'Quota endpoint or API key environment variable is invalid' }
  if (editor.mode === 'add') {
    const id = generateAccountId(name, accounts)
    return {
      ok: true,
      account: { id, providerId: editor.providerId, name, homeDir, color: editor.color, ...(quotaSource !== undefined ? { quotaSource } : {}) },
      mode: 'add',
      editingId: null,
      convertedFromId: editor.convertedFromId,
    }
  }
  return {
    ok: true,
    account: { id: editor.editingId!, providerId: editor.providerId, name, homeDir, color: editor.color, ...(quotaSource !== undefined ? { quotaSource } : {}) },
    mode: 'edit',
    editingId: editor.editingId,
    convertedFromId: null,
  }
}

/**
 * Applies a completed editor submission to the config. Converting an auto row
 * to a manual account mints a fresh id, so an active selection pointing at the
 * auto row would be orphaned by its own conversion; it moves to the new id.
 */
export function applyAccountSubmission(config: Config, submission: AccountSubmission): Config {
  const { account, mode, editingId, convertedFromId } = submission
  if (mode !== 'add') {
    return {
      ...config,
      accounts: config.accounts.map(a => a.id === editingId ? { ...account, enabled: a.enabled } : a),
    }
  }
  return {
    ...config,
    accounts: [...config.accounts, account],
    activeAccountId: convertedFromId !== null && config.activeAccountId === convertedFromId
      ? account.id
      : config.activeAccountId,
  }
}

export { COLOR_PALETTE }
