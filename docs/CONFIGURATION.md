# Configuration and permissions

This reference covers saved state, the local settings API, macOS permissions, and related runtime behavior.

## Saved state

Saved settings are kept outside the published package at
`~/Library/Application Support/local-agent-mcp/config.json`. Tests and advanced deployments can override this with `LOCAL_AGENT_MCP_HOME`. Tunnel credentials and profiles are stored separately by the tunnel client and must not be committed.

The file is created from defaults on first run, written atomically with mode
`0600`, and holds the device name, workspace/download/screenshot paths,
screenshot size and format, shell timeouts, the Computer Use plugin location and
any API keys you add. Change it with the `app_config` tool, the JSON API below, or
any editor: the server re-reads it on every tool call, so edits apply without a
restart, and typed values are validated instead of silently accepted. Secrets are
masked whenever settings are read.

Chat Unleashed intentionally does not expose an `allowedRoots` or global `dryRun` setting as a security boundary. Full terminal access could bypass a path-only restriction. Use macOS account isolation or another OS-level boundary when you need a real sandbox.

### Local JSON API (for a desktop frontend)

With `--http` (loopback by default) the server also serves a small JSON API for a
settings UI. Loopback callers only.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | process id and uptime |
| `GET /api/config` | current settings (secrets masked), file path, defaults |
| `PATCH /api/config` | merge a partial settings object |
| `PUT /api/config` | replace settings, filling gaps with defaults |
| `POST /api/config/reset` | restore defaults |
| `GET /api/status` | permissions, process identity, config path, version |
| `GET /api/diagnose` | the same diagnosis `mac_permissions` prints |
| `POST /api/permissions/request` | ask macOS for grants (`{"kinds":[...]}`) |
| `POST /api/permissions/open` | open the matching System Settings pane |

## Permissions

The server asks macOS for what it needs and names the exact binary that has to be
trusted, whatever launched it.

- **Accessibility** - read UI trees, click, type, arrange windows
- **Screen Recording** - screenshots with real pixels
- **Automation** - Apple Events to Calendar, Notes, browsers and the rest
  (per app, prompted on first use)
- **Full Disk Access** - optional, only for protected stores

`mac_permissions` reports each one; `action=request` triggers the OS prompts and
`action=fix` opens the right panes. Tools that need a grant say so in their error,
with the path to add.
