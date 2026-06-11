# Rudder Agent CLI Reference

Stable CLI contract for agents using the bundled `rudder` skill. Prefer these commands over direct `/api` calls.

## Defaults

- All commands support `--json`.
- `--org-id` defaults to `RUDDER_ORG_ID` when relevant.
- `--run-id` defaults to `RUDDER_RUN_ID` and is attached to mutating requests when available.
- `issue checkout` defaults `--agent-id` from `RUDDER_AGENT_ID`.

## JSON Output Contract

`rudder ... --json` commands must write valid JSON to stdout on success. If a command cannot produce the requested JSON, it must exit nonzero and write a diagnostic error to stderr. An exit-0 command with empty stdout is a CLI/runtime defect, not a valid empty result.

Direct API fallback is allowed for heartbeat close-out only when a required CLI command fails diagnostically or returns exit 0 with empty stdout. When using fallback, note the affected command and reason in the issue comment or run notes so the CLI path can be fixed.

## Agent V1 Commands

| Command | Description | Mutating | Org | Agent | Run ID |
| --- | --- | --- | --- | --- | --- |
| `rudder agent me` | Show the authenticated agent identity, budget, and chain of command. | no | no | no | no |
| `rudder agent inbox` | List the compact assignee and reviewer work inbox for the authenticated agent. | no | no | no | no |
| `rudder agent capabilities` | List the stable Rudder agent command contract. | no | no | no | no |
| `rudder agent update [agent-id] [--title <title>] [--description <text>]` | Update an agent's control-plane identity fields; defaults to the authenticated agent. | yes | no | no | attached when available |
| `rudder agent skills create [agent-id] --name <name> [--enable]` | Create an agent-private skill package under AGENT_HOME/skills. | yes | no | no | attached when available |
| `rudder agent skills enable <agent-id> <selection-ref...>` | Add skill selections to an agent without replacing existing enabled skills. | yes | no | no | attached when available |
| `rudder agent skills sync <agent-id>` | Sync the desired enabled skill set for an agent. | yes | no | no | attached when available |
| `rudder issue get <issue>` | Read a full issue by UUID or identifier. | no | no | no | no |
| `rudder issue search <query> [--org-id <id>]` | Search issues with the server-side issue index across title, identifier, description, and comments. | no | required | no | no |
| `rudder issue context <issue>` | Read the compact heartbeat context for an issue. | no | no | no | no |
| `rudder issue checkout <issue>` | Atomically checkout an issue for the current or specified agent. | yes | no | required | attached when available |
| `rudder issue comment <issue> --body-file <path> [--image <path>]` | Add a comment to an issue, optionally uploading images and appending Markdown image links. | yes | no | no | attached when available |
| `rudder issue comments list <issue>` | List issue comments, optionally only newer comments after a cursor. | no | no | no | no |
| `rudder issue comments get <issue> <comment-id>` | Read one issue comment by id. | no | no | no | no |
| `rudder issue update <issue> ... [--comment-file <path>] [--image <path>]` | Apply generic issue updates when workflow commands are not enough, optionally uploading images for the update comment. | yes | no | no | attached when available |
| `rudder issue review <issue> --decision <decision> --comment-file <path>` | Record a structured reviewer decision with a required comment. | yes | no | no | attached when available |
| `rudder issue commit <issue> --sha <sha> --message <subject>` | Report a code commit created during issue work as structured issue activity. | yes | no | no | attached when available |
| `rudder issue done <issue> --comment-file <path> [--image <path>]` | Mark an issue done with a required completion comment, optionally uploading images. | yes | no | no | attached when available |
| `rudder issue block <issue> --comment-file <path> [--image <path>]` | Mark an issue blocked with a required blocker comment, optionally uploading images. | yes | no | no | attached when available |
| `rudder issue release <issue>` | Release an issue back to todo and clear ownership. | yes | no | no | attached when available |
| `rudder issue documents list <issue>` | List issue documents. | no | no | no | no |
| `rudder issue documents get <issue> <key>` | Read one issue document by key. | no | no | no | no |
| `rudder issue documents revisions <issue> <key>` | List revisions for an issue document. | no | no | no | no |
| `rudder project list --org-id <id>` | List projects in an organization. | no | required | no | no |
| `rudder project get <project-id-or-shortname> [--org-id <id>]` | Read one project by ID or shortname. | no | no | no | no |
| `rudder project create --org-id <id> --name <name>` | Create a project in the organization. | yes | required | no | attached when available |
| `rudder project update <project-id-or-shortname> [--org-id <id>]` | Update mutable project fields such as name, description, status, goals, lead agent, target date, color, or archivedAt. | yes | no | no | attached when available |
| `rudder library file list [directory]` | List Library files and folders; file rows include `libraryEntryId` when a strong reference can be generated. | no | required | no | no |
| `rudder library file get <path>` | Fallback read when local filesystem access is unavailable; JSON includes `mentionHref` and `markdownLink`. | no | required | no | no |
| `rudder library file ref <path>` | Return the stable Markdown reference for one Library file without printing file content. | no | required | no | no |
| `rudder library file link <path>` | Compatibility alias for `rudder library file ref <path>`. | no | required | no | no |
| `rudder library file put <path> --body-file <path>` | Fallback create/update when local filesystem access is unavailable; JSON includes `mentionHref` and `markdownLink`. | yes | required | no | attached when available |
| `rudder approval get <approval-id>` | Read one approval request. | no | no | no | no |
| `rudder approval issues <approval-id>` | List the issues linked to an approval. | no | no | no | no |
| `rudder approval comment <approval-id> --body-file <path>` | Add a comment to an approval. | yes | no | no | attached when available |
| `rudder skill list --org-id <id>` | List organization-visible skills. | no | required | no | no |
| `rudder skill get <skill-id> --org-id <id>` | Read one organization skill detail. | no | required | no | no |
| `rudder skill file <skill-id> --org-id <id> [--path SKILL.md]` | Read one file from an organization skill package. | no | required | no | no |
| `rudder skill import --org-id <id> --source <source>` | Import a skill package into the organization skill library. | yes | required | no | attached when available |
| `rudder skill scan-local --org-id <id> [--roots <csv>]` | Scan local roots for skill packages and import new ones. | yes | required | no | attached when available |
| `rudder skill scan-projects --org-id <id> [--project-ids <csv>] [--workspace-ids <csv>]` | Scan the org workspace and any legacy project workspace records for skill packages and import new ones. | yes | required | no | attached when available |
| `rudder automation list --org-id <id>` | List automations for an organization with compact local filters. | no | required | no | no |
| `rudder automation get <automation-id>` | Read one automation detail including triggers and recent runs. | no | no | no | no |
| `rudder automation runs <automation-id>` | List recent runs for one automation. | no | no | no | no |
| `rudder automation triggers list <automation-id>` | List triggers configured for one automation. | no | no | no | no |
| `rudder automation create --org-id <id> --title <title> --assignee-agent-id <id>` | Create an automation through the governed automation API. | yes | required | no | attached when available |
| `rudder automation update <automation-id>` | Update automation fields through the governed automation API. | yes | no | no | attached when available |
| `rudder automation enable <automation-id>` | Enable an automation by setting status to active. | yes | no | no | attached when available |
| `rudder automation disable <automation-id>` | Disable an automation by setting status to paused. | yes | no | no | attached when available |
| `rudder automation run <automation-id>` | Trigger a manual automation run. | yes | no | no | attached when available |
| `rudder chat list --org-id <id>` | List chat conversations without dumping full message history. | no | required | no | no |
| `rudder chat search <query> --org-id <id>` | Search chats with bounded snippets and optional scope filtering. | no | required | no | no |
| `rudder chat get <chat-id>` | Read one chat conversation record. | no | no | no | no |
| `rudder chat messages <chat-id>` | Read bounded chat messages, with transcript omitted unless requested. | no | no | no | no |
| `rudder chat transcript <chat-id>` | Read chat messages with assistant transcript entries clipped in human output. | no | no | no | no |
| `rudder chat read <chat-id>` | Read a bounded recent-message snapshot for one chat. | no | no | no | no |
| `rudder chat create --org-id <id>` | Create a chat conversation. | yes | required | no | attached when available |
| `rudder chat send <chat-id> --body <text>` | Send a chat message and persist the assistant reply through the server. | yes | no | no | attached when available |
| `rudder chat archive <chat-id>` | Archive a chat conversation without deleting it. | yes | no | no | attached when available |
| `rudder runs list --org-id <id>` | List observed agent runs with filters for status, agent, issue, runtime, and time. | no | required | no | no |
| `rudder runs get <run-id>` | Read one observed run detail. | no | no | no | no |
| `rudder runs events <run-id>` | List persisted run events. | no | no | no | no |
| `rudder runs log <run-id>` | Read stored run log content with clipped human output. | no | no | no | no |
| `rudder runs transcript <run-id>` | Read the server-normalized run transcript, newest-first by default. | no | no | no | no |
| `rudder runs errors <run-id>` | List failed tool calls, stderr, runtime failures, and jump-to-context commands. | no | no | no | no |
| `rudder runs cancel <run-id>` | Cancel a heartbeat run through the governed server route. | yes | no | no | attached when available |
| `rudder runs retry <run-id>` | Retry a failed, timed out, or cancelled run through the governed server route. | yes | no | no | attached when available |

## Issue Close-Out Signals

Before a successful `todo` or `in_progress` issue run exits, leave one close-out signal with the command that matches the outcome:

- progress remains: `rudder issue comment <issue> --body-file <path> [--image <path>]`
- work is complete: `rudder issue done <issue> --comment-file <path> [--image <path>]`
- work is blocked: `rudder issue block <issue> --comment-file <path> [--image <path>]`
- ownership changes: add an explicit handoff comment before or with the assignee update

If an issue has a reviewer, moving it to `blocked` is also a reviewer handoff: the reviewer should confirm the blocker, request changes, approve, or keep explicit follow-up open with `rudder issue review`.

Issue comment and close-out commands accept comment bodies only from files or stdin. For any multiline Markdown, command names, code spans, code blocks, test summaries, or screenshot evidence, write the comment to a temporary Markdown file and pass `--body-file <path>` or `--comment-file <path>`, or pass `-` to read the body from stdin.

`--image` may be repeated. The CLI uploads each local PNG/JPEG/WebP/GIF as an issue attachment and appends Markdown image links to the comment text before sending it.

If your issue comment cites a screenshot path or visual validation artifact, attach that file with `--image <path>` instead of leaving only the local path in the text.

If `RUDDER_WAKE_REASON=issue_passive_followup`, the run is close-out governance for the same issue. Inspect current issue state first, then leave a progress comment, completion, blocker, or explicit handoff.

## Renderable Library References

Agents should not hand-write `library-entry://...` URLs. Local trusted agents
should create and update durable project files directly under
`$RUDDER_PROJECT_LIBRARY_ROOT` with normal filesystem tools. After creating,
updating, or reading a durable Library file, use `rudder library file ref` to
get the CLI-returned `markdownLink` for issue comments, review comments,
blocker notes, done comments, and chat replies.

```bash
printf '%s\n' "<markdown body>" > "$RUDDER_PROJECT_LIBRARY_ROOT/<issue>.md"
result="$(rudder library file ref "$RUDDER_PROJECT_LIBRARY_PATH/<issue>.md" --json)"
printf '%s\n' "$result" | jq -r .markdownLink
```

The relevant JSON fields are:

- `libraryEntryId`: stable identity for the Library file.
- `mentionHref`: raw `library-entry://<id>?t=<title>&p=<path>` target.
- `markdownLink`: complete Markdown link that the renderer turns into a Library
  chip and that continues resolving after Rudder-managed rename or move.

Use `rudder library file get/put` only when local filesystem access to the
Library is unavailable, such as remote or restricted runtimes. `rudder library
file link <path> --json` remains as a compatibility alias for `ref`. The
`ref` path is Library-relative, for example
`$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>`; do not pass the absolute
`$RUDDER_PROJECT_LIBRARY_ROOT/...` filesystem path. Posting the returned
`markdownLink` is the Rudder-visible handoff checkpoint for direct filesystem
writes. If `$RUDDER_PROJECT_LIBRARY_ROOT` is unset or inaccessible, use
`rudder library file get/put "$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>"` as
the remote or restricted runtime fallback. Treat `library-file://...` as legacy
weak path syntax and use it only when preserving old content that has no
`libraryEntryId`.

## Git Identity Policy

Local runtime `HOME` is isolated from the operator home. Codex local runs and runtime-created git worktrees are prepared with `user.useConfigOnly=true` so missing identity fails fast instead of producing `*@*.local` commits. If Git reports missing author or committer identity, configure the repository explicitly with `git config user.name <name>` and `git config user.email <safe-email>`; do not unset the guard or accept auto-detected local-host metadata.

## Reviewer Close-Out Signals

When the inbox row or wake context says `relationship: "reviewer"`, `role: "reviewer"`, or `wakeSource: "review"`, finish the review with one structured reviewer decision. Reviewer work can be either `in_review` or `blocked`; blocked reviewer work means blocker triage, not implementation takeover.

- approve: `rudder issue review <issue> --decision approve --comment-file <path>`
- request changes: `rudder issue review <issue> --decision request_changes --comment-file <path>`
- needs follow-up: `rudder issue review <issue> --decision needs_followup --comment-file <path>`
- blocked or blocker confirmed: `rudder issue review <issue> --decision blocked --comment-file <path>`; use this only for a confirmed human/external blocker and name the next human action.

Do not rely on a free-form reject or accept comment as the review outcome. The structured decision is the durable close-out signal. A blocked reviewer decision records a human handoff and removes the issue from repeated reviewer pickup until the board changes the issue.

## Compatibility Commands

- `rudder agent list --org-id <id>` — List agents for an organization.
- `rudder agent get <agent-id-or-shortname>` — Read one agent by id or shortname.
- `rudder agent hire --org-id <id> --payload <json>` — Create a new hire using the canonical hire workflow.
- `rudder agent config index` — Read the installed agent runtime configuration index.
- `rudder agent config doc <agent-runtime-type>` — Read adapter-specific configuration guidance for one runtime.
- `rudder agent config list --org-id <id>` — List redacted agent configuration snapshots for an organization.
- `rudder agent config get <agent-id-or-shortname>` — Read one redacted agent configuration snapshot by id or shortname.
- `rudder agent icons` — List legacy named agent icons for compatibility/debugging; normal create and hire payloads should omit icon.
- `rudder issue documents put <issue> <key> --body-file <path>` — Legacy create or update of a DB-backed issue document; prefer local project Library files under `$RUDDER_PROJECT_LIBRARY_ROOT` for durable project files.
- `rudder issue create --org-id <id> ... [--label-id <id> ...] [--label <name> ...]` — Create a new issue or subtask with the generic issue surface; agent-created issues default to the creating agent when no assignee is supplied.
- `rudder issue labels list --org-id <id>` — List organization issue labels available for issue creation.
- `rudder approval create --org-id <id> --type <type> --payload <json>` — Create a new approval request.
- `rudder approval resubmit <approval-id> [--payload <json>]` — Resubmit a revision-requested approval, optionally with updated payload.
