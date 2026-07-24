---
title: Chat response annotations
date: 2026-07-23
kind: implementation
status: completed
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
commit_refs:
  - 4ed984050
  - a628cfe98
  - e0ced9f28
  - c9b5ab75b
  - 90e793145
  - 5e8d474c5
  - 1eb4d7b2f
  - 69f0175d5
  - 32f5150a1
  - be76b47ed
  - 25e0aa635
  - 5a65aac57
updated_at: 2026-07-24
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

## Completion Evidence

- `pnpm product-logic:check`: 78 contracts valid.
- `pnpm -r typecheck`: passed.
- `pnpm build`: passed.
- Changed-file import lint: 48 files passed; `git diff --check` passed.
- Focused shared, server, and UI suites: 296 tests passed, including 38
  annotation-validation cases.
- Response annotation E2E: 10/10 passed on the final source revision.
- Adjacent Side Chat, transcript, draft-persistence, and message-layout E2E:
  16/16 passed.
- Independent adversarial review found no remaining P0, P1, or P2 findings.
- Independent real-runtime verification passed against a fresh isolated Rudder
  instance with real API, UI, embedded PostgreSQL, annotation-only multipart
  Send, comment plus PNG/TXT attachments, reload persistence, source navigation,
  Queue/Steer, retry/edit/Fork, Side Chat, and responsive layouts.
- The full repository test command reported unrelated order-dependent or
  pre-existing failures; every feature-adjacent failure was rerun in isolation
  and passed. Full import lint remains blocked by two unchanged baseline test
  files outside this plan.
