# Connecting ChatGPT to this Mac

ChatGPT runs in the cloud. This server runs on your Mac and listens on loopback only. The supported bridge is OpenAI's Secure MCP Tunnel: an outbound connection that `tunnel-client` keeps open, so no port is exposed and no public URL is needed.

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel-client -> http://127.0.0.1:3344/mcp
```

## What you need

- macOS on Apple Silicon
- Node 20 or newer
- Homebrew, if `tunnel-client` is not installed yet
- A ChatGPT account on the web. Custom MCP servers are not available on mobile.

Writes have a plan caveat. OpenAI documents full MCP, including write actions, for Business, Enterprise and Edu. Pro accounts are documented as read and fetch only, so the connector may show read tools and reject writes. Check the tool list in the app settings before relying on it.

## 1. Create the tunnel

Open <https://platform.openai.com/settings/organization/tunnels>, create a tunnel, and copy its ID. It looks like `tunnel_` followed by 32 lowercase letters or digits, optionally with a four character namespace.

Your account needs Tunnels Read and Use to create the runtime key in the next step.

## 2. Create the runtime key

Open <https://platform.openai.com/settings/organization/api-keys> and create a key for the tunnel runtime. Copy it once; it is not shown again. Do not use an admin key for the long-lived daemon.

## 3. Run setup

From this checkout:

```sh
npm install
npm link
chat-unleashed setup
```

Setup asks for the tunnel ID, then the key. The key input is hidden. It then writes `~/.config/tunnel-client/local-mac.yaml` pointed at `http://127.0.0.1:3344/mcp`, stores the key in `~/.local/share/local-agent-mcp/.env.tunnel` with mode `0600`, installs the server and tunnel launchd jobs, builds and deploys the server if needed, starts both, and waits for a real MCP handshake and a `ready` tunnel.

Run it again at any time. Every step that is already true is skipped. `--check` prints the plan without writing anything.

## 4. Add the connector in ChatGPT

1. Open chatgpt.com in a browser and sign in.
2. Settings, Security and login, turn on Developer mode.
3. Settings, Connectors (or Plugins), Add custom MCP server.
4. Name it Chat Unleashed. Choose Tunnel as the connection, paste the tunnel ID, leave authentication at None, and save.
5. Open a new chat, select the app from the composer with the plus button, and ask for something local, for example: "Use Chat Unleashed to list the files on my Desktop."

`chat-unleashed connect` prints these steps with your tunnel ID, and `chat-unleashed connect --open` opens the three pages for you.

## 5. Approve actions

Write actions ask for confirmation the first time. Choosing remember applies to that conversation only; a new conversation asks again. Tools marked read-only skip the prompt.

If a tool fails with a permission error, open System Settings, Privacy and Security, and grant the pane the error names. `mac_permissions` reports the current state and the exact binary that needs the grant.

## Changing the setup later

- Re-run `chat-unleashed connect` to see the connector steps with the current tunnel ID.
- Toggle individual tools in the app's details page in ChatGPT. After a server update, refresh the app to pull the new tool list.
- Edit settings in `~/Library/Application Support/local-agent-mcp/config.json`, or through the `app_config` tool. The server re-reads the file on every call.
- `chat-unleashed doctor` names the failing layer and its fix. `chat-unleashed logs tunnel` follows the tunnel log.

## When a chat stops talking to the Mac

A healthy tunnel does not prove an old chat session is still bound to it. If a request fails after a restart, start a new conversation and select the app again. Refreshing tools does not revive a dead session handle. The tunnel and the local server can both be healthy while a stale connector session is not.

If the tunnel exits but the server is alive, check `chat-unleashed doctor` and the tunnel log. The runtime key must be present in the environment of the tunnel process, which setup handles through the launchd wrapper.

## Security notes

- The tunnel is outbound. Nothing listens on a public interface.
- The key lives in a `0600` file and is referenced by name in the tunnel profile, never copied into it.
- `chat-unleashed` never prints the key, including in `doctor` and `status --json`.
- The audit log under `~/.local/share/local-agent-mcp/logs/audit.log` records tool calls locally. Do not commit it.
