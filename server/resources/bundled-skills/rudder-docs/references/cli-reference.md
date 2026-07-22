# Rudder Agent CLI Reference

Stable typed-tool and CLI fallback catalog for the bundled `rudder-docs`
package. Prefer first-party Rudder MCP tools when the runtime exposes them; use
these CLI commands as fallback when MCP is unavailable or a Rudder MCP tool
returns a transport or configuration error.

## Section Map

- [Operating policy owners](#operating-policy-owners)
- [Defaults](#defaults)
- [JSON output contract](#json-output-contract)
- [Agent V1 commands](#agent-v1-commands)
- [Issue command I/O and shapes](#issue-command-io-and-shapes)
- [Renderable Library CLI output](#renderable-library-cli-output)
- [Reviewer decision command shapes](#reviewer-decision-command-shapes)
- [Compatibility commands](#compatibility-commands)

## Operating Policy Owners

Keep this file focused on commands and CLI-specific I/O. Consult the exact
operating-practices guide for operating behavior:

- [Interface and Chat/issue scope](operating-practices.md#interface-and-scope)
- [Ownership, checkout, and wake scope](operating-practices.md#ownership-checkout-and-wake-scope)
- [Comments, mentions, and evidence](operating-practices.md#comments-mentions-and-evidence)
- [Review and close-out](operating-practices.md#review-and-close-out)
- [Durable Library artifacts](operating-practices.md#durable-library-artifacts)
- [Git identity and attribution](operating-practices.md#git-identity-and-attribution)

## Defaults

- First-party MCP tools use the stable `rudder_<capability_id>` naming convention, for example `rudder_issue_checkout` for `issue.checkout`.
- All commands support `--json`.
- CLI output renders IDs as short IDs by default; `rudder runs ...` commands accept short run IDs. Add `--full-ids` only when a debugging or compatibility workflow needs raw UUIDs.
- `--org-id` defaults to `RUDDER_ORG_ID` when relevant.
- `--run-id` defaults to `RUDDER_RUN_ID` and is attached to mutating requests when available.
- `issue checkout` defaults `--agent-id` from `RUDDER_AGENT_ID`.

## JSON Output Contract

`rudder ... --json` commands must write valid JSON to stdout on success. ID fields in CLI JSON use short display IDs by default; pass `--full-ids` to preserve raw UUIDs. Short run IDs returned by CLI output can be passed back into `rudder runs get`, `events`, `log`, `transcript`, `errors`, `cancel`, and `retry`. If a command cannot produce the requested JSON, it must exit nonzero and write a diagnostic error to stderr. An exit-0 command with empty stdout is a CLI/runtime defect, not a valid empty result.

## Agent V1 Commands

| MCP Tool | CLI Fallback | Description | Mutating | Org | Agent | Run ID |
| --- | --- | --- | --- | --- | --- | --- |
| `rudder_agent_me` | `rudder agent me` | Show the authenticated agent identity, budget, and chain of command. | no | no | no | no |
| `rudder_agent_inbox` | `rudder agent inbox` | List the compact assignee and reviewer work inbox for the authenticated agent. | no | no | no | no |
| `rudder_agent_capabilities` | `rudder agent capabilities` | List the stable Rudder agent command contract. | no | no | no | no |
| `rudder_agent_update` | `rudder agent update [agent-id] [--title <title>] [--description <text>]` | Update an agent's identity fields; defaults to the authenticated agent. | yes | no | no | attached when available |
| `rudder_agent_skills_create` | `rudder agent skills create [agent-id] --name <name> [--enable]` | Create an agent-private skill package under AGENT_HOME/skills. | yes | no | no | attached when available |
| `rudder_agent_skills_enable` | `rudder agent skills enable <agent-id> <selection-ref...>` | Add skill selections to an agent without replacing existing enabled skills. | yes | no | no | attached when available |
| `rudder_agent_skills_sync` | `rudder agent skills sync <agent-id>` | Sync the desired enabled skill set for an agent. | yes | no | no | attached when available |
| `rudder_issue_get` | `rudder issue get <issue>` | Read a full issue by UUID or identifier. | no | no | no | no |
| `rudder_issue_search` | `rudder issue search <query> [--org-id <id>]` | Search issues with the server-side issue index across title, identifier, description, and comments. | no | required | no | no |
| `rudder_issue_context` | `rudder issue context <issue> [--wake-comment-id <comment-id-or-cmt-ref>]` | Read the compact heartbeat context for an issue; wake comments may be addressed by full id or cmt_<uuid-prefix>. | no | no | no | no |
| `rudder_issue_checkout` | `rudder issue checkout <issue>` | Atomically checkout an issue for the current or specified agent. | yes | no | required | attached when available |
| `rudder_issue_comment` | `rudder issue comment <issue> --body-file <path> [--image <path>]` | Add a comment to an issue, optionally uploading images and appending Markdown image links. | yes | no | no | attached when available |
| `rudder_issue_comments_list` | `rudder issue comments list <issue> [--after <comment-id-or-cmt-ref>]` | List issue comments, optionally only newer comments after a full comment id or cmt_<uuid-prefix> with --after. | no | no | no | no |
| `rudder_issue_comments_get` | `rudder issue comments get <issue> <comment-id-or-cmt-ref>` | Read one issue comment by full id or cmt_<uuid-prefix> scoped to the issue. | no | no | no | no |
| `rudder_issue_update` | `rudder issue update <issue> ... [--comment-file <path>] [--image <path>]` | Apply generic issue updates when workflow commands are not enough, optionally uploading images for the update comment. | yes | no | no | attached when available |
| `rudder_issue_review` | `rudder issue review <issue> --decision <decision> --comment-file <path>` | Record a structured reviewer decision with a required comment. | yes | no | no | attached when available |
| `rudder_issue_commit` | `rudder issue commit <issue> --sha <sha> --message <subject>` | Report a code commit created during issue work as structured issue activity. | yes | no | no | attached when available |
| `rudder_issue_done` | `rudder issue done <issue> --comment-file <path> [--image <path>]` | Mark an issue done with a required completion comment, optionally uploading images. | yes | no | no | attached when available |
| `rudder_issue_block` | `rudder issue block <issue> --comment-file <path> [--image <path>]` | Mark an issue blocked with a required blocker comment, optionally uploading images. | yes | no | no | attached when available |
| `rudder_project_list` | `rudder project list --org-id <id>` | List projects in an organization. | no | required | no | no |
| `rudder_project_get` | `rudder project get <project-id-or-shortname> [--org-id <id>]` | Read one project by ID or shortname. | no | no | no | no |
| `rudder_project_create` | `rudder project create --org-id <id> --name <name>` | Create a project in the organization. | yes | required | no | attached when available |
| `rudder_project_update` | `rudder project update <project-id-or-shortname> [--org-id <id>]` | Update mutable project fields such as name, description, status, goals, lead agent, target date, color, or archivedAt. | yes | no | no | attached when available |
| `rudder_user_activity` | `rudder user activity --user me --since today --json` | Read a user-centered activity ledger with safe excerpts and provenance across chats, issue comments, approval comments, and user actor activity. | no | required | no | no |
| `rudder_library_file_list` | `rudder library file list [directory]` | List Library files and folders; file rows include `libraryEntryId` when a strong reference can be generated. | no | required | no | no |
| `rudder_library_file_get` | `rudder library file get <path>` | Fallback read when local filesystem access is unavailable; JSON includes `mentionHref` and `markdownLink`. | no | required | no | no |
| `rudder_library_file_ref` | `rudder library file ref <path>` | Return the stable Markdown reference for one Library file without printing file content. | no | required | no | no |
| `rudder_library_file_link` | `rudder library file link <path>` | Compatibility alias for `rudder library file ref <path>`. | no | required | no | no |
| `rudder_library_file_put` | `rudder library file put <path> --body-file <path>` | Fallback create/update when local filesystem access is unavailable; JSON includes `mentionHref` and `markdownLink`. | yes | required | no | attached when available |
| `rudder_approval_get` | `rudder approval get <approval-id>` | Read one approval request. | no | no | no | no |
| `rudder_approval_issues` | `rudder approval issues <approval-id>` | List the issues linked to an approval. | no | no | no | no |
| `rudder_approval_comment` | `rudder approval comment <approval-id> --body-file <path>` | Add a comment to an approval. | yes | no | no | attached when available |
| `rudder_skill_list` | `rudder skill list --org-id <id>` | List organization-visible skills. | no | required | no | no |
| `rudder_skill_get` | `rudder skill get <skill-id> --org-id <id>` | Read one organization skill detail. | no | required | no | no |
| `rudder_skill_file` | `rudder skill file <skill-id> --org-id <id> [--path SKILL.md]` | Read one file from an organization skill package. | no | required | no | no |
| `rudder_skill_import` | `rudder skill import --org-id <id> --source <source>` | Import a skill package into the organization skill library. | yes | required | no | attached when available |
| `rudder_skill_scan_local` | `rudder skill scan-local --org-id <id> [--roots <csv>]` | Scan local roots for skill packages and import new ones. | yes | required | no | attached when available |
| `rudder_skill_scan_projects` | `rudder skill scan-projects --org-id <id> [--project-ids <csv>] [--workspace-ids <csv>]` | Scan the org workspace and any legacy project workspace records for skill packages and import new ones. | yes | required | no | attached when available |
| `rudder_browser_tabs` | `rudder browser tabs` | List Browser tabs owned by the current Rudder agent run. | no | required | required | required |
| `rudder_browser_user_tabs` | `rudder browser user-tabs` | List user-visible tabs currently open in Rudder's built-in Browser without taking control of them. | no | required | required | required |
| `rudder_browser_open` | `rudder browser open <url>` | Open a run-owned tab in the Rudder Browser. | yes | required | required | required |
| `rudder_browser_navigate` | `rudder browser navigate <tab-id> <url>` | Navigate a run-owned Rudder Browser tab. | yes | required | required | required |
| `rudder_browser_back` | `rudder browser back <tab-id>` | Navigate a run-owned Rudder Browser tab back in history. | yes | required | required | required |
| `rudder_browser_forward` | `rudder browser forward <tab-id>` | Navigate a run-owned Rudder Browser tab forward in history. | yes | required | required | required |
| `rudder_browser_reload` | `rudder browser reload <tab-id>` | Reload a run-owned Rudder Browser tab. | yes | required | required | required |
| `rudder_browser_viewport` | `rudder browser viewport --action <get|set|reset> [--width <px> --height <px>]` | Inspect, set, or reset the responsive viewport for the current Rudder Browser run. | yes | required | required | required |
| `rudder_browser_visibility` | `rudder browser visibility [--visible <true|false>]` | Inspect or change whether the current run's selected Rudder Browser tab is visible. | yes | required | required | required |
| `rudder_browser_snapshot` | `rudder browser snapshot <tab-id> [--input <json>]` | Capture a bounded DOM and accessibility-oriented snapshot, including frame structure and ephemeral node ids. | no | required | required | required |
| `rudder_browser_locator` | `rudder browser locator <tab-id> --input <json>` | Perform read-only bounded Browser locator text, attribute, state, count, or wait operations. | no | required | required | required |
| `rudder_browser_cua` | `rudder browser cua <tab-id> --input <json>` | Perform trusted coordinate mouse, scroll, drag, keyboard, and text input in a run-owned Browser tab. | yes | required | required | required |
| `rudder_browser_dom_cua` | `rudder browser dom-cua <tab-id> --input <json>` | Inspect a bounded read-only DOM snapshot with ephemeral node ids. | no | required | required | required |
| `rudder_browser_dialog` | `rudder browser dialog <tab-id> --input <json>` | Inspect, accept, or dismiss the active JavaScript dialog in a run-owned Browser tab. | yes | required | required | required |
| `rudder_browser_clipboard` | `rudder browser clipboard --input <json>` | Read or write the isolated virtual clipboard for the current Browser run without touching the OS clipboard. | yes | required | required | required |
| `rudder_browser_logs` | `rudder browser logs <tab-id> [--input <json>]` | Read bounded console and runtime logs captured for a run-owned Browser tab. | yes | required | required | required |
| `rudder_browser_download` | `rudder browser download <tab-id> --input <json>` | Download explicit locator media without dispatching page input into a bounded run-owned artifact. | yes | required | required | required |
| `rudder_browser_assets` | `rudder browser assets <tab-id> --input <json>` | List page assets or bundle an explicit bounded selection into a run-owned temporary artifact. | yes | required | required | required |
| `rudder_browser_content` | `rudder browser content <tab-id> --input <json>` | Export current page content or an eligible Google Workspace document into a bounded run-owned artifact. | yes | required | required | required |
| `rudder_browser_wait` | `rudder browser wait <tab-id> --input <json>` | Wait for bounded URL, text, disappearance, or time conditions in a run-owned Browser tab. | no | required | required | required |
| `rudder_browser_read` | `rudder browser read <tab-id>` | Read a structured snapshot from a run-owned Rudder Browser tab. | no | required | required | required |
| `rudder_browser_click` | `rudder browser click <tab-id> <ref>` | Click an element reference returned by Rudder Browser read. | yes | required | required | required |
| `rudder_browser_type` | `rudder browser type <tab-id> <ref> --text <text>` | Type into an element reference in a run-owned Rudder Browser tab. | yes | required | required | required |
| `rudder_browser_screenshot` | `rudder browser screenshot <tab-id> [--input <json>]` | Capture a screenshot of a run-owned Rudder Browser tab. | no | required | required | required |
| `rudder_browser_close` | `rudder browser close <tab-id>` | Close a run-owned Rudder Browser tab. | yes | required | required | required |
| `rudder_automation_list` | `rudder automation list --org-id <id>` | List automations for an organization with compact local filters. | no | required | no | no |
| `rudder_automation_get` | `rudder automation get <automation-id>` | Read one automation detail including triggers and recent runs. | no | no | no | no |
| `rudder_automation_runs` | `rudder automation runs <automation-id>` | List recent runs for one automation. | no | no | no | no |
| `rudder_automation_triggers_list` | `rudder automation triggers list <automation-id>` | List triggers configured for one automation. | no | no | no | no |
| `rudder_automation_triggers_create` | `rudder automation triggers create <automation-id> --kind <kind>` | Create a schedule, webhook, or API trigger through the governed automation API. | yes | no | no | attached when available |
| `rudder_automation_triggers_update` | `rudder automation triggers update <trigger-id>` | Update an automation trigger through the governed automation API. | yes | no | no | attached when available |
| `rudder_automation_triggers_delete` | `rudder automation triggers delete <trigger-id>` | Delete an automation trigger through the governed automation API. | yes | no | no | attached when available |
| `rudder_automation_triggers_rotate_secret` | `rudder automation triggers rotate-secret <trigger-id>` | Rotate an automation webhook trigger secret through the governed automation API. | yes | no | no | attached when available |
| `rudder_automation_create` | `rudder automation create --org-id <id> --title <title> --assignee-agent-id <id>` | Create an automation through the governed automation API. | yes | required | no | attached when available |
| `rudder_automation_update` | `rudder automation update <automation-id>` | Update automation fields through the governed automation API. | yes | no | no | attached when available |
| `rudder_automation_enable` | `rudder automation enable <automation-id>` | Enable an automation by setting status to active. | yes | no | no | attached when available |
| `rudder_automation_disable` | `rudder automation disable <automation-id>` | Disable an automation by setting status to paused. | yes | no | no | attached when available |
| `rudder_automation_run` | `rudder automation run <automation-id>` | Trigger a manual automation run. | yes | no | no | attached when available |
| `rudder_chat_list` | `rudder chat list --org-id <id>` | List chat conversations without dumping full message history. | no | required | no | no |
| `rudder_chat_search` | `rudder chat search <query> --org-id <id>` | Search chats with bounded snippets and optional scope filtering. | no | required | no | no |
| `rudder_chat_get` | `rudder chat get <chat-id>` | Read one chat conversation record. | no | no | no | no |
| `rudder_chat_messages` | `rudder chat messages <chat-id> [--limit <n>] [--cursor <cursor>] [--include-transcript]` | Read bounded chat messages with page cursors; transcript output is omitted unless requested. | no | no | no | no |
| `rudder_chat_transcript` | `rudder chat transcript <chat-id> [--limit <n>] [--cursor <cursor>] [--max-output-chars <n>]` | Read paginated chat messages with assistant transcript entries clipped in human output. | no | no | no | no |
| `rudder_chat_read` | `rudder chat read <chat-id> [--turn-limit <n>] [--cursor <cursor>] [--include-output]` | Read a bounded recent-message snapshot for one chat with page cursors. | no | no | no | no |
| `rudder_chat_create` | `rudder chat create --org-id <id> --body <text>` | Create a chat conversation with its first message. | yes | required | no | attached when available |
| `rudder_chat_send` | `rudder chat send <chat-id> --body <text>` | Send an agent-authored message directly to the operator in a chat. | yes | no | required | attached when available |
| `rudder_chat_archive` | `rudder chat archive <chat-id>` | Archive a chat conversation without deleting it. | yes | no | no | attached when available |
| `rudder_runs_list` | `rudder runs list --org-id <id> [--used-skill <skill>] [--loaded-skill <skill>] [--cursor <cursor>] [--full]` | List lightweight run summaries with stable pagination and filters; use --full only for legacy full-row compatibility. | no | required | no | no |
| `rudder_runs_by_skill` | `rudder runs by-skill <skill> --org-id <id> [--evidence <used-or-loaded>] [--cursor <cursor>] [--full]` | Build a paginated skill evidence packet from lightweight run summaries; use --full only for legacy full-row compatibility. | no | required | no | no |
| `rudder_runs_get` | `rudder runs get <run-id> [--full]` | Read one bounded run summary; use --full only from a direct trusted CLI for raw detail. | no | no | no | no |
| `rudder_runs_events` | `rudder runs events <run-id> [--cursor <cursor>] [--after-seq <n>] [--limit <n>] [--full]` | List a bounded page of persisted run events with a lossless opaque cursor and clipped payload previews. | no | no | no | no |
| `rudder_runs_log` | `rudder runs log <run-id> [--offset <bytes>] [--limit-bytes <n>]` | Read a bounded byte range of stored run log content. | no | no | no | no |
| `rudder_runs_transcript` | `rudder runs transcript <run-id> [--turn-limit <n>] [--cursor <cursor>] [--include-output] [--full]` | Read a compact server-normalized transcript; --json changes encoding only and --full is direct-CLI-only raw access. | no | no | no | no |
| `rudder_runs_errors` | `rudder runs errors <run-id>` | List failed tool calls, stderr, runtime failures, and jump-to-context commands. | no | no | no | no |
| `rudder_runs_cancel` | `rudder runs cancel <run-id>` | Cancel a heartbeat run through the governed server route. | yes | no | no | attached when available |
| `rudder_runs_retry` | `rudder runs retry <run-id>` | Retry a failed, timed out, or cancelled run through the governed server route. | yes | no | no | attached when available |

## Issue Command I/O And Shapes

Operating rules live in [ownership, checkout, and wake scope](operating-practices.md#ownership-checkout-and-wake-scope), [comments and evidence](operating-practices.md#comments-mentions-and-evidence), and [review and close-out](operating-practices.md#review-and-close-out). The CLI close-out shapes are:

- progress: `rudder issue comment <issue> --body-file <path> [--image <path>]`
- done: `rudder issue done <issue> --comment-file <path> [--image <path>]`
- blocked: `rudder issue block <issue> --comment-file <path> [--image <path>]`

Issue comment and close-out commands accept comment bodies only from files or stdin. For multiline Markdown, command names, code spans, code blocks, test summaries, or screenshot evidence, pass `--body-file <path>` or `--comment-file <path>`, or pass `-` to read the body from stdin.

Issue comment responses include `shortRef` when available. `rudder issue comments get <issue> <comment-id-or-cmt-ref>` accepts a full comment UUID or `cmt_<uuid-prefix>`, and `rudder issue comments list <issue> --after <comment-id-or-cmt-ref>` accepts the same forms for the pagination anchor. Use the full UUID when a short ref is ambiguous within the issue.

`--image` may be repeated. The CLI uploads each local PNG/JPEG/WebP/GIF as an issue attachment and appends Markdown image links to the comment text before sending it.

## Renderable Library CLI Output

File placement and handoff policy lives in [Durable Library artifacts](operating-practices.md#durable-library-artifacts). Request a renderable reference with `rudder library file ref <library-relative-path> --json`.

The relevant JSON fields are:

- `libraryEntryId`: stable identity for the Library file.
- `mentionHref`: raw renderable target, optionally with a Rudder-generated path hint.
- `markdownLink`: complete Markdown link for the renderer.

The `ref` argument is Library-relative, not an absolute filesystem path. CLI fallback shapes are `rudder library file get <library-relative-path> --json` and `rudder library file put <library-relative-path> --body-file <path> --json`. `rudder library file link <library-relative-path> --json` remains a compatibility alias for `ref`.

## Reviewer Decision Command Shapes

Reviewer policy lives in [Review and close-out](operating-practices.md#review-and-close-out). Supported decision command shapes are:

- `rudder issue review <issue> --decision approve --comment-file <path>`
- `rudder issue review <issue> --decision request_changes --comment-file <path>`
- `rudder issue review <issue> --decision needs_followup --comment-file <path>`
- `rudder issue review <issue> --decision blocked --comment-file <path>`

## Compatibility Commands

- `rudder agent list --org-id <id>` — List agents for an organization.
- `rudder agent get <agent-id-or-shortname-or-agt-ref>` — Read one agent by id, shortname, or agt_<uuid-prefix> short ref.
- `rudder agent hire --org-id <id> --payload <json>` — Create a new hire using the canonical hire workflow.
- `rudder agent config index` — Read the installed agent runtime configuration index.
- `rudder agent config doc <agent-runtime-type>` — Read adapter-specific configuration guidance for one runtime.
- `rudder agent config list --org-id <id>` — List redacted agent configuration snapshots for an organization.
- `rudder agent config get <agent-id-or-shortname>` — Read one redacted agent configuration snapshot by id or shortname.
- `rudder agent icons` — List legacy named agent icons for compatibility/debugging; normal create and hire payloads should omit icon.
- `rudder issue create --org-id <id> ... [--label-id <id> ...] [--label <name> ...]` — Create a new issue or subtask with the generic issue surface; agent-created issues default to the creating agent when no assignee is supplied.
- `rudder issue labels list --org-id <id>` — List organization issue labels available for issue creation.
- `rudder approval create --org-id <id> --type <type> --payload <json>` — Create a new approval request.
- `rudder approval resubmit <approval-id> [--payload <json>]` — Resubmit a revision-requested approval, optionally with updated payload.
