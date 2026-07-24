---
title: Issue Local Workflows
domain: issues
status: active
coverage: seed
contract_ids:
  - ISSUE.WORKFLOW.001
related_code:
  - server/src/routes/issues.ts
  - server/src/routes/issues.mutations.ts
  - server/src/services/issues.ts
related_tests:
  - server/src/__tests__/issue-comment-reopen-routes.test.ts
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - tests/e2e/issue-detail-toolbar-actions.spec.ts
related_plans:
  - doc/plans/2026-07-24-status-independent-explicit-issue-work.md
edit_policy: user_confirmed_only
---

# Issue Local Workflows

This file owns issue-local workflows only. Cross-domain workflows such as
end-to-end issue intake to agent completion belong in `doc/product/workflows/`
and must cite contract IDs instead of reauthoring behavior.

## ISSUE.WORKFLOW.001

Behavior:

- Creating an issue records `issue.created` activity and may enqueue assignee
  and reviewer wakeups through routing contracts.
- Updating material issue fields records `issue.updated` activity.
- Updating only content fields publishes live update events without inventing a
  material activity entry.
- Adding a comment records `issue.comment_added` activity and may wake mentioned
  agents through routing contracts.
- Review decisions record `issue.review_decision_recorded`. If a reviewer needs
  human input, that request belongs in the review comment rather than a separate
  workflow event.
- Agent-authenticated issue mutations must respect active checkout ownership
  for an `in_progress` assignee. Outside that case, a current assignee or
  reviewer may perform explicit protected issue work regardless of lifecycle
  status.
- The relationship-authorized path requires the actor to remain the current
  assignee or reviewer at the atomic write boundary. Structured review
  decisions additionally revalidate reviewer identity and reviewable status at
  that boundary. Its execution lease serializes explicit wakes rather than
  serving as an additional mutation permission gate.
- A collaborator mention may add only its run-bound response comment. It may
  not reopen the issue or mutate protected issue fields. Commit reporting is
  evidence attribution rather than a protected issue-field mutation and keeps
  its existing run-binding rules.

Invariant:

- Issue mutation routes must not hide material workflow changes as silent state
  updates.
- A comment can be both comment evidence and reopen evidence, but comment thread
  semantics remain owned by collaboration.
- Explicit relationship work does not itself reopen, reassign, or transition an
  issue.

Rationale:

- Rudder's work loop depends on issue mutations leaving enough context for
  operators, reviewers, and future agents to understand what changed.

Related code:

- `server/src/routes/issues.mutations.ts`
- `server/src/services/issues.ts`

Related tests:

- `server/src/__tests__/issue-comment-reopen-routes.test.ts`
- `tests/e2e/issue-detail-toolbar-actions.spec.ts`
