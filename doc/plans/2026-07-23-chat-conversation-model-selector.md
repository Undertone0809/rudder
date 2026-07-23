---
title: Conversation-scoped Chat model selector
date: 2026-07-23
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
  - packages/shared/src/types/chat.ts
  - packages/shared/src/validators/chat.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/services/chats.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - ui/src/api/chats.ts
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.workspace-helpers.ts
  - tests/e2e/chat-conversation-model-selector.spec.ts
commit_refs: []
updated_at: 2026-07-23
---

# Conversation-scoped Chat Model Selector

## Summary

Add an explicit primary-model override to one Chat conversation. The selected
Agent remains the owner of runtime type, credentials, workspace, skills,
fallbacks, and other configuration; the conversation may replace only the
primary model used by future turns. The override is durable for that
conversation, while queued messages preserve the effective model captured when
they entered the queue.

## Problem

Chat currently resolves every turn from the selected Agent's current runtime
configuration. Operators cannot try a different primary model for one
conversation without modifying the durable Agent, and queued continuations
would drift if a conversation-level choice were added without a snapshot.
Locked conversations also disable the entire Agent menu, leaving no place for a
conversation-scoped runtime choice after the first turn.

## Scope

- Persist nullable `chat_conversations.model_override`.
- Accept the override in draft preflight, atomic first-turn creation, and native
  Chat PATCH requests.
- Resolve the primary model in this order: queued-message snapshot,
  conversation override, Agent default.
- Preserve the Agent fallback chain and every non-model runtime setting.
- Clear an incompatible inherited Codex effort only in the derived invocation
  config.
- Reuse runtime-owned model discovery and Codex ordering in a compact selector
  on the selected Agent row.
- Keep the Agent immutable after conversation start while allowing its menu to
  open for model changes.
- Keep forks, Side Chats, other conversations, and new drafts on the Agent
  default unless the operator explicitly chooses an override in that surface.
- Reject override mutation for externally bound or otherwise read-only
  conversations.

Out of scope:

- Editing thinking effort in Chat.
- Adding a free-form model input.
- Copying a model override into a fork or Side Chat.
- Replacing the Agent's runtime type, fallbacks, credentials, or workspace from
  Chat.

## Implementation Plan

1. Add the schema column and migration, then synchronize shared types,
   validators, service creation inputs, hydration, and activity evidence.
2. Extend runtime resolution so descriptors expose the effective model and
   invocation config applies only the winning primary-model value. Include the
   queue snapshot as an explicit invocation option so an already-running turn
   remains immutable.
3. Snapshot the effective model at every queue admission path and restore it in
   ordinary dequeue and fallback Steer continuations.
4. Extend draft preflight and atomic first-turn requests with
   `modelOverride`. Reset the draft override when the selected Agent changes,
   and clear the persisted override when a preferred Agent changes.
5. Restructure the Agent menu so locked Agent choices remain disabled while the
   current row owns an independent keyboard-accessible model selector. Block
   Send and Queue only while a model PATCH is unresolved.
6. Add schema/validator, route, runtime, queue, UI, and Playwright coverage,
   then verify desktop light/dark and narrow layouts in a real browser.
7. Synchronize `CHAT.LIFECYCLE.001` and `AGENT.RUNTIME.ADAPTERS.001`, run the
   repository validation suite, and complete independent review and black-box
   verification.

## Design Notes

- `ChatRuntimeDescriptor.model` remains the effective model, not the Agent
  default. `ChatConversation.modelOverride` carries whether the conversation is
  overriding that default.
- A queue item stores its effective model at admission. Later edits may change
  message content but must retain the original model snapshot.
- A model PATCH does not interrupt or rewrite the invocation config already
  resolved for an active response. It affects only future turns admitted after
  the PATCH commits.
- Switching the preferred Agent clears the prior conversation override
  atomically to prevent a custom or provider-specific model identifier from
  leaking across runtime boundaries.
- Unknown persisted model identifiers remain visible as the current choice, but
  the Chat selector offers only the runtime-owned catalog for new selections.
- For Codex, an inherited reasoning effort unsupported by the selected model is
  omitted from the derived invocation config, which is equivalent to Auto. The
  Agent configuration remains unchanged.

## Success Criteria

- A selected override is persisted, displayed after refresh, and used by the
  next Chat run without changing the Agent record.
- Restoring `Agent default` clears the stored override.
- A running reply continues with its start-time model.
- A queued ordinary continuation and fallback Steer continuation use their
  queue-time model even after the conversation override changes.
- Agent selection stays locked after the first turn, while the menu and current
  Agent's model selector remain usable.
- New conversations, forks, Side Chats, and externally bound Chats do not
  inherit or mutate an unrelated override.

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
