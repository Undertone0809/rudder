---
title: Reviewer Queue Closeout Recovery
date: 2026-05-07
kind: implementation
status: completed
area: agent_runtimes
entities:
  - issue_reviewer
  - review_routing
  - issue_closeout_watchdog
  - agent_inbox
issue:
related_plans:
  - 2026-05-02-issue-add-reviewer-proposal.md
  - 2026-04-24-passive-issue-closeout-watchdog.md
supersedes: []
related_code:
  - server/src/routes/agents.ts
  - server/src/routes/issues.ts
  - server/src/services/issue-review-wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.ts
  - cli/src/commands/client/agent.ts
  - cli/src/commands/client/issue.ts
  - cli/src/agent-v1-registry.ts
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/resources/bundled-skills/rudder/references/cli-reference.md
commit_refs:
  - "fix: recover missing reviewer closeout"
  - "fix: route blocked reviewer handoffs"
updated_at: 2026-05-07
---

# Reviewer Queue Closeout Recovery

## Summary

Make reviewer work a first-class, recoverable part of the Rudder agent work
loop. A reviewer must be able to discover pending `in_review` work and reviewed
`blocked` handoffs during normal timer heartbeats, record one structured review
outcome, and be nudged by the platform when a review run ends without a durable
outcome.

The intended end state is:

- `rudder agent inbox` includes reviewer work, not only assignee work.
- reviewer decisions are recorded with an explicit decision field instead of
  inferred from free-form comments.
- review runs that end without a decision get bounded follow-up before operator
  escalation.
- assignee blocker handoffs on reviewed issues do not strand in `blocked`.

## Problem

The existing reviewer routing work gets an issue to a reviewer, but it does not
guarantee reviewer closure.

Evidence from Codex session `019e023c-82a7-7581-b881-5785621c2f65`:

- Z Studio's CTO agent had zero assignee inbox work but five reviewer issues in
  `in_review`.
- Several reviewer comments already contained decisions such as reject or
  request changes, but the issue status remained `in_review`.
- `/agents/me/inbox-lite` only returned `assigneeAgentId = me` rows in
  `todo,in_progress,blocked`, so a timer heartbeat could exit even while the
  agent had pending reviewer work.
- The first implementation only treated `in_review` as reviewer-owned. That
  missed reviewed issues where the assignee records a blocker with `issue
  block`: the issue can be intentionally handed to the reviewer for blocker
  triage but never appears as reviewer work.

The first-principles issue is that Rudder cannot assume agents will remember to
translate a review judgment into a workflow mutation. Reviewer work needs the
same control-plane safety net as assignee closeout.

## Scope

In scope:

- include reviewer `in_review` rows in the compact agent inbox
- include reviewer `blocked` rows for reviewed blocker handoffs
- mark inbox rows with the agent's relationship to the issue
- add a reviewer decision CLI command that atomically sends decision + comment
- record structured `issue.review_decision_recorded` activity
- add reviewer-run closeout recovery for missing decisions
- update bundled Rudder skill and CLI reference text
- add focused automated coverage for API, CLI contract, and runtime recovery

Out of scope:

- multiple reviewers
- a `review_requests` table
- natural-language parsing of accept/reject comments
- making reviewer equivalent to approval
- changing human reviewer UI surfaces in this iteration

## Implementation Plan

1. Extend the agent inbox route to merge assignee rows with reviewer rows.
2. Add `relationship: "assignee" | "reviewer"` to inbox responses and CLI
   output.
3. Add `reviewDecision` to issue update validation and expose
   `rudder issue review`.
4. In issue update routing, allow reviewer decisions from `in_review` or
   `blocked`, then map them to durable state: `approve -> done`,
   `request_changes -> in_progress`, `blocked -> blocked`, and
   `needs_followup -> keep current review/blocker state` with a required
   comment.
5. Record `issue.review_decision_recorded` activity with the run id.
6. Wake the reviewer when a reviewed issue enters `blocked`.
7. Add runtime reconciliation for reviewer issue runs that finish in
   `in_review` or `blocked` without a recorded review decision.
8. Queue a bounded reviewer closeout wakeup; after max attempts, log
   `issue.review_closure_needs_operator_review`.
9. Update bundled `rudder` skill and generated CLI reference.
10. Run focused tests, then broader validation if the dirty checkout allows it.

## Design Notes

Reviewer closeout must not depend on interpreting prose. A comment that says
"reject" is evidence for humans, but it is not a durable control-plane outcome.
The structured decision is the source of truth for whether the reviewer has
closed the review run.

The reviewer closeout watchdog should be issue-scoped and bounded. It should
ask the reviewer to record a missing decision, not rerun the original review
from scratch. If the reviewer still fails to record a decision, Rudder escalates
to operator attention rather than leaving the issue silently in `in_review` or
`blocked`.

`blocked` is not automatically a terminal parked state for reviewed issues. It
can mean "the assignee cannot proceed and needs reviewer judgment." The reviewer
should not take over implementation by default; they should record whether the
blocker is confirmed, whether the assignee must make changes, whether more
information is needed, or whether the work is acceptable.

The inbox change is intentionally additive. Existing clients that ignore
`relationship` still receive the same core issue fields. New agents can use
`relationship` to avoid confusing reviewer work with implementation ownership.

## Success Criteria

- A timer heartbeat that calls `rudder agent inbox --json` can see reviewer
  `in_review` and reviewed `blocked` work.
- Review decision commands write both a required comment and a structured
  decision activity.
- `request_changes` moves the issue to `in_progress` and wakes the assignee.
- `approve` moves the issue to `done`.
- `needs_followup` leaves the issue in its current review/blocker state but
  counts as a structured reviewer outcome.
- A reviewer issue run that exits without a decision is requeued for reviewer
  closeout while the issue is `in_review` or `blocked`.
- Bounded reviewer closeout exhaustion emits operator-review activity.

## Validation

Completed on 2026-05-07:

- `pnpm exec vitest run server/src/__tests__/agent-inbox-reviewer.test.ts server/src/__tests__/issue-lifecycle-routes.test.ts server/src/__tests__/heartbeat-passive-issue-closeout.test.ts cli/src/__tests__/agent-v1-registry.test.ts`
- `pnpm exec vitest run server/src/__tests__/heartbeat-run-concurrency.test.ts server/src/__tests__/cli-auth-routes.test.ts`
- `git diff --check`
- `pnpm -r typecheck`
- `pnpm build`

Also attempted on 2026-05-07:

- `pnpm test:run` ran 1484 passing tests and then failed in unrelated
  `heartbeat-run-concurrency` and `cli-auth-routes` checks. The exact failed
  files were rerun directly and passed.

## Open Issues

- This implementation does not infer stale review decisions from old comments.
  Existing stuck issues need either manual cleanup or a one-off migration script
  after the new command is available.
- Human reviewer closeout recovery remains attention-surface based; this plan
  only adds agent reviewer runtime recovery.
