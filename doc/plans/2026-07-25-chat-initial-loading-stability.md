---
title: Stabilize Initial Chat Loading
date: 2026-07-25
kind: implementation
status: completed
area: ui
entities:
  - chat
  - messenger
issue: R6Z-19
related_plans: []
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - ui/src/lib/chat-transcript-loading.ts
  - ui/src/lib/chat-transcript-loading.test.ts
  - tests/e2e/chat-initial-loading-stability.spec.ts
commit_refs: []
updated_at: 2026-07-25
---

# Stabilize Initial Chat Loading

## Summary

Keep the existing parallel conversation-detail and message prefetch behavior,
but show one accessible message skeleton until the target conversation detail is
available. The full transcript then mounts once through the normal message
renderer, without first exposing raw message bodies.

## Problem

When a message request completes before the matching conversation-detail
request, the pending-detail branch renders each cached `message.body` as plain
pre-wrapped text. Long histories can briefly fill the viewport, expose Markdown
syntax, and then reflow when the normal transcript replaces the temporary
projection.

## Scope

In scope:

- use `ChatMessagesLoadingState` whenever the target conversation detail is
  still pending, even if messages are already cached;
- keep the composer, new-chat guidance, and unrelated conversation content
  hidden during that state;
- preserve parallel message prefetch and organization isolation;
- retain the normal transcript renderer and initial bottom-scroll behavior once
  detail and messages are ready;
- cover both request completion orders in unit tests and the message-first race
  in Playwright.

Out of scope:

- changing Chat persistence, queueing, routing, or runtime behavior;
- introducing a fixed delay or another request;
- changing final rendering for Markdown, attachments, structured messages,
  Agent attribution, or long-message disclosure;
- editing the guarded Product Logic Registry.

## Implementation Plan

1. Replace the pending-detail raw transcript projection with the existing
   accessible loading skeleton.
2. Strengthen the load-state unit tests for detail-first and message-first
   completion orders.
3. Update the Chat component regression test to prove cached history, the
   composer, and the new-chat empty state stay hidden while detail is pending.
4. Add a Playwright scenario that delays conversation detail until messages
   have returned, then verifies formal Markdown rendering and the initial
   bottom position.
5. Run focused Vitest, Playwright, UI typecheck, and repository-required checks.

## Success Criteria

- No historical body or raw Markdown syntax appears while conversation detail
  is pending.
- The loading surface retains `role="status"` and a readable label.
- The complete transcript appears through the normal renderer after detail
  resolves.
- The first formal transcript render is positioned at the latest message.
- No fixed timing workaround, redundant fetch, or Product Logic change is
  introduced.

## Validation

- Focused Vitest passed: 7 tests covering both load-state completion orders and
  the pending-detail Chat surface.
- The new focused Playwright race passed with messages completing before the
  delayed conversation detail; it verified no raw Markdown or composer leaked,
  final Markdown rendered normally, and the transcript opened at the bottom.
- UI typecheck passed.
- Changed-file import lint passed.
- Product Logic Registry check passed with 79 valid contracts.
- Diff whitespace validation passed.
- The architecture regression check remains blocked by unrelated inherited
  worktree changes that make `CommentThread.tsx` cross the oversized-file
  threshold. This change removes 29 net lines from the already-baselined
  `Chat.tsx` loading branch and introduces no production source expansion.
- The full Chat component file ran 135 of 136 tests successfully, including the
  changed regression. One unrelated existing Side Chat test exceeded its
  five-second timeout; the focused rerun of this change passed.

## Open Issues

None.
