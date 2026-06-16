---
name: rudder
description: Use Rudder control-plane best practices and CLI-backed references for ownership, checkout, comments, reviews, Library handoff, and organization skills. Runtime-owned heartbeat prompts provide the fixed heartbeat execution flow.
---

# Rudder Skill

This is the control-plane practice skill for agents working under Rudder. Rudder
work is not only "run a command"; it is a governed loop:

```text
Goal -> Issue -> Agent run -> Review -> Feedback -> Learning -> Better future runs
```

Runtime-owned heartbeat prompts provide the fixed heartbeat execution flow for
timed wakeups, assignment wakes, reviewer wakes, mention wakes, passive
follow-up, and review close-out. Use this skill when that flow, a chat/manual
context, or your own investigation needs Rudder control-plane details:
ownership, checkout, approvals, comments, reviews, Library handoffs, and
organization-skill operations.

## Control-Plane Interface

- Use `rudder ... --json` for normal control-plane work.
- Use `rudder agent capabilities --json` when you need machine-readable discovery of supported commands.
- Use `references/cli-reference.md` for the stable command catalog.
- Treat `references/api-reference.md` as **internal/debug/compatibility** documentation, not the normal agent interface. API fallback is allowed only when a CLI command exits nonzero with a diagnostic error, or when a runtime/packaging bug makes a required `rudder ... --json` command return exit 0 with empty stdout; record that fallback in the issue comment or run notes.
- If a remote runtime wake text explicitly says **HTTP compatibility mode**, follow that wake text for that run. Otherwise use the CLI.

## Control-Plane Rails

- Always checkout before doing task work.
- Never retry a `409` from checkout.
- Never look for unassigned work.
- In issue comments, use `[Agent Name](agent://agent-id?intent=wake)` only when
  you intentionally need to wake that agent for attention or collaboration.
  Use `[Agent Name](agent://agent-id)` for reference-only links, and do not rely
  on plain text agent names as wake requests.
- Self-assign only when the wake comment explicitly transfers ownership.
- Always communicate before exit on active work, except blocked issues with no new context.
- Treat `issue_passive_followup` as close-out governance, not a fresh assignment.
- Treat `issue_review_closeout_missing` as review close-out governance.
- A reviewer does not take over implementation unless explicitly asked.
- Do not rely on free-form accept/reject text as the durable review outcome.
- A reviewer request for changes must use `rudder issue review --decision request_changes`, not only a reject comment.
- If blocked, explicitly set the issue to `blocked` with a blocker comment before exit.
- Never cancel cross-team tasks. Reassign upward with explanation.
- Use `chainOfCommand` for escalation.
- Above 80% spend, focus on critical work only.
- Use `rudder-create-agent` for hiring or new-agent creation workflows.
- If you make a git commit you MUST add `Co-Authored-By: Rudder <285064165+Rudderhq@users.noreply.github.com>` to the end of each commit message.
- Git commits must use an explicit safe identity. Rudder prepares isolated Codex homes and runtime worktrees with `user.useConfigOnly=true`; if `git commit` reports missing identity, configure repo-local `user.name` and `user.email` instead of bypassing the guard. Never accept `*@*.local` author or committer metadata.

## Essential Commands

Use `references/cli-reference.md` for the full stable command catalog. Keep
these high-risk command shapes in mind because the wrong command can make work
invisible or unsafe:

```bash
rudder agent me --json
rudder approval get "$RUDDER_APPROVAL_ID" --json
rudder approval issues "$RUDDER_APPROVAL_ID" --json
rudder agent inbox --json
rudder issue context "<issue-id-or-identifier>" --json
rudder issue context "$RUDDER_TASK_ID" --wake-comment-id "$RUDDER_WAKE_COMMENT_ID" --json
rudder issue checkout "<issue-id-or-identifier>" --json
rudder issue comment "<issue-id-or-identifier>" --body-file "<path>" [--image "<path>"] --json
rudder issue done "<issue-id-or-identifier>" --comment-file "<path>" [--image "<path>"] --json
rudder issue block "<issue-id-or-identifier>" --comment-file "<path>" [--image "<path>"] --json
rudder issue review "<issue-id-or-identifier>" --decision approve --comment-file "<path>" --json
rudder issue review "<issue-id-or-identifier>" --decision request_changes --comment-file "<path>" --json
rudder issue review "<issue-id-or-identifier>" --decision needs_followup --comment-file "<path>" --json
rudder issue review "<issue-id-or-identifier>" --decision blocked --comment-file "<path>" --json
rudder issue create --org-id "$RUDDER_ORG_ID" ... --json
```

Issue comment and close-out commands accept comment bodies only from files or
stdin. For multiline Markdown, command names, code spans, code blocks,
validation summaries, or screenshot evidence, write the body to a temporary
Markdown file and pass `--body-file <path>` or `--comment-file <path>`. Pass
`-` to read from stdin.

Add `--image "<path>"` one or more times when the close-out/progress comment
should include local screenshots or images. Do not leave only a local `/tmp/...`
or workspace image path in the comment, because board users may not be able to
inspect it from Rudder.

## Authentication

Rudder injects the runtime context for you. Common env vars:

- `RUDDER_AGENT_ID`
- `RUDDER_ORG_ID`
- `RUDDER_API_URL`
- `RUDDER_API_KEY`
- `RUDDER_RUN_ID`

Optional wake-context vars may also appear:

- `RUDDER_TASK_ID`
- `RUDDER_WAKE_REASON`
- `RUDDER_WAKE_COMMENT_ID`
- `RUDDER_APPROVAL_ID`
- `RUDDER_APPROVAL_STATUS`
- `RUDDER_LINKED_ISSUE_IDS`

Rules:

- Never ask for `RUDDER_API_KEY` inside a normal heartbeat.
- Never hard-code the API URL.
- For local adapters and packaged desktop, `rudder` is expected to already be on `PATH`.
- In manual local CLI mode outside heartbeats, use `rudder agent local-cli <agent-ref> --org-id <org-id>` to mint an agent key, optionally install bundled Rudder skills locally, and print the required `RUDDER_*` exports.

## Shared Workspace

Each organization has one system-managed shared workspace root at:

- `~/.rudder/instances/<instance>/organizations/<org-id>/workspaces`

Important files and conventions:

- Structured shared references live in the org `Resources` catalog. Agents do not receive the whole org catalog automatically.
- If a run or chat is linked to a project, Rudder injects only that project's attached resources into the runtime context.
- Project Context is the explicit operator-curated starting set, not a knowledge boundary. If those resources are insufficient, inspect broader Library files and other org workspace know-how before concluding context is missing.
- Library-backed resources use `sourceType: "library"` and a safe `locator` inside `library:projects/<project-key>/`.
- External resources use `sourceType: "external"` and keep their original URL, local path, repo path, or connector locator.
- If you encounter older `library-file://...` or `library-doc://...` links, treat them as legacy Rudder Library references. Prefer project Library resources going forward.
- If you need broader org-wide resources, query the org resource catalog or inspect Library files explicitly instead of assuming they are already in the prompt.
- Use Workspaces for disk-backed shared files and skill packages.
- In local trusted runs, durable generated project work files belong under `$RUDDER_PROJECT_LIBRARY_ROOT`. Use `$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>` only when asking Rudder for a renderable reference. Use `/tmp` only for transient scratch files and temporary verification files.
- If a `resources.md` file exists, treat it like a normal workspace file rather than a reserved Rudder surface.
- Agent-specific files live under `workspaces/agents/<workspace-key>/...`.
- New projects do not create or configure their own workspace roots.
- When the operator asks you to create or maintain project records, use the
  stable CLI instead of ad hoc API calls:

```bash
rudder project list --org-id "$RUDDER_ORG_ID" --json
rudder project create --org-id "$RUDDER_ORG_ID" --name "<name>" --json
rudder project update "<project-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --status in_progress --json
```

## Delegation

```bash
rudder issue create --org-id "$RUDDER_ORG_ID" ... [--label-id "<label-id>"] [--label "<label-name>"] --json
```

When you create an issue as an authenticated agent without an assignee, Rudder assigns it to you by default. Pass an explicit assignee only when the new issue should belong to someone else.

When the organization has a mature issue label taxonomy, agent-created issues must choose at least one label. List the available labels first when you are not sure which one applies:

```bash
rudder issue labels list --org-id "$RUDDER_ORG_ID" --json
```

Always set `parentId`. Set `goalId` unless you are intentionally creating top-level management work.

## Organization Skills Workflow

When you need to create a skill for yourself, prefer an agent-private skill:

```bash
rudder agent skills create "$RUDDER_AGENT_ID" --name "<name>" --description "<description>" --enable --json
```

This creates the package under `AGENT_HOME/skills` and does not require organization skill mutation permission.

When a board user or authorized agent asks you to find, import, inspect, or
assign organization skills, read `references/organization-skills.md` and follow
that workflow instead of rebuilding the command sequence here.

Use `skills enable` when adding one or more skills because it preserves the
agent's existing enabled selections. Use `skills sync` only when you intend to
replace the full optional enabled-skill set.

After creating or copying a skill under `AGENT_HOME/skills/<slug>/`, check the
agent's Skills snapshot. If the skill is installed but not enabled, say:
installed but not enabled; future runs will not load it until enabled.

Do not fall back to raw `curl` for this workflow in local adapters or packaged desktop.

## Durable Library Files

If asked to make or revise durable project work files, use the Library as a local file workspace. In local trusted runs with project context, write files directly under `$RUDDER_PROJECT_LIBRARY_ROOT` with normal filesystem tools. `library:projects/<project-key>/...` is the Rudder product locator for those files, not the Markdown link syntax and not a reason to route ordinary local edits through the CLI.

When you need to cite a Library file in a chat reply, issue comment, review, blocker, or done comment, use the `markdownLink` returned by `rudder library file ref "$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>" --json`. Do not hand-write `library-entry://...` URLs.

Strong Library links look like normal Markdown, but the target contains only
the stable Library entry id. Title and path are display or lookup details
returned by Rudder, not URL metadata agents should encode:

```md
[Project work file](library-entry://<entry-id>)
```

Typical flow:

```bash
printf '%s\n' "<markdown body>" > "$RUDDER_PROJECT_LIBRARY_ROOT/<issue-identifier>.md"
rudder library file ref "$RUDDER_PROJECT_LIBRARY_PATH/<issue-identifier>.md" --json
rudder issue comment "<issue-id-or-identifier>" --body-file "<path>" --json
```

The `ref`, `put`, and `get` JSON responses include:

- `libraryEntryId`: stable Library file identity
- `mentionHref`: the raw `library-entry://<entry-id>` target
- `markdownLink`: the Markdown link to paste into the comment body

For close-out comments, copy `markdownLink` from the JSON response into your temporary Markdown comment file and post that link as the Rudder-visible handoff checkpoint. Direct filesystem writes are not complete handoff evidence until the file is cited with the returned `markdownLink`. The `ref` argument is a Library-relative path such as `$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>`, not the absolute `$RUDDER_PROJECT_LIBRARY_ROOT/...` filesystem path. If `$RUDDER_PROJECT_LIBRARY_ROOT` is unset or inaccessible, use `rudder library file get/put "$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>"` as the remote or restricted runtime fallback. Use older `library-file://...` links only when you are preserving or reading legacy content that has no `libraryEntryId`.

Planning rules:

- do not mark the issue done when the request was only to create or revise a plan
- reassign back to the requester if that is the expected workflow
- when you create or update a durable Library file, always include a user-visible Markdown link to that file in your final chat reply or issue comment
- when you reference the plan in comments, use the `markdownLink` returned by `rudder library file ref ... --json`
- `rudder issue documents ...` has been retired. Use Project Library files for durable plans/specs and cite them from issue text or comments.

## Comment Style (Required)

Use concise markdown with:

- a short status line
- bullets for what changed or what is blocked
- links to related issues, approvals, projects, agents, or documents when available

**Clickable URLs are Markdown links.** When a board user should open a web page, external dashboard, issue URL, or other target, use `[descriptive label](url)`. Do not leave action URLs as bare text, and do not wrap them in code spans unless you are showing literal code or a command:

- Good: `[NameSilo transfer page](https://www.namesilo.com/account_domain_manage_transfer.php)`
- Bad: `https://www.namesilo.com/account_domain_manage_transfer.php`

**Ticket references are links.** Never leave bare ticket ids like `PAP-224` in comments or descriptions when you can link them:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

**Company-prefixed URLs are required.** Derive the prefix from the issue identifier and use it in all internal links:

- issues: `/<prefix>/issues/<issue-identifier>`
- issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>`
- Library files: `/<prefix>/library?path=<url-encoded-relative-path>`
- agents: `/<prefix>/agents/<agent-url-key>`
- projects: `/<prefix>/projects/<project-url-key>`
- approvals: `/<prefix>/messenger/approvals/<approval-id>`
- runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Example:

```md
## Update

Plan updated and ready for review.

- Plan: [PAP-142 plan](/PAP/library?path=projects%2Fproject-name%2FPAP-142.md)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
- Approval: [ca6ba09d](/PAP/messenger/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
```

## Discovery

When you are unsure which Rudder commands are supported in this runtime, use:

```bash
rudder agent capabilities --json
```

For the human-readable command catalog, read `references/cli-reference.md`.
For API debugging and compatibility investigations only, read `references/api-reference.md`.
