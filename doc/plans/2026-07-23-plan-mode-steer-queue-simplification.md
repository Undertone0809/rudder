---
title: Plan Mode Steer And Queue Simplification
date: 2026-07-23
kind: fix-plan
status: implemented
area: chat
entities:
  - messenger_chat
  - chat_steer
  - running_queue
  - runtime_control
issue:
related_plans:
  - 2026-07-15-chat-steer-and-immediate-stop.md
supersedes: []
related_code:
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/app-server-chat.ts
  - server/src/services/chats.ts
  - ui/src/pages/Chat.tsx
  - tests/e2e/chat-concurrent-streaming.spec.ts
commit_refs: []
updated_at: 2026-07-23
---

# Plan Mode Steer And Queue Simplification

## Goal

Plan mode changes Codex execution permissions, not interactive control
capabilities. Standard Codex chats must keep native same-turn Steer whether
Plan mode is on or off. Queue remains the safe default while a response is
running and advances automatically.

The Chat UI exposes only the user concepts needed to act:

- `Queued` for a message waiting behind the active response;
- `Sending...` while a delivery request is in flight;
- `Steer` to apply a queued message to the active response immediately;
- `Retry` only after delivery is proven to have failed and automatic recovery
  is exhausted.

Internal reconciliation states remain durable but are not presented as product
concepts.

## Implementation

1. Treat the Plan overlay's `-s read-only` Codex argument as a structured App
   Server sandbox policy so it no longer disables the App Server chat path.
   Preserve CLI fallback for unsupported custom arguments or explicit App
   Server disablement.
2. Keep native Steer on the same provider turn and generation. A successful
   native acknowledgement removes the queue item without interrupting the run.
3. Decouple queue delivery from assistant-run completion. Once the queued user
   message is durably accepted for a continuation, mark it delivered; a later
   assistant stop or failure must not resurrect it as actionable delivery
   failure.
4. Reconcile legacy actionable rows that already have durable delivery evidence
   to delivered, and keep the server queue worker responsible for advancing
   eligible queued input after terminal transitions.
5. Project durable delivery state into the small UI vocabulary above. Remove
   success toasts and internal labels such as `Needs attention`, `Restarting
   with feedback`, `Running feedback`, and `Delivery unconfirmed`.
6. Render `steer_fallback` handoffs as conversation continuation rather than
   user-visible `Stopped`; preserve `Stopped` for explicit operator stop.
7. Keep Codex in-process App Server lag diagnostics in server logs without
   emitting them as chat-visible stderr blocks.

## Verification

- Unit coverage for App Server selection and read-only sandbox propagation.
- Service coverage for delivery acknowledgement, terminal-run independence,
  queue advancement, and legacy reconciliation.
- UI coverage for the reduced Queue vocabulary and Stop/Steer distinction.
- E2E coverage across Plan on/off and Steer/Queue workflows.
- Full lint, typecheck, tests, build, product-logic check, and real Desktop
  black-box verification with screenshots.

## Product Logic

The Plan/Steer, delivery acknowledgement, UI projection, fallback rendering,
and diagnostic filtering changes restore the existing behavior in
`CHAT.LIFECYCLE.001`, `RUN.CHAT.AGENT.001`, and
`AGENT.RUNTIME.ADAPTERS.001`.

The approved `CHAT.LIFECYCLE.001` delta makes a verified operator Stop eligible
to advance the next ordinary queued message through the server-owned worker.
The stopped generation remains visibly `Stopped`, while the queued message
starts a distinct subsequent turn. Failed, control-lost, aborted, and
unverified terminal states continue to leave ordinary queued work parked.
