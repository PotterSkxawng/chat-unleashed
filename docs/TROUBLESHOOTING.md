# Connection and runtime troubleshooting

Chat Unleashed has three separate runtime layers: the MCP server running on the Mac, the outbound Secure MCP Tunnel client, and ChatGPT's connector session. A healthy Node process does not prove that the tunnel is connected, and a healthy tunnel does not prove that an existing chat session is still bound to it.

The supported remote connection is:

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel-client -> local MCP server on the Mac
```

The final hop can use a stdio child or a private loopback Streamable HTTP endpoint. A loopback URL on the Mac is not a replacement for the remote tunnel.

## Check the layers without restarting

On the Mac, check the local server and tunnel independently:

```bash
pgrep -fl 'tunnel-client|local-agent-mcp'
curl --fail --max-time 3 http://127.0.0.1:3344/health
tunnel-client doctor --profile local-mac --explain
```

The HTTP health command assumes the documented default port. If a profile uses a different port, use that port. The tunnel health listener is separate from the MCP server; consult the profile's `health.listen_addr` setting. On a default setup, inspect `http://127.0.0.1:8080/health`. A running PID alone does not establish remote availability.

If the tunnel profile references `env:CONTROL_PLANE_API_KEY`, the key must be present in **the environment of the tunnel process**, not just in an unrelated Terminal tab. A LaunchAgent and an interactive shell can have different environments. Inspect variable names and LaunchAgent configuration without printing credential values. Do not paste secrets or full environment files into support requests. Use a runtime credential intended for the tunnel.

If the `doctor` command reports a missing key only in Terminal, first check whether the managed tunnel is already healthy before modifying credentials or restarting it. Loading an environment file with `source` is not guaranteed to work if that file uses another variable name or is not shell syntax.

## MCP server is not initialized

This error does **not** necessarily indicate a crash. Compare tunnel and MCP-child PIDs before and after the failed call and inspect the initialize handshake in the tunnel logs. For stdio MCP, operations must not race ahead of a completed initialize handshake and its `notifications/initialized` message.

On the supported `tunnel-client`, stdio profiles may need:

```text
MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true
```

This is a `tunnel-client` compatibility option, not a universal requirement for MCP or HTTP transport. Apply it to the environment that actually launches the tunnel. For a loopback HTTP MCP target, investigate HTTP request/session handling instead of enabling unrelated stdio flags.

## Session terminated

This often means the **ChatGPT-side connector session** has ended. If the tunnel or its stdio child was restarted during an active chat, the old remote session may not reconnect automatically. Verify that the replacement tunnel and server are healthy first. Then reconnect or rebind the ChatGPT plugin/session. Refreshing a tool manifest alone may not replace a dead transport handle.

Do not enter a restart loop: rebuilding or restarting the local server cannot restore a connector object that still points to an old session. If you must restart the tunnel, complete the build, tests and profile checks beforehand, make one deliberate cutover, and expect active chats to need reconnection.

## Tunnel process exited, MCP HTTP server alive

An HTTP server PID may continue to exist while `tunnel-client` has exited. Check the configured LaunchAgent with `launchctl list` and the tunnel's own logs or `doctor` output. A `-` PID with a nonzero exit code means the LaunchAgent is registered but its last run exited. Confirm the control-plane credential is available to the LaunchAgent and the profile points at the correct local target. Start the tunnel once only after the configuration passes validation.

## MCP child exited, tunnel still running

For stdio-backed profiles, the tunnel owns the child lifecycle. Check parent/child PIDs, exit status, stderr and audit logs. The `tunnel-client` stdio failure policy determines whether it restarts the child internally or exits for supervision. With a separate HTTP server, examine the server's own supervisor and `/health` independently. Do not assume a tunnel restart is needed for every child crash.

## MCP server and tunnel both exited

Inspect each process's supervisor and exit logs. Fix the first failure in time rather than repeatedly restarting both. Validate the bundled runtime and the profile before the final start. The original chat connection may already be invalid and require a new connector session.

## HTTP 503, 413 and aborted requests

A `503` with `Retry-After` indicates configured backpressure or request-body memory pressure; it is not necessarily a crash. Reduce simultaneous calls, respect `Retry-After`, and inspect the capacity fields at `/health`. A `413` means the individual request exceeded the configured body limit. Use smaller or paginated inputs instead of blindly raising limits. Aborted client uploads should be isolated to that request; run the HTTP stress tests when changing body parsing.

## macOS permissions

Use the `mac_permissions` tool or System Settings > Privacy & Security. Accessibility covers UI control; Screen & System Audio Recording covers capturing pixels; Automation grants Apple Events to particular target apps; Full Disk Access may be needed for protected locations. Grant access to the **host process** macOS reports, which may differ when the server runs under a LaunchAgent.

## App not found

App discovery uses Launch Services and bundle IDs, with ordinary app directories as fallbacks. Install the requested app, launch it once so macOS can register its bundle, and use `iwork_apps` or `pages_status` to diagnose iWork-specific availability. Native Pages, Numbers and Keynote features require those apps to be installed.

## Browser / CDP failures

Browser automation requires a compatible Chromium-family browser and a reachable debugging target. Confirm the browser is installed and the debugging endpoint was started for the intended browser profile. Browser permissions and network failures are separate from MCP tunnel health. A working `run_command` does not by itself confirm browser CDP access.

## Before reporting a regression

Capture the tool name, approximate time, local server health, tunnel health, process lifetimes, and a sanitized error summary. Never attach API keys, full profile files with credential values, or raw audit arguments that might contain sensitive data. To test a new build, use a separate child in the release test suite; deploy only the validated bundle and compare its SHA-256 with the installed copy. Avoid restarting a working production tunnel while testing.
