---
title: Move Pending Chat Attachments Above the Composer Editor
date: 2026-07-25
kind: implementation
status: completed
area: ui
entities:
  - chat
  - chat_composer
issue: R6Z-21
related_plans: []
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - tests/e2e/chat-paste-attachments.spec.ts
commit_refs: []
updated_at: 2026-07-25
---

# Move Pending Chat Attachments Above the Composer Editor

## Summary

Treat pending image and file attachments as part of the draft content by
rendering their shared preview region above the text editor and above the
composer toolbar. Preserve all existing attachment behavior and change only the
visual order and spacing inside the normal Chat composer.

## Problem

Pending attachments currently render after the toolbar. That separates files
from the draft body they will accompany and puts Project, Agent, Skills, and
send controls between the two parts of the pending message.

## Scope

In scope:

- move the existing pending-attachment region before the editor scroll region;
- align its horizontal inset with the editor content and keep multi-file
  wrapping inside the composer boundary;
- keep image and non-image files in the same preview region;
- add unit and Playwright assertions for attachment/editor/toolbar order;
- visually verify desktop and narrow composer layouts.

Out of scope:

- attachment upload, persistence, protocol, or server changes;
- thumbnail sizing, image cropping, removal, preview, or keyboard behavior;
- changes to sent-message attachment rendering;
- semantic changes to `CHAT.LIFECYCLE.001` or edits to `doc/product/**`.

## Implementation Plan

1. Move `chat-pending-attachments` before
   `chat-composer-editor-scroll` in `Chat.tsx`.
2. Apply editor-aligned horizontal padding and bounded vertical spacing to the
   shared wrapping attachment region.
3. Extend the existing attachment preview component test to assert that the
   preview region precedes both the editor and toolbar.
4. Extend the paste-attachment Playwright flow with the same rendered-order
   contract while retaining paste, removal, send, and assistant-context checks.
5. Run focused unit and E2E tests, browser visual checks, and the repository
   validation suite.

## Design Notes

- The attachment region remains a sibling of the editor and toolbar inside the
  existing composer surface; it is not a floating or external shelf.
- Keeping the existing `PendingAttachmentPreview` mapping preserves duplicate
  filename identity, removal controls, 48px thumbnails, and image preview
  behavior.
- The editor keeps its current independent scrolling behavior. Pending
  attachments remain outside that scroll region so long draft text does not
  move them below the toolbar.

## Success Criteria

- Pending attachments appear above the draft body in new and existing Chats.
- The toolbar never separates pending attachments from the draft body.
- Mixed and repeated attachments wrap without covering the editor, toolbar, or
  removal controls.
- Removing the last attachment leaves no residual spacing.
- Paste, file selection, draft restoration, preview, removal, send, and
  sent-message attachment behavior remain unchanged.

## Validation

- `pnpm exec vitest run ui/src/pages/Chat.attachment-preview.test.tsx`
  passed (136 tests).
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts
  chat-paste-attachments.spec.ts` passed (3 tests).
- The finalized 480px Playwright geometry check passed with ten pending images,
  proving multi-row wrapping, container containment, and no editor overlap.
- Desktop and narrow browser screenshots confirmed the attachment/editor/toolbar
  visual order.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm build`, `git diff --check`, and
  `pnpm product-logic:check` passed.
- `pnpm test:run` was attempted but the repository-wide run encountered
  unrelated host/baseline failures, including widespread process timeouts,
  embedded PostgreSQL shared-memory exhaustion, and existing Pi/Claude runtime
  expectation mismatches. The focused Chat suite remained green.
- Independent reviewer and verifier checks reported no findings after the
  narrow-viewport geometry assertion was added.

## Open Issues

None.
