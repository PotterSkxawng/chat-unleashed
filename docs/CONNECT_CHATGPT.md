# Connecting ChatGPT to Chat Unleashed

ChatGPT runs remotely. Chat Unleashed runs on your Mac and listens on loopback. OpenAI's Secure MCP Tunnel provides the outbound bridge, so you do not need to expose a public port or run a public reverse proxy.

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel-client -> http://127.0.0.1:3344/mcp
```

## What you need

- Apple Silicon Mac
- Node.js 20.11.1 or newer
- Homebrew if `tunnel-client` is not already installed
- A ChatGPT workspace that can add a custom MCP server through a Secure MCP Tunnel

## 1. Create a tunnel

Open <https://platform.openai.com/settings/organization/tunnels>, create a tunnel, and copy its ID. Tunnel IDs start with `tunnel_`.

OpenAI currently requires Tunnels Read + Manage to create or edit a tunnel.

## 2. Create the runtime key

Open <https://platform.openai.com/settings/organization/api-keys> and create a restricted runtime key for `tunnel-client`. The client currently needs Tunnels Read + Use to run and to select the tunnel in ChatGPT.

Copy the key once and keep it private. Do not use a broader admin credential for the long-lived local service.

## 3. Run setup

From the repository checkout:

```sh
npm ci
npm run build
npm link
chat-unleashed setup
```

The wizard validates Apple Silicon and Node.js before changing anything. It then asks for the tunnel ID and runtime key, installs `tunnel-client` through Homebrew when necessary, configures the local server and LaunchAgents, and verifies both the MCP handshake and tunnel.

Setup also installs the tunnel-preserving update watcher. Run `chat-unleashed setup --check` to inspect the plan without writing anything. Use `--fresh` only when you intend to replace the saved tunnel ID or runtime key.

## 4. Add Chat Unleashed in ChatGPT

Run:

```sh
chat-unleashed connect --open
```

The command prints the connector values and opens ChatGPT together with the relevant OpenAI Platform pages.

On ChatGPT web:

1. Open **Plugins**.
2. Select **+**, then **Add custom MCP server**.
3. Enter the values below.
4. Under **Connection**, choose **Tunnel** and select or paste the tunnel ID.
5. Set local MCP authentication to **None**.
6. Review the risk warning and create the plugin.

| Field | Value |
| --- | --- |
| Name | Chat Unleashed |
| Description | Runs commands, reads and writes files, looks at the screen, and drives apps on my Mac. Use it when a request needs work done on the local machine instead of only an answer. |
| Connection | Tunnel |
| Tunnel | the tunnel ID created in step 1 |
| Authentication | None |

Authentication is `None` at the local MCP layer because `tunnel-client` holds the runtime credential on the Mac and authenticates the outbound tunnel. Do not paste the runtime key into the ChatGPT connector form.

If the form does not offer a Tunnel connection type, that workspace does not currently expose the required tunnel feature.

After creating the connector, review the discovered tools. Refresh the custom MCP server's tools after a server update that changes tool definitions.

Official OpenAI references:

- <https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt>
- <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>

## 5. Grant macOS permissions when a tool needs them

The first use of a capability may trigger a macOS permission prompt. Common grants include Accessibility, Screen Recording, Automation for a specific app, and Full Disk Access for protected files.

Use `mac_permissions` or `chat-unleashed doctor` to inspect permission state. macOS remains the authority for those grants.

## Changing the setup later

- `chat-unleashed connect` prints the current connector values.
- `chat-unleashed doctor` identifies which runtime layer is failing.
- `chat-unleashed logs tunnel` follows the tunnel log.
- `chat-unleashed setup --fresh` replaces saved tunnel credentials deliberately.
- `app_config` edits local Chat Unleashed settings.
- `chat-unleashed update` stages source updates without restarting the tunnel.

## When a conversation stops reaching the Mac

Treat the local server, tunnel process, and ChatGPT connector session as separate layers. A healthy server does not prove the tunnel is ready, and a healthy tunnel does not prove an older conversation still has a valid connector session.

Run:

```sh
chat-unleashed doctor
```

If the server and tunnel are healthy but an existing conversation still cannot call tools, refresh the connector tools and start a new conversation with Chat Unleashed selected.

Avoid restarting a healthy tunnel as the first troubleshooting step because a restart can invalidate active remote session state. The [troubleshooting guide](TROUBLESHOOTING.md) covers the failure cases in detail.

Before connecting a workspace, read [SECURITY.md](../SECURITY.md). Chat Unleashed has the local authority of the macOS account that runs it and is not a sandbox.
