# Rust member-directory CLI entry

This is an explicit Rust executable for the read-only `organization.members.list`
capability. Build or run it with `cargo run -p rudder-cli -- org members ...`.
It does not replace or select the existing `rudder` CLI, does not launch Node,
and has no fallback implementation.

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

Interactive TTY board login and stored/keychain board credentials are not
implemented. Supply `--api-key`, `RUDDER_API_KEY`, or a profile
`apiKeyEnvVarName`. `--data-dir` and `--run-id` are not supported by this
read-only command. The existing Node CLI remains the default and the MCP
dispatcher is not changed by this increment.
