---
title: Calendar agent activity clusters
date: 2026-05-02
kind: implementation
status: completed
area: ui
entities:
  - calendar_agent_activity
  - heartbeat_runs
issue:
related_plans:
  - 2026-05-02-google-calendar-oauth-settings.md
supersedes: []
related_code:
  - ui/src/pages/Calendar.tsx
  - ui/src/lib/calendar-display-items.ts
  - tests/e2e/calendar-v1.spec.ts
commit_refs:
  - feat: cluster calendar agent activity
updated_at: 2026-05-02
---

# Calendar Agent Activity Clusters

## Summary

Compress high-frequency derived agent activity in the Calendar week view without
changing persisted calendar data or the Calendar API contract. The intended end
state is that operators can scan agent availability and activity density first,
then open a drawer when they need the underlying projected or historical blocks.

## Problem

Timer heartbeats can generate many small projected or derived work blocks for
each agent. Rendering each block independently makes the week calendar noisy and
pushes the useful operator signal out of view. This is primarily an information
density and progressive disclosure problem, not a color or styling problem.

## Scope

- In scope: display-only clustering for short derived agent work blocks in week
  view, a details drawer for underlying events, and automated coverage for the
  projected heartbeat case.
- Out of scope: month or agenda clustering, server-side aggregation, changing
  heartbeat scheduling, and changing persisted calendar event semantics.

## Implementation Plan

- Add a pure calendar display-item builder that groups small derived
  `agent_work_block` events by local date/hour bucket and agent.
- Keep non-derived, manual, long, all-day, human, external, and cross-agent
  events as single display items.
- Update the timed week grid to lay out display items instead of raw events.
- Render clusters as neutral compact cards with an agent accent rail, status
  dots, aggregate title, and a time-window subtitle.
- Add a cluster drawer that lists underlying events and lets operators drill
  into the existing single-event drawer.
- Extend Calendar E2E coverage for projected heartbeat clustering.

## Design Notes

- Clustering is deliberately local to week view because the week grid is where
  many small time blocks create the most visual noise.
- The helper uses a 60-minute local bucket and a 45-minute maximum event
  duration so long real runs remain visible as individual blocks. Short events
  that cross a bucket boundary also stay visible as individual blocks so the
  display never understates occupied time.
- The cluster title carries the aggregate state, for example
  `Cluster Bot · 5 projected`; the subtitle carries the time window when all
  underlying events share one status.
- Month and agenda views keep raw event lists so existing navigation and search
  behavior stays unchanged.
- This plan mints `calendar_agent_activity` as the stable entity for future
  calendar-density work.

## Success Criteria

- Week view shows one cluster per agent/hour for repeated projected heartbeat
  blocks.
- The top-level cluster does not repeat every raw `Projected heartbeat` title.
- Clicking a cluster opens a drawer with the raw underlying events.
- Clicking an underlying event still opens the existing single-event details
  drawer.
- Manual human calendar events and planned agent annotations remain draggable or
  read-only exactly as before.

## Validation

- `pnpm vitest run ui/src/lib/calendar-display-items.test.ts`
- `pnpm --filter @rudderhq/ui typecheck`
- `RUDDER_E2E_CHROMIUM_EXECUTABLE="/Applications/Browser/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm test:e2e tests/e2e/calendar-v1.spec.ts`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- Visual verification against `http://127.0.0.1:4565/calendar`
  - `/tmp/rudder-calendar-agent-clusters.png`
  - `/tmp/rudder-calendar-agent-clusters-drawer.png`

## Open Issues

None for this implementation. Future work can decide whether month view should
summarize dense projected activity separately.
