---
title: Atomic Chat first turn and zero-message cleanup
date: 2026-07-20
kind: fix-plan
status: completed
area: chat
entities:
  - messenger_chat
  - chat_lifecycle
  - chat_message
  - im_binding
issue:
related_plans: []
supersedes: []
related_code:
  - packages/shared/src/validators/chat.ts
  - packages/shared/src/types/chat.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/chats.ts
  - server/src/services/automations.ts
  - server/src/services/integrations/feishu/inbound-dispatcher-db.ts
  - ui/src/pages/Chat.tsx
  - ui/src/api/chats.ts
  - cli/src/commands/client/chat.ts
  - cli/src/agent-v1-registry.ts
  - packages/db/src/migrations
  - tests/e2e/chat-explicit-agent-settings.spec.ts
commit_refs:
  - 20daadf50
  - b046a6c28
  - d48dfb4a1
  - 64ba3c684
  - ae78a6ce9
  - 7c2a2298e
  - eac0851fe
updated_at: 2026-07-20
---

# Atomic Chat First Turn

## Problem

The new-Chat UI currently persists a conversation before the first message is
accepted. Agent, runtime, model, context, attachment, or permission failures can
therefore leave a visible `New chat` row with no messages. A zero-message Chat
is not work evidence and must not exist in Messenger.

## Target Behavior

- A new Chat remains an unpersisted draft until the server accepts its first
  message.
- Validation and draft preflight are side-effect free.
- Conversation, context links, first message, deterministic title,
  `lastMessageAt`, attachments, generation metadata, and activity evidence use
  one lifecycle boundary before the stream acknowledges acceptance.
- A failure before acceptance leaves the draft and its URL, inputs, files,
  Agent, Project, and Plan mode intact.
- A runtime or generation failure after acceptance preserves the user message
  and visible failure evidence because real work was accepted.
- No production entry point may persist a zero-message Chat.

## Public Interfaces

1. Add `POST /api/orgs/:orgId/chats/preflight`. It performs the same
   organization, Agent/runtime/model, context, and permission checks as first
   send, without writing database or object-store state.
2. Add `POST /api/orgs/:orgId/chats/messages/stream`. It accepts the first body,
   Agent, Project/Issue context, Plan mode, and attachments. Its NDJSON `ack`
   returns both the new conversation and accepted user message.
3. Keep `POST /api/chats/:id/messages/stream` for existing Chats and preserve
   its protocol compatibility.
4. Require `initialMessage.body` on `POST /api/orgs/:orgId/chats`. The server
   derives the message role from the authenticated actor.
5. Require the first body through `--body` or stdin for `rudder chat create`,
   and require `body` in the `rudder_chat_create` MCP schema.

## Implementation

### Lifecycle service

Create one `createWithInitialMessage` transaction entry point. It owns the
conversation, context links, accepted message, title, `lastMessageAt`, and
activity evidence. Ordinary APIs, automations, and IM ingress must not insert
`chat_conversations` directly.

### First-turn stream

Resolve organization access, preferred/default Agent, runtime/model support,
context ownership, and attachment validity before opening the lifecycle
transaction. Files are staged safely before acceptance. The server sends `ack`
only after the first turn is durable. Generation starts at that accepted
boundary; later startup or generation failures remain visible in the Chat.

### UI draft

Run draft preflight for the selected Agent and context. Show the current
configuration error with `Open agents` and disable send while unavailable. Use
the first-turn stream endpoint without calling the create endpoint first. Cache,
clear, and navigate only after `ack`; preserve the complete draft before `ack`
on every failure.

### Internal producers

- Put `automation_run_input` and its conversation in one transaction.
- Put a Feishu session, binding, and first inbound/system event in one
  transaction.
- Keep Fork and Side Chat on their existing copy-history or system-event atomic
  boundaries.
- Add an architecture test that rejects unapproved production inserts into
  `chat_conversations`.

### Historical cleanup

Add a one-time migration that deletes unbound zero-message Chats. Bound
automation or IM zero-message Chats receive a structured recovery event, are
archived and hidden from Messenger, and have stale IM bindings invalidated so
the next inbound event creates a new atomic session. Recompute
`lastMessageAt`; no zero-message conversation may remain afterward.

## Risk, Compatibility, And Rollback

- Requiring `initialMessage.body` on the create API and `body` in the CLI/MCP
  surface is an intentional breaking compatibility change. All in-repository
  callers and fixtures must move to the atomic lifecycle boundary in the same
  release; older external callers receive a validation error instead of
  creating an empty Chat.
- Deleting unbound zero-message Chats is intentionally not reversible because
  those rows contain no conversation evidence. Before release, the migration
  must be tested against production-shaped bound and unbound fixtures and must
  report affected counts.
- Bound historical rows are not deleted: they receive recovery evidence, are
  archived and hidden, and their stale IM bindings are invalidated. Rollback of
  application code must not reactivate those bindings; restoring old binding
  behavior requires an explicit follow-up migration after verifying no inbound
  event would attach to an archived recovered Chat.
- Deployment rollback before the migration runs is ordinary code rollback.
  After it runs, rollback retains the cleaned data and must use the compatibility
  behavior above rather than attempting to reconstruct empty rows.

## Test Matrix

- Service/API: missing model/Agent, cross-org context, invalid attachment, and
  transaction failure add no conversation, message, or activity; success adds
  exactly one conversation and one first message.
- UI: preflight errors never call creation; pre-ack failures retain every draft
  field; navigation and clearing happen only after `ack`.
- E2E: unsupported runtime leaves Messenger/API unchanged; valid runtime creates
  one Chat with its first message; post-accept startup failure keeps message and
  failure evidence; automation, Feishu, Fork, and Side Chat never create empty
  records; migration cleanup and binding rotation are verified.

## Verification

Run `pnpm product-logic:check`, lint, recursive typecheck, tests, build, relevant
Chat E2E, real local black-box verification, screenshot capture, and an
independent adversarial review before hand-off.
