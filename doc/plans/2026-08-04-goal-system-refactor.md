---
title: Rudder Goal system refactor
date: 2026-08-04
kind: implementation
status: in_progress
area: data_model
entities:
  - goals
  - goal_contract
  - goal_activity
  - agent_owner_assignment
issue:
related_plans: []
supersedes:
  - 2026-04-30-goal-center-lifecycle.md
related_code:
  - packages/db/src/schema/goals.ts
  - packages/shared/src/validators/goal.ts
  - server/src/services/goals.ts
  - server/src/routes/goals.ts
  - ui/src/pages/Goals.tsx
  - ui/src/pages/GoalDetail.tsx
  - tests/e2e/goal-detail-lifecycle.spec.ts
commit_refs: []
updated_at: 2026-08-04
---

# Rudder Goal System Refactor

## Summary

Replace the legacy Goal hierarchy and direct CRUD lifecycle with a Goal
contract: one accountable Agent Owner, a stable Contract, a mutable Plan,
append-only Activity, and evidence-backed terminal evaluation.

## Current Slice

- Add canonical contract, lifecycle, evaluation, and focus fields while
  retaining legacy columns for compatibility reads.
- Add Owner Assignment, Plan, and Activity persistence with organization
  boundaries and idempotency indexes.
- Add activation, Plan revision, Activity, Owner reassignment, Focus, and
  evaluator commands. Direct lifecycle/status writes are rejected.
- Remove default-root Goal inheritance from new Issue creation.
- Replace the old Goals tree/detail controls with Contract, Plan, Activity, and
  Proof-oriented surfaces.

## Non-goals

- No P0 sub-goal object or parent/child scheduler.
- No arbitrary predicate DSL or cross-Goal optimizer.
- No deletion of historical Goal evidence.

## Acceptance

- A new Goal starts as Draft and retains no implicit Owner or hierarchy.
- Activation requires a complete Contract, explicit confirmation, one Agent
  Owner in the same organization, an initial Plan, and continuation coverage.
- Users and Agents cannot mark a Goal achieved, maintained, decided, or
  completed by patching a status field.
- Activity is append-only and idempotent; terminal Runs can have one closeout
  Activity per Goal/Run pair.
- Focus is organization-scoped and has at most one active Goal.
- Target, Maximize, Maintain, and Decide evaluation modes reduce to their
  declared terminal result sets, including inconclusive outcomes.
- Runtime E2E evidence covers activation, denial cases, persistence,
  organization boundaries, restart continuity, and no duplicate effects.

## Product Logic Alignment

Affected contract: `ORG.GOAL.001`. The implementation changes the current
hierarchy/status CRUD behavior into the canonical Goal contract described above.
The user explicitly authorized the semantic update on 2026-08-04. The guarded
registry now records the canonical Goal Contract, while legacy hierarchy fields
remain documented as compatibility-only reads and dependency references.
