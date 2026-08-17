---
title: Chat wide visual inspection
date: 2026-08-17
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - inline_visual_artifacts
issue:
related_plans:
  - 2026-07-21-runtime-neutral-chat-inline-visuals.md
supersedes: []
related_code:
  - ui/src/pages/ChatInlineVisual.tsx
  - ui/src/components/MarkdownBody.tsx
  - ui/src/pages/Chat.messages.tsx
commit_refs: []
updated_at: 2026-08-17
---

# Chat Wide Visual Inspection

## Summary

Keep assistant prose at a readable width while allowing Markdown images,
Mermaid diagrams, and trusted inline visual pages to use a responsive wide
media lane. Every inspectable visual exposes direct preview and image-copy
actions without revealing its Markdown, Mermaid, or HTML source.

## Problem

Messenger currently constrains assistant output to the prose column even when
the workspace has substantially more horizontal space. Ordinary images already
use the shared image preview, but Mermaid and scriptless inline visual pages do
not expose equivalent preview or copy actions.

## Scope

- Expand only visual media to a maximum width of 72rem; keep prose near 72ch.
- Add hover, focus, and touch-accessible preview and copy actions.
- Capture Mermaid and inline visual output as bounded PNG snapshots of the
  current rendered state.
- Preserve the existing inline visual sandbox, CSP, persistence, and trust
  model.
- Do not change Server APIs, database data, or attachment classification.

## Implementation Plan

1. Add a reusable visual action overlay and bounded browser-native PNG capture
   helpers.
2. Add wide-media and preview-copy modes to read-only Markdown rendering.
3. Let Messenger assistant messages use the wide media lane while retaining
   the current composer and prose widths.
4. Add the same actions to trusted inline visual frames and synchronize the
   `CHAT.INLINE.VISUAL.001` contract.
5. Cover desktop, mobile, preview, copy, persistence, and failure behavior with
   component and end-to-end tests.

## Design Notes

- PNG capture is lazy and capped at 2x pixel density with a 4096px maximum
  edge.
- Inline visual capture serializes only the already-sanitized same-origin frame
  document. It never returns or displays the backing HTML source.
- The current checkout contains unrelated staged and unstaged changes and an
  unfinished user-owned cherry-pick. Implementation must preserve that state
  and stage only task-owned hunks after the repository operation is resolved.

## Success Criteria

- Desktop visual media uses the available Messenger width without widening
  prose or the composer.
- Preview and Copy Image are directly discoverable on hover and keyboard focus,
  and remain available on touch layouts.
- Mermaid and inline visual snapshots open in the shared image preview and copy
  as PNG.
- Narrow layouts do not overflow or occlude content.

## Validation

- Focused component tests for layout, actions, capture bounds, and errors.
- Chat Mermaid and inline visual E2E coverage.
- `pnpm product-logic:check`, lint, recursive typecheck, unit tests, and build.
- Independent reviewer and exact-candidate black-box verifier gates.
- Desktop and mobile rendered inspection through ego-browser.

## Open Issues

- Branch creation, commit, and push remain blocked while the pre-existing
  user-owned cherry-pick is active.
