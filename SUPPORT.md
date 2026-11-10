# Getting support

For setup and everyday use, start with the [README](README.md), [connection guide](docs/CONNECT_CHATGPT.md), [troubleshooting guide](docs/TROUBLESHOOTING.md) and [deferred update guide](docs/DEFERRED_UPDATES.md).

## Diagnose locally first

```sh
chat-unleashed doctor
chat-unleashed status
npm run build
```

If the CLI is not linked, run `npm run unleashed -- doctor` from the repository checkout. A healthy local HTTP endpoint alone does not guarantee that the Secure MCP Tunnel and the ChatGPT connector session are healthy.

Check the MCP server, tunnel and connector as separate layers. **Do not restart a working tunnel in the middle of an active ChatGPT conversation solely to troubleshoot the local server.**

## Ask for help

Open a [GitHub issue](https://github.com/PotterSkxawng/chat-unleashed/issues/new/choose) for reproducible bugs or feature requests, using the matching template. Include the steps, expected and actual results, macOS and Node.js versions, installation method and results of relevant checks.

Redact device identifiers, local paths, tokens, tunnel profiles, private files and personal data before sharing output. Please do not attach full audit logs. Do not report vulnerabilities in a public issue; see [SECURITY.md](SECURITY.md).

This is a community-maintained project. Support and response times are not guaranteed.
