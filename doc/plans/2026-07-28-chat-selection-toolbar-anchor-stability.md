---
title: Stabilize Chat selection toolbar anchors
date: 2026-07-28
kind: fix-plan
status: completed
area: chat
entities:
  - messenger_chat
  - response_annotations
issue: R6Z-34
related_plans: []
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.response-annotation-selection.ts
  - ui/src/components/chat/SelectionAnnotationToolbar.tsx
  - ui/src/lib/chat-response-annotation-selection.ts
  - tests/e2e/chat-response-annotations.spec.ts
commit_refs:
  - "fix(chat): stabilize selection annotation toolbar"
updated_at: 2026-07-28
---

# Stabilize Chat Selection Toolbar Anchors

## Incident Summary

The response-selection action toolbar can jump to the Chat workspace's
top-left corner after the selected message DOM is replaced. The replacement
detaches the cloned `Range`; its next bounding rectangle is all zeroes, but the
toolbar currently treats that truthy object as a valid live anchor.

This is an implementation reliability fix under
`CHAT.RESPONSE.ANNOTATION.001`. It restores the existing interaction contract
without changing annotation eligibility, actions, persistence, or product
logic.

## What Is Broken?

- A valid selection initially produces the correct toolbar position.
- Source hashing is asynchronous, so query refreshes or transcript projection
  can replace the selected DOM before the pending annotation is materialized.
- A detached range can report a zero, non-finite, or dimensionless rectangle.
  Placement clamps that rectangle into the workspace boundary and makes the
  toolbar appear at its top-left corner.
- A stale hash result can also materialize an older selection after a newer
  selection or Chat scope has become current.

## Root Cause Hypothesis

The pending selection stores a cloned DOM `Range` as long-lived geometry
identity. DOM ranges are not stable across React subtree replacement. The
toolbar also lacks a shared validity predicate for selection geometry and has
no signal that distinguishes a temporarily unmeasurable range from a source
that no longer exists.

## What Will Change?

1. Validate selection rectangles before initial rendering and before every live
   placement update. Reject non-finite, zero-area, and internally inconsistent
   geometry.
2. Resolve canonical source offsets synchronously while the original selection
   is connected, then attach the asynchronous source hash only if that
   selection is still current.
3. Re-find the current annotation source root and restore a fresh DOM range
   from canonical `start` / `end` offsets for live measurement after rerenders,
   scroll, and resize.
4. Retain the last valid rectangle through transient invalid measurements, but
   dismiss the toolbar when the source root is no longer connected and cannot
   be recovered.
5. Guard asynchronous completion with a monotonically increasing selection
   sequence so older results cannot replace a newer selection or cross Chat
   scope.
6. Preserve portal rendering, boundary flip/shift, keyboard navigation,
   Escape behavior, Side Chat eligibility, and narrow-window behavior.

## Risk And Compatibility Notes

- Canonical annotation payloads and persisted data do not change.
- Source-root lookup must match the existing assistant-body and Process
  provenance attributes exactly to avoid binding a selection to a sibling
  transcript block.
- Geometry rejection must not discard legitimate multi-line or narrow text
  selections; positive finite width and height are sufficient.
- No semantic edit to `doc/product/**` is required or authorized.

## Success Criteria

- Invalid live rectangles never overwrite the last valid toolbar anchor.
- A source subtree replacement restores the toolbar beside the same canonical
  quote.
- If the canonical source can no longer be found, the toolbar closes instead
  of clamping to the workspace corner.
- Rapid consecutive selections only show the newest selection.
- Assistant-body and visible Process annotations retain all current actions and
  accessibility behavior.

## Validation Plan

- Component tests for zero, `NaN`, and dimensionless live rectangles.
- Selection helper tests for recovering a canonical range from a replaced
  source root.
- Chat regression coverage for source replacement and stale asynchronous
  completion.
- E2E coverage for assistant-body and Process selections across scroll,
  rerender, narrow viewport, and an open Side Panel.
- Targeted typecheck/tests, product-logic validation, and rendered Desktop/UI
  screenshots before hand-off.

## Open Issues

- Full-suite or packaged verification blockers, if any, will be recorded with
  exact commands and errors rather than weakening the targeted acceptance
  criteria.
