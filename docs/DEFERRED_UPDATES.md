# Deferred, tunnel-preserving updates

Chat Unleashed updates the local MCP server without restarting the Secure MCP Tunnel. The normal CLI update path builds and stages a candidate, then an independent local watcher waits for a quiet window before replacing only the server process.

This is intentionally narrower than upgrading `tunnel-client`. A tunnel restart can invalidate remote connector sessions even when no request is currently in flight.

## Normal use

On a setup created by the current CLI, the updater watcher is installed automatically.

To update from `origin/main`:

```sh
chat-unleashed update
```

The command:

1. fetches `origin/main`,
2. fast-forwards the checkout,
3. installs dependencies from the lockfile,
4. builds the candidate bundle,
5. verifies the updater is installed,
6. stages the candidate after an isolated startup preflight.

The running MCP server and tunnel are not restarted during those steps.

Management commands:

```sh
chat-unleashed update --status
chat-unleashed update --cancel
chat-unleashed update --stage
```

`--stage` builds and stages the current checkout without pulling from GitHub. `--cancel` removes a pending candidate without touching the live server.

The equivalent lower-level npm commands remain available for development:

```sh
npm run update:install
npm run update:stage
npm run update:status
npm run update:check
npm run update:cancel
```

## How a candidate becomes active

The watcher runs a read-only check every 60 seconds. Activation is allowed only when all of the following are true:

- The local MCP health endpoint is healthy.
- There are no active or queued local tools or HTTP requests.
- The tunnel health endpoint is healthy.
- There are no active remote dispatchers, queued commands or in-progress response deliveries.
- At least 20 minutes have passed since the most recent observed activity and since the candidate was staged.
- The live server LaunchAgent points at the expected installed runtime.
- The staged SHA-256 still matches.
- The candidate passes an isolated startup preflight again.
- A second health sample shows no new activity during the final check.

Missing or malformed telemetry blocks activation. The updater fails closed rather than guessing that the system is idle.

## Cutover and rollback

At cutover the updater:

1. preserves the previous working bundle,
2. atomically installs the staged bundle,
3. restarts only the local MCP server LaunchAgent,
4. waits for a new healthy server PID,
5. confirms that the tunnel is still ready with the same tunnel instance.

If the replacement server fails verification, the updater restores the previous bundle, restarts only the server again, records the failure and stops retrying automatically.

The tunnel process is not restarted by this updater.

A rare request can still arrive during the short server replacement window. The quiet-window checks minimize that race but cannot prove that every remote connector session is closed.

## Explicit service restarts

`chat-unleashed restart` is deliberately different from `chat-unleashed update`. It restarts both the local server and tunnel. Use it for deliberate troubleshooting or maintenance, not as the normal software-update path during an active ChatGPT session.

Do not restart the tunnel merely to force a staged server update.

## Service configuration

The watcher is independent of the repository after installation. It stores its own copy under the per-user runtime directory and uses the Node executable resolved during installation.

Defaults:

| Variable | Default |
| --- | --- |
| `LOCAL_AGENT_RUNTIME_HOME` | `~/.local/share/local-agent-mcp` |
| `LOCAL_AGENT_UPDATER_HOME` | `<runtime>/updates` |
| `LOCAL_AGENT_SERVER_LABEL` | `com.local-agent-mcp.server` |
| `LOCAL_AGENT_SERVER_HEALTH_URL` | `http://127.0.0.1:3344/health` |
| `LOCAL_AGENT_TUNNEL_HEALTH_URL` | `http://127.0.0.1:8080/health?details=true` |
| `LOCAL_AGENT_MCP_HOME` | `~/Library/Application Support/local-agent-mcp` |

The updater rejects non-loopback health URLs. It never needs the tunnel control-plane API key.

Upgrading `tunnel-client` itself remains separate maintenance. Schedule that change when interrupting tunnel sessions is acceptable.
