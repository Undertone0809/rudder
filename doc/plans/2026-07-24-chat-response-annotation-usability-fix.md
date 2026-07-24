---
title: Chat response annotation usability fix
date: 2026-07-24
kind: fix-plan
status: in_progress
area: chat
entities:
  - messenger_chat
  - response_annotations
issue:
related_plans:
  - 2026-07-23-chat-response-annotations.md
supersedes: []
related_code:
  - ui/src/components/chat/ResponseAnnotations.tsx
  - ui/src/lib/chat-response-annotation-selection.ts
  - ui/src/pages/Chat.tsx
commit_refs: []
updated_at: 2026-07-24
---

# Chat Response Annotation Usability Fix

## Goal

Restore `CHAT.RESPONSE.ANNOTATION.001` as a usable end-to-end workflow. A user
must be able to select rendered assistant text, add and edit one annotation at
a time, inspect details without resizing the composer, and send the result
without a rendered-text/source-range mismatch.

## Diagnosis And Constraints

- The draft detail card currently participates in composer layout, so expanding
  it pushes the editor downward and enlarges the input surface.
- Source-marker activation currently expands the complete draft list before
  opening one editor, exposing unrelated annotations.
- Marker placement uses the selected range's trailing edge without reserving or
  collision-checking space, so a marker inside a line can cover following text.
- The selected-text failure must be traced across rendered Markdown boundary
  metadata, client range serialization, and server canonical validation before
  changing either side. The server's exact-source verification remains intact.
- This is a behavior restoration and presentation fix under
  `CHAT.RESPONSE.ANNOTATION.001`; no semantic Product Logic Registry edit is
  planned.

## Implementation

- Render draft annotation details as an anchored, upward-preferred portal
  popover. Opening and closing it must not change composer height, and outside
  click/Escape must close it with focus restoration.
- Keep group inspection and single-item editing independent. Clicking marker
  `N` opens only annotation `N`; clicking an edit action closes the group
  popover before opening the single editor.
- Make the attachment picker icon-only with tooltip and accessible name.
- Add enter/exit and repositioning motion for chips, details, editors, and
  markers using existing motion tokens, with an immediate
  `prefers-reduced-motion` path.
- Replace overlay marker placement with a non-obscuring gutter/line-safe
  strategy that handles inline selections, line ends, wrapped text, adjacent
  annotations, scrolling, and narrow viewports.
- Fix rendered selection serialization at its source so Markdown, CJK,
  multiline content, inline syntax, and skill-reference tokens resolve to the
  same visible selection accepted by canonical server validation.

## Tests And Acceptance

- Unit/component tests first reproduce: icon-only attachment action, no
  automatic group expansion, one-marker/one-editor behavior, upward popover
  placement without composer resize, focus/Escape/outside-click behavior,
  reduced motion, and marker non-overlap.
- Selection tests reproduce the exact skill-reference mismatch and cover plain
  text, Markdown syntax, CJK, multiline selections, and ignored decorative
  content.
- Update the Chat response-annotation E2E to cover multiple annotations,
  editing only annotation 2, successful annotation-only Send, reload, and
  non-overlapping markers.
- Run focused UI/shared/server tests, the relevant E2E suite,
  `pnpm product-logic:check`, lint, recursive typecheck, test suite, build, and
  Desktop verification because the reported surface is the packaged app.
- Independently review the diff and run black-box acceptance in a real local
  environment. Capture final screenshots showing the collapsed composer,
  upward details, single-item editor, unobscured markers, and successful Send.
