---
title: Run Admission And Recovery
domain: execution
status: active
coverage: seed
contract_ids:
  - RUN.ADMISSION.001
related_code:
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.release.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
related_tests:
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - server/src/__tests__/heartbeat-passive-issue-closeout.test.ts
  - tests/e2e/issue-passive-followup.spec.ts
related_plans:
  - doc/plans/2026-07-24-status-independent-explicit-issue-work.md
edit_policy: user_confirmed_only
---

# Run Admission And Recovery

## RUN.ADMISSION.001

Behavior:

- Issue-backed wakes serialize through the issue execution lock.
- Explicit comment mentions of the issue's current assignee or reviewer
  serialize through that same execution lock in every issue status, without
  checkout or an automatic lifecycle transition.
- The target relationship is derived again under the issue row lock used to
  grant the execution lease; a concurrent reassignment cannot leave the stale
  target authorized as assignee or reviewer.
- Mentioned agents who are neither current assignee nor current reviewer keep
  the narrow collaboration path and do not acquire issue execution ownership.
- If an issue has no active queued/running execution, wakeup creates a queued
  heartbeat run and stores it on `issues.executionRunId`.
- If the same execution agent already has an active run for the issue, the new
  context coalesces into that run unless it is a same-scope comment follow-up
  that should queue.
- If another active issue run exists, the wake is stored as
  `deferred_issue_execution` and promoted after the active run releases.
- `releaseIssueExecutionAndPromote` clears the issue execution lock after a
  terminal run unless passive close-out queues a follow-up first.
- Deferred issue wakeups are promoted in request order when the current run
  releases and the target agent is still invokable.
- Passive issue close-out may queue same-agent follow-up when the run ends
  without sufficient issue closure signal and timer continuity is not credible.

Invariant:

- No two active issue-backed execution runs should own the same issue execution
  lock.
- Explicit relationship work must preserve issue status and assignment unless
  the request or a separate governed workflow explicitly changes them.
- Deferred wakeups must not be lost when a run finishes.
- Passive follow-up is bounded and auditable.

Rationale:

- Issue work must be serialized enough for operators to trust the visible
  next-action state, while still preserving later wakeups instead of dropping
  them.

Related code:

- `server/src/services/runtime-kernel/heartbeat.wakeup.ts`
- `server/src/services/runtime-kernel/heartbeat.release.ts`
- `server/src/services/runtime-kernel/heartbeat.recovery.ts`

Related tests:

- `server/src/__tests__/heartbeat-passive-issue-closeout.test.ts`
- `tests/e2e/issue-passive-followup.spec.ts`
