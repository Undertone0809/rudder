---
title: Messenger render performance first slice
date: 2026-06-24
kind: implementation
status: complete
area: ui
entities:
  - messenger_chat
  - render_performance
  - markdown_rendering
related_plans: []
supersedes: []
related_code:
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/hooks/useMessenger.ts
  - ui/src/components/MarkdownBody.tsx
  - ui/src/components/transcript/RunTranscriptView.blocks.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Messenger.tsx
  - tests/e2e/messenger-contract.spec.ts
commit_refs: []
updated_at: 2026-06-24
---

# Messenger Render Performance First Slice

## Route

`development-lifecycle-router-maintainer` classifies this as:

```text
performance_benchmark -> implementation -> verification -> review -> handoff
```

Downstream owner: `rudder-performance-architecture-maintainer`.

Exit bar:

- record the workload shape and baseline evidence
- identify whether the bottleneck is network, server aggregation, or render hot path
- land one low-risk optimization slice with regression coverage
- verify with focused tests and a real local browser measurement
- preserve Messenger product contracts for attention, grouping, read state, and navigation

## Current Evidence

Live local instance:

- Runtime: `http://127.0.0.1:3200`
- Organization: Z Studio, `issuePrefix=ZST`, 763 issues at measurement time
- Scenario: operator opens Messenger and scrolls the left thread directory through older rows

Measured API shape:

- First Messenger page: `/api/orgs/:orgId/messenger/threads?limit=40&splitIssues=true`
  - 40 items
  - about 33 KB
  - `hasMore=true`
- Custom groups:
  - 4 groups
  - 12 hydrated entries
  - about 14 KB
- Full thread pagination:
  - 17 pages
  - 652 items
  - about 565 KB total

Measured browser shape:

- Initial Messenger sidebar render: 73 thread rows, about 1,730 DOM nodes
- After repeated scroll/page loading: 345 thread rows, about 6,826 DOM nodes
- The row count grows with every loaded page because `useMessengerModel` keeps all loaded pages in `threadSummaries`, and `MessengerContextSidebar` renders every loaded thread into one scroll container.

## Systemic Risk Scan

### Messenger sidebar

Primary risk: render hot path.

The network payload is paginated and small enough on first open. The scroll
jank risk comes from growing DOM and per-row UI complexity: hover transitions,
dropdown triggers, unread badges, generated title spinners, drag handles, and
sortable wrappers.

The current code already limits visible entries inside managed/custom sections,
but the whole loaded thread set still grows as the user scrolls.

### Markdown surfaces

Primary risk: long markdown bodies and many markdown instances.

Known consumers:

- `MarkdownBody`
- chat message rendering
- Messenger issue/system detail rendering
- issue comments
- run transcript blocks
- organization import/export previews
- entity previews

This first slice should not rewrite markdown rendering. The safer follow-up is a
separate benchmark that seeds many large markdown messages/comments and measures
`MarkdownBody` mount/update cost. A likely later fix is memoizing parsed
markdown or virtualizing long message/comment timelines, not changing markdown
semantics.

### Transcript surfaces

Primary risk: many transcript blocks and expanded raw payloads.

Run transcript code already collapses noisy details in places, but long
transcripts can still create many React nodes. This should be benchmarked as a
separate transcript-specific workload because the product contract for raw
evidence visibility is stricter than the sidebar contract.

### Other list surfaces

Potential long-list surfaces include Activity, Linear import, context sidebars,
issue comments, chat messages, and run lists. The broad rule is the same:
pagination lowers network cost, but only virtualization, visible-entry limits,
or render containment lowers scroll-frame cost once data is loaded.

## Implementation Slice

First slice:

1. Add render containment to Messenger thread rows so offscreen rows are cheaper
   for layout and paint.
2. Add an auto-pagination guard so inertial scrolling does not silently load
   hundreds of rows into the sidebar. After a loaded-row threshold, the user sees
   an explicit load-more control.
3. Keep manual loading available, preserving access to older threads.
4. Add focused regression coverage for the auto-load guard and manual load path.
5. Re-measure the live local Messenger sidebar.

Why this slice:

- It is behavior-preserving for thread identity, grouping, unread state,
  navigation, and row actions.
- It directly addresses the observed growth pattern.
- It avoids a high-risk full virtualizer rewrite while the dirty worktree has
  unrelated chat/Feishu changes.

## Follow-Up Candidates

- Full virtualized sidebar sections with variable row heights and scroll-to-unread support.
- Paged custom group hydration if groups grow large enough to become a hidden bulk payload.
- Markdown benchmark and memoization/virtualization plan for chat and comments.
- Transcript benchmark for long run evidence surfaces.
- Shared long-list performance fixture for UI surfaces that use infinite query or large `.map()` rendering.

## Validation Plan

- Focused component test for Messenger sidebar auto-load threshold.
- Focused component test for manual load after the threshold.
- Browser measurement against the current-code dev app on `http://127.0.0.1:3100`.
  The packaged/prod-local app on `http://127.0.0.1:3200` is only valid after
  rebuilding because it can serve older static assets.
- Narrow type/test checks for touched UI paths.
- Full repo baseline when feasible; report unrelated failures separately.

## Validation Results

- `pnpm --filter @rudderhq/ui exec vitest run src/components/MessengerContextSidebar.scroll.test.tsx src/components/MessengerContextSidebar.test.tsx src/components/MessengerContextSidebar.actions.test.tsx --reporter=dot`
  passed, 92 tests.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `git diff --check -- doc/plans/2026-06-24-messenger-render-performance.md ui/src/components/MessengerContextSidebar.tsx ui/src/components/MessengerContextSidebar.scroll.test.tsx ui/src/components/MessengerContextSidebar.test.tsx`
  passed.
- Browser acceptance against `http://127.0.0.1:3100/perf-disposable-daily-2026-06-23/messenger`
  on the current dev app:
  - initial: 42 real thread rows, 1,520 DOM nodes
  - after repeated sidebar scrolling: 160 real thread rows, 5,011 DOM nodes,
    `Load more threads` visible
  - after clicking manual load: 200 real thread rows, 6,111 DOM nodes,
    `Load more threads` remains available
- Added E2E coverage to `tests/e2e/messenger-contract.spec.ts` for the auto-load
  guard and manual load path. Local execution did not complete:
  - isolated E2E server failed during embedded PostgreSQL initialization before
    the test ran
  - existing `3100` server execution reached the test but failed an older
    assertion because the current dirty dev app issued
    `/api/orgs/:orgId/chats?status=active`
- `pnpm --filter @rudderhq/ui build` passed.
- `pnpm -r typecheck` passed.
- `pnpm product-logic:check` passed, 61 contracts valid.
