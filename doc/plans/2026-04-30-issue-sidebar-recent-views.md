---
title: Issue sidebar recent views
date: 2026-04-30
kind: implementation
status: completed
area: ui
entities:
  - issue_sidebar
  - issue_views
  - recent_issues
issue:
related_plans:
  - 2026-04-30-linear-issue-sidebar-projects.md
  - 2026-04-24-issue-board-display-properties.md
supersedes: []
related_code:
  - ui/src/components/ThreeColumnContextSidebar.tsx
  - ui/src/pages/Issues.tsx
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/KanbanBoard.tsx
  - ui/src/lib/issue-navigation.ts
  - ui/src/lib/recent-issues.ts
  - tests/e2e/issues-recently-viewed.spec.ts
commit_refs:
  - "feat: move recent issues into sidebar"
updated_at: 2026-04-30
---

# Issue Sidebar Recent Views

## Summary

Move issue recent history out of the main Issue Tracker view model and render it
as a bounded object list in the Issues context sidebar. Recent issues are
navigation shortcuts, not a first-class board/list scope like All, Following, or
Starred.

## Problem

The current `Recently Viewed` entry is rendered alongside issue views and opens
`/issues?scope=recent`, which replaces the main work surface with a recent-only
issue list or board. That makes a personal navigation history act like a
workspace view and forces the operator through an extra click before reaching
the issue they likely want.

Long recent histories also need explicit bounds. The sidebar should expose
recent objects without letting them push project slices and external project
groups out of reach.

## Product Decision

- Keep `All Issues`, `Following`, `Starred`, and draft issues as issue view
  entries.
- Render `Recently Viewed` as its own sidebar section below issue views and
  above `Projects`.
- Hide the section when no current-organization recent issues exist.
- Show a compact default list of five recent issues.
- Allow expansion up to twelve recent issues.
- Keep the existing storage limit of fifty recent ids.
- When expanded, constrain the recent list with its own scroll region so
  `Projects` remains reachable even at the expanded limit.
- Treat legacy `/issues?scope=recent` as a compatibility path, not a primary UI
  state.

## Implementation Plan

1. Add a compact `RecentIssueListSection` to `ThreeColumnContextSidebar`.
2. Remove `Recently Viewed` from the top issue view nav.
3. Link each recent issue row directly to `/issues/:identifierOrId` and close
   the mobile sidebar on click.
4. Highlight the current issue detail when it appears in the recent list.
5. Record an issue as recently viewed from list opens, board-card opens,
   sidebar recent-row opens, and direct detail-page loads.
6. Stop remembering `recent` as an issue rail destination.
7. Update the Issues page so `scope=recent` no longer filters the main content.
8. Update recent-view E2E coverage for sidebar rendering, org scoping, and long
   history bounds.

## Success Criteria

- The main Issue Tracker remains the normal issue workspace when recent history
  exists.
- Recent issue history is directly navigable from the sidebar.
- Direct detail loads and sidebar recent-row clicks update the recent ordering.
- Recent history is bounded and cannot dominate the sidebar.
- Current organization filtering still applies to recent issue rows.
- Existing recent local-storage migration behavior remains intact.

## Validation

- Passed:
  `pnpm --filter @rudderhq/ui exec vitest run src/components/ThreeColumnContextSidebar.test.tsx src/components/KanbanBoard.test.tsx src/lib/recent-issues.test.ts`
  - 3 files, 17 tests.
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Attempted:
  `RUDDER_E2E_RUN_ID=issue-sidebar-recent-views pnpm exec playwright test tests/e2e/issues-recently-viewed.spec.ts --config tests/e2e/playwright.config.ts --reporter=line --timeout=120000`.
  The run did not reach page assertions because Chromium headless launch timed
  out after 180 seconds; the run was interrupted before repeating the same
  browser-launch timeout for the remaining cases.
- Visual check in local Chrome against `http://localhost:3100/RUD/issues`:
  - Directly opening `RUD-20` recorded a recent issue and rendered the
    non-empty `Recently Viewed` sidebar section on the detail page.
  - After visiting enough issue detail pages to create a long recent history,
    the collapsed sidebar showed five rows plus `Show 7 more`, with `Projects`
    visible below.
  - After expanding, the recent list showed twelve rows, an internal scroll
    region, `Showing latest 12 of 14`, `Show less`, and `Projects` remained
    reachable in the same sidebar.
