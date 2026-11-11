# Security policy

Chat Unleashed can execute shell commands, read and change files, control desktop applications, and interact with a browser. A connected agent acts with the permissions of the macOS account running the server. Treat access to this MCP endpoint like access to that account.

## Supported versions

We evaluate security fixes against the current `main` branch. Tagged preview builds and older snapshots may not receive individual backports. We do not promise a fixed response or patch timeline.

## Report a vulnerability privately

Do not publish exploit details or real credentials in a GitHub issue, pull request, or discussion.

1. Open the repository's **Security** tab and use **Report a vulnerability** if GitHub private vulnerability reporting is available.
2. If it is unavailable, contact the maintainer through a private channel you already share.
3. Include the affected version or commit, macOS and Node.js versions, impact, and minimal sanitized reproduction steps. Use synthetic data instead of real keys, logs, or private documents.

Please allow time for triage before public disclosure, and only test systems and accounts you control.

## Local exposure

The supported HTTP endpoint binds to loopback and checks Host and Origin values. The MCP transport also enables DNS-rebinding protection. Do not bind the server to `0.0.0.0`, put the local port behind a public reverse proxy, or forward it onto a network.

Remote ChatGPT access should use the configured OpenAI Secure MCP Tunnel. Protect its profile and credentials, keep them out of commits, and rotate a credential if it is exposed.

## Agent authority

Shell commands, browser control, UI scripting, and file access can have real effects. macOS permission prompts limit some capabilities, but they are not a sandbox for actions the user account can already perform.

Chat Unleashed does not present `allowedRoots` as a security boundary. Full terminal access could bypass a path-only restriction. Use a dedicated macOS account or stronger OS-level isolation when you need a real boundary.

Files and web pages can contain prompt-injection attempts. Review unexpected tool requests and sensitive actions before allowing them to continue.

## Credentials, captures, and audit history

The runtime key stays in a protected local file. Audit logging redacts secret-looking keys, environment values, bearer tokens, common token formats, typed text, document bodies, form values, and other content-bearing arguments. Successful tool-result text is not copied into audit summaries.

Audit logs can still contain private filenames, commands, summaries, and application context. The default retention is four files of up to 8 MiB each. `CHAT_UNLEASHED_AUDIT_MAX_BYTES` and `CHAT_UNLEASHED_AUDIT_KEEP` can change those limits.

Screenshots, browser output, downloads, and task artifacts can also contain private information. Sanitize them before attaching anything to a public issue.

## Revoking access and updating safely

Disable the ChatGPT connector or stop the tunnel when you need to revoke remote access. Stopping only the local HTTP server does not revoke the tunnel credential.

`chat-unleashed update` stages and validates a candidate, then replaces only the local MCP server after a quiet window. `chat-unleashed restart` is different: it restarts both the local server and tunnel, which can interrupt active remote sessions.

See the [README security model](README.md#security-model) for the short version and [troubleshooting guide](docs/TROUBLESHOOTING.md) for recovery steps. This project does not claim an independent third-party security audit.
