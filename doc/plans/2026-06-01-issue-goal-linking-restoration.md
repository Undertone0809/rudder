---
title: Issue goal linking restoration
date: 2026-06-01
kind: implementation
status: completed
area: ui
entities:
  - issue_goal_linking
  - goals
  - issue_detail
issue:
related_plans:
  - 2026-04-30-goal-center-lifecycle.md
  - 2026-05-07-new-issue-modal-redirect.md
supersedes: []
related_code:
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/IssueProperties.tsx
  - ui/src/lib/new-issue-dialog.ts
  - server/src/services/issue-goal-fallback.ts
  - server/src/services/issues.ts
  - server/src/__tests__/issue-goal-fallback.test.ts
  - server/src/__tests__/issues-service.test.ts
  - tests/e2e/issue-detail-goal-picker.spec.ts
  - tests/e2e/new-issue-project-context.spec.ts
commit_refs: []
updated_at: 2026-06-01
---

# Issue Goal Linking Restoration

## Summary

Restore issue-level goal linking as an operator-visible workflow. Issues already
support `goalId` in the API and data model, but the current create and detail UI
does not expose the field, which makes goals feel like a passive reporting
surface rather than a work anchor.

## Problem

The Goal Center lifecycle plan previously added issue-side goal linking, and an
E2E test still expects it. A later simplification removed the issue detail goal
picker, while the new issue modal never gained a goal selector. This leaves a
contract mismatch: API callers can set `goalId`, but normal operators cannot
set or correct it from the primary issue workflows.

## Scope

- Restore a goal picker in issue properties for existing issues.
- Add a goal selector to the new issue modal.
- Preserve project selection behavior and avoid changing project multi-goal
  linking semantics.
- Validate direct issue `goalId` references against the issue organization.
- Add focused coverage for create-time goal assignment and existing detail
  reassignment.

Out of scope:

- Goal progress metrics, OKR fields, or scheduling semantics.
- Changing project-to-goal inheritance rules beyond UI defaults.
- Redesigning Goal Detail aggregation.

## Implementation Plan

1. Add `goalId` to new issue local state, draft persistence, request assembly,
   and the create dialog metadata row.
2. Restore issue detail goal picker using the current `IssueProperties`
   patterns.
3. Add server-side same-organization validation for direct `goalId` create and
   update patches.
4. Update tests for the new issue create path and keep the existing detail
   picker E2E meaningful.
5. Run focused type/test/E2E/browser validation, then reviewer gate.

## Design Notes

Goal should sit next to Project because both answer work context, but they are
not synonyms. Project groups execution resources and delivery work; Goal
answers why the issue exists. A project may still imply or group goals, but a
standalone issue must be able to carry a direct goal.

## Success Criteria

- Operators can select a goal while creating an issue.
- Operators can view, change, clear, and open an issue's goal from issue detail.
- Direct issue `goalId` cannot point across organization boundaries.
- Existing issue goal picker E2E passes or is updated only for intentional UI
  changes.

## Validation

- `pnpm exec vitest run ui/src/components/IssueProperties.test.tsx ui/src/components/NewIssueDialog.test.tsx ui/src/lib/new-issue-dialog.test.ts`
- `pnpm exec vitest run server/src/__tests__/issue-goal-fallback.test.ts`
- `pnpm exec vitest run server/src/__tests__/issues-service.test.ts --testNamePattern "goal links|goal clear|parent issue relationships"`
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/new-issue-project-context.spec.ts --grep "selected goal|redirects to the created issue detail"`
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-detail-goal-picker.spec.ts`
- `git diff --check` over the scoped files.
- `pnpm -r typecheck`
- `pnpm build`

`pnpm test:run` did not pass, but the failures are outside this issue-goal
slice: CLI Desktop update timeout behavior, markdown snapshot assertions with
extra `data-markdown-source-*` attributes, CommentThread linked run card
rendering, and Messenger markdown snapshot rendering.

Spawned reviewer gate: first review found a blocker in explicit goal clearing
for projectless issues with a default organization goal. The update fallback now
honors `goalId: null`, service-level coverage proves the clear persists, and a
follow-up spawned reviewer passed the scoped diff.

## Open Issues

- Visual density of the four-column new issue metadata row should be revisited
  with screenshot proof once the unrelated UI dependency break is fixed.
