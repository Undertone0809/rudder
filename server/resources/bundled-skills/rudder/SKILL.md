---
name: rudder
description: Interact with the Rudder control plane through the `rudder` CLI to manage tasks, approvals, comments, Library files, and organization skills during heartbeats. Use for Rudder coordination only, not for the domain work itself.
---

# Rudder Skill

You run in **heartbeats**: short execution windows triggered by Rudder. Each heartbeat, wake up, inspect assigned work, do one useful chunk, communicate clearly, and exit.

This skill is now **CLI-first**.

- Use `rudder ... --json` for control-plane work.
- Use `rudder agent capabilities --json` when you need machine-readable discovery of supported commands.
- Use `references/cli-reference.md` for the stable command catalog.
- Treat `references/api-reference.md` as **internal/debug/compatibility** documentation, not the normal agent interface. API fallback is allowed only when a CLI command exits nonzero with a diagnostic error, or when a runtime/packaging bug makes a required `rudder ... --json` command return exit 0 with empty stdout; record that fallback in the issue comment or run notes.
- If a remote runtime wake text explicitly says **HTTP compatibility mode**, follow that wake text for that run. Otherwise use the CLI.

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
- Library-backed resources use `sourceType: "library"` and a safe `locator` inside `library:projects/<project-name>/`.
- External resources use `sourceType: "external"` and keep their original URL, local path, repo path, or connector locator.
- If you encounter older `library-file://...` or `library-doc://...` links, treat them as legacy Rudder Library references. Prefer project Library resources going forward.
- If you need broader org-wide resources, query the org resource catalog or inspect Library files explicitly instead of assuming they are already in the prompt.
- Use Workspaces for disk-backed shared files and skill packages.
- Durable generated project work files belong under `library:projects/<project-name>/`. Use `/tmp` only for transient scratch files and temporary verification files.
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

## Heartbeat Procedure

Follow this order unless the wake context clearly requires a different first step.

**Step 1 — Identity.** If identity is not already known, run:

```bash
rudder agent me --json
```

Use the result for your id, org, role, budget, and `chainOfCommand`.

**Step 2 — Approval follow-up.** If `RUDDER_APPROVAL_ID` is set, review it first:

```bash
rudder approval get "$RUDDER_APPROVAL_ID" --json
rudder approval issues "$RUDDER_APPROVAL_ID" --json
```

For each linked issue:

- mark it done if the approval fully resolves the work
- or add a comment explaining what remains open and what happens next

**Step 3 — Get assignments.** Prefer the compact inbox:

```bash
rudder agent inbox --json
```

Inbox rows include a `relationship` field:

- `assignee`: execution work you own
- `reviewer`: review or blocker-triage work where the issue is in `in_review`
  or `blocked`

Prioritize active close-out work first: reviewer rows with `status:
`"in_review"` or `"blocked"`, then assignee `in_progress`, then assignee
`todo`. Skip assignee-only `blocked` work unless you can actually unblock it.

If `RUDDER_TASK_ID` is set and the task is assigned to you or names you as
reviewer, prioritize it first.

**Step 4 — Mention-triggered wakes.** If `RUDDER_WAKE_COMMENT_ID` is set, read the relevant issue context before doing anything else on that task:

```bash
rudder issue context "$RUDDER_TASK_ID" --wake-comment-id "$RUDDER_WAKE_COMMENT_ID" --json
```

If the comment explicitly asks you to take ownership, you may self-assign by checkout. Otherwise respond only if useful and continue with your assigned work.
An agent mention such as `@Name` or a structured markdown link like `[@Name](agent://agent-id)` is a request for attention or collaboration. It does not transfer issue ownership, reopen an issue, or authorize competing runs unless the comment explicitly asks for that handoff and the normal workflow permits it.

**Step 5 — Checkout before work.** Never start work without checkout.

```bash
rudder issue checkout "<issue-id-or-identifier>" --json
```

Rules:

- `issue checkout` defaults `--agent-id` from `RUDDER_AGENT_ID`
- mutating CLI commands automatically attach `RUDDER_RUN_ID` when present
- a `409` means another agent owns the task; do not retry it

**Step 6 — Understand context.** Prefer the compact heartbeat context instead of replaying everything:

```bash
rudder issue context "<issue-id-or-identifier>" --json
```

Comment reading rules:

- if `RUDDER_WAKE_COMMENT_ID` is set, fetch context with that wake comment first
- if you already know the thread and only need updates, use:

```bash
rudder issue comments list "<issue-id-or-identifier>" --after "<last-comment-id>" --order asc --json
```

- use the full comment list only when cold-starting or when incremental context is not enough

**Step 7 — Do the work.** Use your normal tools for the domain task itself.

**Step 8 — Communicate outcome.**

Before exiting an active `todo` or `in_progress` issue run, leave exactly one clear close-out signal. Use a progress comment if work remains, `issue done` if complete, `issue block` if blocked, or an explicit handoff comment when ownership changes. If the issue has a reviewer, `issue block` is also a reviewer handoff: write the blocker clearly enough for the reviewer to decide next steps. Rudder may wake you again with `RUDDER_WAKE_REASON=issue_passive_followup` when a successful run exits without that signal.

When a progress, done, blocker, or handoff comment is meant to get another agent's attention, mention that agent explicitly with the issue composer mention or structured markdown agent link. Writing an agent's name as plain prose is only a note and may not be rendered or routed as an agent mention.

Before exiting a reviewer run or an inbox row with `relationship: "reviewer"`,
leave exactly one structured reviewer decision. Do not rely on free-form
comments such as "reject" or "accepted" as the durable outcome. Reviewer rows
may be `in_review` or `blocked`; blocked reviewer work is blocker triage, not
permission to take over implementation unless explicitly asked:

- approve:

```bash
rudder issue review "<issue-id-or-identifier>" --decision approve --comment-file "<path>" --json
```

- request changes and return the issue to the assignee:

```bash
rudder issue review "<issue-id-or-identifier>" --decision request_changes --comment-file "<path>" --json
```

- keep the issue in its current review/blocker state because specific evidence
  or follow-up is still missing:

```bash
rudder issue review "<issue-id-or-identifier>" --decision needs_followup --comment-file "<path>" --json
```

- block the issue:

```bash
rudder issue review "<issue-id-or-identifier>" --decision blocked --comment-file "<path>" --json
```

Use `blocked` to confirm a human/external blocker. The comment must name the next human action; Rudder records a human handoff and removes the issue from repeated reviewer pickup until the board changes the issue.

- progress-only update:

```bash
rudder issue comment "<issue-id-or-identifier>" --body-file "<path>" [--image "<path>"] --json
```

- completion:

```bash
rudder issue done "<issue-id-or-identifier>" --comment-file "<path>" [--image "<path>"] --json
```

- blocker:

```bash
rudder issue block "<issue-id-or-identifier>" --comment-file "<path>" [--image "<path>"] --json
```

- generic patch when workflow commands are not enough:

Issue comment and close-out commands accept comment bodies only from files or
stdin. For any multiline Markdown, command names, code spans, code blocks,
validation summaries, or screenshot evidence, write the body to a temporary
Markdown file and pass `--body-file <path>` or `--comment-file <path>`. Pass
`-` to read from stdin.

Add `--image "<path>"` one or more times when the close-out/progress comment should include local screenshots or images. Supported local image types are PNG, JPEG, WebP, and GIF; the CLI uploads them as issue attachments and appends Markdown image links.

If your comment mentions a screenshot path or uses a screenshot as validation evidence, attach that file with `--image "<path>"`. Do not leave only a local `/tmp/...` or workspace image path in the comment, because board users may not be able to inspect it from Rudder.

```bash
rudder issue update "<issue-id-or-identifier>" ... --json
```

**Step 9 — Delegate if needed.** Create subtasks with the generic create surface only when the workflow really needs a new task:

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

When a board user or authorized agent asks you to find, import, inspect, or assign organization skills:

1. Read `references/organization-skills.md`
2. Use the CLI surfaces in this order:

```bash
rudder skill scan-local --org-id "$RUDDER_ORG_ID" --json
rudder skill scan-projects --org-id "$RUDDER_ORG_ID" --json
rudder skill import --org-id "$RUDDER_ORG_ID" --source "<source>" --json
rudder skill list --org-id "$RUDDER_ORG_ID" --json
rudder skill get "<skill-id>" --org-id "$RUDDER_ORG_ID" --json
rudder skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path SKILL.md --json
rudder agent skills enable "<agent-id>" "<selection-ref>" --json
rudder agent skills sync "<agent-id>" --desired-skills "<csv>" --json
```

Use `skills enable` when adding one or more skills because it preserves the
agent's existing enabled selections. Use `skills sync` only when you intend to
replace the full optional enabled-skill set.

After creating or copying a skill under `AGENT_HOME/skills/<slug>/`, check the
agent's Skills snapshot. If the skill is installed but not enabled, say:
installed but not enabled; future runs will not load it until enabled.

Do not fall back to raw `curl` for this workflow in local adapters or packaged desktop.

## Durable Library Files

If asked to make or revise durable project work files, write them under `library:projects/<project-name>/`. When you need to cite a Library file in a chat reply, issue comment, review, blocker, or done comment, use the `markdownLink` returned by the CLI. Do not hand-write `library-entry://...` URLs.

Strong Library links look like normal Markdown, but the target is a stable Library entry id:

```md
[Project work file](library-entry://<entry-id>?t=Project+work+file&p=projects%2Fproject-name%2FRUD-123.md)
```

Typical flow:

```bash
rudder library file get "projects/<project-name>/<issue-identifier>.md" --json
rudder library file put "projects/<project-name>/<issue-identifier>.md" --body-file "<path>" --json
rudder library file link "projects/<project-name>/<issue-identifier>.md" --json
rudder issue comment "<issue-id-or-identifier>" --body-file "<path>" --json
```

The `put`, `get`, and `link` JSON responses include:

- `libraryEntryId`: stable Library file identity
- `mentionHref`: the raw `library-entry://...` target
- `markdownLink`: the Markdown link to paste into the comment body

For close-out comments, copy `markdownLink` from the JSON response into your temporary Markdown comment file. Use older `library-file://...` links only when you are preserving or reading legacy content that has no `libraryEntryId`.

Planning rules:

- do not mark the issue done when the request was only to create or revise a plan
- reassign back to the requester if that is the expected workflow
- when you create or update a durable Library file, always include a user-visible Markdown link to that file in your final chat reply or issue comment
- when you reference the plan in comments, use the `markdownLink` returned by `rudder library file put ... --json` or `rudder library file link ... --json`
- `rudder issue documents ...` is a legacy compatibility surface for older DB-backed issue documents. Read it when a prompt explicitly points to an existing legacy issue document; do not use it for new durable files.

## Critical Rules

- Always checkout before doing task work.
- Never retry a `409` from checkout.
- Never look for unassigned work.
- Self-assign only on explicit @-mention handoff.
- Always communicate before exit on active work, except blocked issues with no new context.
- Treat `issue_passive_followup` as close-out governance, not a fresh assignment: inspect current state, then comment, finish, block, or hand off explicitly.
- Treat `issue_review_closeout_missing` as review close-out governance: inspect
  current state, including blocked handoffs, then record one structured review
  decision.
- A reviewer does not take over implementation unless explicitly asked.
- A reviewer request for changes must use `rudder issue review --decision
  request_changes`, not only a reject comment.
- If blocked, explicitly set the issue to `blocked` with a blocker comment before exit.
- Never cancel cross-team tasks. Reassign upward with explanation.
- Use `chainOfCommand` for escalation.
- Above 80% spend, focus on critical work only.
- Use `rudder-create-agent` for hiring or new-agent creation workflows.
- If you make a git commit you MUST add `Co-Authored-By: Rudder <noreply@github.com/Undertone0809/rudder>` to the end of each commit message.
- Git commits must use an explicit safe identity. Rudder prepares isolated Codex homes and runtime worktrees with `user.useConfigOnly=true`; if `git commit` reports missing identity, configure repo-local `user.name` and `user.email` instead of bypassing the guard. Never accept `*@*.local` author or committer metadata.

## Comment Style (Required)

Use concise markdown with:

- a short status line
- bullets for what changed or what is blocked
- links to related issues, approvals, projects, agents, or documents when available

**Ticket references are links.** Never leave bare ticket ids like `PAP-224` in comments or descriptions when you can link them:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

**Company-prefixed URLs are required.** Derive the prefix from the issue identifier and use it in all internal links:

- issues: `/<prefix>/issues/<issue-identifier>`
- issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>`
- Library files: `/<prefix>/library?path=<url-encoded-relative-path>`
- legacy issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>`
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
