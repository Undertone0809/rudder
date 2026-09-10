---
title: Chat responsiveness under load
date: 2026-09-08
kind: fix-plan
status: in_progress
area: ui
entities:
  - messenger_chat
  - live_updates
related_code:
  - ui/src/pages/Chat.tsx
  - ui/src/context/LiveUpdatesProvider.tsx
  - ui/src/lib/messenger-query-cache.ts
  - tests/e2e/chat-first-turn-responsiveness.spec.ts
---

# Intent and bounded delivery

The operator reports that submitting a new chat can leave the new-chat screen
stuck, with delayed or incorrect navigation, especially under machine load.
The broader goal is responsive interaction under slow CPU and slow I/O, not
merely a faster spinner on an idle machine.

This slice removes confirmed foreground/background coupling and overlapping
query invalidations, and preserves first-turn operation state across responsive
page remounts. It does not claim whole-app performance qualification or
parity with Hermes Studio. No data migration, runtime protocol rewrite, fake
successful persistence, paid-agent benchmark, or Desktop packaging change is
part of this slice.

## Confirmed source-level causes

- The first-turn acknowledgement seeds the conversation/message caches, then
  awaits list/group refreshes before setting stream state and navigating.
  The NDJSON consumer awaits that callback, so unrelated GETs also block
  processing subsequent stream events.
- The same acknowledgement navigates unconditionally; a late response can
  override a newer user navigation and clear a different composer draft.
- Live updates and Messenger reconciliation invalidate overlapping parent and
  child query keys. Existing cached queries can be restarted repeatedly by a
  single event. Preserve event freshness while removing within-event duplicates;
  do not suppress a later authoritative event with a blanket in-flight guard.
- Independent black-box acceptance found that switching desktop/mobile layout
  remounts the routed Chat page while its first POST is unresolved. Local pending
  content and the send lock disappear, and a component-lifetime navigation guard
  cannot distinguish that remount from actual user navigation. First-turn
  operation ownership must outlive the presentation component.

## State inventory and acceptance packet

| State | Current job / visible controls | Safety and continuity |
| --- | --- | --- |
| Draft | Choose agent/context and Send | Existing agent preflight and draft semantics remain |
| Submitted, not acknowledged | Immediately show local outgoing content and explicit sending feedback | Not represented as persisted; duplicate submission disabled; navigation remains available |
| Acknowledged | Show accepted conversation, one user message, stream/loading state | Seed caches and navigate without waiting for sidebar GETs; server owns the canonical ID |
| User navigated elsewhere | Continue the chosen conversation/workflow | Late acknowledgement must not navigate back or clear the new draft; accepted work remains discoverable |
| Pre-ack failure | Visible error and recoverable original text/files | No fake success; retain existing recovery semantics |
| Streaming/final | Read output or send next turn when allowed | Sidebar synchronization must not stop stream consumption; preserve queue/stop protocol |

Primary tests use an isolated local API and PostgreSQL with the repository's
explicit no-cost agent process fixture. Hold real sidebar GET requests after
initial loading. Independently observe the real NDJSON response and require
navigation plus rendered output while those GETs remain unresolved. Include
4x renderer CPU throttling, late acknowledgement after SPA navigation, failure
recovery, duplicate send, and desktop/mobile pre-ack feedback. Read persisted
messages back to assert one user turn. Runtime-fixture output is not live model
quality evidence.

The acceptance matrix also requires crossing the responsive breakpoint in both
directions while the initial POST is unresolved, retaining text/attachment
feedback and the duplicate-send lock, then opening the acknowledged conversation.
Test failed delivery after remount and successful retry; actual navigation and
organization switches must still supersede foreground handoff. An older final
callback must not clear a newer first-turn operation.
If a first-turn failure arrives after leaving its source, retain the source
draft without replacing a newer draft. A conflicting recovery uses a separate
recoverable draft and an explicit source-organization-scoped toast action; no
automatic navigation. Release recovered attachment references after successful
retry. Test the recovery action through the browser, not only store contents.

## Integration ownership

The operator explicitly assigned integration to this task after concurrent Chat
edits were detected. Preserve unrelated shared-worktree changes. Reconcile the
overlapping first-send implementation against the current user requirement;
retain useful parallel attachment/reload/failure regression coverage instead of
discarding the other work wholesale. Verify the final integrated source, not just
an earlier isolated diff. The initial independent receipt was FAIL, so neither
the previous stage accept nor passing focused tests count as final acceptance.

For invalidations, use actual QueryClient/QueryObserver with deferred query
functions and existing cache, not only mocked invalidateQueries call counts.
Check descendant coverage, organization isolation, and later-event freshness.

Stage review precedes independent black-box acceptance; final review reads the
verifier receipt and exact candidate fingerprint. Screenshots belong outside
the repository. Do not overwrite concurrent edits in the shared checkout.

## Next performance work, not delivered by this slice

1. Capture a production-renderer trace with representative long histories and
   concurrent runs. Record input-to-paint, navigation-to-content, long tasks,
   request counts and bytes. Separate browser CPU, API latency, DB wait, and
   agent startup rather than inferring server performance from a screenshot.
2. Narrow ChatGeneration subscriptions: sidebar activity consumers should not
   subscribe to full streaming bodies. Verify actual render counts before
   choosing selectors or external-store seams.
3. Profile expensive history/Markdown work and stabilize row props; introduce
   windowing only with scroll anchoring, search/jump, selection and accessibility
   regression coverage. Do not apply memoization indiscriminately.
4. Inventory mutation journeys and remove nonessential refetches from UI critical
   paths. Keep optimistic pending, acknowledged, failed and retry states explicit.
   Destructive/governed operations still require authoritative confirmation.
5. If event bursts remain expensive after deduplication, design per-key bounded
   coalescing with a trailing refresh so events arriving during an in-flight
   snapshot are not lost. Blind cancelRefetch:false is not a freshness strategy.

No percentage speedup or whole-app latency guarantee is claimed until measured
against a frozen production build and representative workload.
