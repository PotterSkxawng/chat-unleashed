# Chat Unleashed

[![CI](https://github.com/PotterSkxawng/chat-unleashed/actions/workflows/ci.yml/badge.svg)](https://github.com/PotterSkxawng/chat-unleashed/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/PotterSkxawng/chat-unleashed)](LICENSE)
[![Release: Public Beta 1](https://img.shields.io/badge/release-Public%20Beta%201-0A84FF)](https://github.com/PotterSkxawng/chat-unleashed/releases/tag/preview-public-beta1)
![Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)
![MCP tools](https://img.shields.io/badge/MCP%20tools-114-0A84FF)

**Give ChatGPT local access to your Apple Silicon Mac through MCP.**

Chat Unleashed is an open-source MCP server that lets ChatGPT run commands, work with files, inspect the screen, control apps, automate a browser, edit iWork documents, and carry out longer local workflows. The server stays on your Mac. ChatGPT reaches it through an outbound OpenAI Secure MCP Tunnel.

## Why Chat Unleashed exists

Chat is where most work starts, but normal Chat does not natively act on your Mac. Work and Codex can carry out agentic work, but they draw from a shared agentic usage allowance. Chat Unleashed closes that gap by giving normal Chat a local execution layer: the same conversation can reason about a task and then use MCP tools to do the work on your Mac.

That separation is one of the main reasons Chat Unleashed exists: it turns the Chat experience you already use into a capable local execution layer without routing the work through the Work/Codex agentic pool. It is a particularly useful advantage to make use of now, while that distinction remains.

- [ChatGPT and Codex usage limits](https://help.openai.com/en/articles/20001625-understanding-chatgpt-and-codex-usage-limits)

> **Public Beta:** Chat Unleashed has full terminal and desktop access with the permissions of your macOS account. Read the [security model](#security-model) before connecting it.

## How it works

```mermaid
flowchart LR
    A[ChatGPT] --> B[OpenAI Secure MCP Tunnel]
    B --> C[tunnel-client on your Mac]
    C --> D[Chat Unleashed MCP server]
    D --> E[Shell and files]
    D --> F[macOS apps and UI]
    D --> G[Browser automation]
    D --> H[iWork and local workflows]
```

The MCP server and its settings API bind to loopback by default. You do not expose a public port or run a public reverse proxy.

## Quick start

### Requirements

- Apple Silicon Mac
- Node.js **20.11.1 or newer**
- Homebrew if `tunnel-client` is not already installed
- Access to OpenAI Secure MCP Tunnels for the ChatGPT workspace you want to connect

### Install

```sh
git clone https://github.com/PotterSkxawng/chat-unleashed.git
cd chat-unleashed
npm ci
npm run build
npm link
chat-unleashed setup
```

The setup wizard first checks the Mac and Node.js version, then asks for the tunnel ID and runtime key. It configures the local server and background services, verifies a real MCP handshake, and installs the tunnel-preserving updater.

Then run:

```sh
chat-unleashed connect --open
```

That prints the five values to enter in ChatGPT and opens the relevant settings pages.

For the full walkthrough, see [Connecting ChatGPT](docs/CONNECT_CHATGPT.md).

## What you get

| Area | Capabilities |
| --- | --- |
| Terminal and files | Shell commands, long-lived shell sessions, file read/write/search, downloads, process control |
| Computer use | Screen capture, Accessibility inspection, keyboard, mouse, windows, menus, app control |
| Browser | Chromium DevTools automation, Safari fallback, DOM inspection, clicks, typing, downloads, console and network capture |
| iWork | Deep Pages, Numbers and Keynote creation, editing, formatting, inspection, export and verification |
| macOS apps | Calendar, Reminders, Notes, Contacts, Finder, Shortcuts, media, audio, system and network tools |
| Coding | Git operations, project context, code indexing, reviews, benchmarks and repository workflows |
| Durable work | Plans, saved task state, verification, resumable steps and reusable local skills |

Chat Unleashed currently exposes **114 MCP tools**. See the [full tool reference](docs/TOOLS.md) for the detailed catalog.

## The CLI

The `chat-unleashed` command is the human-facing control surface.

```text
CHAT UNLEASHED  [ Preview (Public Beta 1) ]  ChatGPT access to your Mac

● Ready · 114 tools available to ChatGPT

System         macOS · Apple Silicon · Node.js                         ✔
Secure Tunnel  Connected                                               ✔
MCP Server     114 tools online                                        ✔

Next: chat-unleashed connect
```

Common commands:

| Command | Purpose |
| --- | --- |
| `chat-unleashed` | Show current health and one recommended next action |
| `chat-unleashed setup` | Guided install and configuration |
| `chat-unleashed connect` | Print the ChatGPT connector values |
| `chat-unleashed doctor` | Diagnose the server, tunnel, permissions and configuration |
| `chat-unleashed update` | Fetch, build and stage a tunnel-safe update |
| `chat-unleashed status` | Compact health line, or JSON with `--json` |
| `chat-unleashed start` | Start the background services |
| `chat-unleashed stop` | Stop the background services |
| `chat-unleashed restart` | Explicitly restart both services |
| `chat-unleashed logs [server|tunnel|launchd]` | Follow a local log |

Useful options:

```text
--check      inspect setup/update without applying changes
--fresh      replace saved tunnel/key during setup
--stage      build and stage the current checkout
--status     show pending safe-update state
--cancel     cancel a pending safe update
--verbose    show diagnostic paths, URLs and timings
--json       machine-readable status output
--no-color   disable terminal styling
```

The shorter `local-mac` alias points to the same CLI.

## Security model

Chat Unleashed has full local authority under the macOS account that runs it. It is not a sandbox.

The local HTTP server binds to loopback, checks Host and Origin values, and enables the MCP transport's DNS-rebinding protection. ChatGPT reaches the Mac through the configured outbound OpenAI Secure MCP Tunnel, so the local MCP port should stay private.

macOS still controls Accessibility, Screen Recording, Automation and other permissions. The runtime key lives in a protected local file, and the audit log redacts secret-looking fields and content-bearing arguments before writing them. Files and web pages can still contain prompt-injection attempts, and `run_command` can do anything the user account itself can do.

Read [SECURITY.md](SECURITY.md) for the full trust boundaries, audit behavior and vulnerability-reporting process.

## Tunnel-safe updates

A normal update does **not** restart the tunnel.

```sh
chat-unleashed update
```

The CLI:

1. fetches `origin/main`,
2. fast-forwards the checkout,
3. installs the locked dependencies,
4. builds the candidate,
5. preflights it in an isolated local server,
6. stages it by SHA-256.

The background updater waits for 20 quiet minutes with no local or remote tool traffic. It then switches **only the local MCP server**, verifies the new process, and keeps the existing tunnel instance alive. If verification fails, it restores the previous bundle.

```sh
chat-unleashed update --status
chat-unleashed update --cancel
chat-unleashed update --stage
```

`chat-unleashed restart` is intentionally different: it explicitly restarts both services. Avoid it during an active ChatGPT session unless you want that interruption.

See [Deferred, tunnel-preserving updates](docs/DEFERRED_UPDATES.md) for the full design.

## Configuration and permissions

Saved configuration lives under:

```text
~/Library/Application Support/Chat Unleashed/
```

The tunnel client keeps its profile and runtime credential in separate protected user locations. The server re-reads its settings on each tool call, so most configuration changes do not require a restart.

Read [Configuration and permissions](docs/CONFIGURATION.md) for paths, the local settings API, macOS permissions and optional integrations.

## Documentation

- [Connect ChatGPT](docs/CONNECT_CHATGPT.md)
- [Tool reference](docs/TOOLS.md)
- [iWork behavior and editing details](docs/IWORK.md)
- [Configuration and permissions](docs/CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Tunnel-safe updates](docs/DEFERRED_UPDATES.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Governance](GOVERNANCE.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Development

Install from the lockfile and run the release checks:

```sh
npm ci
npm run build
npm run smoke:logic
npm run smoke:portability
npm run check:public
npm run check:pack
```

The broader release suite also runs integration, stress and updater-safety checks:

```sh
npm run validate:release
```

CI runs on macOS and verifies the supported Node.js range. Some UI and Automation behavior still requires a real logged-in Mac with the corresponding macOS permissions.

The repository intentionally does not publish `chat-unleashed` to npm yet. Install from this GitHub checkout or a GitHub release.

## License

Chat Unleashed is available under the [MIT License](LICENSE).
