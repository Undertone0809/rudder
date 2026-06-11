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

Once the Rudder CLI process starts, `rudder start` shows progress for the
Rudder-managed install stages, including Desktop checksum download, Desktop
asset download, verification, replacement, portable app installation, launcher
setup, and launch. The first `npx` package fetch and its "Ok to proceed?"
prompt are controlled by npm itself, so Rudder progress output starts after
npm has handed execution to the CLI.

First-run speed depends on three separate network paths: npm for the thin CLI,
npm for the cached server runtime, and GitHub Releases for the portable Desktop
asset. On Windows, the Desktop zip is usually the largest asset. If the initial
`npx` phase is slow before Rudder prints its banner, check npm's active registry
and proxy settings with `npm config get registry`, `npm config get proxy`, and
`npm config get https-proxy`. If the slowdown starts at `Downloading
Rudder-...-portable.zip`, the bottleneck is the GitHub Release asset path;
Rudder uses the public release download URL first and falls back to the GitHub
asset API URL if needed.

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
pnpm rudder issue list --org-id <org-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--query text] [--match text]
pnpm rudder issue search "keyword or phrase" --org-id <org-id>
pnpm rudder issue get <issue-id-or-identifier>
pnpm rudder issue create --org-id <org-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm rudder issue update <issue-id> [--status in_progress] [--comment-file ./comment.md] [--image ./screenshot.png]
pnpm rudder issue comment <issue-id> --body-file ./comment.md [--image ./screenshot.png] [--reopen]
pnpm rudder issue done <issue-id> --comment-file ./comment.md [--image ./screenshot.png]
pnpm rudder issue block <issue-id> --comment-file ./comment.md [--image ./screenshot.png]
pnpm rudder issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm rudder issue release <issue-id>
```

`issue search` and `issue list --query` call the server-side `q` search on
`GET /api/orgs/:orgId/issues`, covering identifier, title, description, and
issue comments. Human output includes identifier, title, status, assignee,
project, updated time, and a compact match snippet when the server provides one.
`--match` remains a local filter over already returned rows for compatibility.

`--image` may be repeated. The CLI uploads each local PNG/JPEG/WebP/GIF as an
issue attachment and appends Markdown image links to the comment body.
Issue comments, issue close-out comments, issue document bodies, and approval
comments use file or stdin body input. Use `--body-file` or `--comment-file`
for multiline Markdown, command names, code spans, code blocks, test summaries,
and screenshot evidence. Pass `-` to read the body from stdin.
If a comment cites a screenshot path or visual validation artifact, attach that
file with `--image <path>` instead of leaving only the local path in the text.

## Project Commands

```sh
pnpm rudder project list --org-id <org-id>
pnpm rudder project get <project-id-or-shortname> [--org-id <org-id>]
pnpm rudder project create --org-id <org-id> --name "..." [--description "..."] [--status planned] [--goal-id <goal-id>] [--lead-agent-id <agent-id>]
pnpm rudder project update <project-id-or-shortname> [--org-id <org-id>] [--name "..."] [--status in_progress] [--archived-at null]
```

Project commands are part of the agent-facing CLI contract. Agent-authenticated
mutating calls attach `RUDDER_AGENT_ID` and `RUDDER_RUN_ID` when available and
remain scoped to the authenticated organization.

## Automation Commands

```sh
pnpm rudder automation list --org-id <org-id> [--status active] [--assignee-agent-id <agent-id>] [--project-id <project-id>] [--output-mode track_issue]
pnpm rudder automation get <automation-id>
pnpm rudder automation runs <automation-id> [--limit 50]
pnpm rudder automation triggers list <automation-id>
pnpm rudder automation create --org-id <org-id> --title "..." --assignee-agent-id <agent-id> [--payload '{"outputMode":"chat_output"}']
pnpm rudder automation update <automation-id> [--title "..."] [--payload '{"status":"paused"}']
pnpm rudder automation enable <automation-id>
pnpm rudder automation disable <automation-id>
pnpm rudder automation run <automation-id> [--trigger-id <id>] [--payload '{"manual":true}']
```

Automation read commands use the stable automation REST APIs and do not create
activity rows. Mutations use the governed automation routes, so agent-authenticated
calls attach `RUDDER_AGENT_ID` and `RUDDER_RUN_ID` when available and keep the
same permission/attribution behavior as the UI.

## Chat Commands

```sh
pnpm rudder chat list --org-id <org-id> [--status active|resolved|archived|all] [--query text]
pnpm rudder chat search "keyword" --org-id <org-id> [--scope all|title|summary|messages] [--snippet-chars 220]
pnpm rudder chat get <chat-id>
pnpm rudder chat messages <chat-id> [--include-transcript] [--limit 20]
pnpm rudder chat transcript <chat-id> [--limit 20] [--max-chars 1200]
pnpm rudder chat read <chat-id> [--limit 20] [--include-transcript]
pnpm rudder chat create --org-id <org-id> [--title "..."] [--preferred-agent-id <agent-id>]
pnpm rudder chat send <chat-id> --body "..."
pnpm rudder chat archive <chat-id>
```

Chat search calls the server-side chat query and prints bounded snippets by
default. Long conversations are not dumped by `list` or `search`; use
`messages` or `transcript` explicitly, and prefer `--json` when another tool
needs the complete structured payload.

## Run Debugging Commands

```sh
pnpm rudder runs list --org-id <org-id> [--status failed] [--agent-id <id>] [--issue-id <id>] [--runtime codex_local] [--limit 200]
pnpm rudder runs get <run-id>
pnpm rudder runs events <run-id>
pnpm rudder runs log <run-id> [--max-chars 12000]
pnpm rudder runs transcript <run-id> [--errors-only] [--around-error step-12] [--context-turns 1] [--chronological] [--narrative]
pnpm rudder runs errors <run-id> [--max-chars 1200]
pnpm rudder runs cancel <run-id>
pnpm rudder runs retry <run-id>
```

`runs transcript` is normalized server-side from persisted run detail and log
content. Human output is compact, clipped, and newest-first by default; pass
`--chronological` or `--narrative` for explicit reading modes. `--json` returns
the stable payload with rows, trace counts, and clipped-output metadata.
`runs errors` provides the error-first path for failed tool calls, stderr/result
failures, and runtime failures, including a stable `step-N` context command such
as `rudder runs transcript <run-id> --around-error step-12`.

## Agent Commands

```sh
pnpm rudder agent list --org-id <org-id>
pnpm rudder agent get <agent-id-or-shortname> [--org-id <org-id>]
pnpm rudder agent update [agent-id] [--org-id <org-id>] [--name "..."] [--role engineer] [--title "..."] [--description "..."]
pnpm rudder agent config index
pnpm rudder agent config doc <agent-runtime-type>
pnpm rudder agent config list --org-id <org-id>
pnpm rudder agent config get <agent-id-or-shortname> [--org-id <org-id>]
pnpm rudder agent icons
pnpm rudder agent hire --org-id <org-id> --payload '{"role":"cto","title":"Chief Technology Officer","agentRuntimeType":"codex_local","agentRuntimeConfig":{"cwd":"/abs/path"}}'
pnpm rudder agent skills create [agent-id] --name "Skill name" [--slug short-name] [--description "..."] [--markdown-file ./SKILL.md] [--enable]
pnpm rudder agent skills enable <agent-id> <selection-ref...>
pnpm rudder agent skills sync <agent-id> --desired-skills "<csv>"
pnpm rudder agent local-cli <agent-id-or-shortname> --org-id <org-id>
```

`agent config index`, `agent config doc`, and `agent icons` print plain-text reference docs by default.
Pass `--json` if you want the raw text wrapped as a JSON string.
`agent icons` is a legacy compatibility/debugging reference; normal hire and create payloads should omit `icon` so Rudder generates a DiceBear Notionists avatar.

`agent update` modifies an agent's control-plane identity fields. When `[agent-id]` is omitted it defaults to `RUDDER_AGENT_ID`, so an agent can update its own visible name, title, role, capabilities/description, and manager relationship after an operating-contract change. `--description` is a CLI alias for the stored `capabilities` field; `--clear-title`, `--clear-description`, and `--clear-reports-to` clear nullable fields.

`agent skills create` creates an agent-private skill under `AGENT_HOME/skills` for the target agent. When `[agent-id]` is omitted it defaults to `RUDDER_AGENT_ID`. Pass `--enable` to add the new private skill to the agent's enabled skill set for future runs.

`agent skills enable` is additive and preserves existing enabled skills.
`agent skills sync` replaces the full optional enabled-skill set.

`agent hire` is the canonical CLI wrapper for `POST /api/orgs/:orgId/agent-hires`:

- creates the agent directly when the organization does not require approval
- returns both `agent` and `approval` when board approval is required
- accepts the same payload shape as the hire API, including `desiredSkills`, `sourceIssueId`, and `sourceIssueIds`
- should omit `icon` for normal hires; only pass an explicit DiceBear reference or uploaded `asset:<uuid>` avatar reference supplied by the board/UI

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
pnpm rudder approval comment <approval-id> --body-file ./comment.md
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
