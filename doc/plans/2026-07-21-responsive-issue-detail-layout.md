---
title: Responsive Issue Detail Layout
date: 2026-07-21
kind: implementation
status: completed
area: ui
entities:
  - issue_detail
  - issue_surface
  - side_panel
  - responsive_layout
issue: R6-21
related_plans:
  - 2026-07-01-global-side-panel-workbench.md
  - 2026-05-08-issue-detail-activity-stream.md
supersedes: []
related_code:
  - doc/product/domains/issues/surfaces.md
  - doc/product/registry.yml
  - ui/src/index.css
  - ui/src/components/CommentThread.tsx
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/IssueDetail.test.tsx
  - ui/src/lib/index-css.test.ts
  - tests/e2e/issue-detail-properties-layout.spec.ts
commit_refs: []
updated_at: 2026-07-22
---

# Responsive Issue Detail Layout

## Summary

Make the full Issue Detail surface choose its one- or two-column hierarchy from
the inline size of its own work surface. Opening or resizing the global Side
Panel must therefore compact the existing Issue Detail in place without a
navigation, reload, or reduced-capability substitute.

## Problem

`IssueDetail` currently uses viewport-wide `xl` utilities to mount its desktop
toolbar in one of two locations and to enable a fixed `280px` properties rail.
The global Side Panel can reduce the issue card to roughly half of the workspace
without changing the browser breakpoint, leaving the description and Activity
column unreadably narrow.

## Product Contract Alignment

This issue explicitly approves the following guarded `ISSUE.SURFACE.001`
update:

> Issue Detail chooses one- versus two-column layout from the width of the issue
> work surface, not the browser viewport. In compact desktop/tablet mode,
> operational properties join the primary issue scroll after issue
> identity/context and before the description; issue actions and all detail
> evidence remain available. Opening or resizing the global Side Panel must not
> leave Issue Detail in unreadable columns or lose editable state. Phone layouts
> retain the dedicated Properties sheet.

The responsive E2E belongs in this contract's related tests and registry
mapping.

## Implementation Plan

1. Keep `IssueDetail`'s existing page-level scroll owner and add one named
   inline-size container around the full work surface.
2. Reorder the persistent DOM into semantic heading, actions, properties, and
   body areas. Keep one desktop/tablet properties region and one action toolbar
   so container transitions do not remount editor or picker state.
3. Use `@container issue-detail (min-width: 56rem)` to place the persistent
   areas into the existing primary column plus sticky `280px` rail. Below the
   threshold, flatten properties into the vertical flow before the description.
4. Preserve the `<768px` phone action buttons and Properties sheet as an
   explicit viewport exception.
5. Protect semantic order, one-region ownership, CSS hooks, single-scroll
   behavior, action availability, and the real Side Panel open/resize/close
   workflow with focused tests.
6. Neutralize the shared fixed composer's negative outer gutter only inside
   the Issue Detail body so the compact work surface has no horizontal scroll.

## Validation

- Focused `IssueDetail`, `CommentThread`, and `index.css` contracts: 91/91.
- Responsive Playwright file: 2/2, covering wide, default split,
  resized/restored, closed, light/dark, unsaved draft/focus/scroll retention,
  and phone states.
- Existing sticky composer/single-scroll workflow: 1/1; focused toolbar and
  long-phone-sub-issue workflows also pass.
- `pnpm product-logic:check`: 77 contracts valid.
- Independent adversarial review: approve after the state-retention E2E was
  strengthened.
- Independent Vite-backed black-box verification: approve, with the focused
  acceptance workflow passing twice and all six screenshots inspected.
- Shared-checkout aggregate gates remain red outside this delta: `pnpm lint`,
  `pnpm -r typecheck`, and `pnpm build` stop in unrelated `Chat` files;
  `pnpm test:run` is additionally affected by unrelated environment/home-path
  expectations and exhausted PostgreSQL shared-memory slots. The focused R6-21
  suites and CSS build path remain green.

## Non-Goals

- No backend, schema, API, Side Panel persistence, or resize-policy changes.
- No replacement with `ChatIssueSidePanelView`.
- No redesign of the phone Properties sheet.
