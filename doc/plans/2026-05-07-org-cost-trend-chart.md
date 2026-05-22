---
title: Organization cost trend chart
date: 2026-05-07
kind: implementation
status: completed
area: ui
entities:
  - org_costs
  - cost_trends
issue: ZST-53
related_plans: []
supersedes: []
related_code:
  - server/src/services/costs.ts
  - server/src/routes/costs.ts
  - packages/shared/src/types/cost.ts
  - ui/src/pages/Costs.tsx
commit_refs:
  - feat: add org cost trend chart
updated_at: 2026-05-07
---

# Organization Cost Trend Chart

## Scope

Add a chart to the organization Costs page that makes token consumption and estimated inference spend visible over the selected date range.

## Plan

1. Add a small organization-scoped trend API over `cost_events` grouped by UTC day.
2. Share the trend response type through `@rudderhq/shared` and the UI API client.
3. Render a compact overview chart on `/costs` showing daily token volume and spend.
4. Add automated coverage for the new route and visible Costs UI path.
5. Run focused validation, then broader checks before hand-off.
