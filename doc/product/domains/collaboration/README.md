---
title: Collaboration Domain
domain: collaboration
status: active
coverage: detailed
contract_ids: []
related_code:
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/chats.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/messenger.ts
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Messenger.tsx
related_tests:
  - server/src/__tests__/chat-routes.test.ts
  - server/src/__tests__/chat-assistant.test.ts
  - server/src/__tests__/messenger-service.test.ts
  - tests/e2e/messenger-contract.spec.ts
edit_policy: user_confirmed_only
---

# Collaboration Domain

## Owns

- Chat conversations, messages, attachments, rich references, and assistant
  turns, including the thread Work manifest.
- Messenger thread directory, unread state, custom groups, pin/archive/delete,
  Saved Views, and attention aggregation.
- Issue-thread presentation of comments/activity when shown in Messenger.
- External IM bridges that land in Messenger and then route agent work.

## Does Not Own

- Issue status or assignment. See `ISSUE.*` and `ROUTING.*`.
- Agent run execution. See `RUN.*`.
- Automation definition. See `AUTOMATION.*`.
- Local App command review, process authority, attestation, and shutdown. See
  `DESKTOP.LOCAL.APPS.001`.

## Contract Index

- `CHAT.LIFECYCLE.001`: chat is a conversation-driven task execution surface
  with durable messages, runs, outputs, and references.
- `CHAT.RESPONSE.ANNOTATION.001`: operators can attach precise stable assistant
  or visible Process selections, optional comments, and per-annotation files to
  a durable user message with source provenance and immutable sent evidence.
- `CHAT.INLINE.VISUAL.001`: provider-neutral, message-owned scriptless visuals
  render inside completed assistant answers without becoming Library files or
  Chat Work manifest items.
- `CHAT.TITLE.GENERATION.001`: chat titles use a first-user-message fallback
  plus organization Fast Intelligence generation/regeneration without blocking
  replies or overwriting explicit operator names.
- `CHAT.RICH.REFERENCE.RENDERING.001`: markdown rich-reference tokens keep
  consistent labels, icon rhythm, baseline alignment, and truncation behavior
  across composers and read-only rendered markdown.
- `CHAT.WEBSITE.LINK.ICON.001`: common websites use embedded recognizable icons
  without metadata requests, while unlisted sites retain safe discovery and
  generic-icon fallback.
- `CHAT.THREAD.MANIFEST.001`: each Chat exposes a typed, provenance-preserving
  current-thread Outputs/Sources/References index with organization-scoped
  normal-Chat reference titles, Side Chat privacy, and accessible one-line
  truncation.
- `CHAT.SIDE.PANEL.001`: Side Panel is a global board workbench for opening
  supported referenced issues, automations, Library targets, chats, Browser,
  and Local Apps; an eligible exact target can transfer to Messenger Main while
  its Side siblings remain in place.
- `MESSENGER.ATTENTION.001`: Messenger aggregates chat, issue, approval, and
  run attention without becoming the source of every domain rule.
- `MESSENGER.THREAD.PREVIEW.001`: delayed Chat and Issue detail cards expose
  truncated context while remaining mutually exclusive with row action menus.
- `MESSENGER.CUSTOM.GROUPS.001`: Messenger custom groups organize chat, issue,
  approval, synthetic attention, and Saved View rows in one sortable model
  while preserving each row's native navigation and attention semantics.
- `MESSENGER.SAVED.VIEWS.001`: Messenger durably binds eligible Browser,
  Automation, Library, and Desktop Local App views to group-only rows that open
  or focus the full-bleed Main Workbench rather than the Side Panel.
- `IM.FEISHU.001`: Feishu inbound/outbound integration bridges external chat
  into Rudder Messenger, issue, and run records.
