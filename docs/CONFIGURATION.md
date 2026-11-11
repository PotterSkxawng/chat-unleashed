# Configuration and permissions

This reference covers saved settings, the local settings API, and macOS permissions.

## Saved state

Chat Unleashed stores its settings at:

```text
~/Library/Application Support/Chat Unleashed/config.json
```

Tests and advanced deployments can override that location with `CHAT_UNLEASHED_HOME`. The tunnel client stores its own profile and credential separately; neither belongs in the repository.

On first run, Chat Unleashed creates the config from defaults and writes it atomically with mode `0600`. The file contains the device name, workspace/download/screenshot paths, screenshot format and size, shell timeouts, the Computer Use plugin location, and any API keys you add.

Use `app_config`, the local JSON API below, or a text editor to change settings. The server reloads the file on each tool call, validates typed values, and masks secrets when reading them back.

Chat Unleashed does not expose `allowedRoots` or a global `dryRun` switch as a security boundary. Full terminal access could bypass a path-only restriction. Use macOS account isolation or another OS-level boundary when you need a real sandbox.

## Local JSON API

When the server runs with `--http`, it also serves a loopback-only JSON API for a local settings frontend.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | process id and uptime |
| `GET /api/config` | current settings with secrets masked, config path, and defaults |
| `PATCH /api/config` | merge a partial settings object |
| `PUT /api/config` | replace settings and fill omitted values from defaults |
| `POST /api/config/reset` | restore defaults |
| `GET /api/status` | permissions, process identity, config path, and version |
| `GET /api/diagnose` | the same diagnosis returned by `mac_permissions` |
| `POST /api/permissions/request` | ask macOS for selected grants (`{"kinds":[...]}`) |
| `POST /api/permissions/open` | open the matching System Settings pane |

## macOS permissions

Chat Unleashed asks macOS only for permissions required by the tool being used. The error message names the host binary that needs the grant.

| Permission | Used for |
| --- | --- |
| Accessibility | Reading UI trees, clicking, typing, and arranging windows |
| Screen Recording | Capturing screenshots with real pixels |
| Automation | Sending Apple Events to Calendar, Notes, browsers, iWork, and other apps |
| Full Disk Access | Reading protected stores when a tool genuinely needs them |

`mac_permissions` reports the current state. `action=request` triggers the relevant macOS prompt, and `action=fix` opens the matching System Settings pane.
