---
title: Chat response annotations
date: 2026-07-23
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - response_annotations
  - process_transcript
  - side_chat
issue:
related_plans:
  - 2026-06-01-chat-running-queue-steer.md
  - 2026-06-30-chat-side-panel.md
  - 2026-04-30-chat-user-input-composer-panel.md
supersedes: []
related_code:
  - packages/shared/src/types/chat.ts
  - packages/shared/src/validators/chat.ts
  - server/src/services/chats.ts
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.messages.tsx
  - ui/src/components/MarkdownBody.tsx
commit_refs: []
updated_at: 2026-07-23
---

# Chat Response Annotations

## Summary

Add Codex-style annotations to stable assistant responses and visible Process
text in Rudder Chat. Selection actions, numbered source markers, optional
comments and attachments, composer previews, and sent-message evidence follow
the Codex interaction while using Rudder design tokens.

Annotations belong to the user message that sends them. They are persisted as a
typed structured payload rather than as independent database entities. Queue,
Steer, edit, retry, Fork, and Side Chat must preserve their meaning.

## Interaction

- A valid selection exposes `Add to chat`, `More details`, and
  `Ask in side chat`.
- `Add to chat` attaches the selection without changing the message body.
- `More details` attaches it and inserts a localized request for more detail
  without sending.
- `Ask in side chat` stages the annotation in a provisional Side Chat while
  preserving the main composer.
- Each annotation may contain an optional comment and its own image or file
  attachments. Draft annotations support edit, attachment upload/removal, and
  delete. Sent annotations are immutable and inspectable.
- The composer and sent user message expose an `N annotations` chip and an
  ordered detail popover. Empty message bodies are valid when at least one
  annotation exists.
- Source markers are ordered within the active annotation set. Historical
  markers are restored while inspecting a sent annotation set and can reveal
  collapsed Process evidence.

## Contracts And Persistence

- Add shared typed annotation and attachment-reference schemas with strict
  quantity and size limits.
- Final answers anchor to canonical Markdown source offsets, context, and body
  hash. Process annotations additionally retain generation event sequence
  provenance through live and persisted transcript normalization.
- Existing message, stream, multipart, queue, and Side Chat send paths accept
  annotations. The server verifies organization, lineage, source visibility,
  status, and anchor integrity before persisting canonical snapshots under
  `structuredPayload.inlineAnnotations`.
- Annotation files reuse Chat asset upload and attachment ownership. Draft and
  queued requests use bounded file indexes or server-owned staged asset
  references; after Send, canonical annotations reference the owning user
  message's `chat_attachments` IDs. Images and other files remain scoped to the
  same organization, conversation, user message, and annotation.
- Runtime prompts render selected text, operator comments, and attachment
  metadata as bounded user-authored context. Selected Process text remains Run
  evidence and is not promoted to assistant output.
- Activity and diagnostic logs contain only annotation counts and source IDs;
  they never duplicate selected text, comments, visible Thinking, or file
  contents.
- Fork remaps source message IDs and preserves annotation attachment ownership.
  Work Manifest and automatic learning ignore annotation payloads.

## Product Logic Delta

Add `CHAT.RESPONSE.ANNOTATION.001` to the Product Logic Registry and update the
following contracts:

- `CHAT.LIFECYCLE.001`: annotation-only input and Queue/Steer durability.
- `CHAT.FORK.001`: copied message references and attachment ownership.
- `CHAT.SIDE.CHAT.001`: selected excerpt staging and first-Send persistence.
- `CHAT.THREAD.MANIFEST.001`: annotations are not manifest rows.
- `RUN.RESULT.001`: explicitly selected visible Process text may become
  user-authored quoted context without changing final-result boundaries.
- `RUN.CHAT.AGENT.001`: bounded prompt projection and generation provenance.

## Validation

- Shared and server tests cover limits, organization boundaries, stale anchors,
  annotation-only sends, files, Queue/Steer, edit/retry, Side Chat, Fork, prompt
  projection, and Manifest exclusion.
- UI tests cover exact Markdown selection, CJK and inline syntax, comments,
  annotation files, draft migration, source markers, sent evidence, and
  keyboard/mobile behavior.
- Real E2E covers final answer and Process selection, multiple annotations,
  image/file attachments, More details, annotation-only Send, reload, Queue,
  Steer, Side Chat, failure recovery, and responsive screenshots.
- Run product logic checks, lint, recursive typecheck, unit/integration tests,
  relevant E2E, and the production build before hand-off.
