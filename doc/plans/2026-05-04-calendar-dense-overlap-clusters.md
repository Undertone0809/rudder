---
title: Calendar dense overlap clusters
date: 2026-05-04
kind: implementation
status: completed
area: ui
entities:
  - calendar_agent_activity
  - calendar_overlap_density
issue:
related_plans:
  - 2026-05-02-calendar-agent-activity-clusters.md
supersedes: []
related_code:
  - ui/src/pages/Calendar.tsx
  - ui/src/lib/calendar-collision-clusters.ts
  - tests/e2e/calendar-v1.spec.ts
commit_refs:
  - 8281be0
updated_at: 2026-05-04
---

# Calendar Dense Overlap Clusters

## Summary

Add display-only compaction for high-overlap Calendar week view regions. The
goal is to prevent the week grid from rendering unreadably narrow event cards
when multiple agents have blocks in the same time window.

## Problem

The first activity-clustering pass reduced repeated small blocks from a single
agent, but it did not address cross-agent overlap. When several agent-owned
blocks overlap in a day column, the week view can split them into tiny
horizontal columns that no longer communicate the time block, title, or owner
clearly. The first collision pass only handled four-or-more column groups; a
follow-up visual review showed that three agent-owned columns are already below
the useful readability threshold in the week grid.

## Scope

- In scope: week-view-only collision compaction, a busy-cluster card, cluster
  drawer reuse for underlying events, and a day-view escape hatch for focused
  inspection.
- Out of scope: API changes, persisted aggregation, month/agenda clustering,
  changing heartbeat scheduling, or changing calendar event semantics.

## Implementation Plan

- Add a pure helper that groups connected timed segments and measures their
  required overlap columns.
- Compact mixed or non-agent groups that require at least four columns and
  contain at least four underlying events into a `collision_cluster` display
  item.
- Compact agent-owned groups earlier, at three columns and three events, because
  those cards reduce to initials and ellipses in the week grid.
- Render collision clusters as neutral busy cards with multi-agent accents,
  aggregate count, participant count, time range, and status summary.
- Reuse the existing cluster drawer to show complete underlying event rows.
- Add an `Open day view` action so operators can switch from week scanning to
  focused inspection without losing context.
- Extend Calendar E2E coverage for the dense overlap case.

## Success Criteria

- Week view does not render agent-owned three-column or general four-column
  overlap groups as unreadable slivers.
- The busy cluster preserves the occupied time window and participant density.
- Underlying events remain accessible and ordered by time in the drawer.
- Day view still expands the same blocks as individual time blocks.
- Existing three-column overlap behavior remains expanded and draggable tests
  continue to pass for human-owned calendar events.

## Validation

- `pnpm vitest run ui/src/lib/calendar-collision-clusters.test.ts ui/src/lib/calendar-display-items.test.ts ui/src/lib/calendar-event-layout.test.ts`
  - Passed: 3 files, 13 tests after the follow-up three-column threshold.
- `pnpm --filter @rudderhq/ui typecheck`
  - Passed.
- `pnpm -r typecheck`
  - Passed.
- `RUDDER_E2E_RUN_ID="calendar-dense-$(date +%s)" RUDDER_E2E_CHROMIUM_EXECUTABLE="/Applications/Browser/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm test:e2e tests/e2e/calendar-v1.spec.ts`
  - Passed: 6 tests.
- `RUDDER_E2E_RUN_ID="calendar-three-col-$(date +%s)" RUDDER_E2E_CHROMIUM_EXECUTABLE="/Applications/Browser/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm test:e2e tests/e2e/calendar-v1.spec.ts`
  - Passed: 6 tests, including agent three-column compaction and human
    three-column direct manipulation.
- `pnpm build`
  - Passed.
- `pnpm test:run`
  - Calendar-related tests passed, but the full suite failed in unrelated areas:
    `ui/src/pages/AutomationDetail.test.tsx` and
    `ui/src/pages/InstanceSettings.test.tsx` require `DialogProvider`; CLI
    org import/export E2E imported zero agents where one was expected.
- Visual checks captured outside the repo:
  - `/tmp/rudder-calendar-dense-overlap-week.png`
  - `/tmp/rudder-calendar-dense-overlap-drawer.png`
  - `/tmp/rudder-calendar-dense-overlap-day.png`
  - `/tmp/rudder-calendar-three-column-cluster.png`

## Open Issues

None for the first implementation. Future work can add a richer mini timeline
inside the cluster drawer if operators need faster comparison within dense
windows.
