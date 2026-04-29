---
title: Heartbeat runtime kernel refactor
date: 2026-04-30
kind: implementation
status: completed
area: agent_runtimes
entities:
  - heartbeat_runs
  - agent_runtime_control
  - runtime_kernel
issue:
related_plans:
  - 2026-04-27-agent-run-concurrency.md
supersedes: []
related_code:
  - server/src/services/heartbeat.ts
  - server/src/services/runtime-kernel/orchestrator.ts
  - server/src/services/runtime-kernel/heartbeat.ts
commit_refs:
  - refactor: split heartbeat runtime kernel
updated_at: 2026-04-30
---

# Heartbeat Runtime Kernel Refactor

## Summary

Decompose the oversized heartbeat runtime kernel behind the stable
`server/src/services/heartbeat.ts` facade. Public routes, database schema,
shared types, adapter contracts, and user-visible behavior remain unchanged.

## Implementation Plan

1. Keep `heartbeatService` and `heartbeatOrchestrator` available from the
   existing service facade.
2. Move the service factory into `runtime-kernel/orchestrator.ts` and keep
   `runtime-kernel/heartbeat.ts` as a compatibility shim while consumers move
   to the facade.
3. Extract pure helper surfaces into focused runtime-kernel modules before
   moving stateful queue, execution, recovery, session, and analytics logic.
4. Update direct non-kernel imports to use `server/src/services/heartbeat.ts`.
5. Add internal types for the kernel dependency context and orchestrator return
   surface.

## Compatibility

- No schema or migration changes.
- No HTTP route or payload changes.
- No runtime adapter wire-contract changes.
- Existing helper exports used by tests remain available from
  `server/src/services/heartbeat.ts`.

## Validation

- `pnpm vitest run server/src/__tests__/service-facades.test.ts`
- `pnpm vitest run server/src/__tests__/heartbeat-run-concurrency.test.ts server/src/__tests__/heartbeat-process-recovery.test.ts server/src/__tests__/heartbeat-passive-issue-closeout.test.ts server/src/__tests__/heartbeat-paused-wakeups.test.ts server/src/__tests__/heartbeat-workspace-session.test.ts server/src/__tests__/heartbeat-run-retry-routes.test.ts`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## Result

Implemented on 2026-04-30. The focused heartbeat suites, full typecheck, and
full build passed. Full `pnpm test:run` was rerun after an initial transient
auth failure; all tests passed on the second run except the existing
`company-import-export-e2e.test.ts` suite cleanup step, where the suite's tests
passed but temp directory removal reported `ENOTEMPTY`. The same E2E file
passed when rerun directly.
