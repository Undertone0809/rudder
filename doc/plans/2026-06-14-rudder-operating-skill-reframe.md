---
title: Reframe bundled Rudder skill as agent operating practice
date: 2026-06-14
kind: proposal
status: proposed
area: skills
entities:
  - rudder_skill
  - agent_operating_contract
  - heartbeat_runs
  - organization_skills
issue:
related_plans:
  - 2026-04-14-codex-managed-skill-materialization.md
  - 2026-05-04-agent-operating-contract-runtime.md
  - 2026-06-03-heartbeat-instructions-scene-gate.md
supersedes: []
related_code:
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/resources/bundled-skills/rudder/references/cli-reference.md
  - server/resources/bundled-skills/rudder/references/organization-skills.md
  - server/src/__tests__/bundled-rudder-skill-docs.test.ts
commit_refs: []
updated_at: 2026-06-14
---

# Reframe Bundled Rudder Skill As Agent Operating Practice

## Overview

The bundled `rudder` skill should read as the always-loaded operating practice
for agents working under Rudder, not as a CLI catalog with heartbeat notes
attached. The CLI remains the normal implementation interface, but the skill's
main job is to teach the agent how to preserve the Rudder work loop:

```text
Goal -> Issue -> Agent run -> Review -> Feedback -> Learning -> Better future runs
```

This proposal optimizes only the bundled skill at
`server/resources/bundled-skills/rudder/`. It does not change
`.agents/skills/maintainer/development-lifecycle-router-maintainer/SKILL.md`.
The lifecycle router is being used as the development workflow controller for
this change, not as the artifact being optimized.

## What Is The Problem?

The current bundled `rudder` skill contains the right behavioral rules, but its
top-level framing is still tool-first:

- Frontmatter says the skill is for interacting with the control plane through
  the CLI.
- The opening states "This skill is now CLI-first."
- Main sections mix heartbeat judgment, organization skill management, Library
  artifact rules, command snippets, and critical safety rails at the same
  hierarchy level.

That shape encourages a future agent to treat the skill as a command reference
instead of the Rudder work-loop contract. It also duplicates details that already
belong in `references/cli-reference.md` and
`references/organization-skills.md`.

## Reviewer Gate 1 Findings

Three spawned reviewers reviewed the target and direction before this proposal.
Their shared verdict was conditional accept with these constraints:

- Keep `server/resources/bundled-skills/rudder/SKILL.md` as the target.
- Do not edit or re-expand the lifecycle router.
- Preserve the procedural spine: identity, approval follow-up, inbox ordering,
  mention wake handling, checkout, context, close-out, reviewer decisions, and
  delegation.
- Do not duplicate runtime prompt injection owned by
  `packages/agent-runtime-utils`.
- Keep `references/cli-reference.md` authoritative for command syntax and the
  agent-v1 command catalog.
- Keep `references/organization-skills.md` authoritative for organization skill
  import, inspect, enable, and sync workflows.
- Do not weaken high-risk rails: checkout `409`, structured reviewer decisions,
  `--image`, Library `markdownLink`, and `skills enable` versus `skills sync`.
- Add validation that catches vague rewrites, missing checkout, missing
  close-out, broken reviewer decisions, stale CLI command catalog growth, and
  organization-skill routing drift.

## What Will Be Changed?

1. Rewrite the frontmatter description and opening section so `rudder` is an
   agent operating skill for Rudder heartbeats. CLI-first remains a tool rule,
   not the skill identity.
2. Add a compact heartbeat decision model near the top:
   wake/relationship -> required first action -> required close-out.
3. Move the critical operating rules upward and group them by ownership,
   review, close-out, artifact evidence, escalation, budget, and git identity.
4. Keep the existing heartbeat procedure and essential command examples where
   the exact command prevents unsafe state.
5. Shorten the main organization-skills section to point to
   `references/organization-skills.md` while retaining the agent-private-first
   rule and the `enable` versus `sync` warning.
6. Keep `references/cli-reference.md` as the command catalog. The main
   `SKILL.md` should not grow a full agent-v1 table.
7. Add focused documentation tests for the operating-contract shape.

### Allowed Inline Command Scope

The main `SKILL.md` may keep inline commands only when choosing the wrong
command would create unsafe or invisible Rudder state:

- identity and discovery: `rudder agent me`, `rudder agent inbox`,
  `rudder agent capabilities`
- approval follow-up: `rudder approval get`, `rudder approval issues`
- work ownership and context: `rudder issue checkout`, `rudder issue context`,
  `rudder issue comments list`
- close-out and review: `rudder issue comment`, `rudder issue done`,
  `rudder issue block`, `rudder issue review`
- delegated work creation: `rudder issue create`,
  `rudder issue labels list`
- agent-private skill creation: `rudder agent skills create`
- organization skill assignment warning: `rudder agent skills enable`,
  `rudder agent skills sync`
- durable artifact citation: `rudder library file ref`,
  `rudder library file get`, `rudder library file put`
- project record maintenance when explicitly requested:
  `rudder project list`, `rudder project create`, `rudder project update`

All other command catalog detail should stay in `references/cli-reference.md` or
`references/organization-skills.md`.

## Success Criteria For Change

- A future agent can identify the skill's purpose as Rudder operating practice,
  not just CLI usage.
- The main skill still preserves the non-negotiable heartbeat loop:
  identify, select assigned or reviewer work, checkout, load context, execute,
  close out, and escalate.
- CLI command syntax remains delegated to `references/cli-reference.md`.
- Organization-skill details remain delegated to
  `references/organization-skills.md`.
- Tests fail if the main skill loses checkout, structured reviewer decisions,
  close-out guidance, or accumulates the full command catalog.

## Out Of Scope

- No lifecycle-router changes.
- No runtime prompt assembly changes.
- No CLI behavior, API behavior, database schema, or UI changes.
- No new bundled skill.
- No broad rewrite of `cli-reference.md` or `organization-skills.md` unless the
  main skill edit exposes a direct inconsistency.

## Non-Functional Requirements

- Maintainability: keep the main skill short enough to scan during a heartbeat.
- Auditability: retain the commands and rules that produce durable Rudder
  comments, reviews, blocks, and Library links.
- Compatibility: do not change command names or runtime expectations.

## User Experience Walkthrough

1. Rudder wakes an agent.
2. The agent reads the top of the bundled `rudder` skill and recognizes the
   active scenario: assignee work, reviewer work, approval follow-up, mention
   wake, passive follow-up, review close-out, blocked work, durable artifact, or
   organization-skill request.
3. The agent performs the required first action: identify, read approval,
   inspect inbox, read wake context, checkout, review, or load the delegated
   reference.
4. The agent does one bounded chunk of domain work through normal tools.
5. Before exit, the agent leaves exactly one durable Rudder-visible signal:
   progress, done, block, handoff, or structured review decision.
6. When command syntax is needed, the agent uses the CLI reference instead of
   relying on stale inline examples.

### Heartbeat Decision Table

| Trigger or relationship | Required first action | Ownership rule | Required close-out |
|---|---|---|---|
| Unknown identity | Run `rudder agent me --json`. | Use returned id, org, role, budget, and `chainOfCommand`. | Continue only after identity is known. |
| `RUDDER_APPROVAL_ID` | Read `rudder approval get` and linked `rudder approval issues`. | Do not ignore linked issues. | Mark resolved issues done or comment what remains open. |
| Inbox `relationship: "assignee"` | Use inbox priority, then checkout before work. | Respect single-assignee checkout; never retry `409`. | Exactly one progress, done, block, or handoff signal. |
| Inbox `relationship: "reviewer"` | Inspect review or blocked state. | Reviewer does not silently implement. | Exactly one structured `rudder issue review --decision ...`. |
| `RUDDER_WAKE_COMMENT_ID` | Load issue context with the wake comment id. | Self-assign only if the comment explicitly transfers ownership. | Respond if useful, then continue assigned work or close out explicitly. |
| `RUDDER_WAKE_REASON=issue_passive_followup` | Inspect current issue state. | Treat as close-out governance, not new work discovery. | Comment, finish, block, or hand off explicitly. |
| `RUDDER_WAKE_REASON=issue_review_closeout_missing` or reviewer row without decision | Inspect current review/blocker state. | Do not rely on free-form accept or reject comments. | Record one structured reviewer decision. |
| Blocked assignee work | Skip unless new context lets you unblock. | If blocked by human or external action, name that blocker. | Use `issue block` or reviewer `blocked` decision as appropriate. |
| Durable project artifact requested | Write under the project Library root or use Library fallback commands. | A filesystem write alone is not user-visible handoff evidence. | Cite the returned `markdownLink` in a Rudder comment or reply. |
| Skill creation for self-use | Prefer `rudder agent skills create ... --enable`. | Do not mutate organization skill library for private need. | Report installed/enabled state. |
| Board-authorized organization skill work | Read `references/organization-skills.md`. | `enable` is additive; `sync` replaces optional enabled skills. | Use the reference workflow and report the resulting selection. |
| Delegation needed | Create a sub-issue only when a new task is actually needed. | Set `parentId`; set `goalId` unless intentionally top-level. | Leave a handoff comment and preserve ownership clarity. |

## Implementation

### Product Or Technical Architecture Changes

This is a documentation and validation change. It does not change product
runtime architecture.

### Breaking Change

None.

### Design

The edited main skill should use this structure:

1. Purpose and interface rules.
2. Heartbeat operating loop.
3. Heartbeat decision model.
4. Authentication and workspace context.
5. Heartbeat procedure.
6. Organization skills pointer.
7. Durable Library files.
8. Comment style and discovery.

The critical rules should move from a late checklist into the operating-loop
area, while staying specific enough to preserve existing behavior.

### Security

No new endpoints, dependencies, auth flows, or external calls are introduced.
The existing API-key and no-hard-coded-URL rules stay intact.

## What Is Your Testing Plan (QA)?

### Goal

Validate that the bundled skill now encodes Rudder agent best practice without
losing the concrete safety rails that make the work loop auditable.

### Prerequisites

Repository checkout with test dependencies installed.

### Test Scenarios / Cases

- Full heartbeat spine: the main skill must still contain identity
  (`agent me`), approval follow-up (`approval get` / `approval issues`), inbox
  priority (`agent inbox`), mention wake context, checkout, context load,
  close-out, structured reviewer decision, and delegation.
- Assignee wake: the skill requires checkout before domain work, no retry on
  `409`, no unassigned-work fishing, and exactly one close-out signal before
  exit.
- Reviewer wake: the skill requires `rudder issue review --decision ...`, not
  free-form accept or reject comments, and includes the four reviewer decisions:
  `approve`, `request_changes`, `needs_followup`, and `blocked`.
- Mention wake: the skill requires reading wake context and does not permit
  self-assignment unless the comment explicitly transfers ownership.
- Passive follow-up: the skill treats `issue_passive_followup` as close-out
  follow-up, not new work discovery.
- Review close-out follow-up: the skill treats
  `issue_review_closeout_missing` as review close-out follow-up and requires a
  structured decision.
- Screenshot evidence: the skill preserves `--image` guidance when screenshot
  evidence is mentioned.
- Durable Library evidence: the skill requires `rudder library file ref` and the
  returned `markdownLink` for user-visible Library handoff.
- Organization-skill request: the skill prefers `rudder agent skills create` for
  self-use and routes organization library operations to
  `references/organization-skills.md`.
- Skill assignment safety: the skill preserves the warning that `skills enable`
  is additive while `skills sync` replaces the optional enabled-skill set.
- Delegation: the skill preserves `parentId`, `goalId`, and label-taxonomy
  guidance for newly created issues.
- CLI failure: the skill keeps API fallback limited to diagnostic CLI failure or
  exit-0 empty stdout, with the fallback recorded.
- Reference split guard: the main skill does not contain an `Agent V1 Commands`
  catalog table or broad automation, chat, runs, skill, or library command
  catalog sections.

### Expected Results

The focused doc test should pass and guard these structure-level requirements.
Manual review should confirm that the main skill's allowed inline commands stay
inside the scope above and that detailed command catalog material remains in
the references.

### Pass / Fail

- Passed: manual Node guard script confirmed the expected strings, regex guards,
  and negative catalog-drift checks against the edited `SKILL.md`.
- Passed: `pnpm exec vitest run
  server/src/__tests__/bundled-rudder-skill-docs.test.ts --reporter=verbose`
  after installing local dependencies with
  `pnpm install --no-frozen-lockfile --lockfile=false`.

## Documentation Changes

- Update `server/resources/bundled-skills/rudder/SKILL.md`.
- Update `server/resources/bundled-skills/rudder/references/*` only if the main
  skill exposes a direct inconsistency.
- Add or update `server/src/__tests__/bundled-rudder-skill-docs.test.ts`.

## Open Issues

- Second reviewer gate completed before implementation; reviewers required a
  tighter validation contract and decision table, which this plan now includes.
- Final reviewer gate completed after implementation; reviewers found no content
  blocker and required dependency-backed target Vitest execution before final
  handoff.
- Full suite verification remains broader than this docs-only change and may
  still be blocked if local dependencies or runtime services are incomplete.
