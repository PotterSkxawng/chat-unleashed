# Contributing to Chat Unleashed

Chat Unleashed gives connected agents shell, file, browser, and desktop control on Apple Silicon Macs. Changes should preserve reliability, privacy, predictable behavior, and clear failure modes before adding breadth.

## Before opening an issue

- Search existing issues and check [SUPPORT.md](SUPPORT.md) and the [troubleshooting guide](docs/TROUBLESHOOTING.md).
- Use the bug report or feature request template. Report security vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.
- Include versions, a minimal reproduction, and sanitized error messages. Never post tunnel IDs, tokens, environment files, audit logs, private file contents, contacts, sensitive screenshots, or machine-specific paths.
- Discuss large architecture, permission, or compatibility changes before investing in a major implementation.

## Development setup

Use an Apple Silicon Mac, Node.js 20.11.1 or newer, and npm. Optional features require the corresponding macOS app or permission.

```sh
git clone https://github.com/PotterSkxawng/chat-unleashed.git
cd chat-unleashed
npm ci
npm run build
npm run smoke:logic
npm run check:public
npm run check:pack
```

Additional checks:

```sh
npm run smoke:all
npm run test:updater
npm run stress:all
```

`npm run validate:release` runs the broader release suite. Some tests exercise macOS APIs, local servers, or optional applications, so record the host environment and any limitations with the result. Use synthetic fixtures instead of real user data.

A build only updates `dist/`; it does not deploy or restart a running server.

## Change guidelines

- Keep each change focused and reviewable. Use TypeScript and follow the surrounding source conventions.
- Preserve the loopback-only HTTP model and macOS permission flow. Do not expose the local server to the network or weaken Host/Origin checks.
- Treat shell, browser, filesystem, and UI automation as high-trust operations. Validate inputs and avoid surprising destructive behavior.
- Do not hard-code usernames, hostnames, chip models, tunnel IDs, or absolute home paths. Use documented defaults only where the product contract requires them.
- Keep credentials in protected local configuration. Never commit `.env` files, tunnel profiles, audit records, or captured screen data.
- Do not restart the Secure MCP Tunnel during an active session. Follow the [deferred update guide](docs/DEFERRED_UPDATES.md) for update and deployment work.
- Add or adjust smoke tests when behavior changes, and update the relevant documentation when commands or interfaces change.
- Do not claim broad UI compatibility without testing on an appropriate Mac. CI cannot grant every macOS Automation or Accessibility permission.

## Pull requests

1. Branch from the current `main`.
2. Explain the problem, approach, compatibility considerations, and security or privacy effects.
3. Run the relevant checks and record the exact commands and results in the pull request template.
4. Keep screenshots and logs minimal and sanitized.
5. Prefer conventional commit subjects such as `fix(cli): handle missing profile` or `docs: clarify setup`.

Maintainers may request revisions, more evidence, or a smaller scope. A reviewed contribution is not guaranteed to merge. By submitting a contribution, you confirm that you can offer it under the repository's [MIT License](LICENSE). There is no contributor license agreement.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) when participating. For routine help, see [SUPPORT.md](SUPPORT.md).
