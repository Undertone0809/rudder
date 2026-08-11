---
title: Issue activity timeline progressive disclosure
date: 2026-08-11
kind: implementation
status: in_progress
area: ui
entities:
  - issue_detail
  - issue_activity
  - issue_comments
related_plans:
  - 2026-05-08-issue-detail-activity-stream.md
  - 2026-07-20-thread-pressure-performance-coverage.md
  - 2026-07-28-activity-coordinator-scroll-performance.md
supersedes: []
related_code:
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/CommentThread.tsx
  - ui/src/components/CommentThread.timeline.ts
  - ui/src/components/IssueTimelineDisclosure.tsx
  - ui/src/hooks/useIssueTimelineQueries.ts
  - ui/src/components/VirtualizedActivityTimeline.tsx
  - ui/src/components/IssueDetailFind.tsx
  - tests/e2e/thread-pressure.spec.ts
commit_refs: []
updated_at: 2026-08-11
---

# Issue Activity Timeline Progressive Disclosure

## Summary

Long Issue timelines should preserve the earliest context and the latest
evidence while replacing one continuous middle range with a compact divider.
The divider reports the exact hidden item count and reveals older hidden items
in height-budgeted batches. This follows the useful part of GitHub's long
Issue and pull-request timeline behavior while adapting the batch size to
Rudder's mixed content: many compact activity rows can appear together, while
one large agent comment can consume most of a batch.

This slice applies only to the complete unified Activity section rendered by
`IssueDetail`, including embedded full Issue detail. It covers comments,
activity and commit rows, and historical run rows. The compact comment-only
timeline in the Chat side panel remains unchanged.

## User Job And Decision Sequence

The operator's immediate job is to understand how an Issue started, inspect
its current evidence, and recover older context only when it is relevant.

1. On open, orient from the earliest context and the newest activity.
2. Decide whether the summarized middle history is needed.
3. When needed, reveal the next chronological batch from the older side.
4. Continue until the target evidence is visible or the timeline is fully
   expanded.

The timeline remains an inspection surface. The only new decision is whether
to reveal more history; comment, run-detail, edit, delete, wake, and steering
actions retain their existing semantics.

## Scope

In scope:

- one adaptive hidden middle range in the full Issue Activity timeline;
- deterministic ordering across comments, activity, and historical runs;
- height estimates that distinguish compact rows, runs, and comments;
- monotonic expansion that never hides an item already made visible;
- scroll anchoring, keyboard focus, hash navigation, and Issue Find support;
- exact localized hidden-count copy and accessible disclosure semantics;
- focused helper/component tests and production-shaped E2E coverage;
- Product Logic Registry updates for `ISSUE.SURFACE.001` and
  `ISSUE.COMMENTS.001`.

Out of scope:

- API, database, or unified timeline cursor pagination;
- changing payload cardinality or query response shapes;
- changing the compact Chat side-panel timeline;
- multiple independently collapsed ranges;
- changing comment, run, activity, composer, or navigation behavior beyond
  timeline disclosure.

The existing endpoints still deliver complete Issue payloads in this slice.
That is an explicit intermediate boundary: it reduces mounted DOM and reading
cost, but does not claim network or server-query scalability. A unified cursor
API remains the appropriate follow-up if request size dominates measured Issue
loading.

## Ordering Contract

Build one canonical ordered sequence before disclosure. Sort by:

1. `createdAt` ascending;
2. existing kind precedence `activity -> comment -> run` for equal timestamps;
3. stable item ID ascending.

Disclosure operates only on indices in this canonical sequence. Refetches and
live updates may add or update items, but cannot reorder already-visible items
outside the canonical rules or shrink the visible prefix/suffix boundaries.

## Adaptive Height Model

Use a canonical `12px` inter-item gap. Estimate row height as follows:

| Item | Estimated height |
| --- | ---: |
| Compact activity or commit row | `40px` |
| Terminal or collapsed historical run | `52px` |
| Queued or running expanded run | `320px` |
| Comment | `clamp(144, 112 + visualLines * 20 + imageCount * 240, 720)` |

`visualLines` is derived from the comment's plain-text length and the positive
timeline width. The estimator should conservatively account for explicit line
breaks and wrapped lines without measuring or mounting the hidden Markdown DOM.
Image count comes from the comment attachment/content metadata already
available to the timeline item.

Let the expansion budget be:

```text
B = clamp(0.8 * actualScrollRoot.clientHeight, 640, 900)
```

- initial visible head budget: `0.4B`;
- initial visible latest-tail budget: `0.8B`;
- each `Load more` expansion budget: `B`;
- every batch reveals at least 1 and at most 24 items;
- if the final remainder is too small to justify another divider, reveal it
  completely.

Create a divider only when the remaining middle contains at least four items
and at least `0.5B` estimated height. Otherwise render the complete timeline.
These thresholds prevent a divider that costs more attention than the content
it hides.

## Disclosure Lifecycle

Initial disclosure waits for all five Issue timeline sources to settle
successfully: comments, activity, linked runs, live runs, and active run. It
also waits for a positive timeline width and actual scroll-root height.

If any initial source errors, the current Issue mount permanently chooses
fully-expanded mode. A later retry may complete data and clear its warning, but
must not introduce a new divider underneath content the operator has already
seen. `IssueDetail` renders a compact Activity warning naming that some history
could not be loaded and a `Retry` action that refetches only the failed timeline
sources. This is new local recovery UI; it does not rely on a pre-existing
five-query error surface. Ordinary polling, refetch, resize, edits, deletes,
and live updates do not reset disclosure.

Track monotonic canonical prefix and suffix sort boundaries rather than only
raw counts. Newly arrived latest items remain visible. Existing visible items
remain visible after content estimates, viewport dimensions, or source data
change. Fully expanded is terminal for the current Issue mount; reload or
reopen starts a fresh calculation.

## Reveal, Scroll, Find, And Focus

`Load more` reveals chronologically from the older side of the hidden range.
Before updating disclosure state, capture the divider's position in the active
scroll root. After rendering, restore that position by anchoring the first
newly revealed row to the old divider position, avoiding a viewport jump.

Mouse activation keeps focus where it is. Keyboard activation moves focus to
the first newly revealed timeline wrapper after rendering. Wrappers are
programmatically focusable without entering the ordinary tab order.

If the URL hash names a hidden comment, reveal through that comment in one
operation even when it exceeds the normal 24-item batch cap, then run the
existing hash scroll/highlight behavior. Issue Find currently indexes rendered
DOM, while the existing timeline virtualization unmounts offscreen rows once
the list exceeds 60 items. Opening Find therefore first expands the timeline
completely and temporarily disables virtualization for this timeline, waits
for every row to mount and the rendered index to refresh, and only then runs
the existing highlight/navigation logic. Closing Find restores virtualization
to bound the mounted DOM, but the monotonic disclosure lifecycle never
re-hides the middle range. This keeps Find exact without creating a second
text-search model.

## Divider Presentation And Accessibility

Use a quiet full-width timeline interruption rather than a nested card. It
shows an exact localized count and a `Load more` command. The divider must:

- remain visually subordinate to comments and run evidence;
- expose `aria-controls` for a stable timeline-region ID that remains mounted
  before, during, and after disclosure;
- expose `aria-expanded="false"` while the disclosure button exists; the final
  activation removes the button and divider after revealing all rows;
- announce the exact remaining hidden count through a polite `aria-live`
  region after partial activation, and announce that all activity is shown
  after the final activation; the live region remains mounted outside the
  removable divider so the terminal announcement is observable;
- support Enter and Space activation through the native button behavior;
- preserve visible focus treatment in light and dark themes.

## State Inventory

| State | Current decision | Visible controls | Deferred controls | Safety-critical context | Continuity semantics |
| --- | --- | --- | --- | --- | --- |
| Loading | Wait for complete timeline inputs | Existing loading/error UI | Divider and timeline actions | Source failures remain visible | No disclosure state exists yet |
| Short or low-height timeline | Inspect the complete history | Existing item actions and composer | None | All evidence is visible | Back/Close/Reopen remain unchanged |
| Long timeline, collapsed | Decide whether older middle history is needed | Exact hidden count and `Load more`; existing actions on visible rows | Actions belonging to hidden rows | Earliest context, latest status, errors, and active runs stay visible | Back/Escape/Close do not alter drafts; Reopen recomputes disclosure |
| Partially expanded | Continue inspecting or reveal another batch | Updated count and `Load more` | Remaining hidden-row actions | Previously revealed evidence cannot disappear | Scroll is anchored; polling does not reset state |
| Fully expanded | Inspect or act on any item | Existing timeline actions and composer | None | Complete evidence is visible | Terminal for this mount; reopen may compact again |
| Initial source error | Recover missing history | Compact Activity warning, `Retry`, and all available timeline rows | Divider permanently disabled for this mount | Partial failure is never hidden | Retry refetches failed sources, can fill data, and cannot re-collapse |
| Hidden hash target | Navigate to named evidence | Target reveal and existing target behavior | Unrelated later hidden items may remain deferred | Named evidence becomes visible before navigation completes | Reveal may exceed ordinary batch cap |
| Issue Find open | Search all Issue text | Existing Find controls after full timeline expansion and temporary virtualization suspension | None | Every activity row is mounted, so no matching evidence remains absent from the DOM index | Closing Find restores virtualization but does not re-collapse the timeline |

There is no new draft contract. Back, Escape, Close, Reopen, composer drafts,
comment editing/deletion, wake behavior, and run expansion keep their current
product semantics.

## Product Logic Delta

`ISSUE.SURFACE.001` should state that full Issue detail may adaptively collapse
one middle segment of a long unified Activity timeline while preserving the
earliest context and latest evidence, and that disclosure is monotonic for the
current mount.

`ISSUE.COMMENTS.001` should state that comments remain in canonical chronology
even when temporarily hidden by timeline disclosure; hash targets must reveal
the named comment before navigation, while opening Issue Find must reveal all
comments before DOM indexing; partial load failure must fail open rather than
hide collaboration evidence.

Registry code and test mappings will include the disclosure helper,
`CommentThread`, `IssueDetail`, focused unit tests, and the mixed-content E2E.

## Implementation Plan

1. Add a pure disclosure and height-estimation helper with deterministic
   ordering inputs, budget calculations, initial ranges, and reveal steps.
2. Add focused unit tests for compact-heavy, large-comment, mixed-run, tiny
   remainder, cap, equal-timestamp, resize/refetch monotonicity, and target
   reveal cases.
3. Add an opt-in disclosure configuration to `CommentThread`; keep existing
   callers fully expanded by default. Expose a monotonic full-expansion callback
   and an opt-in mount-all mode for Issue Find's open lifecycle.
4. Wire disclosure only from full `IssueDetail`, including five-query
   readiness/error/retry state, a scoped Activity warning, dimensions, hash
   navigation, and Issue Find refresh.
5. Update Product Logic Registry contracts and mappings.
6. Add a mixed-content E2E and adapt `thread-pressure.spec.ts` while preserving
   its payload cardinality, blanking, mounted-row, scroll coverage, active-run,
   and terminal-log-fanout assertions.
7. Run focused tests, E2E, product-logic checks, lint, typecheck, full tests,
   and build; record any unrelated failures exactly.
8. Verify desktop/mobile and light/dark rendered states with `ego-browser` and
   capture final screenshots outside the repository.
9. Freeze the exact candidate/runtime/organization/data identity, obtain an
   independent verifier `PASS`, then obtain final reviewer `accept` before
   scoped commit and push.

## Acceptance Criteria

- Short timelines and timelines dominated by one or two large comments do not
  receive a gratuitous divider.
- Long mixed timelines initially show earliest context and latest evidence
  with one exact-count middle divider.
- A compact-activity batch reveals more rows than a large-comment batch under
  the same viewport budget, subject to the 1..24 cap.
- Repeated activation reveals chronological older-side batches and eventually
  removes the divider without hiding previously visible rows.
- Polling, live inserts, edits, deletes, resize, retry, and remount follow the
  lifecycle rules above.
- An initial failure of each timeline source is covered: available evidence is
  fully expanded, the warning is visible, Retry refetches failed sources, and a
  successful retry clears the warning without creating a divider.
- Hidden hash targets are revealed and navigated correctly; opening Issue Find
  fully expands the timeline and mounts all rows before indexing, and closing
  Find restores virtualization without re-collapsing it. E2E coverage uses more
  than 60 rows and finds an initially offscreen match.
- Scroll position remains stable after reveal; keyboard and mouse focus
  behavior match the stated contract.
- The compact Chat side-panel timeline remains unchanged.
- Existing composer, run expansion/log fanout, activity ordering, and E2E
  pressure guarantees remain green.
- Final browser evidence covers production-shaped mixed content on desktop and
  constrained/mobile viewports in light and dark themes.
