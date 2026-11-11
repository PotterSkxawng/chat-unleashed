# Connecting ChatGPT to Chat Unleashed

ChatGPT runs remotely. Chat Unleashed runs on your Mac and listens on loopback only. The supported bridge is OpenAI's Secure MCP Tunnel: an outbound connection maintained by `tunnel-client`, so no public port or public reverse proxy is required.

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel-client -> http://127.0.0.1:3344/mcp
```

## What you need

- Apple Silicon Mac
- Node.js 20.11.1 or newer
- Homebrew if `tunnel-client` is not already installed
- A ChatGPT workspace with the Secure MCP Tunnel connection option available

## 1. Create the tunnel

Open <https://platform.openai.com/settings/organization/tunnels>, create a tunnel, and copy its ID. It starts with `tunnel_`. OpenAI currently requires Tunnels Read + Manage to create or edit a tunnel.

## 2. Create the runtime key

Open <https://platform.openai.com/settings/organization/api-keys> and create a restricted runtime key for `tunnel-client`. OpenAI currently requires Tunnels Read + Use to run the client and select the tunnel in ChatGPT. Copy the key once and keep it private. Do not use a broader admin credential for the long-lived local service.

## 3. Run setup

From the repository checkout:

```sh
npm ci
npm run build
npm link
chat-unleashed setup
```

The wizard validates Apple Silicon and Node.js first. It then:

1. installs `tunnel-client` through Homebrew when needed,
2. asks for the tunnel ID,
3. accepts the runtime key through masked input,
4. writes `~/.config/tunnel-client/local-mac.yaml`,
5. stores the key in `~/.local/share/local-agent-mcp/.env.tunnel` with mode `0600`,
6. builds and deploys the local server when needed,
7. installs independent server and tunnel LaunchAgents,
8. verifies a real MCP handshake and tunnel readiness,
9. installs the tunnel-preserving update watcher.

Run setup again at any time. Existing correct steps are reused. `chat-unleashed setup --check` inspects the plan without writing anything. `--fresh` lets you replace the saved tunnel ID or key deliberately.

## 4. Add the connector in ChatGPT

OpenAI's current flow is on ChatGPT web. Workspace permissions still control who can add custom MCP servers. You do not need to enable Developer Mode first.

Run:

```sh
chat-unleashed connect --open
```

The command prints the current values and opens ChatGPT plus the Platform tunnel/key pages. In ChatGPT:

1. Open **Plugins**.
2. Select **+**, then **Add custom MCP server**.
3. Enter the name and description below.
4. Under **Connection**, choose **Tunnel** and select or paste your tunnel ID.
5. Set the local MCP authentication to **None**.
6. Review the risk warning, acknowledge it, and create the plugin.

Use these values in the custom MCP server form:

| Field | Value |
| --- | --- |
| Name | Chat Unleashed |
| Description | Runs commands, reads and writes files, looks at the screen and drives apps on my Mac. Use it when a request needs work done on the local machine instead of only an answer. |
| Connection | Tunnel |
| Tunnel | the tunnel ID created in step 1 |
| Authentication | None |

Authentication is `None` at the local MCP layer because `tunnel-client` holds the runtime credential on the Mac and authenticates the outbound tunnel. Do not paste the runtime key into the ChatGPT connector form.

If the form does not offer a Tunnel connection type, the required tunnel feature is not available in that workspace configuration.

After creation, review the discovered tools. When the server's tool definitions change later, refresh the custom MCP server's tools in the workspace before relying on the new definitions.

OpenAI's current setup documentation is maintained at <https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt> and the Secure MCP Tunnel guide at <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>.

## 5. Grant macOS permissions as needed

The first use of a capability may trigger macOS permissions such as:

- Accessibility
- Screen Recording
- Automation for a specific app
- Full Disk Access for protected files, only when genuinely required

Use the `mac_permissions` tool or `chat-unleashed doctor` to inspect permission state. macOS remains the authority for these grants.

## Changing the setup later

- `chat-unleashed connect` shows the current connector values.
- `chat-unleashed doctor` identifies which layer is failing.
- `chat-unleashed logs tunnel` follows the tunnel log.
- `chat-unleashed setup --fresh` replaces tunnel credentials deliberately.
- `app_config` edits saved local settings.
- `chat-unleashed update` stages source updates without restarting the tunnel.

## When a conversation stops reaching the Mac

Treat the local server, tunnel process and ChatGPT connector session as separate layers.

A healthy server does not prove the tunnel is ready. A healthy tunnel does not prove an older conversation still has a valid connector session. Run:

```sh
chat-unleashed doctor
```

If the server and tunnel are healthy but an existing conversation still cannot call tools, refresh the connector tools and start a new conversation with Chat Unleashed selected.

Avoid restarting the tunnel as a first troubleshooting step. A tunnel restart can invalidate active remote session state.

## Security notes

- The local MCP endpoint is loopback-only by default.
- The tunnel is outbound and does not require exposing a public port.
- The runtime key is stored in a protected `0600` file and is never printed by the CLI.
- Audit logs are local and bounded. Content-bearing arguments and successful tool-result text are not copied into the audit trail; secret-looking fields and environment values are redacted. Logs can still contain private filenames, commands and application context.
- Chat Unleashed has full local authority granted to the macOS account. It is not a sandbox.

See [SECURITY.md](../SECURITY.md) for the complete security policy.
