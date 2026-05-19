---
title: Messenger mention caret fix
date: 2026-05-19
kind: fix-plan
status: completed
area: chat
entities:
  - messenger_chat
  - plain_text_composer
  - mention_chips
issue:
related_plans:
  - 2026-04-30-chat-user-input-composer-panel.md
  - 2026-05-10-messenger-pinned-thread-summary.md
supersedes: []
related_code:
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/MarkdownEditor.test.tsx
commit_refs:
  - fix: keep mention caret after tab selection
updated_at: 2026-05-19
---

# Messenger Mention Caret Fix

## Incident Summary

In the Messenger plain-text composer, selecting an `@` mention with Tab rendered
the mention chip but moved the caret back to the beginning of the input. The
expected behavior is the normal typing model: after the mention renders, the
caret remains after the rendered chip so the next typed character continues the
same sentence.

## What Is Broken?

- Observed: type text, open an `@` mention, press Tab, then the input caret can
  jump to the start of the composer.
- Expected: Tab accepts the highlighted mention and leaves the caret immediately
  after the rendered mention chip.
- Impact: users composing chat messages can accidentally insert follow-up text at
  the start of the message, corrupting the draft.

## Root Cause Hypothesis

The composer has two representations of a mention: canonical markdown for
storage and a rendered atomic inline chip for editing. The Tab selection path
updated the markdown/chip but did not leave a stable editable text boundary after
the atomic chip. Lexical and the DOM selection could then restore focus at an
unhelpful fallback position.

## What Changed

1. Keep an editor-internal zero-width caret boundary after the inserted mention
   chip on the plain-text composer path.
2. Strip that internal boundary before `onChange`, draft persistence, and copy
   serialization so the saved markdown and clipboard text stay clean.
3. Re-find the rendered mention chip by href and visible label after rendering,
   then restore the Lexical and DOM selection after that chip.
4. Add regression coverage for Tab mention selection, post-chip caret placement,
   and copy behavior that must not leak the internal boundary character.

## Risk And Compatibility Notes

The boundary character is editor-internal only. It must never become part of the
external markdown value, persisted draft, or copied text. Non-plain-text editor
paths should continue to use the existing markdown behavior.

## Success Criteria

- Pressing Tab to accept a mention leaves the caret after the rendered mention.
- Continuing to type inserts after the mention, not at the start of the input.
- The external markdown remains canonical mention markdown.
- Copying text from the composer does not include the internal boundary marker.

## Validation

- Passed: focused `MarkdownEditor.test.tsx` suite, 16 tests.
- Passed: `@rudderhq/ui` typecheck.
- Passed: real-browser Messenger validation on `/r1/messenger/chat`: typed
  prefix text, accepted `@s` with Tab, verified the caret after the rendered
  chip, typed another character, and confirmed the canonical draft markdown.
- Accepted by both advisor-review-loop reviewers after the copy-path blocker was
  addressed.

## Open Issues

- Full repository typecheck and build were blocked by unrelated dirty Desktop
  changes in `desktop/src/cli-runner.ts`.
- Full `pnpm test:run` was blocked by unrelated embedded PostgreSQL init errors.
