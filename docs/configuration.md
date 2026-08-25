# Configuration

Press `s` in the terminal or use the settings control in the desktop/web apps.
All clients write the same daemon-owned configuration.

## General

- Refresh interval controls local usage polling (default 2 seconds).
- Billing poll controls provider API refresh (default 5 minutes, minimum 1).
- Privacy mode and its shortcut apply across clients.
- Timezone accepts an IANA name or `System`.
- Dashboard layout can be a grid or one provider at a time.
- Reset times can be relative or exact.
- LAN access is off by default.

## Themes

Tokmon is the default paired dark/light theme. Phosphor is a dark terminal
palette. The editor catalog includes VS Code, Monokai, Dracula, GitHub, Nord,
One Dark Pro, Solarized, Tokyo Night, Catppuccin, Midnight, Forest, Sunset,
Cyberpunk, Synthwave, Luxury, and Minimal palettes imported from ZeroCut's
common theme format.

Auto follows the operating system in desktop and web clients. Custom palettes
start from a built-in preset and require valid `#RRGGBB` colors with contrast
checks. The terminal never paints the terminal background and honors
`NO_COLOR`.

## Providers and accounts

Provider tracking and account discovery are separate controls. Discovery can be
disabled globally, per provider, or for one detected home. Manual accounts are
never removed when discovery is turned off.

An installed harness is not an account by itself. Tokmon creates a default
account only when its home contains readable credentials or usage history.

Use **Remove from Tokmon** to stop tracking one detected account. This reversible
exclusion does not sign out, delete provider files, or affect sibling accounts;
removed accounts remain available under **Restore**. Turning discovery off is
broader and hides every automatically detected account.

Manual Claude and Codex accounts can read quota from an API-key-authenticated
proxy. Set the exact quota endpoint and the name of an environment variable that
contains its API key. Tokmon stores the URL and environment variable name, not
the key. The daemon process must receive that variable when it starts.

The accepted endpoint paths are `/api/oauth/usage` for Claude and
`/backend-api/wham/usage` for Codex. Remote endpoints require HTTPS. Plain HTTP
is accepted only on loopback addresses. URLs with credentials, query strings,
fragments, or a different path are rejected.

Manual accounts also support display name, home directory, accent color,
enable/disable, and ordering.

## Desktop

Desktop settings cover pinned providers, summary disclosure, graph period, and
launch at login.

## Files

| Platform | Configuration | Cache/daemon data |
| --- | --- | --- |
| macOS | `~/.config/tokmon/config.json` | `~/Library/Caches/tokmon` |
| Linux | `~/.config/tokmon/config.json` | `$XDG_CACHE_HOME/tokmon` or `~/.cache/tokmon` |
| Windows | `%APPDATA%\tokmon\config.json` | `%LOCALAPPDATA%\tokmon\cache` |

Configuration writes use a temporary file plus atomic rename.
