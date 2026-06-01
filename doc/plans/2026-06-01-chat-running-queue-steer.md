---
title: Chat Running Queue And Explicit Steer
date: 2026-06-01
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - running_queue
  - chat_steer
issue:
related_plans:
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-05-07-chat-run-progress-recovery.md
  - 2026-05-22-automation-chat-output-and-activity-polish.md
supersedes: []
related_code:
  - packages/db/src/schema/chat_conversations.ts
  - packages/db/src/schema/chat_messages.ts
  - packages/shared/src/types/chat.ts
  - packages/shared/src/validators/chat.ts
  - server/src/services/chat-generation-locks.ts
  - server/src/services/chats.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - ui/src/api/chats.ts
  - ui/src/context/ChatGenerationContext.tsx
  - ui/src/pages/Chat.tsx
commit_refs: []
updated_at: 2026-06-02
---

# Chat Running Queue And Explicit Steer

## Summary

Agent chat should remain writable while a reply is running. A user message sent
during an active generation becomes a queued follow-up by default. It is not
interpreted as stop, interrupt, correction, or mid-run guidance. The user can
explicitly steer one queued item into the current generation with a separate
action.

V1 must make the queue durable and visible, preserve FIFO order, avoid duplicate
execution, and avoid claiming that steer succeeded when the runtime cannot
actually accept mid-run input.

## Problem

The current chat generation lock rejects a second send with `409 A chat reply is
already being generated for this conversation`. That forces users to wait or
stop the run before adding follow-up context. It also leaves no explicit product
surface for the common Codex-style choice between "queue this for later" and
"steer the currently running agent".

## Scope

- In scope: a durable per-conversation running queue, queue list/create/edit/
  cancel routes, explicit steer route, visible queue strip in Messenger, stop/
  failed preservation, reconnect sync, and tests for server/API/UI behavior.
- In scope: a conservative V1 steer fallback. If the active runtime handle does
  not support true mid-run delivery, the item stays queued with a visible
  `unsupported` result.
- In scope: preserving the message payload snapshot needed for later execution:
  body, attachment ids where available, model/runtime hints, and selected
  project/skills/access metadata when the client supplies them.
- Out of scope: conversation-level "turn off queueing", AI intent
  classification, cross-runtime true mid-run injection for runtimes that do not
  expose it, and issue activity fan-out beyond chat-visible evidence.

## Implementation Plan

1. Add chat queue schema and shared contracts.
   - `chat_queued_messages` stores org, conversation, position, status, version,
     idempotency key, payload snapshot, expected/active generation ids,
     delivery attempts, last delivery reason, and source message ids.
   - `chat_generations` stores durable generation status for current and
     terminal chat turns.

2. Add server queue service methods.
   - List authoritative queue snapshot.
   - Create idempotent queued item.
   - Edit queued item with optimistic version guard.
   - Cancel queued item.
   - Attempt steer with expected active generation guard.
   - Claim the next FIFO item for manual or automatic continuation.

3. Update generation locking.
   - Keep the existing in-memory abort controller path.
   - Add generation id/status metadata.
   - Return `unsupported` for steer when no runtime handle can accept true
     mid-run guidance.

4. Update chat routes.
   - Running stream send remains the active-generation path.
   - Non-stream send and stream send return queue responses when the same chat
     is already active instead of returning 409.
   - Add queue management endpoints under `/chats/:id/queue`.
   - Stop/failed/aborted runs keep queued items and do not auto-dequeue.

5. Update Messenger UI.
   - Keep the composer enabled while a stream is active.
   - While active, the send action creates a queue item instead of starting a
     concurrent generation.
   - Render a compact bottom queue strip with Up next, Steer, Edit, Delete, and
     fallback state.
   - Keep the existing stop button available for the active generation.

6. Add coverage.
   - Server route/service tests for FIFO, idempotency, conflicts, stale
     generation, unsupported steer fallback, stop preservation.
   - UI tests for running send creates queue and queue actions render.
   - E2E for running queue and unsupported steer fallback in a real browser
     workflow.

## Design Notes

- Queue is the default. Steer is an explicit user action.
- No intent inference is allowed in V1.
- Only `completed` generations may auto-continue. `stopped`, `failed`, and
  `aborted` leave queue items parked for manual action.
- A steer result is accepted only when runtime delivery and transcript
  persistence both happen. Transcript-only evidence is not accepted steer.
- A queued item that cannot steer remains FIFO-eligible with
  `last_delivery_reason`, not a separate long-lived fallback state.
- Manual continue must claim the lowest-position queued item; it cannot bypass
  FIFO by arbitrary item id.

## Success Criteria

- Sending while a chat generation is active creates a visible queued item rather
  than returning 409 or starting a concurrent generation.
- Queued items are org-scoped, conversation-scoped, ordered, idempotent, and
  editable/cancellable before claim.
- Explicit Steer returns a clear result. Unsupported/stale/closing generations
  keep the item queued.
- Stop and failure keep queue state and do not auto-continue.
- Reconnect can load an authoritative queue snapshot.
- The UI makes the difference between active stream, queued follow-up, and steer
  fallback understandable without hidden intent inference.

## Validation

- `pnpm --filter @rudderhq/server typecheck` passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm -r typecheck` passed.
- `pnpm exec vitest run server/src/__tests__/chat-routes.test.ts` passed.
- `pnpm test:e2e tests/e2e/chat-concurrent-streaming.spec.ts` passed, covering
  concurrent chats, default queueing, in-place queued edit, unsupported steer
  fallback, parked queue after stop, and active stream route persistence.
- `pnpm build` passed.
- `pnpm test:run` was run and still fails on existing markdown snapshot
  assertions in unrelated UI tests that expect exact HTML without
  `data-markdown-source-*` attributes.

## Open Issues

- True mid-run runtime injection is adapter-dependent. This implementation must
  not overclaim accepted steer for unsupported runtimes.
- V1 auto-dequeue is client-driven from the authoritative queue snapshot. A
  future server-side worker can reuse the same FIFO claim/release contract if
  queue execution needs to continue without an open browser session.
