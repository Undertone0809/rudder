---
title: Review Closeout And Learning
domain: review-feedback-learning
status: active
coverage: detailed
contract_ids:
  - REVIEW.DECISION.001
  - REVIEW.CLOSEOUT.001
  - LEARNING.PROMOTION.001
related_code:
  - server/src/routes/issues.mutations.ts
  - server/src/services/issue-review-wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
  - server/src/services/runtime-kernel/heartbeat.release.ts
related_tests:
  - tests/e2e/issues-reviewer-routing.spec.ts
  - server/src/__tests__/agent-inbox-reviewer.test.ts
  - server/src/__tests__/heartbeat-passive-issue-closeout.test.ts
  - tests/e2e/issue-passive-followup.spec.ts
edit_policy: user_confirmed_only
---

# Review Follow-Up And Learning

## REVIEW.DECISION.001

Why:

- Reviewer work is judgment work. It must not be confused with assignee
  implementation, and it must end with a structured decision that the next
  actor can trust.

Flow:

1. Issue enters reviewable state with reviewer.
2. Reviewer wake uses `ROUTING.REVIEWER.001`.
3. Reviewer inspects issue, output, run evidence, and comments.
4. Reviewer records structured decision with required comment.
5. Accepted work can complete; changes-requested routes back to assignee;
   blocked/human-needed states remain visible.

Invariants:

- Reviewer decisions require comment evidence.
- Assignee completion cannot silently bypass reviewer.
- Reviewer routing and reviewer decision are separate contracts.

Evidence:

- `tests/e2e/issues-reviewer-routing.spec.ts` verifies visible reviewer routing
  behavior.
- `server/src/__tests__/agent-inbox-reviewer.test.ts` verifies reviewer work is
  exposed through agent-facing inbox semantics.
- Known gap: richer multi-reviewer workflows should get separate contracts if
  they become implemented product behavior.

## REVIEW.CLOSEOUT.001

Why:

- A successful issue-backed run that leaves no close-out signal burns tokens
  without telling Rudder whether work moved forward. Bounded follow-up keeps
  the work loop inspectable.
- Reviewer work has a separate failure mode: if a reviewer-requested run does
  not record a structured review result and the issue remains `in_review`,
  Rudder needs review follow-up instead of treating the run as accepted,
  rejected, or assigned implementation work.

Flow:

1. Issue-backed run succeeds.
2. Release/recovery checks whether sufficient issue close-out evidence exists:
   status transition, comment, reviewer handoff, result reference, or other
   accepted signal.
3. For assignee issue work, if no sufficient close-out exists, Rudder may queue
   bounded same-agent issue follow-up unless timer continuity makes a retry
   unnecessary.
4. For reviewer work, if the reviewer run does not produce a structured review
   decision and the issue remains `in_review`, Rudder may queue bounded review
   follow-up for the reviewer.
5. After bounded attempts, Rudder escalates toward reviewer/operator visibility
   instead of infinite follow-up.

Invariants:

- Issue follow-up is bounded, auditable, and same-agent scoped.
- Review follow-up is reviewer-scoped and remains in the review scene.
- Free-form accept/reject text is not a durable review decision. Durable review
  result requires the structured review decision path under
  `REVIEW.DECISION.001`.
- Missing close-out is visible as a work-loop gap, not hidden as success.

Evidence:

- `server/src/__tests__/heartbeat-passive-issue-closeout.test.ts` verifies
  bounded passive close-out behavior.
- `tests/e2e/issue-passive-followup.spec.ts` verifies visible issue follow-up
  behavior.
- Known gap: close-out scoring should be revisited if additional artifact types
  become accepted close-out signals.

## LEARNING.PROMOTION.001

Why:

- Rudder's product promise is a self-improving agent team, but learning cannot
  be an invisible prompt rewrite. Feedback must have evidence, scope, approval,
  and rollback/eval path when it changes future behavior.

Product model:

- Feedback can target issue context, Library docs, skills, workflow docs,
  agent instructions, decisions, eval cases, or no-op.
- Promotion requires a human or policy-approved path appropriate to risk.
- Product Logic Registry updates are governed by `doc/product/GOVERNANCE.md`.

Flow:

1. Reviewer/operator leaves feedback on issue, run, output, or proposal.
2. Rudder preserves feedback with linked evidence.
3. A learning proposal identifies target artifact, reason, expected future
   behavior, tests/evals, and rollback.
4. Approved promotion updates the artifact and records activity.
5. Future runs consume the improved context through normal instruction, skill,
   Library, or workflow loading contracts.

Invariants:

- Feedback is not automatically promoted into durable agent behavior.
- A learning update must cite the evidence that justified it.

Evidence:

- `doc/product/GOVERNANCE.md` governs product-doc promotion and edit
  authorization.
- `scripts/product-logic-check.test.mjs` verifies registry mechanics but not
  learning-quality judgment.
- Known gap: `LEARNING.PROMOTION.001` currently documents the product path more
  than a fully implemented workflow; future implementation must add E2E and
  approval coverage before treating it as automated.
