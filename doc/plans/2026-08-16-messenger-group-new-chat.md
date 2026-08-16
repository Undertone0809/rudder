---
title: Messenger group-scoped new chat
date: 2026-08-16
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_lifecycle
  - messenger_group
issue:
related_plans:
  - 2026-07-20-atomic-chat-first-turn.md
  - 2026-06-22-chat-fork-conversation-groups.md
supersedes: []
related_code:
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/api/chats.ts
  - packages/shared/src/validators/chat.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/chats.create.ts
  - server/src/services/chat-family-groups.ts
  - doc/product/domains/collaboration/chat-messenger-im.md
commit_refs: []
updated_at: 2026-08-16
---

# Messenger Group-Scoped New Chat

## Summary

Add `New chat` to each Messenger custom group's actions menu. The action opens
the existing unpersisted Chat draft with the selected group as ephemeral
context. The first accepted user message remains the creation boundary; only
then is `chat:<conversationId>` added to that operator's group.

## Scope

- Add group-menu navigation to `/messenger/chat?groupId=<groupId>`.
- Carry the optional group context through the first-turn JSON and multipart
  stream requests.
- Assign the new Chat in the same transaction as its conversation and first
  message, with organization/operator ownership checks and placement locks.
- Treat a deleted, missing, or foreign group as a normal loose Chat.
- Update the guarded Chat lifecycle and Messenger custom-group contracts and
  registry references as authorized for this task.

No empty conversation is created when the group action is opened. No database
migration is required.

## State Inventory

| State | Current decision, visible controls, and primary action | Deferred controls and safety or continuity requirement |
| --- | --- | --- |
| Group menu open | `New chat` is the focal peer action in the existing group actions menu | Chat composer controls and membership mutation are deferred; selecting it navigates only and sends no Chat create request |
| New Chat draft | Existing Agent, Project, Plan, attachment, and composer controls; `Send` is the primary action | Conversation membership and Chat list effects are deferred; `groupId` remains URL-scoped draft context and no group mutation occurs. Back, browser navigation, and closing the draft leave no persisted Chat; there is no intentional Reopen restoration contract beyond the existing local draft behavior |
| First message submitting | Existing streaming send state with the active send/stop controls | Later Chat actions and group management are deferred until acknowledgement; the server validates group ownership inside the creation transaction |
| First message acknowledged | Normal Chat transcript and navigation; the accepted Chat is the primary result | Draft-only controls are replaced by normal Chat actions; Chat is durable, group cache refreshes, and the row appears in the group |
| Group deleted before send | Normal draft and `Send` primary action | Group membership is deferred and then skipped; creation succeeds without grouping and does not recreate the group |
| Refresh/reopen | Normal Messenger and Chat routes with the durable Chat visible | No new decision is introduced; successful membership survives reload. Failed pre-ack sends preserve the existing draft behavior, while Back/Cancel/Close do not create a Chat |

## Implementation

1. Add the group action and pass `groupId` from `Chat.tsx` to the existing
   first-turn API. Clear the query context only after the first-turn
   acknowledgement navigates to the accepted Chat.
2. Extend only `createChatFirstTurnSchema` and
   `ChatFirstMessageStreamOptions`. Send the field in both JSON and multipart
   requests; ordinary Chat create/update and existing Chat message requests
   remain unchanged.
3. Extend the Chat creation transaction with an explicit Messenger owner ID.
   Lock the owner and group in the same order used by group deletion, re-read
   the operator-scoped group, and append `chat:<conversationId>` when it still
   exists. Missing or foreign groups are a no-op; unexpected persistence
   failures roll back the Chat transaction.
4. Invalidate the custom-group query after first-turn acknowledgement and
   update the Product Logic Registry references.

## Validation

- Component test for group-menu navigation without empty Chat creation.
- API serialization tests for JSON and multipart group context.
- Shared validator, route, and service tests for successful assignment,
  missing/deleted/foreign fallback, ownership, locking, and rollback.
- E2E test for group menu -> normal Chat -> first message -> grouped row ->
  reload, plus deletion-before-send fallback.
- Run `pnpm product-logic:check`, focused tests, relevant E2E, lint, recursive
  typecheck, full tests, and build where feasible.
- Use `ego-browser` on the exact final candidate for desktop and constrained
  viewport screenshots, interaction proof, and console/error checks.
- Obtain independent reviewer `accept`, verifier `PASS`, and final review on
  the same candidate before scoped commit and push.

## Success Criteria

The user can start a normal Chat from any custom group without creating an
empty row, and the Chat appears in that group after its first message is
accepted. Group deletion or ownership changes cannot cause an incorrect
membership, cross-operator placement, or failed Chat creation.
