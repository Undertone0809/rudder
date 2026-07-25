---
title: Simplify Issue Agent Identity
date: 2026-07-25
kind: implementation
status: completed
area: ui
entities:
  - issue_properties
  - assignee_labels
issue: R6Z-22
related_plans:
  - 2026-07-21-responsive-issue-detail-layout.md
  - 2026-05-09-issue-approval-ui-rendering.md
supersedes: []
related_code:
  - ui/src/components/AssigneeLabel.tsx
  - ui/src/components/IssueProperties.tsx
  - ui/src/components/IssueProperties.test.tsx
  - tests/e2e/issue-detail-properties-layout.spec.ts
commit_refs: []
updated_at: 2026-07-25
---

# Simplify Issue Agent Identity

## Summary

Make the selected Assignee and Reviewer in Issue Properties easier to scan by
showing each Agent avatar at its full 24px size without an additional framed
wrapper and by omitting the title badge from the selected value. Keep the
shared label's existing presentation as its default so unrelated issue lists
and Chat proposal surfaces do not change.

## Problem

The selected Agent identity currently nests a 14px Agent icon inside a framed
24px circle and stacks a title badge under the name. The frame makes the actual
avatar feel undersized, while the badge adds hierarchy and height to a compact
properties rail. The picker menu still needs the Agent title as supporting
information because it helps distinguish candidates during selection.

## Scope

- Add an explicit reusable bare Agent-avatar presentation to `AssigneeLabel`.
- Use it only for selected Agent values in `IssueProperties`.
- Remove title badge input from the selected Assignee and Reviewer values.
- Preserve name truncation, full-name tooltip, user principals, clearing, and
  all picker behavior.
- Preserve the two-line Agent name and supporting title in selection menus.
- Update component and browser coverage across wide, compact, and mobile Issue
  Properties surfaces.

No ownership, Agent identity, API, persistence, or guarded Product Logic
behavior changes are in scope.

## Implementation Plan

1. Extend `AssigneeLabel` with a default-preserving Agent avatar presentation
   option and expose stable data hooks for focused layout assertions.
2. Switch only the selected Assignee and Reviewer triggers in
   `IssueProperties` to the bare 24px avatar and single-line name treatment.
3. Replace the component test's old stacked badge assertions with bare-avatar,
   absent-badge, truncation, and menu-supporting-title assertions.
4. Update the existing responsive Playwright coverage to verify the same
   contract in the desktop rail, compact Issue Detail, and mobile Properties
   sheet.
5. Run focused tests, repository checks, and real rendered visual validation;
   capture desktop and mobile screenshots for review.

## Design Notes

- `AssigneeLabel` retains its framed avatar as the default for compatibility.
- `AgentMenuLabel` remains unchanged so menus retain two-line Agent metadata.
- The bare Agent icon is itself the 24px visual, rather than a smaller icon
  inside a 24px wrapper.
- The selected label remains `min-w-0` with a truncated single-line name and
  the existing full-name `title` attribute.

## Success Criteria

- Selected Agent values have a 24px avatar with no border/background wrapper.
- Selected values contain no Agent title badge.
- Long names do not create horizontal overflow in any Issue Properties surface.
- Picker menus retain supporting titles.
- User assignment, clearing, and picker behavior remain unchanged.

## Validation

- `ui/src/components/IssueProperties.test.tsx`
- `tests/e2e/issue-detail-properties-layout.spec.ts`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- Desktop and mobile browser screenshots from the real local app

## Validation Results

- Focused `IssueProperties` Vitest: 9 tests passed.
- Target Chromium E2E: 1 test passed across desktop, compact, and mobile
  Properties surfaces, including long-name overflow measurements.
- Repository lint, recursive typecheck, and build passed.
- The full Vitest run completed with 576 files passing and 63 files failing.
  Failures were outside this change and dominated by shared-runner timeouts,
  exhausted embedded-PostgreSQL shared-memory IDs, and existing assertions on
  unrelated surfaces; the focused `IssueProperties` suite passed inside that
  run.
- Desktop and mobile screenshots were inspected for avatar sizing, removed
  title badges, and responsive layout.

## Open Issues

None.
