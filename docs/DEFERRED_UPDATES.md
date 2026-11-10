# Deferred, tunnel-preserving updates

The updater stages a validated local MCP bundle, waits for an extended period without tool traffic, and replaces **only the separately supervised local HTTP MCP server**. It does not restart the Secure MCP Tunnel or modify its credentials, profile, binary or LaunchAgent. This is intentionally narrower than a tunnel-client software upgrade: a silent remote queue cannot prove that every ChatGPT connector session is closed.

## One-time setup

The local HTTP MCP server and tunnel must already have working, **independent** launchd services. The default server label is `com.local-agent-mcp.server`. The server executable should be the installed bundle at `~/.local/share/local-agent-mcp/dist/index.js` and its private HTTP port is 3344 by default. The tunnel health listener is assumed to be on loopback port 8080. All settings are configurable at install time through the environment variables listed below.

From a source checkout on an Apple Silicon Mac with Node.js 20.11.1 or newer:

```bash
npm run validate:release
npm run update:install
npm run update:stage
npm run update:status
```

`update:install` installs a small standalone watchdog under the per-user runtime directory and registers `com.local-agent-mcp.updater` with launchd. It runs its read-only idle check every 60 seconds. Neither the tunnel nor the MCP server is restarted during installation. The watchdog does nothing until a bundle has been staged.

`update:stage` checks JavaScript syntax, starts the candidate as a separate HTTP MCP server with temporary private state, verifies that it reports healthy, and copies the bytes into a content-addressed staging directory. It records SHA-256 and a new quiet-window start time. It does **not** overwrite the installed bundle or stop any process. A later stage supersedes an earlier pending candidate.

A successful `npm run validate:release` is required before staging a release candidate. Syntax checking and isolated startup alone are not substitutes for integration and stress tests.

## How a candidate becomes active

On each scheduled run, the watchdog requires:

- The local MCP `/health` endpoint is healthy with no active/queued tools or HTTP requests.
- The tunnel's detailed `/health` endpoint is healthy with no active dispatchers, queued commands or response deliveries.
- At least 20 minutes have passed since the stage was created, the most recent observable tunnel activity, the latest local audit entry, and either process's startup.
- The live server LaunchAgent is registered and its command points at the expected installed bundle.
- The staged SHA-256 still matches, the candidate passes the isolated startup test again, and a second health sample shows no intervening remote traffic.

Missing or malformed telemetry **blocks** activation. A manual call through ChatGPT counts as activity, so inspecting or using the tool delays the quiet window. The watchdog's own direct loopback health probes do not count as MCP tool calls.

At cutover, it preserves the previous working bundle, atomically switches the installed file, and invokes `launchctl kickstart -k` on **only the local MCP server's** LaunchAgent. It verifies the new server PID and health while ensuring the tunnel remains ready with its original instance ID. If health verification fails, it restores the previous bundle, restarts only the local server again, records failure and stops retrying automatically.

**The tunnel process is never restarted by this updater.** Even after 20 minutes without calls, an open ChatGPT session might still exist. A rare new request arriving between the final probe and server restart can fail. The watcher minimizes this race but cannot promise zero interruption. This is safer than restarting the tunnel and breaking all active connector session handles.

## Management

```bash
npm run update:status    # pending digest, last outcome and any defer reason
npm run update:check     # one guarded check; does not force an update
npm run update:cancel    # remove the pending update without touching the live server
```

Do not manually restart the tunnel to force an update. The process will transition on its own when a quiet window is observed. For an intentionally urgent cutover, arrange a time when no client will call Local Mac and use the normal launchd service management outside an active ChatGPT session.

If a prior activation was interrupted, the watchdog blocks further automatic restarts. Inspect the server and tunnel, confirm whether the new or prior bundle is installed, and stage a known-good release again. The last successful local bundle is retained as `dist/index.js.previous`. Failed activations are not retried in a loop.

## Portability and service configuration

The watcher is independent of the repository after installation. It uses the current Node executable discovered during installation and stores its own configuration in the per-user LaunchAgent; no personal username, chip generation, tunnel ID, or secret is published in the source. It uses app-local data directories (private to the current user) and never needs the tunnel control-plane API key.

The following optional variables can be set when installing the watcher:

| Variable | Default |
| --- | --- |
| `LOCAL_AGENT_RUNTIME_HOME` | `~/.local/share/local-agent-mcp` |
| `LOCAL_AGENT_UPDATER_HOME` | `<runtime>/updates` |
| `LOCAL_AGENT_SERVER_LABEL` | `com.local-agent-mcp.server` |
| `LOCAL_AGENT_SERVER_HEALTH_URL` | `http://127.0.0.1:3344/health` |
| `LOCAL_AGENT_TUNNEL_HEALTH_URL` | `http://127.0.0.1:8080/health?details=true` |
| `LOCAL_AGENT_MCP_HOME` | macOS `~/Library/Application Support/local-agent-mcp` for audit/activity |

If your health ports or server job label differ, configure them **before** registering the watcher. The updater rejects non-loopback health URLs. The 20-minute quiet period is an intentionally conservative fixed release-policy default, not a promise that all ChatGPT sessions are disconnected.

Upgrading `tunnel-client` itself should remain a separate, explicitly scheduled maintenance operation. A tunnel restart can terminate remote sessions even with zero current requests. Do not apply Homebrew upgrades or restart the tunnel from this watchdog.
