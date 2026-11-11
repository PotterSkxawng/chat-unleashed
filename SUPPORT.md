# Getting support

Start with the [README](README.md), [connection guide](docs/CONNECT_CHATGPT.md), and [troubleshooting guide](docs/TROUBLESHOOTING.md). For update behavior, use the [deferred update guide](docs/DEFERRED_UPDATES.md).

## Diagnose the local layers first

```sh
chat-unleashed doctor
chat-unleashed status
npm run build
```

If the CLI is not linked, run `npm run unleashed -- doctor` from the repository checkout.

Check the MCP server, tunnel, and ChatGPT connector as separate layers. A healthy local HTTP endpoint does not prove that the tunnel or connector session is healthy. Do not restart a working tunnel in the middle of an active ChatGPT conversation just to troubleshoot the local server.

## Open an issue

Use the matching [GitHub issue template](https://github.com/PotterSkxawng/chat-unleashed/issues/new/choose) for reproducible bugs or feature requests. Include the reproduction steps, expected and actual results, macOS and Node.js versions, installation method, and results of the relevant checks.

Redact device identifiers, local paths, tokens, tunnel profiles, private files, and personal data. Do not attach full audit logs.

Report vulnerabilities privately through [SECURITY.md](SECURITY.md), not a public issue.

Chat Unleashed is community-maintained, so response times are not guaranteed.
