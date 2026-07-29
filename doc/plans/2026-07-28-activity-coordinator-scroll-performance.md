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
  - ui/src/pages/AgentDetail.run-log.tsx
  - ui/src/components/CommandPalette.test.tsx
  - tests/e2e/thread-pressure.spec.ts
  - scripts/perf/compare-scroll-evals.mjs
commit_refs: []
updated_at: 2026-07-29
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
   and poll loop per transcript consumer, including the Agent Run detail page.
   Keep the socket lifecycle independent from asynchronously hydrated session,
   notification, and operator display state by reading those handlers through
   stable refs.
   The currently opened Run alone keeps a cursor-based structured-event
   backfill; its persisted cursor is independent from WebSocket presentation
   events and reaches two stable reads after terminal status.
4. Add variable-height virtualization to high-volume Messenger and transcript
   surfaces while preserving drag, unread navigation, and scroll anchoring.
5. Add repeatable pressure and scroll evals that report DOM, frame, long-task,
   request, renderer task-time, and JavaScript heap evidence before and after
   the change.
6. Prove that unrelated coordinator updates do not rerender or requery the
   Command Palette.

## Acceptance

- One generic organization WebSocket is active per renderer.
- An assistant delta does not rerender the Messenger directory.
- Background runs do not create duplicate log polling loops.
- Opening an active Agent Run reuses the same organization stream and shared
  run-detail source.
- A live-to-terminal Run transition refreshes detail state, hydrates final
  evidence, reconciles reconnect gaps, and stops log polling.
- Messenger and transcript DOM size stays bounded by the visible range plus
  overscan.
- Streaming, Stop checkpoints, annotations, drag/drop, unread navigation, and
  final persisted output remain exact.
- Fresh dev and packaged Desktop builds pass automated checks and black-box
  performance acceptance.

## Measured evaluation

The disposable dev pressure dataset contains 2,001 Chat messages, 699
Messenger threads, 500 Issue comments, 250 terminal Runs, and 2 active Runs.
The comparison uses the same browser, viewport, interaction script, and
production/static UI path.

| Surface / metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Chat mounted messages | 4,002 | 16 | -99.6% |
| Chat ready time | 11,328 ms | 1,293 ms | -88.6% |
| Chat p95 frame interval | 1,016.7 ms | 16.7 ms | -98.4% |
| Chat dropped-frame ratio | 97.2% | 1.28% | -95.9 pp |
| Chat long tasks | 13 | 0 | -100% |
| Chat renderer task time | 6,418 ms | 4,925 ms | -23.3% |
| Messenger mounted rows | 400 | 98 | -75.5% |
| Messenger p95 frame interval | 9.2 ms | 16.7 ms | +81.5% |
| Messenger dropped-frame ratio | 3.21% | 0.18% | -3.03 pp |
| Messenger long tasks | 3 | 0 | -100% |
| Messenger renderer task time | 3,472 ms | 2,188 ms | -37.0% |
| Total DOM nodes | 78,017 | 3,671 | -95.3% |
| Event listeners | 11,345 | 864 | -92.4% |
| JavaScript heap | 166.6 MiB | 32.0 MiB | -80.8% |

The after build used exactly one organization WebSocket. Before expanding a
terminal Run, only the two active Runs fetched logs. Deep Chat and Issue
navigation mounted an initially absent target while keeping the timeline
bounded, and background Chat streaming remained exact after navigating away
and back.

Renderer task time is the repeatable CPU-pressure proxy exposed by Chromium.
Comparable process RSS was not available from the browser trace, so the report
does not present JavaScript heap as OS RSS.

## 2026-07-29 scroll continuity follow-up

Fast trackpad movement exposed a transient blank viewport when the browser
advanced `scrollTop` before React committed the next virtual range. Messenger
now uses direct transform updates plus a chunked outer range. The outer window
keeps a 40-row runway on both sides (48 during drag) but changes its React range
only at eight-row boundaries, avoiding both per-row reconciliation and a
production-sized always-mounted directory. Its initial estimate is calibrated
to the measured Z Studio row height so the scroll geometry settles quickly.
The React Virtual adapter compares the extracted mounted range, rather than the
raw visible range, before scheduling React work; scrolling inside an existing
runway therefore stays on the browser's compositor path.
Rich grouped sections keep roughly one extra viewport ahead (24 rows, raised to
32 while dragging) and half that budget behind (12/16 rows).
Nested timelines no longer read layout and synchronously commit React state for
every transform mutation written by the outer virtualizer. Those ancestor
corrections are skipped on the scroll hot path and coalesced once after
scrolling settles.

Custom Group collapse state is written to the disclosure DOM in the click task,
before persistence or React reconciliation, and the former 200ms grid
transition has been removed. React commits the same state after the first paint,
with one cancellable deferred commit per Group. Disclosure state is local to
the Group row, so a click does not rerender the directory. Persistence is
serialized per Group, making rapid inverse clicks last-write-wins; the latest
failed write rolls back to the last server-confirmed state.

The production-build pressure E2E now performs 40 consecutive-frame,
non-sequential scroll reversals over 699 Messenger threads split between two
expanded virtualized groups. It measures only real row/header/footer coverage
(not the group's full-height background) and fails when any visual hole exceeds
the 16px intentional layout-spacing budget. The scenario also includes loose
rows and collapses and re-expands a group before scrolling.

The final production run observed zero blank samples across 42 fast reversals,
a maximum uncovered interval of 10px, one dropped frame in five seconds
(0.18%), no long tasks, and a 16.7ms p95 frame interval.
