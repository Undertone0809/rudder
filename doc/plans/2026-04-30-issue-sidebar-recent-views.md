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
  - ui/src/lib/issue-navigation.ts
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
- Allow expansion up to twenty recent issues.
- Keep the existing storage limit of fifty recent ids.
- If more than twenty current-organization recent issues exist, constrain the
  expanded recent list with its own scroll region so `Projects` remains
  reachable.
- Treat legacy `/issues?scope=recent` as a compatibility path, not a primary UI
  state.

## Implementation Plan

1. Add a compact `RecentIssueListSection` to `ThreeColumnContextSidebar`.
2. Remove `Recently Viewed` from the top issue view nav.
3. Link each recent issue row directly to `/issues/:identifierOrId` and close
   the mobile sidebar on click.
4. Highlight the current issue detail when it appears in the recent list.
5. Stop remembering `recent` as an issue rail destination.
6. Update the Issues page so `scope=recent` no longer filters the main content.
7. Update recent-view E2E coverage for sidebar rendering, org scoping, and long
   history bounds.

## Success Criteria

- The main Issue Tracker remains the normal issue workspace when recent history
  exists.
- Recent issue history is directly navigable from the sidebar.
- Recent history is bounded and cannot dominate the sidebar.
- Current organization filtering still applies to recent issue rows.
- Existing recent local-storage migration behavior remains intact.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/components/ThreeColumnContextSidebar.test.tsx`
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Passed on focused rerun:
  `pnpm vitest run server/src/__tests__/agent-instructions-routes.test.ts server/src/__tests__/issue-lifecycle-routes.test.ts`
- `pnpm test:run` ran the full suite and passed 1285 tests with 1 skipped,
  but failed 2 server tests during the full concurrent run:
  `agent-instructions-routes.test.ts` and `issue-lifecycle-routes.test.ts`.
  Both failed tests passed when rerun directly.
- Attempted:
  `RUDDER_E2E_RUN_ID=issue-sidebar-recent-views npx playwright test tests/e2e/issues-recently-viewed.spec.ts --config tests/e2e/playwright.config.ts --reporter=line --timeout=120000`.
  The run did not reach assertions because Chromium launch timed out after
  180 seconds in this environment.
- Visual check: opened `http://127.0.0.1:3100/issues` in Safari and verified
  the empty-recent sidebar state no longer shows a `Recently Viewed` issue-view
  entry and preserves the Issues / Projects / main-content layout. Chrome was
  blocked by a Gate Wallet security interstitial, and Playwright/Chrome MCP
  browser automation timed out or disconnected.
