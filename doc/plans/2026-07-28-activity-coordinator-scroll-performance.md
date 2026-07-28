---
title: Activity coordinator and scroll performance
date: 2026-07-28
kind: implementation
status: completed
area: ui
entities:
  - messenger_chat
  - activity_coordinator
  - run_transcript
  - performance_evals
issue:
related_plans: []
supersedes: []
related_code:
  - ui/src/runtime/activity-coordinator.ts
  - ui/src/context/ActivityCoordinatorContext.tsx
  - ui/src/context/ChatGenerationContext.tsx
  - ui/src/context/LiveUpdatesProvider.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/components/VirtualizedActivityTimeline.tsx
  - ui/src/components/transcript/useLiveRunTranscripts.ts
  - tests/e2e/thread-pressure.spec.ts
  - scripts/perf/compare-scroll-evals.mjs
commit_refs: []
updated_at: 2026-07-28
---

# Activity coordinator and scroll performance

## Goal

Keep Messenger, active chats, issue runs, and live transcripts responsive at
production-shaped scale without manual loading or loss of live correctness.

## Implementation

1. Add an organization-scoped activity coordinator with keyed summary
   subscriptions, detail leases, and one shared live-event stream.
2. Isolate chat generation status from full stream drafts so assistant deltas do
   not rerender Messenger.
3. Share live run events and persisted-log tailing instead of opening a socket
   and poll loop per transcript consumer.
4. Add variable-height virtualization to high-volume Messenger and transcript
   surfaces while preserving drag, unread navigation, and scroll anchoring.
5. Add repeatable pressure and scroll evals that report DOM, frame, long-task,
   request, renderer task-time, and JavaScript heap evidence before and after
   the change.

## Acceptance

- One generic organization WebSocket is active per renderer.
- An assistant delta does not rerender the Messenger directory.
- Background runs do not create duplicate log polling loops.
- Messenger and transcript DOM size stays bounded by the visible range plus
  overscan.
- Streaming, Stop checkpoints, annotations, drag/drop, unread navigation, and
  final persisted output remain exact.
- Fresh dev and packaged Desktop builds pass automated checks and black-box
  performance acceptance.

## Measured evaluation

The disposable dev pressure dataset contains 2,001 Chat messages, 221
Messenger threads, 500 Issue comments, 250 terminal Runs, and 2 active Runs.
The comparison uses the same browser, viewport, interaction script, and
production/static UI path.

| Surface / metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Chat mounted messages | 4,002 | 16 | -99.6% |
| Chat ready time | 6,356 ms | 1,150 ms | -81.9% |
| Chat p95 frame interval | 791.7 ms | 9.3 ms | -98.8% |
| Chat dropped-frame ratio | 95.9% | 0% | -95.9 pp |
| Chat long tasks | 21 | 0 | -100% |
| Chat renderer task time | 6,937 ms | 3,519 ms | -49.3% |
| Messenger mounted rows | 222 | 24 | -89.2% |
| Messenger p95 frame interval | 9.3 ms | 9.2 ms | -1.1% |
| Messenger dropped-frame ratio | 1.7% | 0% | -1.7 pp |
| Messenger renderer task time | 3,624 ms | 1,680 ms | -53.6% |
| Total DOM nodes | 72,826 | 1,515 | -97.9% |
| Event listeners | 10,440 | 488 | -95.3% |
| JavaScript heap | 151.3 MiB | 24.1 MiB | -84.1% |

The after build used exactly one organization WebSocket. Before expanding a
terminal Run, only the two active Runs fetched logs. Deep Chat and Issue
navigation mounted an initially absent target while keeping the timeline
bounded, and background Chat streaming remained exact after navigating away
and back.

Renderer task time is the repeatable CPU-pressure proxy exposed by Chromium.
Comparable process RSS was not available from the browser trace, so the report
does not present JavaScript heap as OS RSS.
