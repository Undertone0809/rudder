---
title: Chat response annotation usability fix
date: 2026-07-24
kind: fix-plan
status: completed
area: chat
entities:
  - messenger_chat
  - response_annotations
  - side_chat
issue:
related_plans:
  - 2026-07-23-chat-response-annotations.md
supersedes: []
related_code:
  - ui/src/lib/chat-response-annotation-selection.ts
  - ui/src/components/chat/ResponseAnnotations.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/components/side-panel/SideChatPanelView.tsx
  - tests/e2e/chat-response-annotations.spec.ts
commit_refs:
  - "fix(chat): repair response annotation interactions"
updated_at: 2026-07-24
---

# Chat Response Annotation Usability Fix

## Scope

Repair the existing `CHAT.RESPONSE.ANNOTATION.001` workflow without changing
its product contract:

- keep the attachment action icon-only while retaining an accessible label;
- show draft details only after explicit activation and edit only the selected
  annotation;
- render draft details above the composer in a non-layout-shifting popover;
- add directional enter/exit motion with reduced-motion support;
- place numbered markers in a side gutter without obscuring response text or
  one another; and
- correct Markdown soft-break selection offsets so valid partial selections
  pass the server's exact-source validation.

Main Chat and Side Chat must retain matching behavior.

## Root Cause

The Markdown DOM omits visible text for soft line breaks, but the raw source
contains newline characters. The DOM-to-source mapper could therefore anchor a
partial selection one character early, causing the server to compare the
selected text with a source slice prefixed by `\n` and reject the send.

The draft annotation count surface and the single-annotation editor also shared
expansion state. Activating one marker could consequently reveal the complete
draft list, and the list was rendered inside composer flow, increasing its
height. Marker coordinates were tied to the selection endpoint, so badges could
cover the selected response text and collide on the same line.

## Implementation

1. Add regression tests for soft-break offsets, selected-only editing,
   icon-only attachment UI, upward popover motion, and marker gutter/collision
   layout.
2. Normalize mapped selection starts past raw-only whitespace when it is not
   part of the visible selected text.
3. Separate group-popover state from selected-editor state in Main Chat and
   Side Chat.
4. Portal draft details above the composer and preserve keyboard focus on
   close.
5. Move markers to an available response gutter and stack same-line markers.
6. Extend E2E coverage for the reported workflow and validate the rendered
   behavior in the real local app.

## Validation

- Focused UI regression: 133 tests passed across annotation components,
  Markdown rendering, Side Chat parity, and motion CSS.
- Isolated real-instance response annotation E2E passed, including exact
  soft-break Send, selected-only marker activation, icon-only attachment,
  upward non-layout-shifting details, and non-overlapping markers.
- `pnpm lint` and `pnpm product-logic:check` passed.
- Recursive typecheck, build, and packaged Desktop verification reached an
  unrelated shared-main transcript type error where
  `TranscriptToolSemanticInfo.actionKind` is missing. The full unit run
  completed 6,031 passing tests and reported 16 unrelated failures in
  concurrently modified transcript, Local App, Messenger, onboarding, and
  heartbeat suites; the response annotation suites passed in that run.
- Independent adversarial code review and isolated black-box verification were
  completed, including fixes found during both passes.
