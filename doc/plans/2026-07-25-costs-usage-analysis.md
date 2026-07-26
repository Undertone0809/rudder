---
title: Improve Costs Usage Analysis
date: 2026-07-25
kind: implementation
status: implemented
area: ui
entities:
  - costs_overview
  - cost_aggregation
  - date_ranges
issue: R6Z-23
related_plans: []
supersedes: []
related_code:
  - ui/src/pages/Costs.tsx
  - ui/src/pages/Costs.distribution.tsx
  - ui/src/hooks/useDateRange.ts
  - ui/src/lib/date-range-cache.ts
  - packages/shared/src/types/cost.ts
  - server/src/routes/costs.ts
  - server/src/services/costs.ts
  - tests/e2e/cost-trend.spec.ts
commit_refs: []
updated_at: 2026-07-25
---

# Improve Costs Usage Analysis

## Summary

Turn the Costs Overview into a usage-analysis surface with a rolling 24-hour
range, explicit hourly or daily trend aggregation, four usage metrics, and
responsive Agent and Project distribution charts. Keep the Finance ledger in
its dedicated tab and preserve existing budget, provider, and biller behavior.

## Problem

The current Overview mixes inference usage with finance-ledger summaries,
supports only daily trends, omits cached-token and runtime-duration metrics,
and excludes unattributed cost events from Project totals. Its Custom range
also starts empty, while low-contrast trend labels and clipped top ticks make
the existing chart difficult to read.

## Scope

In scope:

- add a minute-aligned rolling 24-hour preset and explicit `hour` / `day`
  trend granularity across shared, API, route, service, cache, and UI layers;
- default the first Custom selection to the latest seven local calendar days,
  preserve later selections, and reject reversed date ranges;
- aggregate cumulative overlapping `heartbeat_runs` duration into cost
  summaries without a schema migration;
- include an Unattributed row in Project aggregation while keeping only real
  Project IDs eligible for trend filtering;
- replace Overview finance and expandable Agent-ledger cards with four usage
  metrics and reusable Token/Cost distribution panels;
- improve trend axis contrast, spacing, hourly labels, complete tooltips, and
  narrow-screen behavior;
- align `BUDGET.ENFORCEMENT.001` and its code/test registry entries.

Out of scope:

- changing budget enforcement, provider quota, biller, or Finance semantics;
- persisting cost-summary rollups or adding database columns;
- treating overlapping runs as unique wall-clock time.

## Implementation Plan

1. Extend date-range helpers and hook state with `24h`, Custom defaults,
   reversed-range validation, and a returned trend granularity.
2. Add the shared granularity contract and active duration field, then thread
   granularity through UI API calls, query keys, route validation, and service
   calls.
3. Implement UTC hourly trend buckets, cumulative clipped run duration, and
   Unattributed Project aggregation in the cost service.
4. Refactor Costs Overview metrics and trend formatting, conditionally fetch
   Finance only for its tab, and add responsive accessible distribution
   panels with bounded `Other` grouping.
5. Add helper, route, PostgreSQL service, component, and Playwright coverage,
   then update the authorized Product Logic contract.
6. Run focused and repository-wide validation, inspect desktop and narrow UI
   screenshots, and obtain independent reviewer and verifier checks.

## Design Notes

- Hour buckets are UTC-aligned identifiers; axis and tooltip presentation use
  the browser's local time zone.
- Active duration sums each run once after clipping its interval to the
  selected range. Running runs end at the earlier of query time and range end.
- Distribution totals come from the same cost-event aggregations as the
  summary. Project rows retain a null ID for Unattributed, but null IDs never
  enter the trend-filter request.
- Finance queries are enabled only while the Finance tab is active.

## Success Criteria

- Last 24 Hours produces hourly buckets and local-hour labels.
- Estimated cost, total tokens, cached tokens, and active duration match their
  documented aggregation semantics.
- Project distribution includes Unattributed and both distribution panels
  support Token/Cost toggles, Other grouping, empty states, and responsive
  layouts.
- Custom immediately loads a valid seven-day range and never queries a reversed
  interval.
- Finance remains functional in its tab and is absent from Overview.

## Validation

- Focused Vitest coverage passed: 29 date-range, Costs component, and route
  tests.
- PostgreSQL-backed cost rollup coverage passed: 9 tests for hour/day buckets,
  clipped active duration, Unattributed rows, and deterministic single-Project
  Run attribution.
- Playwright passed all 3 cases in `tests/e2e/cost-trend.spec.ts`, including
  the rolling 24-hour workflow, Custom defaults, metrics, responsive
  distributions, and large token totals.
- Full lint, repository typecheck, build, changed-import lint, focused
  typechecks, and `pnpm product-logic:check` (79 contracts) passed.
- The repository-wide `pnpm test:run` completed with 5,392 passing, 729
  skipped, and 58 failures caused by host workspace environment pollution,
  shared PostgreSQL exhaustion, unrelated timeouts, and current-main route
  drift. All changed focused suites above passed independently.
- The actual Costs page was inspected in Chromium at desktop and 390-pixel
  viewport widths; both screenshots are attached to the issue handoff.
- Independent implementation review and verification completed; the review's
  Project attribution and metric-toggle accessibility findings were fixed and
  re-reviewed with no remaining blockers.

## Open Issues

None.
