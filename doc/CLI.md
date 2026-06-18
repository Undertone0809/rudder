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

## Agent-Facing Usage Principles

Prefer explicit context for agent and maintenance work:

- Pass `--org-id <org-id>` on organization-scoped reads and mutations when a local profile could point at the wrong organization.
- Pass `--json` for scripts, issue close-out evidence, and any command whose output will be parsed by another tool.
- Use file or stdin body options for multiline Markdown. `issue comment` and `approval comment` use `--body-file`; `issue done`, `issue block`, and `issue review` use `--comment-file`; `chat send` uses `--body` or stdin, not `--body-file`.
- Attach local screenshots and visual evidence with repeatable `--image <path>` on issue comments/status updates. A comment that only mentions `/tmp/foo.png` is not durable evidence for board users.
- Keep run attribution intact. Mutating agent-authenticated commands attach `RUDDER_AGENT_ID` and `RUDDER_RUN_ID` when available; if a command reports a run ownership conflict, inspect the issue/run state instead of retrying blindly.
- Treat approval decisions, automation runs, organization skill imports, agent skill sync, project archive changes, run cancel/retry, and organization deletion as governed or high-impact operations. Read the target first, then mutate.
- For run investigation, filter first with `runs list`, then use `runs errors` or bounded `runs transcript` reads. Do not start by dumping large run/transcript payloads.
- Use Library-relative paths such as `projects/rudder/proposals/plan.md` with `library file ref`; do not pass absolute filesystem paths or hand-write `library-entry://` links.

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

Recommended cases:

```sh
pnpm rudder issue context ZST-123 --wake-comment-id <comment-id> --json
pnpm rudder issue checkout ZST-123 --agent-id "$RUDDER_AGENT_ID" --expected-statuses todo,backlog,blocked --json
pnpm rudder issue comment ZST-123 --body-file ./progress.md --image ./screenshot.png --json
pnpm rudder issue done ZST-123 --comment-file ./done.md --image ./screenshot.png --json
```

Bad cases to avoid:

- Passing multiline Markdown through a shell argument such as `--body "line1\nline2"`; use `--body-file` or stdin.
- Citing `/tmp/screenshot.png` in a comment without `--image /tmp/screenshot.png`; board users may not be able to inspect it.
- Repeating `issue done` after a run ownership conflict; inspect `issue get`, `issue context`, and the active run instead.
- Leaving a free-form comment like "approved" as a review decision; use `issue review --decision approve|request_changes|needs_followup|blocked`.

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

Recommended cases:

```sh
pnpm rudder project list --org-id <org-id> --json
pnpm rudder project get rudder-dev --org-id <org-id> --json
pnpm rudder project create --org-id <org-id> --name "Rudder dev" --status in_progress --lead-agent-id <agent-id> --json
pnpm rudder project update rudder-dev --org-id <org-id> --status in_progress --json
```

Bad cases to avoid:

- Resolving a short project name without `--org-id` when multiple profiles or organizations are in play.
- Creating a new project before checking for the existing project id or shortname.
- Using `--archived-at` casually; archive changes affect project visibility and should follow a `project get` check.

## Automation Commands

```sh
pnpm rudder automation list --org-id <org-id> [--status active] [--assignee-agent-id <agent-id>] [--project-id <project-id>] [--output-mode track_issue]
pnpm rudder automation get <automation-id>
pnpm rudder automation runs <automation-id> [--limit 50]
pnpm rudder automation triggers list <automation-id>
pnpm rudder automation triggers create <automation-id> --kind schedule --cron-expression "0 9 * * 1" [--timezone UTC] [--label "..."] [--disabled]
pnpm rudder automation triggers create <automation-id> --kind webhook [--signing-mode bearer|hmac_sha256] [--replay-window-sec 300]
pnpm rudder automation triggers create <automation-id> --kind api [--label "..."] [--payload '{"enabled":true}']
pnpm rudder automation triggers update <trigger-id> [--label "..."] [--enabled|--disabled] [--cron-expression "..."] [--timezone UTC] [--signing-mode bearer|hmac_sha256] [--replay-window-sec 300] [--payload '{"label":null}']
pnpm rudder automation triggers delete <trigger-id>
pnpm rudder automation triggers rotate-secret <trigger-id>
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

Trigger mutation commands accept `--payload <json>` for the raw server payload
and also expose the common schedule/webhook/api fields as flags. Create supports
`schedule`, `webhook`, and `api` trigger kinds; update targets the trigger id
returned by `automation get` or `automation triggers list`.

Recommended cases:

```sh
pnpm rudder automation list --org-id <org-id> --status active --assignee-agent-id <agent-id> --json
pnpm rudder automation get <automation-id> --json
pnpm rudder automation triggers list <automation-id> --json
pnpm rudder automation run <automation-id> --payload '{"manual":true}' --idempotency-key zst-123-smoke --json
```

Bad cases to avoid:

- Running an automation by title or stale clipboard id without first checking `automation get`; manual runs can create tracked issues or chats.
- Updating or deleting a trigger without verifying whether the id is a trigger id or automation id.
- Retrying a manual run repeatedly without `--idempotency-key`; duplicate downstream work becomes harder to detect.
- Passing malformed JSON through `--payload`; validate the object before mutating automation state.

## Chat Commands

```sh
pnpm rudder chat list --org-id <org-id> [--status active|resolved|archived|all] [--query text]
pnpm rudder chat search "keyword" --org-id <org-id> [--scope all|title|summary|messages] [--snippet-chars 220]
pnpm rudder chat get <chat-id>
pnpm rudder chat messages <chat-id> [--limit 20] [--cursor <cursor>] [--include-transcript|--include-output] [--max-output-chars 1200]
pnpm rudder chat transcript <chat-id> [--limit 20] [--cursor <cursor>] [--max-chars 1200]
pnpm rudder chat read <chat-id> [--limit 20|--turn-limit 20] [--cursor <cursor>] [--include-output] [--max-output-chars 1200]
pnpm rudder chat create --org-id <org-id> [--title "..."] [--preferred-agent-id <agent-id>]
pnpm rudder chat send <chat-id> --body "..."
pnpm rudder chat archive <chat-id>
```

Chat search calls the server-side chat query and prints bounded snippets by
default. Long conversations are not dumped by `list` or `search`; use
`messages`, `read`, or `transcript` explicitly. These commands return
`page.nextCursor` in `--json` output for bounded follow-up reads; transcript
entries are omitted unless `--include-transcript` / `--include-output` is set.

When authenticated as an agent, `chat send` appends a direct agent-authored
message to the conversation for the operator to read. It does not create an
operator/user prompt, does not edit prior operator messages, and does not start
another chat assistant reply.

Recommended cases:

```sh
pnpm rudder chat list --org-id <org-id> --status active --query "release" --json
pnpm rudder chat read <chat-id> --turn-limit 20 --include-output --json
pnpm rudder chat send <chat-id> --body "Status: validation is running."
printf '%s\n' "Longer agent-authored note" | pnpm rudder chat send <chat-id>
```

Bad cases to avoid:

- Writing `chat send --body-file ./note.md`; this command supports `--body` or stdin only.
- Assuming an agent-authenticated `chat send` starts a new assistant generation. It only appends an agent-authored message.
- Dumping a long chat with unbounded transcript output when a cursor or `--turn-limit` read would answer the question.
- Editing/regenerating from a user message with `--edit-user-message-id` before reading the current conversation state.

## Run Debugging Commands

```sh
pnpm rudder runs list --org-id <org-id> [--status failed] [--agent-id <id>] [--issue-id <id>] [--runtime codex_local] [--used-skill <skill-key>] [--loaded-skill <skill-key>] [--limit 200]
pnpm rudder runs by-skill <skill-key-or-name> --org-id <org-id> [--evidence used|loaded] [--limit 50]
pnpm rudder runs get <run-id>
pnpm rudder runs events <run-id>
pnpm rudder runs log <run-id> [--max-chars 12000]
pnpm rudder runs transcript <run-id> [--turn-limit 20] [--cursor <cursor>] [--include-output] [--max-output-chars 1200] [--errors-only] [--around-error step-12] [--context-turns 1] [--chronological] [--narrative]
pnpm rudder runs errors <run-id> [--max-chars 1200]
pnpm rudder runs cancel <run-id>
pnpm rudder runs retry <run-id>
```

`runs list --used-skill <skill>` returns runs where telemetry shows the skill
was actually used. This is the default evidence semantic for skill optimization;
it does not count skills that were only loaded into the runtime. Use
`--loaded-skill <skill>` only when you deliberately need the broader "available
to the run" evidence set. Both filters match a skill key or display/runtime
name and include `skillEvidence`, `errorSummary`, Langfuse link metadata,
issue context, agent, runtime, timestamps, and the raw run fields in JSON.

`runs by-skill <skill>` is the agent-facing evidence packet for skill
optimization. It defaults to `--evidence used`, summarizes recent matching runs
by status, agent, issue, and common errors, then prints follow-up commands such
as `rudder runs transcript <run-id>` or `rudder runs errors <run-id>`. Pass
`--json` for a stable object with `{ skill, summary, rows, nextCommands }`.
Run IDs rendered by the CLI are short IDs by default, and every `runs <run-id>`
follow-up command accepts those short IDs directly.

`runs transcript` is normalized server-side from persisted run detail and log
content. Human output is compact, clipped, and newest-first by default; pass
`--chronological` or `--narrative` for explicit reading modes. Human compact
rows omit detailed output unless `--include-output` is set. `--json` requests
the full stable payload with raw transcript entries, page metadata, trace
counts, and unclipped entry output for scripts and agents.
`runs errors` provides the error-first path for failed tool calls, stderr/result
failures, and runtime failures, including a stable `step-N` context command such
as `rudder runs transcript <run-id> --around-error step-12`.

Recommended cases:

```sh
pnpm rudder runs list --org-id <org-id> --agent-id <agent-id> --status failed --limit 20 --json
pnpm rudder runs errors <run-id> --max-chars 4000 --json
pnpm rudder runs transcript <run-id> --around-error step-12 --context-turns 2
pnpm rudder runs transcript <run-id> --chronological --turn-limit 30 --include-output
```

Bad cases to avoid:

- Starting a run audit with a broad unfiltered `runs list --json`; filter by organization, agent, issue, status, skill, or time first.
- Expecting `runs list` to act as a projection/summary transcript endpoint. Use `runs errors` or `runs transcript` for details.
- Using `--json` transcript output when a compact human view is enough; full payloads can include large raw entries.
- Cancelling or retrying a run without checking whether it belongs to another active issue owner.

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

Recommended cases:

```sh
pnpm rudder agent inbox --json
pnpm rudder agent get <agent-id-or-shortname> --org-id <org-id> --json
pnpm rudder agent skills enable <agent-id> rudder/rudder local/abc123/custom-skill --json
pnpm rudder agent skills sync <agent-id> --desired-skills "rudder/rudder,local/abc123/custom-skill" --json
```

Bad cases to avoid:

- Treating `agent skills sync` as additive. It replaces the full optional enabled-skill set; use `agent skills enable` for additive changes.
- Claiming a newly copied private skill will load in future runs before checking the agent skill snapshot and enabling the selection.
- Printing or pasting broad `RUDDER_*` environment dumps after `agent local-cli`; keep API keys private.
- Passing explicit avatar/icon payloads to `agent hire` unless the board supplied a supported avatar reference.

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

Approval decisions use `--decision-note` for short decision context. Approval
comments use `--body-file` for longer Markdown discussion and do not resolve the
approval.

Recommended cases:

```sh
pnpm rudder approval get <approval-id> --json
pnpm rudder approval issues <approval-id> --json
pnpm rudder approval approve <approval-id> --decision-note "Reviewed linked issues and accepted." --json
pnpm rudder approval comment <approval-id> --body-file ./approval-note.md --json
```

Bad cases to avoid:

- Approving or rejecting from the list row alone without reading the approval detail and linked issues.
- Passing `--body-file` to `approval approve` or `approval reject`; use `--decision-note` for decisions.
- Leaving only an approval comment like "approved"; comments are not durable approval decisions.
- Resubmitting with a partial payload before checking whether the route expects the complete revised object.

## Library Commands

```sh
pnpm rudder library file list [directoryPath] --org-id <org-id>
pnpm rudder library file get <filePath> --org-id <org-id>
pnpm rudder library file ref <filePath> --org-id <org-id>
pnpm rudder library file put <filePath> --body-file ./local.md --org-id <org-id>
```

`library file ref` returns `markdownLink`; paste that returned Markdown into
issue comments or chat replies. In local trusted project runs, durable generated
project files should be written under the project Library root and then cited
with `library file ref "$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>"`.

Recommended cases:

```sh
pnpm rudder library file list projects/rudder --org-id <org-id> --json
pnpm rudder library file put projects/rudder/proposals/plan.md --body-file ./plan.md --org-id <org-id> --json
pnpm rudder library file ref projects/rudder/proposals/plan.md --org-id <org-id> --json
printf '%s\n' "# Note" | pnpm rudder library file put projects/rudder/know-how/note.md --body-file - --org-id <org-id>
```

Bad cases to avoid:

- Passing an absolute local path such as `/Users/me/.../plan.md` to `library file ref`; use the Library-relative path.
- Hand-writing `library-entry://...` or old `library-file://...` links instead of using the returned `markdownLink`.
- Treating `/tmp` files as durable project handoff artifacts.
- Using removed inline content flags; `library file put` requires `--body-file` or stdin.

## Skill Commands

```sh
pnpm rudder skill list --org-id <org-id>
pnpm rudder skill get <skill-id> --org-id <org-id>
pnpm rudder skill file <skill-id> [--path SKILL.md] --org-id <org-id>
pnpm rudder skill import --org-id <org-id> --source <local-path-or-url-or-repo-ref>
pnpm rudder skill scan-local --org-id <org-id> [--roots <csv>]
pnpm rudder skill scan-projects --org-id <org-id> [--project-ids <csv>] [--workspace-ids <csv>]
```

Organization skills are shared packages. Importing or scanning them does not by
itself change any agent's enabled skill selections; use `agent skills enable`
or `agent skills sync` for agent-specific loading.

Recommended cases:

```sh
pnpm rudder skill list --org-id <org-id> --json
pnpm rudder skill file <skill-uuid> --path SKILL.md --org-id <org-id> --json
pnpm rudder skill import --org-id <org-id> --source /abs/shared/path/to/skill --json
pnpm rudder skill scan-projects --org-id <org-id> --project-ids <project-id> --json
```

Bad cases to avoid:

- Passing slashful organization skill keys such as `local/<hash>/<slug>` where the route expects a skill id; prefer the UUID returned by `skill list`.
- Importing an organization skill from an agent-private directory that may disappear.
- Assuming `skill import` enables the skill for agents. Enable or sync the target agent's skill selections separately.
- Bulk scanning all local roots when the target project/workspace path is known.

## Activity Commands

```sh
pnpm rudder activity list --org-id <org-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## User Activity Commands

```sh
pnpm rudder user activity --user me --since today --json
pnpm rudder user activity --user <user-id> --since 7d [--include chat,comments,approvals,activity] [--agent-id <agent-id>] [--project-id <project-id>] [--issue-id <issue-id>] [--limit 50] [--cursor <cursor>]
```

`user activity` returns a user-centered ledger with safe excerpts and source
provenance across chat messages, issue comments, approval comments, and user
actor activity events. It does not replace the organization event feed exposed
by `activity list`.

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
