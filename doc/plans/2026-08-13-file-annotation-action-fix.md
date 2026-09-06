---
title: Fix file annotation actions
date: 2026-08-13
kind: fix-plan
status: in_progress
area: ui
entities:
  - chat_annotations
  - side_panel
  - side_chat
issue:
related_plans: []
supersedes: []
related_code:
  - ui/src/lib/chat-file-annotation-events.ts
  - ui/src/components/chat/FileAnnotationSelectionToolbar.tsx
  - ui/src/pages/Chat.tsx
  - tests/e2e/chat-side-panel.spec.ts
commit_refs: []
updated_at: 2026-08-13
---

# Fix File Annotation Actions

## Incident Summary

Selecting text in a saved file shows the annotation toolbar, but clicking either
action can make the toolbar disappear without opening an annotation editor or Side
Chat. The global request is fire-and-forget, while Chat may silently ignore it when
its conversation query snapshot is not ready or differs from the Side Panel context.

This is a regression fix within `CHAT.RESPONSE.ANNOTATION.001`,
`CHAT.SIDE.PANEL.001`, and `CHAT.SIDE.CHAT.001`. It does not edit the guarded
Product Logic Registry.

## State Inventory

- Selection: show only `Add to chat` and `Ask in side chat`; defer comment editing
  until an action is accepted.
- Add: open one annotation editor for the current Chat route. Save writes to that
  Chat draft; Cancel and Delete do not send a message.
- Side Chat: open a temporary Side Chat draft anchored to a completed assistant
  message in the current Chat. Do not persist a new conversation before first Send.
- Context exception: explain why the action could not run and keep the file
  selection toolbar available for retry or dismissal.
- Dismissal: outside click, Escape, unavailable anchor geometry, and unsaved files
  retain their current close or suppression behavior.

## Implementation

- Replace the fire-and-forget file annotation event with a synchronous acknowledgement
  that returns `accepted`, `rejected`, or `unhandled`.
- Treat the current Chat route ID as authoritative for `Add to chat`, so a temporarily
  missing conversation query snapshot cannot discard the request.
- Require a matching current conversation snapshot, completed assistant anchor, and
  valid Side Chat context before accepting `Ask in side chat`.
- Reject stale Side Panel context rather than attaching an old selection to a newly
  navigated Chat.
- Close the selection toolbar only after `accepted`; surface rejection and unhandled
  outcomes explicitly while retaining the selection.
- Preserve database, server API, annotation schema, and file safety boundaries.

## Success Criteria

- Both actions produce a visible accepted state from a saved local or Library file.
- `Add to chat` works while the selected conversation query snapshot is temporarily
  absent, provided the annotation still targets the current route.
- Stale conversation context never writes an annotation into the newly active Chat.
- Side Chat is accepted only with a completed assistant source message.
- Rejected and unhandled requests retain the toolbar and provide visible feedback.
- Unsaved files continue to expose no annotation actions.

## Validation Plan

- Unit coverage for all acknowledgement outcomes, close rules, keyboard activation,
  and stale-context rejection.
- Chat integration coverage for a missing conversation snapshot, stale Side Panel
  context, accepted actions, and explicit failure feedback.
- Chromium E2E through real file selection and real mouse activation for Add, Side
  Chat, Chat switching, and unsaved-file suppression.
- Rendered Web and Desktop inspection with wide and constrained screenshots.
- Run focused UI tests, relevant E2E, `pnpm product-logic:check`, `pnpm lint`,
  `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, and `pnpm desktop:verify`.

## Risk And Compatibility Notes

- DOM event dispatch is synchronous, so acknowledgement is resolved before the sender
  decides whether to close. First response wins if multiple listeners exist.
- Events constructed without the responder remain compatible and are handled
  defensively by Chat.
- No persistence or wire-format migration is required.

## Open Issues

- Final candidate identity, runtime/data identity, screenshots, and independent
  reviewer/verifier receipts will be recorded in the adjacent delivery packet.
