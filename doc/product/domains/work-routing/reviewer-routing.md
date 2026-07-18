---
title: Reviewer Routing
domain: work-routing
status: active
coverage: seed
contract_ids:
  - ROUTING.REVIEWER.001
related_code:
  - server/src/routes/issues.mutations.ts
  - server/src/services/issue-review-wakeup.ts
  - server/resources/bundled-skills/rudder-docs/references/cli-reference.md
related_tests:
  - tests/e2e/issues-reviewer-routing.spec.ts
  - server/src/__tests__/agent-inbox-reviewer.test.ts
related_plans:
  - doc/plans/2026-07-18-rudder-docs-skill-proposal.md
edit_policy: user_confirmed_only
---

# Reviewer Routing

## ROUTING.REVIEWER.001

Behavior:

- Moving an issue to `in_review` or `blocked` with a reviewer agent queues a
  reviewer wake.
- Creating an issue directly in `in_review` with a reviewer agent queues a
  reviewer wake.
- Changing reviewer while an issue is already reviewable queues a reviewer
  wake.
- Reviewer wakes use source `review` and reason `issue_review_requested`.
- Reviewer wake context includes `role: "reviewer"` and instructions to record
  one structured reviewer decision.
- If the current actor is the reviewer agent, Rudder does not wake that same
  reviewer unless an assignee handoff to review is happening.

Invariant:

- Reviewer routing is not assignment routing.
- Reviewer work must close with a structured reviewer decision, not just a
  free-form comment.

Rationale:

- Review is a separate ownership state. Reusing assignment semantics would hide
  whether the agent is implementing or judging the work.

Related code:

- `server/src/routes/issues.mutations.ts`
- `server/src/services/issue-review-wakeup.ts`
- `server/resources/bundled-skills/rudder-docs/references/cli-reference.md`

Related tests:

- `tests/e2e/issues-reviewer-routing.spec.ts`
- `server/src/__tests__/agent-inbox-reviewer.test.ts`
