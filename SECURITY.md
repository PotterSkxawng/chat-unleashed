# Security policy

Chat Unleashed can execute shell commands, read and change files, control desktop applications and interact with a browser. A connected agent can act with the permissions of the macOS account running the server. Treat access to this MCP endpoint as sensitive.

## Supported versions

Security fixes are evaluated for the current `main` branch. Tagged preview builds and older snapshots are not guaranteed individual security maintenance. There is no promise of a fixed response or patch timeline.

## Privately report a vulnerability

**Do not publish a vulnerability, exploit details or real credentials in a GitHub issue, pull request or discussion.**

1. Open this repository's **Security** tab and use **Report a vulnerability** if GitHub private vulnerability reporting is available.
2. If that option is unavailable, contact the repository maintainer through a private channel you already share, without posting the details publicly. Do not assume ordinary GitHub issues are confidential.
3. Provide a description of the impact, the affected version or commit, macOS and Node.js versions, and minimal sanitized reproduction steps. Use synthetic data instead of actual keys, logs or private documents.

The maintainer will review reports and coordinate any fix and disclosure when practical. Please allow time for triage before public disclosure, and do not test against systems or accounts that you do not control.

## Important security boundaries

- **Local HTTP is not authenticated.** The supported local endpoint binds to loopback and checks Host and Origin values. The MCP transport also enables DNS-rebinding protection. Do not bind it to `0.0.0.0`, expose it through a public reverse proxy or forward its port.
- **Remote access uses the configured Secure MCP Tunnel.** Protect tunnel credentials and profiles, keep them out of commits and rotate credentials if exposed.
- **Tools are privileged.** Shell commands, browser interaction, UI scripting and file access can have real effects. macOS permissions are not a sandbox for actions already allowed to the user.
- **There is no path sandbox.** Chat Unleashed intentionally does not present an `allowedRoots` setting as a security boundary because full terminal access could bypass one. Use a dedicated macOS account or stronger OS-level isolation when you need a real boundary.
- **Prompt injection is a risk.** Files and web pages accessed by an agent may contain untrusted instructions. Review unexpected requests and sensitive actions.
- **Audit arguments are redacted, not content-free.** Content-bearing fields such as typed text, document bodies and form values are redacted before writing the local audit log, and successful tool-result text is not copied into audit summaries. Secret-looking keys, environment values, bearer tokens and common token formats are also redacted. Filenames, commands, summaries and other private context may still be present.
- **Audit retention is bounded.** The default is four files of up to 8 MiB each. Operators can change the limits with `LOCAL_AGENT_AUDIT_MAX_BYTES` and `LOCAL_AGENT_AUDIT_KEEP`.
- **Captures can be sensitive.** Screenshots, browser output, downloaded files and task artifacts can expose private information. Do not attach raw versions to public issues.
- **Revocation matters.** Disable the connector or stop the tunnel if you need to revoke remote access. Stopping only the local HTTP server does not revoke the tunnel credential.
- **Updates preserve the tunnel by default.** `chat-unleashed update` stages and validates a candidate, then replaces only the local MCP server after a quiet window. An explicit `chat-unleashed restart` is a different operation and restarts both services.

See the [README security model](README.md#security-model) and [troubleshooting guide](docs/TROUBLESHOOTING.md) for operational guidance. This policy does not claim the project has undergone an independent third-party security audit.
