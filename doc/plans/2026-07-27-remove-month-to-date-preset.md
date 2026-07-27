---
title: Remove the Month to Date Date-Range Preset
date: 2026-07-27
kind: implementation
status: completed
area: ui
entities:
  - costs_overview
  - date_ranges
  - budget_visibility
issue: R6Z-30
related_plans:
  - 2026-07-25-costs-usage-analysis.md
supersedes: []
related_code:
  - ui/src/hooks/useDateRange.ts
  - ui/src/lib/date-range-cache.ts
  - ui/src/pages/Costs.tsx
  - ui/src/components/ProviderQuotaCard.tsx
  - tests/e2e/cost-trend.spec.ts
  - doc/product/domains/governance-and-visibility/approvals-budgets-activity.md
commit_refs:
  - "fix(ui): remove month-to-date cost preset"
updated_at: 2026-07-27
---

# Remove the Month to Date Date-Range Preset

## Summary

Remove Month to Date from the executable date-range model and Costs UI, then
make Last 24 Hours the initial Costs range with hourly trend aggregation.
Preserve monthly budget enforcement and month-based health metrics that are
not date-filter presets.

## Problem

Costs currently defaults to Month to Date, and the `mtd` value remains
callable through shared date-range types and resolution logic even if its UI
entry were removed. The selected range also drives a provider budget-deficit
notch that assumes a month-to-date window.

## Scope

In scope:

- remove `mtd` from date preset types, labels, ordering, and date resolution;
- default Costs to Last 24 Hours and retain its hourly trend granularity;
- remove the Month-to-Date-only provider budget-deficit calculation and its
  component wiring;
- update unit, component-adjacent, and E2E evidence;
- align `BUDGET.ENFORCEMENT.001` with the supported Costs ranges and default.

Out of scope:

- monthly budget periods, thresholds, enforcement, or hard stops;
- Dashboard month-to-date spend and Inbox monthly budget utilization;
- Calendar month views or the Year to Date preset;
- API date-boundary parameters, database schema, or cost aggregation storage.

## Implementation Plan

1. Narrow the shared UI date-preset unions and remove Month to Date labels and
   resolver branches.
2. Change the Costs hook default to Last 24 Hours.
3. Remove Month-to-Date-only provider deficit-notch derivation and prop
   plumbing while retaining generic and weekly quota warnings.
4. Update E2E coverage to prove the absent preset, default rolling query,
   hourly trend, Custom memory, and large-token aggregation.
5. Synchronize the authorized Product Logic contract and run focused plus
   repository-level validation.
6. Inspect the actual Costs page at desktop and narrow viewport widths and
   attach screenshots to the issue close-out.

## Design Notes

- `SlidingDatePreset` remains broader than the Costs-only `DatePreset` because
  Dashboard and Agent detail use `1d` and `15d`; neither union retains `mtd`.
- Last 24 Hours remains minute-aligned and maps to explicit hourly aggregation.
- Removing the selected-period deficit notch does not remove the reusable
  quota bar notch or the weekly over-allocation warning.
- Existing callers still send explicit `from` and `to` timestamps, so server
  routes and date-boundary protocols do not change.

## Success Criteria

- No executable source or active test references the `mtd` preset.
- Costs initially selects Last 24 Hours and requests an hourly trend.
- Last 7 Days, Last 30 Days, Year to Date, All Time, and Custom remain
  available and Custom retains its remembered inputs.
- Monthly budget enforcement and non-selector monthly metrics remain intact.

## Validation

- `pnpm exec vitest run ui/src/lib/date-range-cache.test.ts
  ui/src/pages/Costs.test.tsx` passed 16/16 tests.
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts
  cost-trend.spec.ts` passed 3/3 tests, including the default hourly query,
  Custom memory, responsive layouts, and large token totals.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm build`, and
  `pnpm product-logic:check` passed; the Product Logic registry validated all
  79 contracts.
- The repository-wide `pnpm test:run` completed with 604 files passing,
  39 failing, and one skipped. The failures were unrelated environment and
  concurrency failures in database-backed, workspace-preview, CLI, and
  runtime suites; the focused Costs suites remained green.
- The live Costs page was inspected at desktop and 390-pixel widths. Both
  showed Last 24 Hours selected, no Month to Date option, all retained
  presets, and an hourly trend description without layout regressions.
- Independent implementation review and black-box verification reported no
  findings. The verifier reran the Costs E2E suite successfully and confirmed
  the packaged `prod_local/default` Desktop process remained healthy and
  unchanged.

## Open Issues

None.
