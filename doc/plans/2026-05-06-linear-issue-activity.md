---
title: Linear issue activity integration
date: 2026-05-06
kind: implementation
status: completed
area: ui
entities:
  - plugin_linear
  - issue_activity
  - issue_detail
issue: 96621597-f964-4a0d-8e30-3b9f1f3e5a45
related_plans:
  - 2026-05-02-linear-source-issue-board.md
supersedes: []
related_code:
  - ui/src/pages/IssueDetail.tsx
  - packages/plugins/examples/plugin-linear/src/ui/index.tsx
  - packages/plugins/examples/plugin-linear/src/manifest.ts
commit_refs:
  - fix: move linked Linear issue into activity
updated_at: 2026-05-06
---

# Linear Issue Activity Integration

## Summary

Move the linked Linear issue detail contribution out of the Issue detail tab bar
and into the existing Activity surface so imported Linear context reads as part
of the issue timeline instead of a separate destination.

## Problem

Imported Linear issues currently add a standalone `Linear` tab on every issue
detail page. The tab is too prominent for a source-link summary, and unlinked
issues show a mostly empty Linear panel. Operators only need the linked Linear
context alongside activity when a Rudder issue actually came from Linear.

## Scope

- Hide the Linear plugin detail tab from the Issue detail tab bar.
- Render the Linear linked-issue contribution inside the Activity tab.
- Keep non-Linear plugin detail tabs unchanged.
- Avoid changing the Linear import flow, source issue board, or backend link
  model.
- Avoid adding new plugin slot types unless the current detail-tab mechanism is
  insufficient for this focused UI move.

## Implementation Plan

1. Identify the Linear issue detail slot by plugin key and slot id.
2. Filter that slot out of the Issue detail tab item list.
3. Mount the Linear slot inside Activity with the current issue context.
4. Keep the Activity timeline, cost summary, and other plugin tabs stable.
5. Add focused UI coverage for the Linear slot placement.

## Design Notes

The first pass should stay host-side and compatibility-preserving. The Linear
plugin can continue declaring its existing `detailTab` slot while the Issue
detail page chooses a more appropriate host placement for that specific
first-party contribution.

## Success Criteria

- Issue detail no longer shows a separate `Linear` tab for the first-party
  Linear plugin.
- The Activity tab contains the Linear linked issue panel when the plugin slot
  is available.
- Other plugin detail tabs still appear as separate tabs.
- Existing issue comments, activity rows, and run cost summary still render.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/pages/IssueDetail.test.tsx`
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm --filter @rudderhq/ui build`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm test:run`
- Passed: `pnpm build`
- Passed: `git diff --check -- ui/src/pages/IssueDetail.tsx ui/src/pages/IssueDetail.test.tsx doc/plans/2026-05-06-linear-issue-activity.md`
- Not run: browser visual inspection, because this checkout does not currently
  have a seeded linked Linear issue fixture ready for the Issue detail page.

## Open Issues

- The Linear plugin component currently owns linked/unlinked state rendering;
  if Activity should hide completely for unlinked issues, a later plugin data
  or slot contract change may be cleaner than host-side special-casing.
