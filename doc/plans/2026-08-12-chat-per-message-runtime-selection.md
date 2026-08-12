---
title: Per-message Chat runtime selection
date: 2026-08-12
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - chat_runtime
related_plans:
  - 2026-07-23-chat-conversation-model-selector.md
supersedes:
  - 2026-07-23-chat-conversation-model-selector.md
related_code:
  - packages/shared/src/validators/chat.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/chat-assistant.ts
  - ui/src/api/chats.ts
  - ui/src/pages/Chat.model-selector.tsx
  - ui/src/pages/Chat.tsx
  - tests/e2e/chat-conversation-model-selector.spec.ts
commit_refs: []
updated_at: 2026-08-12
---

# Per-message Chat Runtime Selection

## Decision

Model and Thinking in the Chat composer configure the next submitted message,
not the conversation. Selecting either value is local draft work and must not
PATCH the existing conversation. The send request carries the explicit values,
and the server freezes them when admitting that message so an active or queued
generation cannot drift.

This replaces the earlier durable conversation-override interaction while
retaining legacy fields and server compatibility for existing records and
older clients.

## State Inventory

| State | Current decision | Visible controls | Deferred controls | Primary affordance | Continuity |
| --- | --- | --- | --- | --- | --- |
| New or existing Chat draft | Runtime for the next message | Bound Agent, Model, Thinking, context, composer | Run-only evidence | Send | Selection remains local to this composer draft |
| Sending or queued | No new runtime decision for the admitted message | Frozen submitted message and active run state | Later-message runtime choice | Stop or await result | Server owns an immutable Agent/model/effort snapshot |
| Send accepted | Runtime for a future message | Agent defaults in the composer | Optional overrides until reopened | Compose next message | Submitted overrides clear after acknowledgement |
| Send rejected before acknowledgement | Retry the same draft | Previous text, attachments, Model, Thinking | Future-message reset | Retry Send | Draft runtime selection is restored with the failed draft |
| Provisional Side Chat accepted, message rejected before acknowledgement | Retry the first Side Chat message | Persisted hidden Side Chat, previous text, attachments, Model, Thinking | Future-message reset | Retry Send | Provisional-to-persisted identity change does not clear the composer runtime draft |
| Legacy conversation with attachment | Runtime for the next modern message | Agent defaults unless locally overridden | Historical conversation override | Send | Multipart submission carries explicit default intent and does not revive the legacy override |
| Switch/close/reopen conversation | Runtime for a newly composed message | Agent defaults unless that composer draft is still intentionally resident | Prior submitted override | Compose | No conversation-level runtime preference is restored |

Safety-critical context is the bound Agent and its inherited runtime defaults.
Changing Model or Thinking replaces only the next message's primary model and
adapter-owned effort; credentials, workspace, skills, fallbacks, permissions,
and the Agent binding remain unchanged. Back/Close dismiss menus without
changing the selection. There is no separate Save or Cancel action because the
selection is part of the composer draft. Reopen does not restore a previously
submitted override.

## Implementation

1. Keep runtime selection in UI draft state for both new and existing Chats.
2. Extend existing-message stream requests with nullable model and effort
   overrides and validate them against the bound Agent before admission.
3. Freeze the effective Agent, model, and effort at direct-run and queue
   admission boundaries; never mutate an in-flight generation.
4. Clear UI overrides only after the server acknowledges the submitted message;
   preserve them on pre-acknowledgement failure.
5. Remove the saving row, mutation spinner, and conversation PATCH from the
   selector while retaining visible error handling for model discovery and send
   admission.
6. Update focused tests, server route coverage, and the real E2E workflow for
   current-run isolation, queued-message isolation, reset-after-send, and
   failure recovery.
7. Synchronize `CHAT.LIFECYCLE.001` and `AGENT.RUNTIME.ADAPTERS.001`, then run
   `pnpm product-logic:check`.

## Acceptance Criteria

- Selecting Model or Thinking in an existing Chat performs no conversation
  PATCH and renders no Saving status.
- The next Send invokes the bound Agent with the selected model and effort.
- A currently running or already queued message retains its admitted runtime.
- After acknowledgement, the composer returns to Agent defaults; a rejected
  send preserves the selection for retry.
- Refreshing or reopening an idle conversation does not restore the last sent
  override.
- Existing conversation override records remain readable for compatibility but
  the current Messenger interaction does not create or update them.
- Desktop and constrained rendered evidence show stable layout without the
  removed saving row.
