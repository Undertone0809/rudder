---
title: Run Admission And Recovery
domain: execution
status: active
coverage: seed
contract_ids:
  - RUN.ADMISSION.001
related_code:
  - server/src/services/entity-run-cleanup.ts
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.release.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
related_tests:
  - server/src/__tests__/chat-agent-runs.test.ts
  - server/src/__tests__/heartbeat-passive-issue-closeout.test.ts
  - server/src/__tests__/heartbeat-paused-wakeups.test.ts
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - server/src/__tests__/issues-service.test.ts
  - tests/e2e/issue-passive-followup.spec.ts
edit_policy: user_confirmed_only
---

# Run Admission And Recovery

## RUN.ADMISSION.001

Behavior:

- Issue-backed wakes serialize through the issue execution lock.
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
- Archived Issue and Chat targets are ineligible for new wake/run admission.
  Admission locks the referenced entity and rechecks archive state before
  creating work, including when the reference appears only in payload/context.
- Permanent deletion locks wake/run admission data, rejects active work or
  pending terminal effects, and removes inactive entity-owned wake/run records
  under `CONTROL.ENTITY.RETENTION.001`.

Invariant:

- No two active issue-backed execution runs should own the same issue execution
  lock.
- Deferred wakeups must not be lost when a run finishes.
- Passive follow-up is bounded and auditable.
- No wake or run may be admitted after its target becomes archived, and archive
  or delete must not race a payload/context-only admission into orphaned work.

Rationale:

- Issue work must be serialized enough for operators to trust the visible
  next-action state, while still preserving later wakeups instead of dropping
  them.

Related code:

- `server/src/services/runtime-kernel/heartbeat.wakeup.ts`
- `server/src/services/runtime-kernel/heartbeat.release.ts`
- `server/src/services/runtime-kernel/heartbeat.recovery.ts`
- `server/src/services/entity-run-cleanup.ts`

Related tests:

- `server/src/__tests__/heartbeat-passive-issue-closeout.test.ts`
- `server/src/__tests__/heartbeat-paused-wakeups.test.ts`
- `server/src/__tests__/heartbeat-run-concurrency.test.ts`
- `server/src/__tests__/chat-agent-runs.test.ts`
- `server/src/__tests__/issues-service.test.ts`
- `tests/e2e/issue-passive-followup.spec.ts`
