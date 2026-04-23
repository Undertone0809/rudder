---
title: Issue board display properties
date: 2026-04-24
kind: implementation
status: completed
area: ui
entities:
  - issue_board
  - issue_views
issue: RUD-168
related_plans:
  - 2026-04-10-issue-board-and-org-goals-polish.md
supersedes: []
related_code:
  - ui/src/components/IssuesList.tsx
  - ui/src/components/KanbanBoard.tsx
  - ui/src/components/IssuesList.test.tsx
commit_refs:
  - 16ce14b
updated_at: 2026-04-24
---

# Issue Board Display Properties

## Summary

Add Linear-style display properties to the issue board so operators can choose
which metadata appears on issue cards without changing which issues are
included in the view.

## Problem

The issue board currently has filter, sort, group, and view mode state, but the
board card content is hardcoded. This forces every board workflow to use the
same card density and makes "show me more/less issue context" a card
implementation problem instead of a view setting.

## Scope

- Add display property state to the existing local issue view state.
- Add a Display toolbar control for board mode.
- Render board cards from the selected display properties.
- Keep default board cards compatible with the current identifier, priority,
  and assignee presentation.
- Do not add backend persistence or schema changes in this pass.

## Implementation Plan

1. Extend `IssueViewState` with a typed `displayProperties` list and backward
   compatible defaults.
2. Add a compact Display popover to `IssuesList` for board mode.
3. Pass selected display properties and project/current-user context into
   `KanbanBoard`.
4. Render optional identifier, priority, assignee, labels, project, updated,
   and created fields on cards.
5. Add focused component tests for persistence and card rendering behavior.

## Design Notes

Filters answer "which issues are visible"; display properties answer "which
fields are visible on each card." These controls should remain separate.

The default remains intentionally dense: identifier, priority, and assignee.
Additional fields appear as compact metadata chips/rows instead of expanding
cards into detail previews.

## Success Criteria

- Existing saved issue views keep working when `displayProperties` is missing.
- Operators can toggle board card fields from the toolbar.
- Board cards update immediately and persist the selected display properties.
- Default board cards preserve the current high-signal metadata.

## Validation

- `pnpm --filter @rudder/ui typecheck`
- `pnpm vitest run ui/src/components/IssuesList.test.tsx`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-board-display-properties.spec.ts --list`

The focused Playwright run for
`tests/e2e/issue-board-display-properties.spec.ts` was attempted with the
standard webServer flow and with an explicit `RUDDER_E2E_PORT=3290`, but the
runner hung without producing a pass/fail result. The spawned runner, server,
browser, and embedded Postgres processes were stopped. The test file is kept as
coverage for CI or a stable local Playwright environment.

## Open Issues

- Shared/server-side saved views may be useful later, but local view state is
  enough for RUD-168.
