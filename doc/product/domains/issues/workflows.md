---
title: Issue Local Workflows
domain: issues
status: active
coverage: seed
contract_ids:
  - ISSUE.WORKFLOW.001
related_code:
  - server/src/routes/issues.mutations.ts
  - server/src/services/issues.ts
related_tests:
  - server/src/__tests__/issue-comment-reopen-routes.test.ts
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - tests/e2e/issue-detail-toolbar-actions.spec.ts
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
- Issue title regeneration follows the content-only update path defined by
  `ISSUE.TITLE.GENERATION.001`; it does not invent a material workflow event.
- Adding a comment records `issue.comment_added` activity and may wake mentioned
  agents through routing contracts.
- Review decisions record `issue.review_decision_recorded`. If a reviewer needs
  human input, that request belongs in the review comment rather than a separate
  workflow event.
- Agent-authenticated issue mutations must respect the current run checkout
  ownership checks before changing protected work.

Invariant:

- Issue mutation routes must not hide material workflow changes as silent state
  updates.
- A comment can be both comment evidence and reopen evidence, but comment thread
  semantics remain owned by collaboration.

Rationale:

- Rudder's work loop depends on issue mutations leaving enough context for
  operators, reviewers, and future agents to understand what changed.

Related code:

- `server/src/routes/issues.mutations.ts`
- `server/src/services/issues.ts`

Related tests:

- `server/src/__tests__/issue-comment-reopen-routes.test.ts`
- `server/src/__tests__/issue-lifecycle-routes.test.ts`
- `tests/e2e/issue-detail-toolbar-actions.spec.ts`
