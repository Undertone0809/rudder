---
title: Agent runs sort and trigger distribution
date: 2026-05-29
kind: implementation
status: implemented
area: ui
entities:
  - agent_dashboard
  - agent_runs
  - heartbeat_runs
issue:
related_plans:
  - 2026-04-22-agent-dashboard-skills-analytics.md
  - 2026-04-18-org-heartbeats-workspace.md
supersedes: []
related_code:
  - ui/src/pages/AgentDetail.runs.tsx
  - ui/src/pages/AgentDetail.run-filters.tsx
  - ui/src/pages/AgentDetail.overview.tsx
  - ui/src/components/ActivityCharts.tsx
commit_refs: []
updated_at: 2026-05-29
---

# Agent Runs Sort And Trigger Distribution

## Summary

Add a compact sort control to the Agent detail Runs tab and add a dashboard
distribution view that shows what triggered recent runs in the selected time
window.

## Problem

The Runs tab already supports filtering, but the list always sorts by newest
run. Operators cannot answer simple triage questions such as which runs in the
current filter were longest, most token-heavy, or most expensive. The Agent
Dashboard also shows volume and success rate but not the mix of run triggers.

## Scope

- in scope:
  - URL-backed sort state for the Runs tab
  - sorting after the existing filter state is applied
  - compact sort UI in the existing floating toolbar
  - dashboard trigger distribution card for the active date window
  - focused unit and E2E coverage
- out of scope:
  - backend pagination or new API contracts
  - changing how runs are persisted
  - redefining the durable heartbeat invocation taxonomy

## Implementation Plan

1. Extend run filter state with a sort field and helper that sorts filtered
   runs by created time, duration, token volume, or cost.
2. Add a sort popover to the existing Runs toolbar and preserve sort in URL
   query parameters.
3. Add a dashboard trigger distribution chart based on the current dashboard
   run window and the existing run reason classifier.
4. Update unit tests for sort parsing, chips, and ordering.
5. Update E2E coverage for the Runs toolbar and dashboard distribution.
6. Verify in browser and capture the changed Agent detail surface.

## Design Notes

- Keep the UI dense and operational. Sort should be a secondary control beside
  the existing filter button, not a new panel.
- The distribution card should answer "what wakes this agent" without claiming
  a stronger source taxonomy than current run metadata supports.
- Sorting is scoped to the loaded run set for this first UI slice.

## Success Criteria

- Runs can be filtered and then sorted by duration.
- URL state preserves the selected sort.
- Agent Dashboard shows a readable trigger distribution for the selected
  date range.
- Existing run filters and selected-run behavior continue to work.

## Validation

- `pnpm --filter @rudderhq/ui test -- AgentDetail.run-filters ActivityCharts --runInBand`
- `pnpm --filter @rudderhq/ui typecheck`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-runs-filter-menu.spec.ts tests/e2e/agent-dashboard-skills-analytics.spec.ts`
- `pnpm -r typecheck`
- attempted `pnpm test:run`; task-focused tests passed, but the full suite was
  blocked by unrelated current workspace/package dist and async database
  teardown failures outside this UI change.

## Open Issues

- A later backend slice should move large-history sorting into the API when
  operators need strict queries across more than the loaded run limit.
