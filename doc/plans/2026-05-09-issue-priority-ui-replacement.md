---
title: Issue priority UI replacement
date: 2026-05-09
kind: implementation
status: completed
area: ui
entities:
  - issue_priority
  - issue_properties
issue: be73b47e-1995-45e5-bfb0-2c50e75d1766
related_plans: []
supersedes: []
related_code:
  - ui/src/components/PriorityIcon.tsx
  - ui/src/components/IssueProperties.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/IssuesList.tsx
commit_refs:
  - fix: replace issue priority visuals
updated_at: 2026-05-09
---

# Issue Priority UI Replacement

## Context

The issue asks to replace the current issue priority treatment with the supplied visual reference. The existing UI uses warning/up/minus/down line icons and labels such as `Critical`; the target treatment uses compact ascending bar glyphs, orange priority colors, and the top priority label `Urgent`.

## Implementation Plan

1. Centralize priority presentation in `PriorityIcon` so all existing call sites inherit the replacement.
2. Preserve stored priority values (`critical`, `high`, `medium`, `low`) and map `critical` to the display label `Urgent`.
3. Update the editable popover menu to match the reference: wider menu, rounded rows, chip-like active/option states, and a check mark for the selected value.
4. Reuse the same priority metadata in issue property rows, issue lists, filters, and new-issue chips rather than duplicating icon/color definitions.
5. Add focused component coverage for the display label, bar glyph, and selectable popover behavior.

## Validation

- Run the narrow UI tests that cover the priority component and affected issue list behavior.
- Run typecheck/build checks before hand-off if the narrow validation passes.
- Visually inspect the rendered issue priority control and capture evidence outside the repository tree.
