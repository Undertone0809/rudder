# Issue proposal Side Panel — Design QA

- Source visual truth:
  - `/Users/zeeland/.codex/attachments/a01e7734-d54b-45fb-8b89-f59c394744d3/image-1.png` (`3070 × 1998`)
  - `/Users/zeeland/.codex/attachments/a01e7734-d54b-45fb-8b89-f59c394744d3/image-2.png` (`3600 × 2260`)
  - `/Users/zeeland/.codex/attachments/a01e7734-d54b-45fb-8b89-f59c394744d3/image-3.png` (`3158 × 2260`)
- Rendered implementation:
  - `/tmp/rudder-issue-proposal-qa/issue-proposal-inline-card.png`
  - `/tmp/rudder-issue-proposal-qa/issue-proposal-side-panel.png`
- Viewport: `1280 × 720` CSS px, Chromium, device scale factor `1`
- Implementation pixels: `1280 × 720`
- Density normalization: the references are differently sized product-direction screenshots rather than a pixel-identical target. The comparison used matching desktop/light-theme product states and proportional region/layout comparison; no density-only differences were filed.
- State:
  - unopened full Issue proposal card with ten-line details preview
  - opened `Issue proposal` Side Panel tab with compact inline launcher, full proposal content, and review actions

## Full-view comparison evidence

The implementation preserves the existing Rudder Messenger shell and existing Side Panel outer frame. Opening the proposal produces a dedicated tab, narrows the conversation work surface, replaces the inline card with a compact launcher, and keeps the proposal review surface in the right panel. Closing the tab restores the full inline card. These are the same major-region and lifecycle relationships shown by the source references.

The final `1280 × 720` capture shows proposal details above the compact sticky review footer, avoiding the earlier state where the footer obscured all proposal body content at this viewport.

## Focused-region comparison evidence

- Side Panel chrome: existing tab strip, expand/collapse controls, resize behavior, borders, radii, and surface tokens are reused rather than recreated.
- Proposal header and facts: title, pending status, priority, issue status, owner, and reviewer retain the source hierarchy and product tokens.
- Compact inline state: the row uses the requested `Issue proposal` label, a lightbulb icon, and a reopen affordance in the same location and density as the source's compact plan row.
- Review footer: decision feedback and all three review actions remain visible at the narrow Side Panel width. The textarea and button padding were reduced only for this presentation so proposal content remains visible above it.
- No focused asset comparison was needed: the implementation introduces no logos, illustrations, imagery, or non-standard icons; all new icons come from the project's existing Lucide library.

## Required fidelity surfaces

- Fonts and typography: existing Rudder font stack, weights, title scale, compact tab text, and small metadata hierarchy are preserved.
- Spacing and layout rhythm: existing Side Panel spacing and card tokens are reused; the narrow-panel facts become a single column and the action footer is compact enough for the target viewport.
- Colors and visual tokens: all surfaces, borders, state badges, and action colors use existing Rudder CSS variables and semantic button variants.
- Image quality and asset fidelity: no source imagery was replaced or approximated; the feature adds no raster or custom vector assets.
- Copy and content: `Issue proposal`, `Show full proposal`, `Approve & create issue`, `Request changes`, and `Reject` match the requested review workflow. A polite live-region message announces the panel transition.

## Findings

No actionable P0, P1, or P2 visual differences remain.

Acceptable differences:

- The references mix dark and light themes and use different proposal data; the implementation follows the active Rudder theme and live proposal data.
- The final viewport is smaller than the reference mock. The Side Panel therefore uses the existing narrow-width one-column fact layout and scrollable body.

## Comparison history

1. Initial rendered pass:
   - P1: target-content replacement could enter a maximum-update-depth loop.
   - Fix: replaced target mutation with a stable ID-only target and an external-store-backed content registry.
   - Post-fix evidence: the full Side Panel lifecycle E2E completed without UI recovery.
2. Reviewer/adversarial pass:
   - P1: a stable ReactNode wrapper could retain stale review callbacks.
   - P2: the disclosure ARIA model did not match opening a separate panel.
   - P2: the tall sticky action footer hid proposal details at `1280 × 720`.
   - Fixes: publish fresh proposal render state through a subscribable registry, remove false disclosure ARIA when opening the panel, add a live-region announcement, and compact the panel-only footer.
   - Post-fix evidence: Request changes submitted current feedback in the real E2E environment; the final screenshot shows proposal details above the footer.

## Implementation checklist

- [x] Existing Side Panel outer design reused
- [x] Full card → compact row → panel lifecycle verified
- [x] Collapse/reopen and tab-close restoration verified
- [x] Current review feedback reaches Request changes
- [x] Transition is announced without false disclosure semantics
- [x] Reduced-motion fallback included
- [x] Final rendered screenshot reviewed

final result: passed
