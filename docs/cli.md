# CLI queries

Query commands are meant for scripts and coding agents. They use the running
daemon when available and can start it when needed.

## Usage

```bash
tokmon usage
tokmon usage --period week --provider codex
tokmon usage --model opus --json
tokmon usage --period all --json --compact
```

`usage` refreshes local history by default. Use `--cached` for the fastest
known result or `--refresh` to refresh billing too.

JSON output includes:

- `schemaVersion`;
- provider and account source IDs;
- per-model input, output, cache, token, call, and cost fields;
- a `sources` collection mapping rows to provider homes and local paths.

Use `tokmon usage --help` for the current period and filter options.

### One session or conversation

Use `--session <id>` (or `-s <id>`) for one Claude Code or Codex session, or
one Cursor conversation. IDs are exact, not prefixes. Child sessions and other
conversations are excluded; there is no fallback to account-wide totals.

```bash
tokmon usage --session SESSION_ID --period all --json --compact
tokmon usage -s SESSION_ID --provider codex --cached --json --compact
tokmon usage -s CONVERSATION_ID --provider cursor --refresh --json --compact
```

Replace the placeholder with the transcript's `sessionId` (Claude),
`session_meta.payload.id` (Codex), or `conversationId` / composer ID (Cursor).
Provider, account, model, and period filters still apply. The default period
is **month**; use `--period all` for all available session history.

Claude and Codex read matching local transcripts. Cursor requires a logged-in
account and its usage API: only the last 90 days are available, and events may
arrive late. Local Cursor spend estimates are not used for session queries.
`input`, `output`, `cacheRead`, and `cacheCreate` are separate token counts;
Codex cached input is removed from `input` to avoid counting it twice. Tokmon
currently exposes Codex cache reads; its cache-create count remains zero.

The first query discovers the matching transcript or fetches Cursor events.
Later queries reread that transcript; Cursor events may be cached for 60 seconds.
`--refresh` bypasses Cursor's event cache and also refreshes account usage and
billing, so a cold `--refresh` can take longer; increase `--timeout` if needed.
`--cached` reads only the daemon's last result for that exact session:
run a query without it first. This cache is bounded, in memory, and cleared when
the daemon restarts or account configuration changes.

JSON keeps `schemaVersion: 1` and adds `filters.session`. An unmatched ID returns
empty rows and zero totals. Source failures appear in `errors` with a message;
if available, the last successful session totals are retained. Check `errors`
before treating a result as current. An older daemon without session support
must be updated and restarted.

## Providers

```bash
tokmon providers
tokmon providers --json
```

This reports configured accounts and provider source paths. Privacy-sensitive
automation should prefer redacted output or enable global privacy mode.

## Snapshot

```bash
tokmon snapshot
tokmon snapshot --refresh --compact --timeout 60
```

The snapshot is the complete daemon presentation contract used by the clients.
It is useful for debugging integrations; stable automation should prefer the
narrower `usage` and `providers` schemas.

## Configuration

```bash
tokmon config path
tokmon config get
tokmon config set --help
```

Configuration writes go through daemon compare-and-swap semantics, so a CLI
change cannot silently overwrite a newer desktop or web change.
