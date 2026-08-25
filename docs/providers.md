# Providers and accounts

Tokmon separates local usage history from live quota/billing. Some providers
offer both; others expose only one side.

## Usage providers

| Provider | Source | Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` | Token/cost history plus session, weekly, and model limits |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | Token/cost history, plan, limits, and credits |
| Cursor | Cursor API events and local composer data | Token/cost history, spend, and caps |
| opencode | `~/.local/share/opencode/opencode.db` | Uses the cost recorded by opencode |
| pi | `~/.pi/agent/sessions/**/*.jsonl` | Uses the cost recorded by pi |
| Grok | `~/.grok/logs/unified.jsonl` plus session metadata | Joins turns to models and reads SuperGrok billing when available |

## Quota and billing providers

| Provider | Source | Notes |
| --- | --- | --- |
| Copilot | GitHub token from `gh` or VS Code | Premium request and chat quota |
| Antigravity | Local OAuth state | Per-pool Google Cloud Code quota |
| Gemini | `~/.gemini/oauth_creds.json` | Google Cloud Code plan and quota |

An expired Gemini token can usually be refreshed by running `gemini` again.

## Cost calculation

Where a tool records its own cost, Tokmon uses that value. Otherwise it applies
the published model price to input, output, cache-create, and cache-read tokens.
Cache reads use the discounted cache rate.

These totals are API-equivalent estimates. Subscription plans do not turn a
local estimate into an invoice.

## Automatic discovery

Tokmon checks standard provider homes and any additional homes it can safely
identify. Discovery can be disabled:

- globally;
- for one provider;
- for one detected account home.

Ignoring a detected account does not remove credentials or files. The account
stays restorable in settings. Manually configured accounts are independent from
automatic discovery.

Harness installation and account evidence are separate. Finding a Claude,
Codex, or other provider executable can suggest that harness during onboarding,
but it cannot create a runtime account. A full refresh rescans account homes
before fetching usage and quota data.

## Multiple accounts

Each manual account has a provider, name, home directory, and accent color.
Accounts can be enabled, disabled, renamed, and reordered without changing the
provider's own files.

The daemon resolves one canonical identity for each account and sends it to all
clients. Privacy mode replaces identifying text at presentation time; it does
not create a second account model.

## Proxy quota endpoints

A manual Claude or Codex account may replace its live provider quota request
with a compatible proxy endpoint. Claude endpoints must end at
`/api/oauth/usage`. Codex endpoints must end at
`/backend-api/wham/usage`. Tokmon parses the normal provider response shape, so
the dashboard and menu bar use the same quota metrics as a direct account.

Configure the API key by environment variable name. For example, use
`CLIPROXY_API_KEY` in the account editor and start Tokmon with that variable in
its environment. Tokmon never writes the variable's value to `config.json` or
sends it through its daemon protocol.
