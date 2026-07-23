---
title: Status-independent explicit issue work
date: 2026-07-24
kind: implementation
status: completed
area: agent_runtimes
entities:
  - issue_execution
  - issue_checkout
  - issue_reviewer
related_plans:
  - 2026-05-02-issue-add-reviewer-proposal.md
  - 2026-05-07-reviewer-queue-closeout-recovery.md
  - 2026-07-18-rudder-docs-skill-proposal.md
related_code:
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - server/src/routes/issues.comments-attachments.ts
  - server/src/services/issues.comments-attachments.ts
  - server/src/services/runtime-kernel/heartbeat.core.ts
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
updated_at: 2026-07-24
---

# Status-independent explicit issue work

## Goal

Allow an issue's current assignee agent or reviewer agent to carry out an
explicit user-requested comment mention in any lifecycle state, including
`in_review`, `done`, and `cancelled`, without forcing issue checkout or silently
moving the issue back to `in_progress`.

Issue status remains a routing and lifecycle signal. The current assignee or
reviewer relationship supplies explicit-work authority, while the issue
execution lease continues to serialize issue-scoped runs.

## Product Logic Delta

This implementation updates:

- `ROUTING.CHECKOUT.001`: checkout remains the atomic ownership-plus-transition
  operation for checkout-eligible assignment work. A relationship-authorized
  explicit mention uses the existing issue execution lease instead of checkout.
- `RUN.WAKEUP.001` and `RUN.ADMISSION.001`: explicit mention wakes for the
  current assignee or reviewer acquire the issue execution lease without
  changing status. Mentioned collaborators who own neither relationship keep
  the existing narrow collaboration path.
- `ROUTING.ATTENTION.001`: mention context records the target agent's
  relationship to the issue so authorization and prompt selection are
  deterministic.
- `AGENT.INSTRUCTIONS.001`: assignment/follow-up scenes keep the checkout rail;
  relationship-authorized explicit mentions receive a no-checkout,
  preserve-status execution rail.
- `ISSUE.STATE.001` and `ISSUE.WORKFLOW.001`: issue state does not independently
  revoke explicit work authority from the current assignee or reviewer, and
  explicit work does not imply a lifecycle transition.
- `REVIEW.DECISION.001`: formal review routing still requires a structured
  reviewer decision in reviewable states, while an ordinary explicit mention
  of the reviewer is not automatically converted into a formal review run.

Automatic timer pickup, inbox selection, review routing, passive closeout, and
non-explicit stale queued-run cancellation remain status-sensitive. A direct
user mention of the current assignee or reviewer remains executable even when
the issue is `cancelled`; the run must preserve that status unless the user
explicitly asks for a lifecycle change.

## Implementation

1. Add RED tests for assignee and reviewer mention context, prompt selection,
   execution serialization, and preservation of `in_review` / `done`.
2. Attach `relationship: assignee | reviewer | collaborator` to each comment
   mention wake.
3. Let current-assignee and current-reviewer mention wakes use the issue
   execution lock; preserve the bypass only for narrow collaborator mentions.
4. Add an explicit relationship-work prompt rail that forbids checkout and
   implicit status changes. Keep formal reviewer routing distinct from an
   ordinary reviewer mention.
5. Add API/browser E2E coverage for the real comment workflow in `in_review`
   and `done`.
6. Synchronize guarded Product Logic Registry contracts and registry metadata.

## Safety Invariants

- Organization boundaries and authenticated agent identity remain enforced.
- A mention never changes assignee or reviewer.
- Only the issue's current assignee or reviewer receives relationship work
  authority.
- An existing active issue execution lease defers/coalesces later
  relationship-authorized work rather than allowing concurrent mutation.
- Review acceptance and assignee completion gates remain unchanged.
- Paused agents, budget stops, project access, and runtime concurrency limits
  remain unchanged.

## Verification

- Focused prompt, mention-route, lifecycle, and concurrency tests
- Relevant Playwright E2E against a real local server
- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- Independent adversarial code review
- Independent black-box verifier in a real local environment
