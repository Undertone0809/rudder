---
title: Side Panel Resize Auto-Expand Reachability
date: 2026-07-23
kind: fix-plan
status: completed
area: ui
entities:
  - side_panel
related_plans:
  - 2026-07-01-global-side-panel-workbench.md
supersedes: []
related_code:
  - ui/src/components/Layout.tsx
  - ui/src/components/Layout.test.ts
  - tests/e2e/chat-side-panel.spec.ts
  - desktop/scripts/smoke.mjs
commit_refs: []
updated_at: 2026-07-23
---

# Side Panel Resize Auto-Expand Reachability

## Summary

Restore continuous Side Panel resizing from the equal docked split through the
desktop auto-expand transition. The docked width limit and auto-expand test must
share one geometry model based on the actual `workspace-main-panel-stack`, so a
legal drag is not stopped early by historical fixed caps.

## Product Logic Alignment

- Affected contract: `CHAT.SIDE.PANEL.001`.
- This fix restores the contract's stable, right-anchored desktop resize path;
  it does not introduce a new product workflow.
- `doc/product/**` remains unchanged. No Product Logic Registry edit is
  authorized or needed for this regression restoration.

## Root Cause

The current layout combines unrelated width rules:

- docked widths are capped by fixed `340px` main-content and `720px` panel
  limits;
- widths resolved before the workspace is measured are capped at `42%` of the
  viewport;
- auto-expand compares panel width with two thirds of the whole workspace and
  does not subtract the visible `4px` resize divider;
- resize state mixes transformed `getBoundingClientRect()` visual pixels with
  layout-pixel CSS widths and raw pointer deltas. At the `994px` desktop
  breakpoint the ancestor scale makes that mismatch large enough to cross the
  expansion boundary early.

Those rules create unreachable docked widths. A roughly `653px` main/panel stack
cannot grow beyond `340px` even though the 2:1 transition is near `433px`, and a
wide stack cannot grow beyond `720px`. A remembered legal width can also be
truncated before the actual workspace measurement becomes available.

## Geometry

For a measured desktop workspace layout width `W` (`offsetWidth`):

```text
resizerWidth = 4
availableWidth = W - resizerWidth
mainWidth = availableWidth - panelWidth
autoExpand = panelWidth > 2 * mainWidth
dockedMaximum = availableWidth * 2 / 3
visualScale = renderedWorkspaceBoundingWidth / W
layoutPointerDelta = clientPointerDelta / visualScale
```

Panel state, clamping, the default split, and the 2:1 decision stay in layout
pixels. Pointer input is converted from rendered visual pixels to layout pixels
before changing panel state. Equality remains docked; only a strict crossing
expands.

The nominal minimum docked width is `340px`. In an extremely narrow desktop
stack where that minimum would exceed the 2:1 boundary, the effective minimum
drops to `availableWidth / 2`, which remains below the boundary. This keeps
minimum and maximum self-consistent, preserves the default 1:1 split, and
prevents a legal shrink from being interpreted as expansion. Oversized
remembered or dragged widths still clamp to the exact 2:1 maximum. Mobile
overlay behavior is not changed.

The drag-to-collapse threshold preserves the existing `48px` gap below the
effective minimum (`340px - 292px`). In a narrow stack it moves down with that
minimum, so beginning a drag from the smaller 1:1 default cannot immediately
close the panel.

Before `W` is known, stored and proportional widths receive only the existing
minimum-width clamp. Their final upper clamp happens after the real workspace
measurement is available.

The measured `workspace-main-panel-stack` layout width is also the only ratio
baseline. Custom widths store their in-memory ratio as `panelWidth / W` and
restore as `ratio * W` when that stack changes because of a window, context
column, or sidebar resize. Local storage continues to persist the pixel width;
before `W` is measured, that remembered pixel value is preserved without a
viewport-derived ratio or upper cap.

## Implementation

1. Add focused unit tests for compact, wide, equality, default, remembered,
   proportional, and extremely narrow geometry; run them first and record the
   expected failures.
2. Replace the fixed docked caps in `Layout.tsx` with one internal measured
   layout-pixel geometry source used by both clamping and auto-expand, and
   convert transformed pointer movement into that coordinate space.
3. Strengthen Playwright coverage at `994x900` and `1440x900` with dynamic
   bounding-box targets immediately below, at, and beyond the 2:1 boundary.
   Verify Dashboard and Messenger three-column workspaces.
4. Extend the real Electron Browser smoke resize path with the same dynamic
   continuity and transition checks while preserving cancel, lost-capture,
   shrink, collapse, reopen, and Browser-identity coverage.

## Test Plan

- Focused Vitest: `ui/src/components/Layout.test.ts`.
- Focused Playwright: Side Panel auto-expand and Browser resize scenarios in
  `tests/e2e/chat-side-panel.spec.ts`.
- Desktop smoke: run the native smoke path when the required Electron fixture
  environment is available.
- Product registry structure: `pnpm product-logic:check`.

The pre-threshold checks use the rendered workspace, panel, main, and resizer
boxes with a `2px` tolerance. A single held drag samples below and within
`2px` of the 2:1 boundary, requires monotonic panel growth and resizer
movement, then crosses by `4-8` CSS pixels. Exact equality remains covered by
the layout-pixel unit test, avoiding browser pointer-coordinate quantization in
the black-box test. Expanded state must fill the stack within `2px`, hide the
resizer, and leave the mounted main surface inert with width at most `2px`.
The authored divider width is checked in layout pixels, while visual continuity
uses bounding boxes. The `10px` hit target must also win an actual
`elementFromPoint` probe outside the narrower divider, so an authored-but-clipped
target cannot pass.

## Compatibility And Data Impact

- No public API or shared type changes.
- No database, migration, persistence-format, or organization-scope changes.
- Existing local-storage key and proportional width memory remain compatible.
- Collapse drag, drag shield/lifecycle, focus restoration, right anchoring,
  expanded-main inertness, and Browser guest identity remain unchanged.

## Verification Record

- RED — `pnpm exec vitest run ui/src/components/Layout.test.ts --reporter=verbose`:
  failed in the five new geometry cases as expected. Observed old results were
  `340` instead of `432.67`, `720` instead of `957.33`, `false` at the
  4px-adjusted strict crossing, `604` instead of an unmeasured remembered
  `900`, and `720` instead of the measured `877.33` boundary.
- GREEN — the same focused Vitest command: 22 tests passed.
- Scale/minimum RED — the focused Vitest command then failed in three expected
  cases: narrow `W=480` remained `340` instead of the self-consistent default,
  and both unscaled and `0.73`-scaled drag conversion were absent.
- Scale/minimum GREEN — the focused Vitest command passed 24 tests.
- Workspace-ratio RED — the viewport-based implementation restored `666.67px`
  where the measured workspace ratio required `350px`.
- Remembered-pixel RED — the unmeasured preservation helper was absent, so a
  narrow remembered `238px` could not be proven stable before measurement.
- Dynamic-collapse RED/GREEN — a narrow `W=480` stack initially reused the
  fixed `292px` collapse threshold and could close on the first move. The final
  helper preserves the existing `48px` gap below the effective minimum; the
  combined Layout and resize-lifecycle run passed 29 tests.
- Final geometry GREEN — the focused suite covers workspace ratios, remembered
  pixels, narrow min/max and collapse thresholds, strict boundaries, and scaled
  and unscaled pointer movement.
- Focused Chromium E2E — passed in 20-22 seconds in both the implementation and
  independent verifier runs. One held drag covered `994x900` Dashboard and
  `1440x900` Messenger layouts, pre-boundary continuity, the resize shield,
  strict crossing, expanded stack fill, hidden resizer, and inert main content.
- Independent black-box geometry at `994px`: measured stack `653px`, divider
  `4px`, and boundary `432.67px`; samples at roughly `424px` and `429px`
  remained docked, then the crossing filled the stack. Equivalent `1440px`
  Messenger coverage also passed.
- Desktop dev smoke — passed independently with the repository version after
  adding geometry-settle polling and feedback-based native pointer correction.
  The native Electron Browser guest survived both width cases, expansion,
  cancel, collapse, reopen, restart, profile isolation, and profile clearing.
- `pnpm desktop:dist`: passed, including packaged server verification.
- Packaged desktop smoke — passed for startup recovery, clean Browser/webview,
  and upgrade scenarios. The packaged native resize path and Browser guest
  identity checks also passed.
- The first full `pnpm test:run` under maximum workspace concurrency reported
  seven timeouts/assertion flakes in five unrelated files plus one UI teardown
  timer. All five failed files passed on isolated rerun (130 tests), and the UI
  teardown file passed on isolated rerun (128 tests).
- `pnpm -r typecheck`: passed.
- `pnpm build`: passed (existing CSS optimizer and chunk-size warnings only).
- `pnpm lint`: passed; 2,091 files checked and imports organized.
- `pnpm product-logic:check`: 77 contracts valid.
- `node --check desktop/scripts/smoke.mjs`: passed.
- Independent specification and code-quality reviews: approved with no
  blocking findings.
- `git diff --check`: passed.
