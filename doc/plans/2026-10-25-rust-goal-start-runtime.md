---
title: Rust Goal Start Core and Runtime Handoff
date: 2026-10-25
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - goals
  - goal_start_request
  - agent_wakeup
issue:
related_plans:
  - 2026-08-04-goal-system-refactor.md
supersedes: []
related_code:
  - native/crates/d1-persistence/src/goal_writes.rs
  - native/crates/d1-persistence/src/goal_reads.rs
  - server/src/services/goals.ts
  - server/src/routes/goals.ts
commit_refs: []
updated_at: 2026-10-25
---

# Rust Goal Start Core and Runtime Handoff

## Scope

Port the existing Goal Start preview compiler and transactional start operation
into Rust persistence. Preserve the current packet, hash, capability warning and
confirmation, draft reuse, Goal activation, owner assignment, initial Plan and
Activity, audit, and request replay behavior. Persist the existing durable
Goal-owner wakeup intent in the same transaction. Reuse existing Goal tables and
transaction helpers; add no schema or queue framework without evidence that an
existing field cannot represent the contract.

The Rust core remains internal until the generic GoalRun queue owner and
dispatch contract are agreed. It must not call or fall back to Node heartbeat.
Public `/goals/start-preview` and `/goals/start` routing, Node handler removal,
and public acceptance are a later cutover owned with the Rust GoalRun runtime.

## Current Delivery Boundary

The composed candidate adds the native `goal_started` owner, Claude execution
context, durable cleanup-receipt recovery, and idempotent cost/budget settlement.
Migration `0184` extends the existing wakeup/run ownership fields and journal;
it does not create a separate migration history. Public Goal Start still uses
the legacy dispatcher and does not enqueue native-owned work yet.

`POST /api/agent-runs/:id/cancel` handles positively identified native Goal Runs
through Rust identity, organization/visibility checks, cancellation intent and
audit. Cancellation leaves ownership and running state intact until the matching
process owner proves cleanup. Legacy or ambiguous references keep their existing
route, and `/api/heartbeat-runs/:id/cancel` remains migration debt. A passing
cancellation-intent test is not evidence of provider cleanup or public Start.

Budget hard stops and manual Agent/organization pause are observed by the
native owner. During migration, Rust budget settlement requests cancellation
from legacy owners through their existing marker and cleanup paths; already
running legacy work may wait for its existing 60-second renewal poll. Those
legacy lifecycle responsibilities are not counted as retired.

Before enabling public native Start, qualify the complete Start/run/stop flow,
full-server crash/restart recovery, and Desktop Quit dispatch for native Goal
Runs. The present Desktop native-Chat stop path is not a Goal Run stop path.

## Boundaries

- Keep the legacy TypeScript compiler and tests as read-only parity oracles; do
  not add or extend Node business behavior.
- Do not add Goal stop or reopen endpoints. Current close behavior is terminal
  evaluation; generic run cancellation is a separate runtime lifecycle.
- Keep queue claiming, run creation/execution, and cancellation with the agreed
  Rust GoalRun owner; this core only persists the current Goal wakeup intent.

## Verification

- Compare Rust preview output and canonical packet hashes against golden cases
  derived from the current compiler, including blockers, capability warnings,
  objective modes, deadline, and Unicode input.
- Exercise PostgreSQL success, rollback, same-key replay, changed-payload
  conflict, concurrent replay, reusable draft, owner invokability, and
  organization-boundary cases.
- Before any public cutover, require the agreed Rust GoalRun handoff, real public
  entry coverage for preview/start and run creation, and proof that Rust failure
  cannot invoke Node start or heartbeat business handlers.
