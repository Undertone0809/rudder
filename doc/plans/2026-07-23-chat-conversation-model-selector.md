---
title: Conversation-scoped Chat runtime selector
date: 2026-07-25
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - chat_runtime
issue: R6Z-16
related_plans:
  - 2026-07-20-atomic-chat-first-turn.md
  - 2026-06-01-chat-running-queue-steer.md
  - 2026-04-28-rud-157-model-fallback.md
  - 2026-05-07-remove-copilot-default-runtime.md
supersedes: []
related_code:
  - packages/db/src/schema/chat_conversations.ts
  - packages/db/src/schema/chat_queued_messages.ts
  - packages/shared/src/types/chat.ts
  - packages/shared/src/validators/chat.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/services/chats.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - ui/src/api/chats.ts
  - ui/src/pages/Chat.model-selector.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.workspace-helpers.ts
  - tests/e2e/chat-conversation-model-selector.spec.ts
commit_refs: []
updated_at: 2026-07-25
---

# Conversation-scoped Chat Runtime Selector

## Summary

Replace the composer Agent picker with direct model and thinking-effort
controls scoped to one Chat conversation. The internally bound Agent remains
the owner of runtime type, credentials, workspace, skills, fallbacks, and other
configuration; the conversation may replace only the primary model and effort
used by future turns. Both overrides are durable for that conversation, while
queued messages preserve the effective model and effort captured when they
entered the queue.

## Problem

Chat currently exposes the Agent identity in the composer even though the
operator's turn-by-turn choice is the runtime model. Operators cannot try a
different primary model or reasoning effort for one conversation without
modifying the durable Agent, and queued continuations would drift if
conversation-level choices were added without admission snapshots.

## Scope

- Persist nullable `chat_conversations.model_override` and
  `chat_conversations.effort_override`.
- Accept the override in draft preflight, atomic first-turn creation, and native
  Chat PATCH requests.
- Resolve model and effort in this order: queued-message snapshot,
  conversation override, Agent default.
- Preserve the Agent fallback chain and every runtime setting other than the
  two explicit conversation overrides.
- Clear an incompatible inherited or overridden Codex effort to Auto only in
  the derived invocation config.
- Reuse runtime-owned model discovery, Codex ordering, effort options, and
  compatibility rules in a compact composer runtime selector.
- Remove Agent choices from the composer. The selected Agent remains an
  internal immutable binding after conversation start.
- Keep forks, Side Chats, other conversations, and new drafts on the Agent
  defaults unless the operator explicitly chooses overrides in that surface.
- Reject override mutation for externally bound or otherwise read-only
  conversations.

Out of scope:

- Adding a free-form model input.
- Copying model or effort overrides into a fork or Side Chat.
- Changing the bound Agent from the composer.
- Replacing the Agent's runtime type, fallbacks, credentials, or workspace from
  Chat.

## Implementation Plan

1. Add both schema columns and one migration, then synchronize shared types,
   validators, service creation inputs, hydration, and activity evidence.
2. Extend runtime resolution so descriptors expose the effective model and
   effort and invocation config applies only the winning values. Include both
   queue snapshots as explicit invocation options so an already-running turn
   remains immutable.
3. Snapshot the effective model and effort at every queue admission path and
   mark those server-owned snapshots with an explicit version. Restore both in
   ordinary dequeue and fallback Steer continuations, while treating unversioned
   legacy rows as conversation-runtime work rather than trusted snapshots.
4. Extend draft preflight and atomic first-turn requests with
   `modelOverride` and `effortOverride`. Reset draft overrides when the internal
   Agent scope changes, and clear persisted overrides when a preferred Agent
   changes.
5. Replace the composer Agent pill/menu with one keyboard-accessible runtime
   pill/menu containing model and thinking controls. Block Send and Queue only
   while a runtime PATCH is unresolved; Stop remains available. Move focus to
   the model control on open and restore the trigger on Escape.
6. Add schema/validator, route, runtime, queue, UI, and Playwright coverage,
   then verify desktop light/dark and narrow layouts in a real browser.
7. Synchronize `CHAT.LIFECYCLE.001` and `AGENT.RUNTIME.ADAPTERS.001`, run the
   repository validation suite, and complete independent review and black-box
   verification.

## Design Notes

- `ChatRuntimeDescriptor.model` and `.effort` expose effective values.
  `ChatConversation.modelOverride` and `.effortOverride` retain whether the
  conversation inherits or overrides Agent defaults.
- A queue item stores its effective model and effort at admission. Later edits
  may change message content but must retain both snapshots. Lost-response
  replay also returns the original snapshots even if conversation controls
  changed meanwhile.
- Only queue items carrying the server-written snapshot version may restore
  model and effort into an invocation. Pre-existing unversioned rows ignore
  those historically client-controlled fields and retain their original
  idempotency fingerprint algorithm.
- A runtime PATCH does not interrupt or rewrite the invocation config already
  resolved for an active response. It affects only future turns admitted after
  the PATCH commits.
- Switching the preferred Agent through non-composer repair flows clears both
  conversation overrides atomically to prevent provider-specific values from
  leaking across runtime boundaries.
- Unknown persisted model identifiers remain visible as the current choice, but
  the Chat selector offers only the runtime-owned catalog for new selections.
- Nullable effort means Agent default. The explicit string `auto` means the
  conversation clears inherited effort.
- For Codex, an effort unsupported by the selected model is omitted from the
  derived invocation config, which is equivalent to Auto. The Agent
  configuration remains unchanged.

## Success Criteria

- Selected model and effort overrides are persisted, displayed after refresh,
  and used by the next Chat run without changing the Agent record.
- Restoring either `Agent default` clears that stored override.
- A running reply continues with its start-time model and effort.
- A queued ordinary continuation and fallback Steer continuation use their
  queue-time model and effort even after conversation overrides change.
- The composer exposes no Agent choices and keeps the model/effort controls
  usable after the first turn.
- New conversations, forks, Side Chats, and externally bound Chats do not
  inherit or mutate unrelated overrides.

## Validation

- Generate and inspect the Drizzle migration.
- Run focused shared, DB, Chat route, assistant/runtime, queue/Steer, and UI
  tests.
- Add and run `tests/e2e/chat-conversation-model-selector.spec.ts`.
- Verify desktop light and dark themes plus a narrow viewport with screenshots.
- Run `pnpm lint`, `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, and
  `pnpm product-logic:check`.
- Run independent adversarial review and black-box verification before handoff.

## Open Issues

- Dynamic provider model discovery can fail. The selector must preserve and
  display the current effective model, surface the discovery failure, and keep
  the Agent-default restore action available.
- The Product Logic delta for `CHAT.LIFECYCLE.001` and
  `AGENT.RUNTIME.ADAPTERS.001` remains pending explicit operator authorization
  under the guarded-doc workflow.
