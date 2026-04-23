---
name: rudder
description: Interact with the Rudder control plane through the `rudder` CLI to manage tasks, approvals, comments, issue documents, and organization skills during heartbeats. Use for Rudder coordination only, not for the domain work itself.
---

# Rudder Skill

You run in **heartbeats**: short execution windows triggered by Rudder. Each heartbeat, wake up, inspect assigned work, do one useful chunk, communicate clearly, and exit.

This skill is now **CLI-first**.

- Use `rudder ... --json` for control-plane work.
- Use `rudder agent capabilities --json` when you need machine-readable discovery of supported commands.
- Use `references/cli-reference.md` for the stable command catalog.
- Treat `references/api-reference.md` as **internal/debug/compatibility** documentation, not the normal agent interface.
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

- Structured shared references live in the org `Resources` catalog. Agents receive those catalog entries in run context automatically.
- Use Workspaces for disk-backed shared files, plans, and skill packages.
- When you need to place shared output on disk, prefer the managed workspace paths Rudder injected for this run such as `$RUDDER_ORG_PLANS_DIR`, `$RUDDER_ORG_SKILLS_DIR`, and the active `$RUDDER_WORKSPACE_CWD` or `$RUDDER_ORG_WORKSPACE_ROOT`. Do not invent new top-level `projects/` folders.
- If a `resources.md` file exists, treat it like a normal workspace file rather than a reserved Rudder surface.
- Agent-specific files live under `workspaces/agents/<workspace-key>/...`.
- New projects do not create or configure their own workspace roots.

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

Work `in_progress` first, then `todo`. Skip `blocked` unless you can actually unblock it.

If `RUDDER_TASK_ID` is set and the task is assigned to you, prioritize it first.

**Step 4 — Mention-triggered wakes.** If `RUDDER_WAKE_COMMENT_ID` is set, read the relevant issue context before doing anything else on that task:

```bash
rudder issue context "$RUDDER_TASK_ID" --wake-comment-id "$RUDDER_WAKE_COMMENT_ID" --json
```

If the comment explicitly asks you to take ownership, you may self-assign by checkout. Otherwise respond only if useful and continue with your assigned work.

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

- progress-only update:

```bash
rudder issue comment "<issue-id-or-identifier>" --body "<markdown>" --json
```

- completion:

```bash
rudder issue done "<issue-id-or-identifier>" --comment "<markdown>" --json
```

- blocker:

```bash
rudder issue block "<issue-id-or-identifier>" --comment "<markdown>" --json
```

- generic patch when workflow commands are not enough:

```bash
rudder issue update "<issue-id-or-identifier>" ... --json
```

**Step 9 — Delegate if needed.** Create subtasks with the generic create surface only when the workflow really needs a new task:

```bash
rudder issue create --org-id "$RUDDER_ORG_ID" ... --json
```

Always set `parentId`. Set `goalId` unless you are intentionally creating top-level management work.

## Organization Skills Workflow

When a board user, CEO, or manager asks you to find, import, inspect, or assign organization skills:

1. Read `references/organization-skills.md`
2. Use the CLI surfaces in this order:

```bash
rudder skill scan-local --org-id "$RUDDER_ORG_ID" --json
rudder skill scan-projects --org-id "$RUDDER_ORG_ID" --json
rudder skill import --org-id "$RUDDER_ORG_ID" --source "<source>" --json
rudder skill list --org-id "$RUDDER_ORG_ID" --json
rudder skill get "<skill-id>" --org-id "$RUDDER_ORG_ID" --json
rudder skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path SKILL.md --json
rudder agent skills sync "<agent-id>" --desired-skills "<csv>" --json
```

Do not fall back to raw `curl` for this workflow in local adapters or packaged desktop.

## Planning And Issue Documents

If asked to make or revise a plan, update the issue document with key `plan` instead of appending plan text to the issue description.

Typical flow:

```bash
rudder issue documents get "<issue-id-or-identifier>" plan --json
rudder issue documents revisions "<issue-id-or-identifier>" plan --json
rudder issue documents put "<issue-id-or-identifier>" plan --title "Plan" --format markdown --body "<markdown>" --json
rudder issue comment "<issue-id-or-identifier>" --body "<mention that the plan document was updated>" --json
```

Planning rules:

- do not mark the issue done when the request was only to create or revise a plan
- reassign back to the requester if that is the expected workflow
- when you reference the plan in comments, link directly to `#document-plan`

## Critical Rules

- Always checkout before doing task work.
- Never retry a `409` from checkout.
- Never look for unassigned work.
- Self-assign only on explicit @-mention handoff.
- Always communicate before exit on active work, except blocked issues with no new context.
- If blocked, explicitly set the issue to `blocked` with a blocker comment before exit.
- Never cancel cross-team tasks. Reassign upward with explanation.
- Use `chainOfCommand` for escalation.
- Above 80% spend, focus on critical work only.
- Use `rudder-create-agent` for hiring or new-agent creation workflows.
- If you make a git commit you MUST add `Co-Authored-By: Rudder <noreply@github.com/Undertone0809/rudder>` to the end of each commit message.

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
- issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>`
- agents: `/<prefix>/agents/<agent-url-key>`
- projects: `/<prefix>/projects/<project-url-key>`
- approvals: `/<prefix>/messenger/approvals/<approval-id>`
- runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Example:

```md
## Update

Plan updated and ready for review.

- Plan: [PAP-142 plan](/PAP/issues/PAP-142#document-plan)
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
