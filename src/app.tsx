import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { useMouse } from '@zenobius/ink-mouse'
import {
  DEFAULTS, getTrackedAccountRows, setProviderTrackingEnabled,
  type Config,
} from './config'
import { buildAccounts, accountsByProvider } from './accounts'
import {
  PROVIDERS, PROVIDER_ORDER, detectAccountProviders, detectInstalledProviders,
  type Account, type ProviderId,
} from './providers'
import { resolveTimezone } from './tz'
import { glyphs } from './ui/glyphs'
import * as fmt from './ui/format'
import type { WebServerController } from './web/server'
import { Spinner, TabBar, PeakBadge, dispatchLinkClicks } from './ui/shared'
import { DashboardView, computeDashLayout, TotalsRow } from './ui/dashboard'
import { TableProviderBar, ControlBar, TokenTable } from './ui/table'
import { Onboarding, type OnboardItem } from './ui/onboarding'
import { LoadingView, accountReady, statsReadyInput, type ReadyInput } from './ui/loading'
import {
  SettingsView, DESKTOP_FIXED_ROWS, GENERAL_ROWS, THEME_ROWS,
  type AccountIdentity, type SettingsTab,
} from './ui/settings'
import { derivePrivacyLabels, deriveSlots, findActiveSlot, computeChrome } from './ui/app-layout.logic'
import { ResizingView } from './ui/resizing'
import { AccountStrip } from './ui/account-strip'
import { Footer } from './ui/footer'
import { TinyFallback } from './ui/tiny-fallback'
import { RefreshStatusLine } from './ui/refresh-status'
import { useDaemon } from './client/use-daemon'
import { toStatsMap, pickTable } from './client/snapshot-adapter'
import {
  TABS, VIEWS, SORTS,
  type Slot,
  acctKey, clampCaret, spliceInsert,
  sortLabel, sortRows, filterTokenRows,
  tableModelOptions, cycleTableModel, filterRowsByModel,
} from './ui/app.logic'
import { openUrl, IS_TTY } from './ui/terminal'
import { handleKey, handleTerminalFocusInput } from './ui/keybindings'
import { useTerminalSize } from './ui/hooks/use-terminal-size'
import { usePaste } from './ui/hooks/use-paste'
import { useLoader } from './ui/hooks/use-loader'
import { useDegradedPolling } from './ui/hooks/use-degraded-polling'
import { useRefreshAll } from './ui/hooks/use-refresh-all'
import { useConfigState } from './ui/hooks/use-config-state'
import { useAccountForm } from './ui/hooks/use-account-form'
import { TuiThemeProvider, useTuiTheme } from './ui/theme'

export function App({ interval: cliInterval, initialConfig, baseUrl = null, mode = 'degraded', degradedMessage }: {
  interval?: number
  initialConfig?: Config
  baseUrl?: string | null
  mode?: 'connected' | 'degraded'
  degradedMessage?: string
}) {
  const connected = mode === 'connected' && baseUrl !== null
  const degraded = !connected
  const daemon = useDaemon(connected ? baseUrl : null)

  const { config, configSaveError, updateConfig } = useConfigState({
    initialConfig,
    cliInterval,
    connected,
    daemon,
  })
  const [detected, setDetected] = useState<ProviderId[]>([])
  const [detectedAccounts, setDetectedAccounts] = useState<ProviderId[]>([])
  const [tab, setTab] = useState(0)
  const [view, setView] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [expanded, setExpanded] = useState(-1)
  const [sort, setSort] = useState(1)
  const [tableProvider, setTableProvider] = useState<ProviderId | null>(null)
  const [tableModel, setTableModel] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [settingsCursor, setSettingsCursor] = useState(0)
  const [tzEdit, setTzEdit] = useState<string | null>(null)
  const [tzError, setTzError] = useState<string | null>(null)
  const [tzCaret, setTzCaret] = useState(0)
  const [allowedHostsEdit, setAllowedHostsEdit] = useState<string | null>(null)
  const [allowedHostsError, setAllowedHostsError] = useState<string | null>(null)
  const [allowedHostsCaret, setAllowedHostsCaret] = useState(0)
  const [searchCaret, setSearchCaret] = useState(0)
  const [onboardSel, setOnboardSel] = useState<ProviderId[] | null>(null)
  const [onboardCursor, setOnboardCursor] = useState(0)
  const [dashPage, setDashPage] = useState(0)
  const { exit } = useApp()
  const { cols, rows, resizing, live } = useTerminalSize()

  const webRef = useRef<WebServerController | null>(null)
  const webStartingRef = useRef(false)
  useEffect(() => () => { void webRef.current?.stop() }, [])

  const cfg = config ?? DEFAULTS
  const interval = cliInterval ?? cfg.interval * 1000
  const billingMs = cfg.billingInterval * 60_000
  const tz = resolveTimezone(cfg.timezone)
  const configReady = config !== null
  const snapshot = daemon.snapshot
  const daemonDetected = useMemo(
    () => [...new Set((snapshot?.accounts ?? []).map(account => account.providerId))],
    [snapshot],
  )
  const detectedProviders = useMemo(
    () => [...new Set([...(snapshot?.installedProviders ?? detected), ...daemonDetected])],
    [daemonDetected, detected, snapshot?.installedProviders],
  )
  const detectedAccountProviders = connected ? daemonDetected : detectedAccounts

  const accounts = useMemo(() => connected
    ? (snapshot?.accounts ?? []).map(account => ({
        id: account.id,
        providerId: account.providerId,
        name: account.name,
        color: account.color,
        homeDir: account.homeDir ?? undefined,
        source: account.source,
      }))
    : buildAccounts(cfg, detectedAccountProviders), [cfg, connected, detectedAccountProviders, snapshot])
  const trackedAccountRows = useMemo(
    () => getTrackedAccountRows(cfg, detectedAccountProviders, accounts, snapshot?.suppressedAccounts),
    [cfg, detectedAccountProviders, accounts, snapshot?.suppressedAccounts],
  )
  const settingsRowCount = settingsTab === 'general'
    ? GENERAL_ROWS
    : settingsTab === 'theme'
      ? THEME_ROWS
      : settingsTab === 'desktop'
        ? DESKTOP_FIXED_ROWS
      : settingsTab === 'providers'
          ? PROVIDER_ORDER.length + 1
          : trackedAccountRows.length + 1
  const accountsRef = useRef<Account[]>([])
  accountsRef.current = accounts
  const rowCountRef = useRef(0)
  const tabRef = useRef(0)
  tabRef.current = tab
  const dashPageCountRef = useRef(1)
  const tzValueRef = useRef('')
  const tzCaretRef = useRef(0)
  const allowedHostsValueRef = useRef('')
  const allowedHostsCaretRef = useRef(0)
  const searchValueRef = useRef('')
  const searchCaretRef = useRef(0)
  const accountsKey = useMemo(() => accounts.map(acctKey).join('|'), [accounts])

  const allGroups = useMemo(() => accountsByProvider(accounts), [accounts])
  const tableProvs = useMemo(
    () => allGroups.map(g => g.provider).filter(pid => PROVIDERS[pid].hasUsage),
    [allGroups],
  )
  const effTableProvider = (tableProvider && tableProvs.includes(tableProvider)) ? tableProvider : (tableProvs[0] ?? null)
  const tableAccounts = useMemo(
    () => effTableProvider ? accounts.filter(a => a.providerId === effTableProvider) : [],
    [accounts, effTableProvider],
  )

  const needsOnboarding = configReady && !cfg.onboarded
  const newProviders = configReady && cfg.onboarded
    ? PROVIDER_ORDER.filter(p => !cfg.knownProviders.includes(p) && detectedProviders.includes(p))
    : []
  const showPicker = needsOnboarding || newProviders.length > 0

  const {
    statsLocal,
    peakLocal,
    updatedLocal,
    tableLocal,
    tableLoading,
    refreshAll: refreshAllDegraded,
  } = useDegradedPolling({
    degraded,
    configReady,
    showPicker,
    accountsKey,
    accountsRef,
    interval,
    billingMs,
    tz,
    activeTableProvider: effTableProvider,
    tableVisible: tab === 1,
  })

  const daemonRefreshRef = useRef(daemon.refresh)
  const degradedRefreshRef = useRef(refreshAllDegraded)
  daemonRefreshRef.current = daemon.refresh
  degradedRefreshRef.current = refreshAllDegraded
  const requestDaemonRefresh = useCallback(() => daemonRefreshRef.current('all'), [])
  const requestDegradedRefresh = useCallback(() => degradedRefreshRef.current(), [])
  const { status: refreshStatus, refreshAll } = useRefreshAll({
    connected,
    requestDaemonRefresh,
    requestDegradedRefresh,
  })
  const stats = useMemo(
    () => connected ? toStatsMap(snapshot, accounts) : statsLocal,
    [connected, snapshot, accounts, statsLocal],
  )
  const accountIdentities = useMemo(() => {
    const out = new Map<string, AccountIdentity>()
    for (const [id, stat] of stats) {
      const billing = stat.billing
      if (!billing) continue
      out.set(id, {
        email: billing.email ?? null,
        displayName: billing.displayName ?? null,
        plan: billing.plan ?? null,
      })
    }
    return out
  }, [stats])
  const showPeak = accounts.some(a => a.providerId === 'claude')
  const peak = connected ? (showPeak ? (snapshot?.peak ?? null) : null) : peakLocal
  const updated = useMemo(
    () => connected ? new Date(snapshot?.generatedAt ?? Date.now()) : updatedLocal,
    [connected, snapshot, updatedLocal],
  )
  const intervalLabel = connected && snapshot?.intervalMs
    ? Math.round(snapshot.intervalMs / 1000)
    : cfg.interval
  const billingIntervalMs = connected && snapshot?.billingIntervalMs
    ? snapshot.billingIntervalMs
    : cfg.billingInterval * 60_000
  const billingIntervalLabel = connected && snapshot?.billingIntervalMs
    ? Math.max(1, Math.round(snapshot.billingIntervalMs / 60_000))
    : cfg.billingInterval
  const readyInputFor = useCallback((id: string): ReadyInput | undefined => {
    if (connected) {
      const wa = snapshot?.accounts.find(a => a.id === id)
      if (!wa) return undefined
      return { summaryState: wa.summaryState, billingState: wa.billingState, billing: wa.billing }
    }
    return statsReadyInput(statsLocal.get(id))
  }, [connected, snapshot, statsLocal])

  // Built once so the account strip and the settings list can never disagree
  // with the dashboard about who an account is.
  const privacyLabels = useMemo(() => derivePrivacyLabels({
    privacyMode: cfg.privacyMode,
    rows: [...trackedAccountRows, ...accounts],
    resolved: connected ? (snapshot?.accounts ?? []) : accounts,
  }), [accounts, cfg.privacyMode, connected, snapshot, trackedAccountRows])

  const slots: Slot[] = useMemo(
    () => deriveSlots(accounts, cfg.privacyMode, privacyLabels),
    [accounts, cfg.privacyMode, privacyLabels],
  )
  const { activeSlotIdx, focusId } = useMemo(
    () => findActiveSlot(slots, cfg.activeAccountId),
    [slots, cfg.activeAccountId],
  )
  const visibleAccounts = useMemo(
    () => focusId === null ? accounts : accounts.filter(a => a.id === focusId),
    [accounts, focusId],
  )
  const groups = useMemo(
    () => focusId === null ? allGroups : accountsByProvider(visibleAccounts),
    [allGroups, visibleAccounts, focusId],
  )

  const TOO_SMALL = cols < 40 || rows < 12

  const allReady = accounts.length > 0 && accounts.every(a => accountReady(readyInputFor(a.id), a.providerId))

  const { gridBudget } = useMemo(() => computeChrome(slots, cols, rows), [slots, cols, rows])
  const dashLayout = useMemo(
    () => computeDashLayout(groups, stats, cols, gridBudget, focusId, cfg.dashboardLayout, billingIntervalMs),
    [groups, stats, cols, gridBudget, focusId, cfg.dashboardLayout, billingIntervalMs],
  )
  const dashPageCount = dashLayout.pageCount
  const dashPaginated = dashPageCount > 1
  dashPageCountRef.current = dashPageCount

  tzValueRef.current = tzEdit ?? ''
  tzCaretRef.current = clampCaret(tzCaret, (tzEdit ?? '').length)
  allowedHostsValueRef.current = allowedHostsEdit ?? ''
  allowedHostsCaretRef.current = clampCaret(allowedHostsCaret, (allowedHostsEdit ?? '').length)
  searchValueRef.current = search
  searchCaretRef.current = clampCaret(searchCaret, search.length)

  const isPrintable = (input: string, key: { ctrl: boolean; meta: boolean }): boolean =>
    !!input && !key.ctrl && !key.meta && !isPasteInput(input)

  const insertText = (text: string): void => {
    if (showSettings && accountForm && ['name', 'homeDir', 'quotaUrl', 'apiKeyEnv'].includes(accountForm.field)) {
      setAccountForm(f => {
        if (!f || (f.field !== 'name' && f.field !== 'homeDir' && f.field !== 'quotaUrl' && f.field !== 'apiKeyEnv')) return f
        const r = spliceInsert(f[f.field] ?? '', f.caret, text)
        return { ...f, [f.field]: r.value, caret: r.caret, error: null }
      })
    } else if (showSettings && tzEdit !== null) {
      const r = spliceInsert(tzValueRef.current, tzCaretRef.current, text)
      tzValueRef.current = r.value; tzCaretRef.current = r.caret
      setTzEdit(r.value); setTzCaret(r.caret); setTzError(null)
    } else if (showSettings && allowedHostsEdit !== null) {
      const r = spliceInsert(allowedHostsValueRef.current, allowedHostsCaretRef.current, text)
      allowedHostsValueRef.current = r.value; allowedHostsCaretRef.current = r.caret
      setAllowedHostsEdit(r.value); setAllowedHostsCaret(r.caret); setAllowedHostsError(null)
    } else if (tab === 1 && searchMode) {
      const r = spliceInsert(searchValueRef.current, searchCaretRef.current, text)
      searchValueRef.current = r.value; searchCaretRef.current = r.caret
      setSearch(r.value); setSearchCaret(r.caret)
    }
  }
  const { handlePasteData, isPasteInput } = usePaste(insertText)

  const SORTS_FOR = SORTS

  const tableAccountIds = useMemo(() => tableAccounts.map(a => a.id), [tableAccounts])
  const table = useMemo(
    () => connected ? pickTable(snapshot, tableAccountIds) : tableLocal,
    [connected, snapshot, tableAccountIds, tableLocal],
  )

  const { showLoader } = useLoader({
    configReady, showPicker, accountsKey, allReady,
    tooSmall: TOO_SMALL, showSettings, accountsCount: accounts.length,
  })
  const pickerProviders = needsOnboarding ? PROVIDER_ORDER : newProviders
  const onboardEnabled = onboardSel ?? detectedProviders
  const onboardItems: OnboardItem[] = pickerProviders.map(pid => ({
    id: pid, name: PROVIDERS[pid].name, color: PROVIDERS[pid].color,
    detected: detectedProviders.includes(pid), enabled: onboardEnabled.includes(pid),
  }))

  useEffect(() => {
    void Promise.all([detectInstalledProviders(), detectAccountProviders()]).then(([installed, accounts]) => {
      setDetected(installed)
      setDetectedAccounts(accounts)
    })
  }, [])

  const tableKey = useMemo(
    () => `${effTableProvider}|${tableAccounts.map(acctKey).join(',')}|${tz}`,
    [effTableProvider, tableAccounts, tz],
  )
  useEffect(() => {
    setCursor(0); setExpanded(-1)
    setTableModel(null)
    setSort(1)
  }, [tableKey])

  useEffect(() => { setCursor(0); setExpanded(-1) }, [search, tableModel])

  useEffect(() => { setDashPage(p => Math.min(p, dashPageCount - 1)) }, [dashPageCount])
  useEffect(() => {
    setSettingsCursor(c => Math.max(-1, Math.min(c, settingsRowCount - 1)))
  }, [settingsRowCount])

  const resetView = useCallback(() => { setCursor(0); setExpanded(-1) }, [])
  const clampRow = (n: number) => Math.max(0, Math.min(rowCountRef.current - 1, n))

  const mouse = useMouse()
  useEffect(() => {
    if (!IS_TTY) return
    mouse.enable()
    if (process.stdout.isTTY) {
      try { process.stdout.write('\x1b[?1003l\x1b[?1002l\x1b[?1015l') } catch {}
    }
    const onScroll = (_pos: { x: number; y: number }, dir: string | null) => {
      const up = dir === 'scrollup'
      const t = tabRef.current
      if (t === 1) {
        setCursor(c => up ? Math.max(0, c - 3) : clampRow(c + 3))
      } else if (t === 0 && dashPageCountRef.current > 1) {
        setDashPage(p => up ? Math.max(0, p - 1) : Math.min(dashPageCountRef.current - 1, p + 1))
      }
    }
    mouse.events.on('scroll', onScroll)
    const onData = (d: Buffer | string) => { if (!handlePasteData(d)) dispatchLinkClicks(d) }
    process.stdin.on('data', onData)
    return () => { mouse.events.off('scroll', onScroll); process.stdin.off('data', onData) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleOnboard(i: number): void {
    if (i < 0 || i >= pickerProviders.length) return
    const pid = pickerProviders[i]
    setOnboardSel(prev => {
      const base = prev ?? detectedProviders
      return base.includes(pid) ? base.filter(p => p !== pid) : [...base, pid]
    })
  }
  function toggleProvider(pid: ProviderId): void {
    updateConfig(c => setProviderTrackingEnabled(c, pid, c.disabledProviders.includes(pid)))
  }
  function confirmOnboarding(): void {
    const enabled = onboardEnabled
    updateConfig(c => {
      if (!c.onboarded) {
        return {
          ...c,
          disabledProviders: PROVIDER_ORDER.filter(p => !enabled.includes(p)),
          knownProviders: [...PROVIDER_ORDER],
          onboarded: true,
        }
      }
      const newlyDisabled = pickerProviders.filter(p => !enabled.includes(p))
      return {
        ...c,
        disabledProviders: [...new Set([...c.disabledProviders, ...newlyDisabled])],
        knownProviders: [...new Set([...c.knownProviders, ...pickerProviders])],
      }
    })
    setOnboardSel(null)
    setOnboardCursor(0)
  }

  const cycleAccount = useCallback((dir: 1 | -1): void => {
    if (slots.length <= 1) return
    const next = (activeSlotIdx + dir + slots.length) % slots.length
    updateConfig(c => ({ ...c, activeAccountId: slots[next].id }))
    resetView()
  }, [slots, activeSlotIdx, updateConfig, resetView])

  const cycleTableProvider = useCallback((dir: 1 | -1): void => {
    if (tableProvs.length <= 1) return
    const cur = effTableProvider ? tableProvs.indexOf(effTableProvider) : 0
    const nextProv = tableProvs[(cur + dir + tableProvs.length) % tableProvs.length]
    setTableProvider(nextProv)
    setSort(1)
    setCursor(0); setExpanded(-1); setTableModel(null); setSearch(''); setSearchCaret(0); setSearchMode(false)
  }, [tableProvs, effTableProvider])

  const {
    accountForm, setAccountForm,
    openAddAccount, openConfigureAccount, openEditAccount, commitAccountForm,
    cycleFormField, cycleProvider, cycleColor, deleteAccount, moveAccount,
  } = useAccountForm({ cfg, detected: detectedProviders, updateConfig, trackedAccountRows, setSettingsCursor })

  async function toggleWeb(): Promise<void> {
    if (connected) {
      if (baseUrl) openUrl(baseUrl)
      return
    }
    if (webRef.current) { openUrl(webRef.current.url); return }
    if (webStartingRef.current) return
    webStartingRef.current = true
    try {
      const { startWebServer } = await import('./web/server')
      const ctrl = await startWebServer({ config: cfg, log: false })
      webRef.current = ctrl
      openUrl(ctrl.url)
    } catch {} finally {
      webStartingRef.current = false
    }
  }

  const onTabSelect = useCallback((i: number) => { setTab(i); resetView() }, [resetView])
  const onStripSelect = useCallback((i: number) => {
    updateConfig(c => ({ ...c, activeAccountId: slots[i].id })); resetView()
  }, [slots, updateConfig, resetView])
  const onProviderSelect = useCallback((p: ProviderId) => {
    setTableProvider(p); setCursor(0); setExpanded(-1); setTableModel(null); setSearch(''); setSearchCaret(0); setSearchMode(false)
  }, [])
  const onRowClickToken = useCallback((idx: number) => {
    if (idx === cursor) setExpanded(e => e === idx ? -1 : idx); else setCursor(idx)
  }, [cursor])

  const rawTokenRows = useMemo(
    () => tab === 1 ? (table ? [table.daily, table.weekly, table.monthly][view] : []) : [],
    [tab, table, view],
  )
  const tokenModelOptions = useMemo(() => tableModelOptions(rawTokenRows), [rawTokenRows])
  useEffect(() => {
    if (tableModel && !tokenModelOptions.includes(tableModel)) setTableModel(null)
  }, [tableModel, tokenModelOptions])
  const cycleTableModelFilter = useCallback((dir: 1 | -1): void => {
    setTableModel(cur => cycleTableModel(cur, tokenModelOptions, dir))
    resetView()
  }, [tokenModelOptions, resetView])
  const activeTableModel = tableModel && tokenModelOptions.includes(tableModel) ? tableModel : null
  const tokenRows = useMemo(
    () => tab === 1
      ? sortRows(filterTokenRows(filterRowsByModel(rawTokenRows, activeTableModel), search), sort)
      : [],
    [tab, rawTokenRows, activeTableModel, search, sort],
  )

  useInput((input, key) => {
    if (handleTerminalFocusInput(input)) return
    handleKey(input, key, {
    onboarding: {
      show: showPicker, providers: pickerProviders, cursor: onboardCursor,
      setCursor: setOnboardCursor, toggle: toggleOnboard, confirm: confirmOnboarding,
    },
    accountEditor: {
      form: accountForm, setForm: setAccountForm, commit: commitAccountForm,
      cycleField: cycleFormField, cycleProvider, cycleColor,
    },
    timezoneEditor: {
      value: tzEdit, setValue: setTzEdit, setError: setTzError,
      setCaret: setTzCaret, valueRef: tzValueRef, caretRef: tzCaretRef,
    },
    allowedHostsEditor: {
      value: allowedHostsEdit, setValue: setAllowedHostsEdit, setError: setAllowedHostsError,
      setCaret: setAllowedHostsCaret, valueRef: allowedHostsValueRef, caretRef: allowedHostsCaretRef,
    },
    textInput: { isPrintable, insert: insertText },
    settings: {
      show: showSettings, setShow: setShowSettings, cursor: settingsCursor,
      tab: settingsTab, setTab: setSettingsTab, setCursor: setSettingsCursor,
      trackedAccounts: trackedAccountRows, moveAccount, toggleProvider,
      openEditAccount, openConfigureAccount, deleteAccount, openAddAccount,
    },
    table: {
      tab, searchMode, setSearchMode, search, setSearch, setSearchCaret,
      searchValueRef, searchCaretRef, cycleProvider: cycleTableProvider,
      setExpanded, setSort, sorts: SORTS_FOR,
      cycleModel: cycleTableModelFilter,
      setView, cursor, rowCountRef, rows, setCursor, clampRow,
    },
    dashboard: { paginated: dashPaginated, pageCount: dashPageCount, setPage: setDashPage },
    global: {
      exit, showLoader, configReady, toggleWeb, config: cfg, updateConfig,
      cycleAccount, setTab, resetView, slots, refreshAll,
    },
    })
  }, { isActive: IS_TTY })

  if (!config) return <Box padding={1}><Text dimColor>Loading...</Text></Box>

  if (resizing) return <TuiThemeProvider appearance={cfg.appearance}><ResizingView cols={live.cols} rows={live.rows} /></TuiThemeProvider>

  if (showPicker) {
    return (
      <TuiThemeProvider appearance={cfg.appearance}>
        <Box flexDirection="column" paddingX={2} paddingY={1} height={rows}>
          <Onboarding
            items={onboardItems} cursor={onboardCursor} onToggle={toggleOnboard} onConfirm={confirmOnboarding}
            heading={needsOnboarding ? 'Welcome to tokmon' : 'New providers detected'}
            subheading={needsOnboarding
              ? 'Pick the tools you want to track. You can change this anytime in settings.'
              : 'tokmon found these installed since you last set up. Pick which to track.'}
          />
        </Box>
      </TuiThemeProvider>
    )
  }

  if (showLoader) {
    return (
      <TuiThemeProvider appearance={cfg.appearance}>
        <Box flexDirection="column" paddingX={2} paddingY={1} height={rows} overflow="hidden">
          <LoadingView groups={allGroups} stats={stats} cols={cols} rows={rows} readyInput={readyInputFor} privacyMode={cfg.privacyMode} />
        </Box>
      </TuiThemeProvider>
    )
  }

  if (TOO_SMALL && !showSettings) {
    return <TuiThemeProvider appearance={cfg.appearance}><TinyFallback groups={groups} stats={stats} rows={rows} cols={cols} refreshStatus={refreshStatus} /></TuiThemeProvider>
  }

  rowCountRef.current = tokenRows.length

  return (
    <TuiThemeProvider appearance={cfg.appearance}>
      <Box flexDirection="column" paddingX={2} paddingY={1} height={rows} overflow="hidden">
      <Box justifyContent="space-between">
        <Box>
          <ThemedBrand />
          <Text dimColor>  {glyphs().middot}  usage {intervalLabel}s  {glyphs().middot}  limits {billingIntervalLabel}m</Text>
        </Box>
        <Box>
          {peak && (<><PeakBadge peak={peak} resetDisplay={cfg.resetDisplay} tz={tz} /><Text dimColor>  {glyphs().middot}  </Text></>)}
          <Text dimColor>{fmt.time(updated, tz)}</Text>
        </Box>
      </Box>

      {degraded && (
        <Text dimColor>{glyphs().warn} degraded {glyphs().middot} {degradedMessage ?? 'background service unavailable, running in-process'}</Text>
      )}

      {connected && daemon.conn !== 'live' && (
        <Text dimColor>{glyphs().warn} reconnecting {glyphs().middot} showing last known data</Text>
      )}

      {cfg.allowNetworkAccess && (
        <ThemedError>{glyphs().warn} unsafe network access enabled {glyphs().middot} dashboard may be reachable from your LAN after daemon restart</ThemedError>
      )}

      {configSaveError && (
        <ThemedError>{glyphs().warn} {configSaveError}</ThemedError>
      )}

      <RefreshStatusLine status={refreshStatus} />

      {showSettings ? (
        <SettingsView
          config={cfg}
          cursor={settingsCursor}
          activeTab={settingsTab}
          tzEdit={tzEdit}
          tzCaret={tzCaret}
          tzError={tzError}
          allowedHostsEdit={allowedHostsEdit}
          allowedHostsCaret={allowedHostsCaret}
          allowedHostsError={allowedHostsError}
          resolvedTz={tz}
          accountForm={accountForm}
          activeAccountId={cfg.activeAccountId}
          trackedAccounts={trackedAccountRows}
          accountIdentities={accountIdentities}
          privacyLabels={privacyLabels}
        />
      ) : (
        <>
          <Box marginTop={1} marginBottom={1}>
            <TabBar tabs={TABS} active={tab} onSelect={onTabSelect} />
            <Text dimColor>  Tab/{glyphs().arrowL}{glyphs().arrowR}</Text>
          </Box>
          {tab === 0 && (
            <>
              <DashboardView groups={groups} stats={stats} cols={cols} budget={gridBudget} computed={dashLayout} page={dashPage} privacyMode={cfg.privacyMode} privacyLabels={privacyLabels} resetDisplay={cfg.resetDisplay} tz={tz} billingIntervalMs={billingIntervalMs} />
              {slots.length > 1 && (
                <Box marginTop={1}>
                  <Text dimColor>focus  </Text>
                  <AccountStrip
                    slots={slots}
                    activeIdx={activeSlotIdx}
                    onSelect={onStripSelect}
                  />
                </Box>
              )}
              <TotalsRow groups={groups} stats={stats} cols={cols} />
            </>
          )}
          {tab === 1 && (
            <>
              {tableProvs.length > 0 && (
                <TableProviderBar providers={tableProvs} active={effTableProvider} onSelect={onProviderSelect} />
              )}
              <Box height={1} />
              <ControlBar views={VIEWS} period={view} sort={sortLabel(SORTS_FOR[sort % SORTS_FOR.length])}
                model={activeTableModel} search={search} searchCaret={searchCaret} searching={searchMode}
                showPeriod showModel />
              <Box height={1} />
              {!effTableProvider ? (
                <Text dimColor>No providers enabled {glyphs().emDash} press s to pick providers.</Text>
              ) : tableLoading && !table ? (
                <Spinner label="Loading history" />
              ) : (
                <TokenTable
                  rows={tokenRows} cursor={cursor} expanded={expanded}
                  maxRows={Math.max(1, rows - 16)} cols={cols}
                  onRowClick={onRowClickToken}
                />
              )}
            </>
          )}
        </>
      )}

      {(tab === 0 || showSettings) && <Footer hasAccounts={slots.length > 1} paginated={tab === 0 && dashPaginated} cols={cols} />}
      </Box>
    </TuiThemeProvider>
  )
}

function ThemedBrand() {
  const theme = useTuiTheme()
  return <Text bold color={theme.accent}>{glyphs().dotSel} tokmon</Text>
}

function ThemedError({ children }: { children: ReactNode }) {
  const theme = useTuiTheme()
  return <Text color={theme.crit}>{children}</Text>
}
