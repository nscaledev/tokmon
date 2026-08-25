import { Box, Text } from 'ink'
import { glyphs } from './glyphs'
import { COLOR_PALETTE, generateAccountId, type Account } from '../config'
import { PROVIDER_ORDER, PROVIDERS } from '../providers'
import type { ProviderId } from '../providers/types'
import { CaretText } from './shared'
import { useTuiTheme } from './theme'

export type FormField = 'provider' | 'name' | 'homeDir' | 'quotaUrl' | 'apiKeyEnv' | 'color'

export interface AccountForm {
  mode: 'add' | 'edit'
  field: FormField
  providerId: ProviderId
  name: string
  homeDir: string
  quotaUrl?: string
  apiKeyEnv?: string
  hadQuotaSource?: boolean
  color: string
  caret: number
  editingId: string | null
  /** Auto row this form is converting to a manual account, if any. */
  convertedFromId: string | null
  error: string | null
}

export const FORM_FIELDS: FormField[] = ['provider', 'name', 'homeDir', 'quotaUrl', 'apiKeyEnv', 'color']

export function AccountFormView({ form, accounts }: { form: AccountForm; accounts: Account[] }) {
  const theme = useTuiTheme()
  const previewId = form.mode === 'add'
    ? generateAccountId(form.name || 'account', accounts)
    : form.editingId ?? ''
  const accent = form.color
  const stepIndex: Record<FormField, number> = { provider: 1, name: 2, homeDir: 3, quotaUrl: 4, apiKeyEnv: 5, color: 6 }
  const step = stepIndex[form.field]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={accent} bold>{glyphs().vbar}</Text>
        <Text bold>{' '}{form.mode === 'add' ? 'NEW ACCOUNT' : 'EDIT ACCOUNT'}</Text>
        <Text dimColor>   step {step} of 6</Text>
      </Box>
      <Box marginTop={1}><Stepper active={form.field} accent={accent} /></Box>

      <Box marginTop={1} flexDirection="column" borderStyle={glyphs().border} borderColor={accent} paddingX={2} paddingY={1}>
        <ProviderField value={form.providerId} focused={form.field === 'provider'} />
        <Box height={1} />
        <FormField label="Name" hint="display name for this account" value={form.name}
          focused={form.field === 'name'} caret={form.caret} accent={accent} placeholder="e.g. Work, Personal" />
        <Box height={1} />
        <FormField label="Home directory" hint={`path containing the tool's data dir  ${glyphs().middot}  ~ for default`} value={form.homeDir}
          focused={form.field === 'homeDir'} caret={form.caret} accent={accent} placeholder="~/work" mono />
        <Box height={1} />
        <FormField label="Quota endpoint" hint="optional exact Claude or Codex usage URL" value={form.quotaUrl ?? ''}
          focused={form.field === 'quotaUrl'} caret={form.caret} accent={accent} placeholder="https://proxy.example/api/oauth/usage" mono />
        <Box height={1} />
        <FormField label="API key environment variable" hint="the secret stays outside Tokmon's config" value={form.apiKeyEnv ?? ''}
          focused={form.field === 'apiKeyEnv'} caret={form.caret} accent={accent} placeholder="CLIPROXY_API_KEY" mono />
        <Box height={1} />
        <ColorField value={form.color} focused={form.field === 'color'} />
        <Box height={1} />
        <Box>
          <Text dimColor>id  {glyphs().boxMark} </Text>
          <Text bold color={accent}>{previewId || 'account'}</Text>
          <Text dimColor> {glyphs().boxMark}   auto-generated from name</Text>
        </Box>
      </Box>

      {form.error && <Box marginTop={1}><Text color={theme.crit}>{glyphs().warn} {form.error}</Text></Box>}

      <Box marginTop={1}>
        <Text dimColor>tab/{glyphs().arrowU}{glyphs().arrowD} </Text><Text>switch field</Text><Text dimColor>  {glyphs().middot}  </Text>
        <Text dimColor>enter </Text><Text>{form.field === 'color' ? 'save' : 'next'}</Text><Text dimColor>  {glyphs().middot}  </Text>
        {(form.field === 'color' || form.field === 'provider') ? (
          <><Text dimColor>{glyphs().arrowL}{glyphs().arrowR} </Text><Text>{form.field === 'provider' ? 'pick provider' : 'pick color'}</Text><Text dimColor>  {glyphs().middot}  </Text></>
        ) : (
          <><Text dimColor>{glyphs().arrowL}{glyphs().arrowR} </Text><Text>move caret</Text><Text dimColor>  {glyphs().middot}  </Text></>
        )}
        <Text dimColor>ctrl+s </Text><Text>save</Text><Text dimColor>  {glyphs().middot}  </Text>
        <Text dimColor>esc </Text><Text>cancel</Text>
      </Box>
    </Box>
  )
}

function Stepper({ active, accent }: { active: FormField; accent: string }) {
  const steps: { id: FormField; label: string }[] = [
    { id: 'provider', label: 'Provider' },
    { id: 'name', label: 'Name' },
    { id: 'homeDir', label: 'Home' },
    { id: 'quotaUrl', label: 'Quota URL' },
    { id: 'apiKeyEnv', label: 'Key env' },
    { id: 'color', label: 'Color' },
  ]
  const activeIdx = steps.findIndex(s => s.id === active)
  return (
    <Box>
      {steps.map((s, i) => {
        const done = i < activeIdx
        const cur = i === activeIdx
        const dot = done ? glyphs().dot : cur ? glyphs().dotSel : glyphs().radioOff
        return (
          <Box key={s.id}>
            <Text color={cur || done ? accent : undefined} dimColor={!cur && !done}>{dot} </Text>
            <Text bold={cur} color={cur ? accent : undefined} dimColor={!cur}>{s.label}</Text>
            {i < steps.length - 1 && <Text dimColor>  {glyphs().rule}  </Text>}
          </Box>
        )
      })}
    </Box>
  )
}

function ProviderField({ value, focused }: { value: ProviderId; focused: boolean }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={focused ? PROVIDERS[value].color : undefined} bold={focused} dimColor={!focused}>
          {focused ? glyphs().caretR : ' '} Provider
        </Text>
      </Box>
      <Box>
        <Text>  {focused ? glyphs().vbar : ' '} </Text>
        {PROVIDER_ORDER.map(pid => {
          const selected = pid === value
          const p = PROVIDERS[pid]
          return (
            <Box key={pid} marginRight={2}>
              {selected
                ? <Text bold color={p.color}>[{p.name}]</Text>
                : <Text dimColor>{p.name}</Text>}
            </Box>
          )
        })}
      </Box>
      <Box><Text dimColor>      which tool this account tracks</Text></Box>
    </Box>
  )
}

function FormField({ label, hint, value, focused, caret, accent, placeholder, mono }: {
  label: string; hint: string; value: string; focused: boolean; caret?: number; accent: string; placeholder: string; mono?: boolean
}) {
  const isPlaceholder = value === ''
  const display = isPlaceholder ? placeholder : value
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={focused ? accent : undefined} bold={focused} dimColor={!focused}>
          {focused ? glyphs().caretR : ' '} {label}
        </Text>
      </Box>
      <Box>
        <Text color={focused ? accent : undefined}>  {focused ? glyphs().vbar : ' '} </Text>
        {focused
          ? isPlaceholder
            ? <><Text color={accent}>{glyphs().vbar}</Text><Text dimColor italic={mono}>{placeholder}</Text></>
            : <CaretText value={value} caret={caret ?? value.length} color={accent} />
          : <Text dimColor={isPlaceholder} italic={mono && isPlaceholder}>{display}</Text>}
      </Box>
      <Box><Text dimColor>      {hint}</Text></Box>
    </Box>
  )
}

function ColorField({ value, focused }: { value: string; focused: boolean }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={focused ? value : undefined} bold={focused} dimColor={!focused}>
          {focused ? glyphs().caretR : ' '} Accent color
        </Text>
      </Box>
      <Box>
        <Text>  {focused ? glyphs().vbar : ' '} </Text>
        {COLOR_PALETTE.map(c => (
          <Box key={c} marginRight={1}>
            {c === value ? <Text bold color={c}>[{glyphs().dot}]</Text> : <Text color={c} dimColor={!focused}> {glyphs().dot}</Text>}
          </Box>
        ))}
      </Box>
      <Box><Text dimColor>      shows on dashboard, account strip, borders</Text></Box>
    </Box>
  )
}
