import { normalizeAllowedHost, sanitizeTyped } from '../config'
import { clampCaret, spliceBackspace } from './app.logic'
import { isValidTimezone } from '../tz'
import type { InputKey, KeyContext } from './keybinding-context'

export function handleAccountEditor(
  input: string,
  key: InputKey,
  editor: KeyContext['accountEditor'],
  text: KeyContext['textInput'],
): void {
  const { form, setForm, commit, cycleField, cycleProvider, cycleColor } = editor
  if (!form) return
  if (key.escape) { setForm(null); return }
  if (key.ctrl && input === 's') { commit(); return }
  if (key.tab) { cycleField(key.shift ? -1 : 1); return }
  if (key.upArrow) { cycleField(-1); return }
  if (key.downArrow) { cycleField(1); return }
  if (form.field === 'provider') {
    if (key.leftArrow) { cycleProvider(-1); return }
    if (key.rightArrow) { cycleProvider(1); return }
    if (key.return) { setForm(value => value && { ...value, field: 'name', caret: value.name.length }); return }
    return
  }
  if (form.field === 'color') {
    if (key.leftArrow) { cycleColor(-1); return }
    if (key.rightArrow) { cycleColor(1); return }
    if (key.return) { commit(); return }
    return
  }
  const field = form.field as 'name' | 'homeDir' | 'quotaUrl' | 'apiKeyEnv'
  if (key.leftArrow) { setForm(value => value && { ...value, caret: clampCaret(value.caret - 1, (value[field] ?? '').length) }); return }
  if (key.rightArrow) { setForm(value => value && { ...value, caret: clampCaret(value.caret + 1, (value[field] ?? '').length) }); return }
  if (key.ctrl && input === 'a') { setForm(value => value && { ...value, caret: 0 }); return }
  if (key.ctrl && input === 'e') { setForm(value => value && { ...value, caret: (value[field] ?? '').length }); return }
  if (key.return) {
    if (field === 'name' && form.name.trim() === '') {
      setForm(value => value && { ...value, error: 'Name required', caret: value.name.length })
      return
    }
    setForm(value => value && {
      ...value,
      field: field === 'name' ? 'homeDir' : field === 'homeDir' ? 'quotaUrl' : field === 'quotaUrl' ? 'apiKeyEnv' : 'color',
      caret: field === 'name' ? value.homeDir.length : field === 'homeDir' ? (value.quotaUrl?.length ?? 0) : field === 'quotaUrl' ? (value.apiKeyEnv?.length ?? 0) : value.caret,
    })
    return
  }
  if (key.backspace || key.delete) {
    setForm(value => {
      if (!value || (value.field !== 'name' && value.field !== 'homeDir' && value.field !== 'quotaUrl' && value.field !== 'apiKeyEnv')) return value
      const result = spliceBackspace(value[value.field] ?? '', value.caret)
      return { ...value, [value.field]: result.value, caret: result.caret, error: null }
    })
    return
  }
  if (text.isPrintable(input, key)) {
    const clean = sanitizeTyped(input)
    if (clean) text.insert(clean)
  }
}

export function handleTimezoneEditor(
  input: string,
  key: InputKey,
  editor: KeyContext['timezoneEditor'],
  text: KeyContext['textInput'],
  updateConfig: KeyContext['global']['updateConfig'],
): void {
  const { value, setValue, setError, setCaret, valueRef, caretRef } = editor
  if (value === null) return
  if (key.escape) { setValue(null); setError(null); return }
  if (key.return) {
    const next = value.trim()
    if (next === '' || next.toLowerCase() === 'system') {
      updateConfig(config => ({ ...config, timezone: null })); setValue(null); setError(null)
    } else if (isValidTimezone(next)) {
      updateConfig(config => ({ ...config, timezone: next })); setValue(null); setError(null)
    } else {
      setError(`Invalid: ${next}`)
    }
    return
  }
  if (key.leftArrow) { setCaret(caret => clampCaret(caret - 1, value.length)); return }
  if (key.rightArrow) { setCaret(caret => clampCaret(caret + 1, value.length)); return }
  if (key.ctrl && input === 'a') { setCaret(0); return }
  if (key.ctrl && input === 'e') { setCaret(value.length); return }
  if (key.backspace || key.delete) {
    const result = spliceBackspace(valueRef.current, caretRef.current)
    valueRef.current = result.value; caretRef.current = result.caret
    setValue(result.value); setCaret(result.caret); setError(null)
    return
  }
  if (text.isPrintable(input, key)) {
    const clean = sanitizeTyped(input)
    if (clean) text.insert(clean)
  }
}

export function handleAllowedHostsEditor(
  input: string,
  key: InputKey,
  editor: KeyContext['allowedHostsEditor'],
  text: KeyContext['textInput'],
  updateConfig: KeyContext['global']['updateConfig'],
): void {
  const { value, setValue, setError, setCaret, valueRef, caretRef } = editor
  if (value === null) return
  if (key.escape) { setValue(null); setError(null); return }
  if (key.return) {
    const parts = value.split(',').map(part => part.trim()).filter(Boolean)
    const normalized = parts.map(normalizeAllowedHost)
    if (normalized.some(host => host === null)) {
      setError('Use exact DNS names without a scheme, port, path, or wildcard')
      return
    }
    updateConfig(config => ({ ...config, allowedHosts: [...new Set(normalized as string[])] }))
    setValue(null); setError(null)
    return
  }
  if (key.leftArrow) { setCaret(caret => clampCaret(caret - 1, value.length)); return }
  if (key.rightArrow) { setCaret(caret => clampCaret(caret + 1, value.length)); return }
  if (key.ctrl && input === 'a') { setCaret(0); return }
  if (key.ctrl && input === 'e') { setCaret(value.length); return }
  if (key.backspace || key.delete) {
    const result = spliceBackspace(valueRef.current, caretRef.current)
    valueRef.current = result.value; caretRef.current = result.caret
    setValue(result.value); setCaret(result.caret); setError(null)
    return
  }
  if (text.isPrintable(input, key)) {
    const clean = sanitizeTyped(input)
    if (clean) text.insert(clean)
  }
}

export function handleSearchEditor(
  input: string,
  key: InputKey,
  table: KeyContext['table'],
  text: KeyContext['textInput'],
): void {
  const { search, setSearch, setSearchMode, setSearchCaret, searchValueRef, searchCaretRef } = table
  if (key.return || key.escape) {
    setSearchMode(false)
    if (key.escape) { setSearch(''); setSearchCaret(0) }
    return
  }
  if (key.leftArrow) { setSearchCaret(caret => clampCaret(caret - 1, search.length)); return }
  if (key.rightArrow) { setSearchCaret(caret => clampCaret(caret + 1, search.length)); return }
  if (key.ctrl && input === 'a') { setSearchCaret(0); return }
  if (key.ctrl && input === 'e') { setSearchCaret(search.length); return }
  if (key.backspace || key.delete) {
    const result = spliceBackspace(searchValueRef.current, searchCaretRef.current)
    searchValueRef.current = result.value; searchCaretRef.current = result.caret
    setSearch(result.value); setSearchCaret(result.caret)
    return
  }
  if (text.isPrintable(input, key)) {
    const clean = sanitizeTyped(input)
    if (clean) text.insert(clean)
  }
}
