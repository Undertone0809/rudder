---
title: Goal Center lifecycle and work anchoring
date: 2026-04-30
kind: implementation
status: completed
area: ui
entities:
  - goals
  - goal_lifecycle
  - issue_goal_linking
issue:
related_plans:
  - 2026-04-10-issue-board-and-org-goals-polish.md
  - 2026-04-27-rudder-onboarding-issue-system-proposal-v1.md
supersedes: []
related_code:
  - server/src/services/goals.ts
  - server/src/__tests__/goal-service.test.ts
  - server/src/routes/goals.ts
  - ui/src/pages/GoalDetail.tsx
  - ui/src/components/GoalProperties.tsx
  - ui/src/components/IssueProperties.tsx
commit_refs:
  - 00d248c
updated_at: 2026-04-30
---

# Goal Center Lifecycle And Work Anchoring

## Summary

Upgrade Goals from a static tree into Rudder's why control surface. Operators
should see what work a goal anchors, assign responsibility, correct hierarchy,
cancel goals that have history, and hard-delete only unused goals.

## Implementation Plan

1. Add a dependency summary for goals and reuse it for delete preflight and
   blocked delete responses.
2. Harden goal create/update/delete rules for same-organization owner and
   parent references, no cycles, and last root organization goal protection.
3. Rework goal detail into an operating view with summary counts, Work,
   Sub-goals, and Activity tabs.
4. Add owner and parent pickers to goal properties.
5. Add a goal picker to issue properties so existing work can be linked or
   unlinked retroactively.

## Product Decisions

- Use existing `cancelled` status as the non-destructive exit state.
- Do not add goal archive fields or statuses in this pass.
- Treat hard delete as a cleanup action for mistaken, unused goals.
- Keep project multi-goal linking behavior unchanged.

## Validation

- Server coverage for safe delete, blocked delete, root protection, parent
  validation, and owner validation.
- UI coverage for issue goal linking and goal detail lifecycle behavior.
- Run `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` before hand-off.

## Completion Notes

- Added dependency-aware hard delete with structured blocked-delete details.
- Added owner and parent correction controls with server-side same-org and cycle guards.
- Added the goal operating view with Work, Sub-goals, and Activity tabs.
- Added issue-side goal linking and unlinking.
- Verified with focused goal tests, full typecheck, full test run, full build, and browser preview screenshots.
