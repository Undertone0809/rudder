---
title: Chat composer file drop
date: 2026-07-26
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_attachments
issue: R6Z-24
related_plans:
  - 2026-07-25-chat-composer-pending-attachment-layout.md
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.file-drop.tsx
  - ui/src/pages/Chat.messages.tsx
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - ui/src/pages/UiLab.tsx
  - tests/e2e/chat-paste-attachments.spec.ts
commit_refs: []
updated_at: 2026-07-26
---

# Chat Composer File Drop

## Summary

Let operators drag one or more files onto the Chat composer and stage them
through the existing pending-attachment pipeline. The composer shows a clear
copy affordance while a file drag is over the drop target.

## Problem

Chat already supports adding files from the picker and pasting clipboard
files, but dropping files onto the input surface does nothing. This breaks a
common desktop workflow and makes the composer feel less capable than its
visible attachment support suggests.

## Scope

- Accept file drags on both new and existing native Chat composers, including
  the attachment-capable `ask_user` answer panel.
- Reuse existing file materialization, pending preview, removal, send, and
  failure-retention behavior.
- Show a bounded visual drop target while files are over the composer.
- Preserve native text and link drag/drop behavior.
- Keep external-bound read-only Chat unchanged.
- Do not change upload APIs, persistence, file policy, or Product Logic
  Registry prose.

## Implementation Plan

1. Added file-only drag detection and nested drag-depth handling to Chat.
2. Routed dropped files into the existing pending attachment callback.
3. Rendered an accessible, pointer-transparent drop overlay.
4. Added component regression tests for feedback, staging, nested leave
   handling, `ask_user`, and non-file drags.
5. Extended Chat attachment E2E coverage with the visible drag/drop workflow.

## Design Notes

The browser emits `dragenter` and `dragleave` for descendants as the pointer
moves across the composer. A depth counter prevents the drop affordance from
flickering. Only drags whose transfer advertises files are cancelled; normal
editor text/link drags keep their default behavior.

This is an additional input affordance for the existing attachment path under
`CHAT.LIFECYCLE.001`, not a persistence or lifecycle contract change.

## Success Criteria

- Dropped files appear in the same pending attachment preview used by the file
  picker and clipboard paste.
- Multiple files remain distinct and removable.
- The copy affordance appears only for file drags and clears on leave or drop.
- Plain text drags are not intercepted.
- The dropped files can be sent through the normal Chat workflow.

## Validation

- Focused Chat attachment component tests.
- Chat attachment Playwright E2E.
- UI typecheck, repository-required checks, and product-logic structural check.
- Real browser drag/drop verification with final screenshot evidence.

Focused component coverage, targeted Playwright coverage, repository lint,
workspace typecheck, production build, diff checks, and Product Logic
validation pass. The repository-wide Vitest run was also executed, but remains
red from unrelated pre-existing and environment-coupled failures in the active
local Rudder runtime; all file-drop-specific tests pass.

## Open Issues

None.
