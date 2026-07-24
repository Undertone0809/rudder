---
title: Execution Domain
domain: execution
status: active
coverage: seed
contract_ids: []
related_code:
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/runtime-kernel/heartbeat.release.ts
related_tests:
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - server/src/__tests__/heartbeat-process-recovery.test.ts
edit_policy: user_confirmed_only
---

# Execution Domain

## Owns

- Wakeup admission and coalescing.
- Timer preflight and execution-safety preflight gates.
- Heartbeat run records and execution lifecycle.
- Runtime invocation and adapter results.
- Run logs, transcripts, usage, sessions, and finalization.
- Issue execution locks and deferred wake promotion.
- Desktop Local App definition review, safe local process execution,
  attestation, lifecycle, and exact live-guest continuity.

## Does Not Own

- Issue status rules. See `ISSUE.STATE.001`.
- Who should be assigned or reviewed. See `ROUTING.*`.
- Stable instruction authorship. See `AGENT.INSTRUCTIONS.001`.
- Messenger Saved View placement and Main Workbench binding. See
  `MESSENGER.SAVED.VIEWS.001`.

## Contract Index

- `RUN.WAKEUP.001`: wakeup queueing, skips, defers, and coalescing.
- `RUN.PREFLIGHT.001`: timer heartbeats launch only when preflight finds
  recoverable or visible actionable work, unless preflight is explicitly
  disabled.
- `RUN.WORKSPACE.PREFLIGHT.001`: managed workspace paths are created and
  writability-checked before adapter execution.
- `RUN.EXECUTION.001`: heartbeat execution invokes the configured adapter and
  records the result.
- `RUN.ADMISSION.001`: issue-backed runs serialize on issue execution lock and
  release/promote correctly.
- `RUN.RESULT.001`: transcripts, usage, logs, sessions, and result metadata are
  persisted for inspection.
- `DESKTOP.LOCAL.APPS.001`: Desktop runs only explicitly reviewed local
  development services, keeps executable authority installation-local, and
  preserves exact runtime identity across Side-to-Main transfer.
