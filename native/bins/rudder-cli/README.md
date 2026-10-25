# Rust CLI entry

This explicit Rust executable provides board authentication and the read-only
`organization.members.list` capability, plus the shared Rust core MCP transport.
Build or run it with `cargo run -p rudder-cli -- org members ...`.
It does not replace or select the existing `rudder` CLI, does not launch Node,
and has no fallback implementation.

The server owns `/api/cli-auth/*` in Rust when
`RUDDER_RUST_PUBLIC_INGRESS_MODE=required`. The supported standalone `off`
mode temporarily retains its existing Node handlers; they are not registered
behind the Rust listener and are never a fallback for a failed native request.
Removing this compatibility path requires the default-ingress cutover and its
startup acceptance. Desktop selects `required` unless explicitly overridden.

```text
rudder-cli org members [--org-id <id>] [--query <text>]
  [--type <human|agent|all>] [--limit <1..100>] [--cursor <opaque>]
  [--api-base <url>] [--api-key <token>] [--context <path>]
  [--profile <name>] [--config <path>] [--json] [--full-ids]
```

The command calls the canonical `organization.members.list` API with a bearer
token, requires an organization ID, preserves the returned page and opaque
cursor, and prints either JSON or the existing CLI-style `total=` and member
records. A response is capped at 1,000,000 bytes, requests time out after 10
seconds by default, and redirects are not followed. Set
`RUDDER_CLI_HTTP_TIMEOUT_MS` to a value from 50 through 120000 to change the
request timeout.
Bearer credentials are sent only to HTTPS URLs or loopback HTTP URLs.

`--context` and `--profile` read the existing context JSON shape. Profile API
keys are read only from the environment variable named by
`apiKeyEnvVarName`; the token itself is never read from or written to context.
`--config` is used only to infer the local API port when no API URL is otherwise
configured. API URL precedence is `--api-base`, `RUDDER_API_URL`, profile
`apiBase`, then the local configured/default host and port. Organization ID
precedence is `--org-id`, `RUDDER_ORG_ID`, then profile `orgId`.

Board login uses the existing browser approval workflow and compatible version-1
`auth.json` store:

```sh
rudder-cli auth login --api-base http://localhost:3100 --no-browser --json
rudder-cli auth whoami --api-base http://localhost:3100 --json
rudder-cli auth logout --api-base http://localhost:3100 --json
```

Omit `--no-browser` to open the approval page automatically. Login also supports
`--instance-admin` and `--org-id`. Approve access in the browser before the
challenge expires. Board keys are saved only after approval and identity lookup;
they are never printed. The approval URL contains the temporary challenge secret.

`RUDDER_AUTH_STORE` overrides the credential file; otherwise it is
`$RUDDER_HOME/auth.json` or `~/.rudder/auth.json`. Auth commands accept
`--data-dir` to select `RUDDER_HOME`. Writes use an OS lock and atomic replacement,
preserve other origins, and create credential files with mode 0600 on Unix.
Existing Unix stores with group/world permissions are rejected before keys are
used; restrict their permissions to 0600 before retrying.
Logout attempts server revocation and removes the matching local credential even
if the server is unavailable; `revoked` reports that distinction. A concurrent
new login is preserved. Context files never contain keys. Member commands and
`whoami` prefer an explicit key/environment key/profile key over stored board
credentials.

`rudder-cli mcp-server` serves the same core tool manifest and stdio protocol as
`rudder-native mcp-server`, without launching the Node CLI. API-backed tools
still depend on their respective API owners; a Rust MCP transport does not
retire an API's remaining Node business implementation. Browser and Computer
servers are separate surfaces and are not selected by this command.

The existing Node CLI remains the default. Its other commands and interactive
member-command login are not replaced by this explicit entry.
`--data-dir` and `--run-id` remain unsupported by `org members`.
