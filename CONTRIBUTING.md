# Contributing to Chat Unleashed

Thanks for helping improve Chat Unleashed. It is an Apple Silicon macOS MCP server with powerful local tools. Reliability, privacy and predictable behavior matter more than adding features quickly.

## Before opening an issue

- Search existing issues and read [SUPPORT.md](SUPPORT.md) and [the troubleshooting guide](docs/TROUBLESHOOTING.md).
- Use the bug report or feature request template. For security vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than opening an issue.
- Share versions, a minimal reproduction and sanitized error messages. **Never post** tunnel IDs, tokens, environment files, audit logs, private file contents, contacts, screenshots of sensitive windows or machine-specific paths.
- Propose large changes in an issue before investing in a major implementation.

## Development setup

Use an Apple Silicon Mac, Node.js 20.11.1 or newer and npm. Optional features require their corresponding macOS applications or permissions.

```sh
git clone https://github.com/PotterSkxawng/chat-unleashed.git
cd chat-unleashed
npm ci
npm run build
npm run smoke:logic
npm run check:public
npm run check:pack
```

Useful extra checks:

```sh
npm run smoke:all
npm run test:updater
npm run stress:all
```

`npm run validate:release` runs the broader release checks. Some tests exercise macOS APIs, local servers or optional applications, so include the host environment and any limitations when reporting results. Do not use real user data for test fixtures. A build only updates `dist/`; it does not deploy or restart a running server.

## Change guidelines

- Keep changes focused and reviewable. Use TypeScript and follow the surrounding source conventions.
- Preserve macOS permission prompts and the private loopback-only HTTP model. Do not expose the local server to the network or weaken Host/Origin checks.
- Treat shell, browser, filesystem and UI automation as high-trust operations. Validate paths and inputs; avoid surprising destructive actions.
- Avoid hard-coded usernames, hostnames, chip models, local ports beyond documented defaults, tunnel identifiers and absolute home paths.
- Keep credentials in protected local configuration. Never commit `.env` files, tunnel profiles, audit records or captured screen data.
- Do not restart the Secure MCP Tunnel during an active session. Follow [deferred update guidance](docs/DEFERRED_UPDATES.md) when working on updates or deployment.
- Add or adjust smoke tests for behavior changes and update documentation when commands or interfaces change.
- Don't claim full UI compatibility without testing on an appropriate Mac. Automated CI cannot grant every macOS Automation or Accessibility permission.

## Pull requests

1. Create a focused branch based on the current `main` branch.
2. Explain the problem, the approach, compatibility considerations and any security or privacy effects.
3. Run relevant checks and record the exact commands and results in the pull request template.
4. Keep screenshots and logs minimal and sanitized. Do not include personal content or real credentials.
5. Prefer conventional commit subjects, such as `fix(cli): handle missing profile` or `docs: clarify setup`.

Maintainers may ask for revisions, additional tests or a smaller scope. Contributions are reviewed but not guaranteed to be merged. By submitting a contribution, you confirm you have the right to offer it under the repository's [MIT License](LICENSE). There is no contributor license agreement.

## Community

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md) when participating. For routine help, see [SUPPORT.md](SUPPORT.md).
