---
title: Issue Active Run Steer
date: 2026-08-11
kind: implementation
status: validation
area: agent_runtimes
entities:
  - issue_comment
  - agent_run
  - runtime_control
issue:
related_plans:
  - 2026-07-15-chat-steer-and-immediate-stop.md
supersedes: []
related_code:
  - server/src/routes/issues.comments-attachments.ts
  - server/src/services/runtime-kernel/heartbeat.core.ts
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - ui/src/components/CommentThread.tsx
  - ui/src/pages/IssueDetail.tsx
commit_refs: []
updated_at: 2026-08-11
---

# Issue Active Run Steer

## Summary

Add an explicit Steer action to the Issue comment composer while an Issue Run
is active. The first implementation uses the runtime-neutral
interrupt-and-continue path: persist feedback, durably admit one continuation,
then interrupt the exact run the operator observed.

## Problem

Issue comments can already wake an Agent and the comment API retains a legacy
`interrupt` option, but the user-visible Issue workflow exposes neither as a
truthful Steer action. A normal comment during an active run queues later work
without redirecting the current execution, while an unfenced interrupt could
target a run that changed after the UI rendered.

## Scope

- Show Steer only when Issue Detail observes a running Issue Run.
- Fence Steer to the observed run id.
- Persist the feedback and admit its continuation before interrupting the old
  run.
- Preserve ordinary comments, directed mention wakes, and the legacy interrupt
  request shape.
- Cover the public Issue workflow and stale-run rejection.
- Keep `doc/product/**` unchanged until the operator explicitly approves the
  Product Logic Registry delta.

Native same-turn steering for Issue Runs is out of scope because current Issue
runtimes execute through non-interactive adapter attempts. A future runtime may
use the shared control-handle capability without changing the visible action.

## Implementation Plan

1. Add a fenced Steer payload to the shared issue-comment validator and API.
2. Extend the comment composer with an active-run-only Steer command.
3. Persist Steer feedback and enqueue one `issue_comment_steer` continuation.
4. Interrupt only the expected running Issue Run after continuation admission.
5. Add unit, route, and real-browser E2E coverage.
6. Run independent review and exact-candidate black-box acceptance.

## Design Notes

Steer is a command, not a special mention. It targets the Agent that owns the
observed active Issue Run even when the comment contains no Agent mention.
`expectedRunId` prevents delayed clicks from cancelling a newer execution.

The ordering is intentional: comment evidence and continuation admission must
exist before the old process is interrupted. This avoids losing the operator's
feedback across process exit and issue-execution-lock release.

## Success Criteria

- Active Issue Run shows a Steer action next to Comment.
- Steer without an Agent mention is accepted and remains visible as a comment.
- The observed run becomes cancelled and exactly one continuation carries the
  Steer comment context.
- A stale observed run returns conflict without persisting or retargeting.
- Ordinary Comment behavior remains unchanged.

## Validation

- Shared schema, UI component, route, and runtime concurrency tests pass. The
  runtime suite covers durable admission receipts, disabled on-demand wakeups,
  admission failure, relationship/run drift, and legacy interrupt behavior.
- Browser E2E passes with a real process runtime, PostgreSQL, API, and Issue
  Detail UI. It observes persisted feedback, cancellation of the fenced run,
  and exactly one active continuation carrying `issue_comment_steer` context.
- Repository lint, recursive typecheck, and build pass. Full `test:run` and
  `product-logic:check` remain red on unrelated shared-worktree migration and
  `ANALYTICS.TELEMETRY.001` changes; targeted task coverage is green.
- Independent verifier and final review remain required for the frozen
  candidate.

## Open Issues

- Product Logic Registry alignment is pending explicit user authorization for
  `ISSUE.COMMENTS.001`, `RUN.WAKEUP.001`, and `RUN.ADMISSION.001`.
