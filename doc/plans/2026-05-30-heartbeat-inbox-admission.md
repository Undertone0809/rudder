---
title: Heartbeat inbox admission alignment
date: 2026-05-30
kind: fix-plan
status: completed
area: agent_runtimes
entities:
  - heartbeat_scheduler
  - agent_inbox
  - automation_execution
issue:
related_plans: []
supersedes: []
related_code:
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
  - server/src/routes/agents.ts
  - server/src/services/issues.ts
commit_refs: []
updated_at: 2026-05-30
---

# Heartbeat Inbox Admission Alignment

## Problem

Timer heartbeats can launch a local agent runtime even when the agent-visible
inbox is empty. In the Z Studio `prod_local` instance, Mira produced repeated
hourly no-op runs: each run had no `issueId`, `rudder agent inbox --json`
returned empty, and the agent exited without work.

The root cause is a predicate mismatch:

- timer preflight directly queries `issues` for assigned
  `todo`, `in_progress`, or `blocked` rows;
- `rudder agent inbox` goes through `issueService.list`, which hides
  `originKind = automation_execution` rows unless explicitly requested.

That means stale automation execution issues can make the scheduler believe
work exists while the agent cannot see or act on that work.

## Decision

Treat agent-visible inbox semantics as the admission contract for timer
heartbeats.

Timer preflight should only launch a no-context heartbeat when the same work
would appear in `/api/agents/me/inbox-lite`:

- assignee work: `todo`, `in_progress`, `blocked`;
- reviewer work: `in_review`, `blocked`, excluding confirmed blocked reviewer
  handoffs;
- default issue list visibility rules, including hidden rows and automation
  execution exclusion.

Explicit assignment, review, on-demand, and automation wakeups remain separate:
they may carry an `issueId` or wake context and are not blocked by the
no-context timer preflight rule.

## Acceptance Criteria

- A timer heartbeat with no visible inbox work records a skipped wakeup and
  does not create a `heartbeat_runs` row.
- A timer heartbeat with only stale hidden/default-excluded automation execution
  rows is skipped before runtime launch.
- A timer heartbeat with visible assigned work still launches.
- `rudder agent inbox` and timer admission no longer disagree on the existence
  of actionable work for no-context timer runs.

## Verification

- Add a focused regression in `heartbeat-run-concurrency.test.ts` covering
  automation execution rows excluded by inbox semantics.
- Run the focused heartbeat test file.
- Run relevant typecheck if practical in the current worktree.

## Result

Implemented on 2026-05-30 by routing timer preflight admission through the same
issue-list visibility rules used by the agent inbox. This prevents no-context
timer heartbeats from launching only because hidden/default-excluded automation
execution issues still exist.

Validation:

- `pnpm test:run server/src/__tests__/heartbeat-run-concurrency.test.ts`
  - covers visible assignee work
  - covers visible reviewer work
  - covers inbox-hidden automation execution work for assignee and reviewer
  - covers confirmed blocked reviewer handoff exclusion
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:run` was attempted. The heartbeat concurrency suite passed in the
  full run, but the full run failed on unrelated embedded-Postgres/runtime
  service concurrency timeouts. The failed files passed when rerun directly:
  - `pnpm test:run server/src/__tests__/workspace-runtime.test.ts`
  - `pnpm test:run server/src/__tests__/orgs-service.test.ts`
  - `pnpm test:run server/src/__tests__/heartbeat-process-recovery.test.ts`
