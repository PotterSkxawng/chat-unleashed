# Connection and runtime troubleshooting

Chat Unleashed has three runtime layers: the local MCP server, the outbound Secure MCP Tunnel client, and ChatGPT's connector session. Check them separately before restarting anything.

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel-client -> local MCP server on the Mac
```

## Start with the three layers

On the Mac:

```bash
pgrep -fl 'tunnel-client|chat-unleashed'
curl --fail --max-time 3 http://127.0.0.1:3344/health
tunnel-client doctor --profile local-mac --explain
```

The HTTP command assumes the documented default port. If the profile uses another port, use that port. On a default setup, tunnel health is available at `http://127.0.0.1:8080/health`.

A running PID proves only that a process exists. It does not prove that ChatGPT can reach the MCP server.

If the tunnel profile references `env:CONTROL_PLANE_API_KEY`, the key must exist in the environment of the tunnel process itself. A LaunchAgent and an interactive Terminal can have different environments. Inspect variable names and LaunchAgent configuration without printing credential values.

## `MCP server is not initialized`

This usually points to the MCP initialize handshake, not necessarily a crashed process.

Compare the tunnel and MCP-child PIDs before and after the failed call, then inspect the tunnel log for the initialize request and `notifications/initialized`.

For stdio profiles on the supported `tunnel-client`, this compatibility flag may be required:

```text
MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true
```

Apply it only to the environment that launches the stdio tunnel. A loopback HTTP MCP target should be debugged at the HTTP/session layer instead.

## Session terminated

A terminated session often means the ChatGPT-side connector handle ended after the tunnel or its stdio child restarted.

First verify that the replacement server and tunnel are healthy. If they are, reconnect or rebind the ChatGPT plugin/session. Refreshing the tool manifest alone may not replace a dead transport handle.

Do not enter a restart loop. A local server restart cannot repair a ChatGPT connector that still points to an old remote session.

## Tunnel exited, MCP HTTP server still running

Check the configured LaunchAgent, the tunnel log, and `chat-unleashed doctor`.

```bash
launchctl list | grep chat-unleashed
chat-unleashed logs tunnel
chat-unleashed doctor
```

A `-` PID with a nonzero exit code means launchd still knows about the job but the last run exited. Confirm that the control-plane credential is available to the LaunchAgent and that the profile points at the correct local target before starting the tunnel again.

## MCP child exited, tunnel still running

For stdio-backed profiles, the tunnel owns the child lifecycle. Check parent/child PIDs, exit status, stderr, and audit logs. The tunnel's stdio failure policy determines whether it restarts the child or exits for supervision.

For a separate HTTP server, inspect its supervisor and `/health` independently. A child crash does not automatically require a tunnel restart.

## MCP server and tunnel both exited

Read both supervisors' logs and fix the earliest failure first. Validate the bundled runtime and tunnel profile before starting the services again.

The original ChatGPT conversation may already have lost its connector session, so a healthy replacement process can still require a new chat connection.

## HTTP 503

A `503` with `Retry-After` usually means configured backpressure or request-body memory pressure.

Reduce simultaneous calls, respect `Retry-After`, and inspect the capacity fields at `/health`. Run the HTTP stress tests after changing capacity or body-parsing logic.

## HTTP 413

A `413` means one request exceeded the configured body limit. Split or paginate the input instead of raising the limit blindly.

## Aborted uploads

An aborted client upload should affect only that request. If it destabilizes the server, reproduce it with the HTTP stress tests and inspect body-parsing behavior.

## macOS permissions

Use `mac_permissions` or System Settings > Privacy & Security.

| Permission | Used for |
| --- | --- |
| Accessibility | UI trees, clicking, typing, and window control |
| Screen & System Audio Recording | Capturing real screen pixels |
| Automation | Apple Events sent to specific apps |
| Full Disk Access | Protected locations when a tool genuinely needs them |

Grant access to the host process macOS reports. That process can differ when Chat Unleashed runs under a LaunchAgent.

## App not found

App discovery uses Launch Services and bundle IDs, then falls back to ordinary application directories.

Install the app and launch it once so macOS can register its bundle. For iWork, use `iwork_apps` or `pages_status` to confirm availability.

## Browser or CDP failures

Browser automation needs a compatible Chromium-family browser and a reachable debugging target.

Confirm that the intended browser and profile are running with debugging enabled. Browser permissions and network failures are separate from MCP tunnel health. A working `run_command` does not prove that browser CDP access works.

## Before reporting a regression

Record the tool name, approximate time, server health, tunnel health, relevant process lifetimes, and a sanitized error summary.

Do not attach API keys, full credential-bearing profiles, private files, or raw audit logs. Test a new build through the release suite before deploying it, and avoid restarting a working production tunnel just to test a local change.
