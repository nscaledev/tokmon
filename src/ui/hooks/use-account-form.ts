import { useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import {
  COLOR_PALETTE, generateAccountId, pickAccentColor,
  normalizeQuotaSource,
  type Config, type Account as StoredAccount, type TrackedAccountRow,
} from '../../config'
import { PROVIDERS, PROVIDER_ORDER, type ProviderId } from '../../providers'
import { FORM_FIELDS, type AccountForm } from '../account-form'

export type AccountFormDefaults =
  Pick<TrackedAccountRow, 'providerId' | 'name' | 'homeDir' | 'color'>
  & { convertedFromId?: string | null }

/**
 * Applies a completed account form to the config. Converting an auto row to a
 * manual account mints a fresh id, so an active selection pointing at the auto
 * row would be orphaned by its own conversion; it moves to the new id instead.
 */
export function applyAccountForm(config: Config, form: AccountForm): Config {
  const { name, homeDir } = form
  const hasQuotaSource = Boolean(form.quotaUrl?.trim() || form.apiKeyEnv?.trim())
  const quotaSource = hasQuotaSource
    ? normalizeQuotaSource({ url: form.quotaUrl, apiKeyEnv: form.apiKeyEnv }, form.providerId)
    : form.hadQuotaSource ? null : undefined
  if (form.mode === 'add') {
    const id = generateAccountId(name, config.accounts)
    const account: StoredAccount = {
      id, providerId: form.providerId, name, homeDir, color: form.color,
      ...(quotaSource !== undefined ? { quotaSource } : {}),
    }
    return {
      ...config,
      accounts: [...config.accounts, account],
      activeAccountId: form.convertedFromId !== null && config.activeAccountId === form.convertedFromId
        ? id
        : config.activeAccountId,
    }
  }
  return {
    ...config,
    accounts: config.accounts.map(a =>
      a.id === form.editingId
        ? { ...a, providerId: form.providerId, name, homeDir, color: form.color, ...(quotaSource !== undefined ? { quotaSource } : {}) }
        : a),
  }
}

export function useAccountForm({ cfg, detected, updateConfig, trackedAccountRows, setSettingsCursor }: {
  cfg: Config
  detected: ProviderId[]
  updateConfig: (fn: (prev: Config) => Config) => void
  trackedAccountRows: TrackedAccountRow[]
  setSettingsCursor: Dispatch<SetStateAction<number>>
}): {
  accountForm: AccountForm | null
  setAccountForm: Dispatch<SetStateAction<AccountForm | null>>
  openAddAccount: (defaults?: AccountFormDefaults) => void
  openConfigureAccount: (row: TrackedAccountRow) => void
  openEditAccount: (acc: StoredAccount) => void
  commitAccountForm: () => void
  cycleFormField: (dir: 1 | -1) => void
  cycleProvider: (dir: 1 | -1) => void
  cycleColor: (dir: 1 | -1) => void
  deleteAccount: (id: string) => void
  moveAccount: (idx: number, dir: -1 | 1) => void
} {
  const [accountForm, setAccountForm] = useState<AccountForm | null>(null)

  function openAddAccount(defaults?: AccountFormDefaults): void {
    const providerId = defaults?.providerId ?? ((detected[0] ?? 'claude') as ProviderId)
    setAccountForm({
      mode: 'add', field: 'provider', providerId,
      name: defaults?.name ?? '', homeDir: defaults?.homeDir ?? '~', quotaUrl: '', apiKeyEnv: '', hadQuotaSource: false, color: defaults?.color ?? pickAccentColor(cfg.accounts),
      caret: defaults?.name?.length ?? 0,
      editingId: null, convertedFromId: defaults?.convertedFromId ?? null, error: null,
    })
  }
  function openConfigureAccount(row: TrackedAccountRow): void {
    // The prefilled name is the row's registered name, never a privacy
    // placeholder: this writes a durable account, not a label.
    openAddAccount({ ...row, convertedFromId: row.id })
  }
  function openEditAccount(acc: StoredAccount): void {
    setAccountForm({
      mode: 'edit', field: 'provider', providerId: acc.providerId,
      name: acc.name, homeDir: acc.homeDir, quotaUrl: acc.quotaSource?.url ?? '', apiKeyEnv: acc.quotaSource?.apiKeyEnv ?? '', hadQuotaSource: Boolean(acc.quotaSource), color: acc.color || PROVIDERS[acc.providerId].color,
      caret: acc.name.length,
      editingId: acc.id, convertedFromId: null, error: null,
    })
  }
  function commitAccountForm(): void {
    if (!accountForm) return
    const name = accountForm.name.trim()
    const homeDir = accountForm.homeDir.trim() || '~'
    if (!name) { setAccountForm({ ...accountForm, error: 'Name required', field: 'name', caret: accountForm.name.length }); return }
    if ((accountForm.quotaUrl || accountForm.apiKeyEnv) && !normalizeQuotaSource({ url: accountForm.quotaUrl, apiKeyEnv: accountForm.apiKeyEnv }, accountForm.providerId)) {
      setAccountForm({ ...accountForm, error: 'Quota endpoint or API key environment variable is invalid', field: 'quotaUrl', caret: accountForm.quotaUrl?.length ?? 0 })
      return
    }
    updateConfig(c => applyAccountForm(c, { ...accountForm, name, homeDir }))
    setAccountForm(null)
  }
  const cycleFormField = useCallback((dir: 1 | -1): void => {
    setAccountForm(f => {
      if (!f) return f
      const i = FORM_FIELDS.indexOf(f.field)
      const next = FORM_FIELDS[(i + dir + FORM_FIELDS.length) % FORM_FIELDS.length]
      const caret = next === 'name' ? f.name.length : next === 'homeDir' ? f.homeDir.length : next === 'quotaUrl' ? (f.quotaUrl?.length ?? 0) : next === 'apiKeyEnv' ? (f.apiKeyEnv?.length ?? 0) : f.caret
      return { ...f, field: next, caret }
    })
  }, [])
  const cycleProvider = useCallback((dir: 1 | -1): void => {
    setAccountForm(f => {
      if (!f) return f
      const i = PROVIDER_ORDER.indexOf(f.providerId)
      return { ...f, providerId: PROVIDER_ORDER[(i + dir + PROVIDER_ORDER.length) % PROVIDER_ORDER.length] }
    })
  }, [])
  const cycleColor = useCallback((dir: 1 | -1): void => {
    setAccountForm(f => {
      if (!f) return f
      const i = COLOR_PALETTE.indexOf(f.color as typeof COLOR_PALETTE[number])
      const idx = i < 0 ? 0 : i
      return { ...f, color: COLOR_PALETTE[(idx + dir + COLOR_PALETTE.length) % COLOR_PALETTE.length] }
    })
  }, [])
  function deleteAccount(id: string): void {
    updateConfig(c => ({
      ...c,
      accounts: c.accounts.filter(a => a.id !== id),
      activeAccountId: c.activeAccountId === id ? null : c.activeAccountId,
    }))
  }
  function moveAccount(idx: number, dir: -1 | 1): void {
    updateConfig(c => {
      const next = [...c.accounts]
      const target = idx + dir
      if (target < 0 || target >= next.length) return c
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return { ...c, accounts: next }
    })
    setSettingsCursor(c => Math.max(0, Math.min(trackedAccountRows.length - 1, c + dir)))
  }

  return {
    accountForm, setAccountForm,
    openAddAccount, openConfigureAccount, openEditAccount, commitAccountForm,
    cycleFormField, cycleProvider, cycleColor, deleteAccount, moveAccount,
  }
}
