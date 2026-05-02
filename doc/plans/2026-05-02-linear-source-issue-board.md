---
title: Linear source issue board
date: 2026-05-02
kind: implementation
status: implemented
area: ui
entities:
  - plugin_linear
  - issue_board
  - external_issue_source
issue:
related_plans:
  - 2026-04-25-linear-import-plugin-completion.md
  - 2026-04-30-linear-issue-sidebar-projects.md
  - 2026-04-24-issue-board-display-properties.md
supersedes: []
related_code:
  - ui/src/pages/Issues.tsx
  - ui/src/components/IssuesList.tsx
  - ui/src/components/KanbanBoard.tsx
  - ui/src/components/LinearIssueSourceBoard.tsx
  - ui/src/components/BreadcrumbBar.tsx
  - ui/src/components/ThreeColumnContextSidebar.tsx
  - packages/plugins/examples/plugin-linear/src/worker.ts
  - packages/plugins/examples/plugin-linear/src/ui/index.tsx
commit_refs: []
updated_at: 2026-05-02
---

# Linear Source Issue Board

## Summary

Move the primary Linear browsing flow into the native Issue Tracker instead of
forcing operators through a separate Linear intake page. When an operator picks a
Linear team or Linear project from the Issues sidebar, the main Issue board
should switch into a read-only external-source mode that reuses the existing
board/list controls to inspect Linear issues and import selected work into
Rudder.

## Problem

The current Linear plugin is import-first, but its main workflow lives in a
plugin page. That makes Linear feel like a side utility rather than a first-class
source of incoming work. Operators should be able to stay in the Issue Tracker,
inspect all Linear projects under a connected team, and import only the issues
that should become executable Rudder work.

## Scope

- Add a `source=linear` mode to the Issues route.
- Render Linear issues in the existing Issue Tracker board/list surface.
- Keep Linear issue cards visually distinct as external, read-only rows before
  import.
- Allow selecting one or more Linear issues and importing them into a chosen
  Rudder project.
- Show imported Linear issues as linked to their Rudder issue.
- Expand the Issues sidebar Linear group to support team/project navigation.
- Keep the existing `/linear` plugin page available as an advanced/bulk intake
  surface.
- Do not add background sync, bidirectional status sync, webhooks, comment sync,
  or agent execution against non-imported Linear issues.

## Implementation Plan

1. Inspect the current Issue Tracker, Kanban board, Linear plugin worker, and
   sidebar contracts on latest `origin/main`.
2. Add a `source=linear` branch in `Issues.tsx` that stays on the Issue route
   while delegating external-source rendering to a dedicated host board
   component.
3. Introduce an external issue source presentation shape in the UI layer rather
   than extending the shared `Issue` type.
4. Add `LinearIssueSourceBoard` to resolve the Linear contribution and query
   `linear-catalog`, `page-bootstrap`, `linear-issues`, and
   `import-linear-issues`.
5. Add board/list views, selection, and import controls for external Linear
   rows, including target Rudder project selection and row-level imported state.
6. Update the Issues header so Linear source mode reads as `Linear Issues` and
   does not show the native issue create/search controls.
7. Update `ThreeColumnContextSidebar` so Linear navigation points at
   `/issues?source=linear&linearTeamId=...` and
   `/issues?source=linear&linearTeamId=...&linearProjectId=...` instead of
   making the plugin page the primary path.
8. Add focused unit tests for sidebar routing, Linear source board rendering,
   selection/import behavior, and plugin URL filter compatibility.
9. Extend or add E2E coverage for the Linear source Issue board path where the
   local browser environment allows it.

## Design Notes

- The Issue Tracker remains the primary work surface; `/linear` remains a
  plugin-owned advanced page.
- External Linear rows must not be draggable or status-mutating. A Linear issue
  becomes executable only after import creates a native Rudder issue.
- Status lanes for Linear rows use the plugin's configured Linear-to-Rudder
  status mapping.
- The UI should expose source state in compact operator language: `External`,
  `Imported`, and `Open Rudder issue`.
- The new `external_issue_source` entity is introduced for this class of
  host-board external source views.

## Success Criteria

- Selecting a Linear team/project in the Issues sidebar keeps the operator on
  `/issues` with `source=linear`.
- The main Issue Tracker renders Linear issues in board/list mode with an
  external-source heading.
- Linear rows are read-only before import and cannot be dragged to mutate
  status.
- Operators can select Linear rows, choose a target Rudder project, and import
  them.
- Imported rows show an `Imported` state and link to the created Rudder issue.
- Existing native Rudder Issue Tracker behavior and tests keep passing.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/components/LinearIssueSourceBoard.test.tsx src/components/ThreeColumnContextSidebar.test.tsx src/pages/Issues.test.tsx src/components/BreadcrumbBar.test.tsx`
- Passed: `pnpm --filter @rudderhq/plugin-linear test -- --run`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Passed: `RUDDER_E2E_USE_EXISTING_SERVER=1 RUDDER_E2E_BASE_URL=http://127.0.0.1:3101 RUDDER_E2E_CHROMIUM_EXECUTABLE=/Applications/Browser/Google Chrome.app/Contents/MacOS/Google Chrome npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/linear-plugin-import.spec.ts --project=chromium --workers=1 --timeout=90000`
- Verified rendered desktop and mobile Linear source board screenshots:
  `/tmp/rudder-linear-source-board-desktop.png` and
  `/tmp/rudder-linear-source-board-mobile.png`.
- Failed, unrelated to this feature: `pnpm test:run` still fails in embedded
  PostgreSQL-backed suites with `Postgres init script exited with code 1`.

## Open Issues

- Import target choice may start as an explicit selector and later remember the
  last target per Linear source.
- Team-level source views should work even when a Linear team has no projects.
- The first pass may keep some advanced Linear filters on `/linear` if they do
  not map cleanly to the Issue Tracker toolbar.
