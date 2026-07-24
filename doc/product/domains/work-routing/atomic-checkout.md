---
title: Atomic Checkout
domain: work-routing
status: active
coverage: seed
contract_ids:
  - ROUTING.CHECKOUT.001
related_code:
  - server/src/routes/issues.ts
  - server/src/routes/issues.mutations.ts
  - server/src/routes/issues-checkout-wakeup.ts
  - server/src/services/issues.ts
related_tests:
  - server/src/__tests__/issues-checkout-wakeup.test.ts
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - tests/e2e/agent-detail-issues-tab.spec.ts
related_plans:
  - doc/plans/2026-07-24-status-independent-explicit-issue-work.md
edit_policy: user_confirmed_only
---

# Atomic Checkout

## ROUTING.CHECKOUT.001

Behavior:

- Issue checkout is a governed route that sets active ownership for agent work.
- An agent actor can checkout only as itself.
- Agent checkout requires a run id so later mutations can prove run ownership.
- Checkout records `issue.checked_out` activity.
- Board/user checkout or another actor's checkout wakes the assignee.
- A running agent checking out work for itself from the same run does not get a
  redundant wake.
- Checkout is the ownership-plus-`in_progress` transition for checkout-eligible
  assignment work. It is not the admission mechanism for an explicit comment
  request directed to the issue's current assignee or reviewer.
- A relationship-authorized explicit mention uses the issue execution lease
  without checking out, changing assignment, or changing status.

Invariant:

- Active `in_progress` assignee work must prove current-run ownership through
  checkout. Outside that active-checkout case, the current assignee/reviewer
  relationship authorizes explicit protected issue work without making
  lifecycle status a permission gate.
- The execution lease serializes relationship-authorized explicit wakes; it is
  not a second mutation permission check once the actor is still the current
  assignee or reviewer. Collaborator mention runs remain limited to their
  narrow comment response and cannot mutate protected issue fields.
- Protected writes atomically revalidate the current relationship; an
  `in_progress` assignee write also revalidates the checkout run. A concurrent
  reassignment or lifecycle change cannot leave a stale authorization window.
- Checkout must not create an unnecessary duplicate run for the same agent/run.
- Issue status alone must not revoke explicit work authority from the current
  assignee or reviewer.
- Relationship is revalidated while holding the issue row lock that grants the
  execution lease so concurrent reassignment cannot authorize a stale owner.

Rationale:

- Checkout is Rudder's atomic handoff from durable issue to active assignee
  work. Separating it from explicit-work admission prevents a `done`,
  `in_review`, or `cancelled` issue from being silently reopened merely because
  its current assignee or reviewer was asked to act.

Related code:

- `server/src/routes/issues.mutations.ts`
- `server/src/routes/issues-checkout-wakeup.ts`
- `server/src/services/issues.ts`

Related tests:

- `server/src/__tests__/issues-checkout-wakeup.test.ts`
- `tests/e2e/agent-detail-issues-tab.spec.ts`
