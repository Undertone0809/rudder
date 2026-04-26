# CLI Reference

Rudder CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm rudder --help
```

First-time install from npm:

```sh
npx @rudderhq/cli@latest start
```

This checks for newer Rudder CLI releases, prepares the matching persistent
`rudder` CLI, and installs the matching per-user portable Rudder Desktop app
from GitHub Release assets when needed. Desktop assets are checksum-verified
before installation.

Invocation forms are equivalent once they resolve to the same CLI version:

```sh
npx @rudderhq/cli@latest start
rudder start

npx @rudderhq/cli@latest onboard --yes
rudder onboard --yes
```

Use `npx @rudderhq/cli@latest ...` for the first run or when explicitly selecting
an npm dist-tag/version. Use `rudder ...` after the persistent CLI exists. The
command behavior is the same; only binary resolution differs.

CLI-only first-run setup remains available:

```sh
npx @rudderhq/cli@latest onboard --yes
```

Packaged Desktop also attempts to export a `rudder` command on first launch by
writing a small wrapper script that routes back through the installed Desktop
executable. Development Desktop runs do not install or manage this wrapper; use
`pnpm rudder ...` while working from the repo. If no writable PATH directory is
available, fall back to:

```sh
npx @rudderhq/cli@latest onboard --yes
```

First-time local bootstrap + run:

```sh
pnpm rudder run
```

Choose local instance:

```sh
pnpm rudder run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `rudder onboard` and `rudder configure --section server` set deployment mode in config
- runtime can override mode with `RUDDER_DEPLOYMENT_MODE`
- `rudder run` and `rudder doctor` do not yet expose a direct `--mode` flag

Target behavior (planned) is documented in `doc/DEPLOYMENT-MODES.md` section 5.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm rudder allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Organization-scoped commands also support `--org-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.rudder`:

```sh
pnpm rudder run --data-dir ./tmp/rudder-dev
pnpm rudder issue list --data-dir ./tmp/rudder-dev
```

## Context Profiles

Store local defaults in `~/.rudder/context.json`:

```sh
pnpm rudder context set --api-base http://localhost:3100 --org-id <org-id>
pnpm rudder context show
pnpm rudder context list
pnpm rudder context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm rudder context set --api-key-env-var-name RUDDER_API_KEY
export RUDDER_API_KEY=...
```

## Organization Commands

```sh
pnpm rudder organization list
pnpm rudder organization get <org-id>
pnpm rudder organization delete <org-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm rudder organization delete PAP --yes --confirm PAP
pnpm rudder organization delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `RUDDER_ENABLE_COMPANY_DELETION`.
- With agent authentication, organization deletion is organization-scoped. Use the current organization ID/prefix (for example via `--org-id` or `RUDDER_ORG_ID`), not another organization.

## Issue Commands

```sh
pnpm rudder issue list --org-id <org-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm rudder issue get <issue-id-or-identifier>
pnpm rudder issue create --org-id <org-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm rudder issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm rudder issue comment <issue-id> --body "..." [--reopen]
pnpm rudder issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm rudder issue release <issue-id>
```

## Agent Commands

```sh
pnpm rudder agent list --org-id <org-id>
pnpm rudder agent get <agent-id-or-shortname> [--org-id <org-id>]
pnpm rudder agent config index
pnpm rudder agent config doc <agent-runtime-type>
pnpm rudder agent config list --org-id <org-id>
pnpm rudder agent config get <agent-id-or-shortname> [--org-id <org-id>]
pnpm rudder agent icons
pnpm rudder agent hire --org-id <org-id> --payload '{"role":"cto","title":"Chief Technology Officer","icon":"crown","agentRuntimeType":"codex_local","agentRuntimeConfig":{"cwd":"/abs/path"}}'
pnpm rudder agent local-cli <agent-id-or-shortname> --org-id <org-id>
```

`agent config index`, `agent config doc`, and `agent icons` print plain-text reference docs by default.
Pass `--json` if you want the raw text wrapped as a JSON string.

`agent hire` is the canonical CLI wrapper for `POST /api/orgs/:orgId/agent-hires`:

- creates the agent directly when the organization does not require approval
- returns both `agent` and `approval` when board approval is required
- accepts the same payload shape as the hire API, including `desiredSkills`, `sourceIssueId`, and `sourceIssueIds`

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Rudder agent:

- creates a new long-lived agent API key
- prints the `RUDDER_*` environment you need for local Claude/Codex runs
- runtime skill loading still comes from the agent's enabled-skills configuration inside Rudder, not from `~/.codex/skills` or `~/.claude/skills`
- prints `export ...` lines for `RUDDER_API_URL`, `RUDDER_ORG_ID`, `RUDDER_AGENT_ID`, and `RUDDER_API_KEY`

Example for shortname-based local setup:

```sh
pnpm rudder agent local-cli codexcoder --org-id <org-id>
pnpm rudder agent local-cli claudecoder --org-id <org-id>
```

## Approval Commands

```sh
pnpm rudder approval list --org-id <org-id> [--status pending]
pnpm rudder approval get <approval-id>
pnpm rudder approval create --org-id <org-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm rudder approval approve <approval-id> [--decision-note "..."]
pnpm rudder approval reject <approval-id> [--decision-note "..."]
pnpm rudder approval request-revision <approval-id> [--decision-note "..."]
pnpm rudder approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm rudder approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm rudder activity list --org-id <org-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm rudder dashboard get --org-id <org-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm rudder heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.rudder/instances/default`:

- config: `~/.rudder/instances/default/config.json`
- embedded db: `~/.rudder/instances/default/db`
- logs: `~/.rudder/instances/default/logs`
- storage: `~/.rudder/instances/default/data/storage`
- secrets key: `~/.rudder/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
RUDDER_HOME=/custom/home RUDDER_INSTANCE_ID=dev pnpm rudder run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm rudder configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
