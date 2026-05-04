---
title: Issue board manual order
date: 2026-05-04
kind: implementation
status: completed
area: ui
entities:
  - issue_board
  - issue_manual_order
issue:
related_plans:
  - 2026-04-24-issue-board-display-properties.md
  - 2026-04-25-motion-v1.md
supersedes: []
related_code:
  - packages/db/src/schema/issues.ts
  - packages/shared/src/types/issue.ts
  - packages/shared/src/validators/issue.ts
  - server/src/services/issues.ts
  - server/src/routes/issues.ts
  - ui/src/api/issues.ts
  - ui/src/lib/issue-sort.ts
  - ui/src/components/IssuesList.tsx
  - ui/src/components/KanbanBoard.tsx
commit_refs:
  - c25c316
updated_at: 2026-05-04
---

# Issue Board Manual Order

## Summary

Add persisted manual ordering to the native Rudder issue board. Operators should
be able to drag issue cards up and down within a status lane, or move a card
into a precise position in another lane, and see that order survive reloads and
other board views.

## Problem

The board already uses drag and drop, but the current behavior only persists
status changes. Within-lane drag gestures are discarded because issue order is
derived from the active sort state, usually updated time or priority. That makes
the board feel reorderable without giving the operator a real work-queue order.

## Scope

In scope:

- Add a durable `board_order` value to issues.
- Add a board reorder API that is organization-scoped and records activity.
- Add a `Manual` sort mode for issue views.
- Enable precise same-lane and cross-lane card ordering in board mode.
- Keep existing status drag behavior working.
- Add focused API/UI tests for reorder behavior.

Out of scope:

- Changing issue priority when a card is reordered.
- Adding named/shared saved views.
- Reordering list-mode rows.
- Changing agent checkout order in this pass.
- Syncing external source boards such as Linear before import.

## Implementation Plan

1. Extend the issue schema, shared type, and migration history with
   `board_order`.
2. Backfill existing issues with a deterministic order per organization and
   status based on current priority/updated ordering.
3. Add a shared reorder validator and `issuesApi.reorder(...)` client method.
4. Add a server service method and route that validate organization membership,
   update status and `board_order` transactionally, and log `issue.reordered`.
5. Add `manual` to the UI sort model and make manual board mode sort by
   `boardOrder`, then `updatedAt`, then identifier.
6. Update `KanbanBoard` drag handling to compute the target status and sibling
   ordered ids for same-lane and cross-lane drops.
7. Update `IssuesList` so board drag reorder calls the new API and switches the
   view to `Manual` when needed.
8. Add focused tests for manual sort state, reorder calls, and server ordering.
9. Run typecheck, focused tests, full tests/build as feasible, and update
   `commit_refs` after the final commit.

## Design Notes

- Manual order is a board data contract, not local view state. The ordering
  belongs to the issue in its organization/status lane.
- `Manual` is separate from `Priority`; reordering should not imply urgency.
- Agent checkout order remains unchanged for this pass so a UI ordering change
  does not silently alter autonomous execution policy.
- The server accepts the moved issue id, target lane, and adjacent
  `previousIssueId` / `nextIssueId` after the drag. This keeps the payload
  small while making reindexing deterministic.
- Existing issues should receive sparse numeric order values to leave room for
  future insertion optimizations, even if this implementation reindexes the
  affected lane on each reorder.

## Success Criteria

- Dragging a card within a lane changes its visible order and persists after
  refetch/reload.
- Moving a card to another lane preserves the precise drop position there.
- Manual order is available from the Sort control and is automatically used
  when the operator reorders cards.
- Non-manual sort modes still sort by their selected field.
- Organization access and activity logging remain enforced for reorder
  mutations.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/components/KanbanBoard.test.tsx src/components/IssuesList.test.tsx`
- Passed: `pnpm --filter @rudderhq/server exec vitest run src/__tests__/issue-lifecycle-routes.test.ts src/__tests__/issues-service.test.ts`
- Passed: `pnpm --filter @rudderhq/server exec vitest run src/__tests__/issue-lifecycle-routes.test.ts`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm test:run` (268 test files, 1343 passed, 1 skipped)
- Passed: `pnpm build`
- Passed: `pnpm exec playwright test tests/e2e/issue-board-manual-order.spec.ts --config tests/e2e/playwright.config.ts --list`
- API-level local verification passed against a temporary local server on
  `127.0.0.1:3110`: created three issues, called
  `/api/orgs/:orgId/issues/reorder`, and confirmed persisted `boardOrder`
  values.
- Focused Playwright execution attempted:
  `pnpm exec playwright test tests/e2e/issue-board-manual-order.spec.ts --config tests/e2e/playwright.config.ts --reporter=line --timeout=120000`.
  It failed before assertions because local Chromium launch timed out after
  180 seconds.
- Browser MCP visual verification was attempted against the local page, but the
  browser navigation tool timed out after 120 seconds.

## Open Issues

- A future pass should decide whether `board_order` becomes the agent checkout
  queue order. This implementation intentionally keeps that policy unchanged.
