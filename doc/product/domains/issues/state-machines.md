---
title: Issue State Machines
domain: issues
status: active
coverage: seed
contract_ids:
  - ISSUE.STATE.001
related_code:
  - server/src/services/issues.helpers.ts
  - server/src/services/issues.ts
  - server/src/routes/issues.mutations.ts
  - cli/src/commands/worktree-merge-history-lib.ts
related_tests:
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - server/src/__tests__/issues-service.test.ts
  - cli/src/__tests__/worktree-merge-history.test.ts
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - tests/e2e/issue-detail-done-project-edit.spec.ts
related_plans:
  - doc/plans/2026-07-24-status-independent-explicit-issue-work.md
edit_policy: user_confirmed_only
---

# Issue State Machines

## ISSUE.STATE.001

Behavior:

- Issue status is the durable work-state signal for the board and agents.
- Reviewable states are `in_review` and `blocked`.
- Reviewer decisions require a comment and are allowed only while the issue is
  `in_review` or `blocked`.
- When an assignee agent tries to complete an issue that has a reviewer, Rudder
  normalizes the status to `in_review` unless the acting agent is the reviewer
  recording an accepted decision.
- When an assignee completes an issue without a reviewer, Rudder keeps the
  status `done` so the issue can close out without an artificial review gate.
- Closed issues can be reopened by a comment with explicit reopen intent.
- Status is a durable lifecycle and routing signal, not a permission gate for
  an explicit request directed to the current assignee or reviewer.
- Relationship-authorized explicit work preserves the current status unless
  the request or a separate governed workflow explicitly changes it.

Invariant:

- An agent cannot silently bypass reviewer ownership by marking a reviewed issue
  `done`.
- An issue in `in_review` must have a reviewer agent or user; a direct status
  request without one is rejected.
- Clearing the last reviewer from an issue in `in_review` or `blocked` is
  rejected unless the same transition changes the status to `done`, `todo`, or
  `in_progress`.
- Review decisions are structured outcomes, not only free-form comments.
- Status changes that materially affect the issue must leave activity evidence.
- Explicit work on `in_review`, `done`, or `cancelled` must not silently move
  the issue to `in_progress`.

Rationale:

- Issue state is the operator-facing contract for where work is in the Rudder
  loop. Reviewer gates must remain visible and durable.

Related code:

- `server/src/routes/issues.mutations.ts`
- `server/src/services/issues.helpers.ts`
- `server/src/services/issues.ts`

Related tests:

- `server/src/__tests__/issue-lifecycle-routes.test.ts`
- `tests/e2e/issue-detail-done-project-edit.spec.ts`
