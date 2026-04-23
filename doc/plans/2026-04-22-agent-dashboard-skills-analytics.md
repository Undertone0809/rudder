---
title: RUD-156 agent dashboard skills analytics
date: 2026-04-22
kind: implementation
status: completed
area: ui
entities:
  - agent_dashboard
  - agent_skills
  - heartbeat_run_events
issue: RUD-156
related_plans:
  - 2026-04-11-agent-skills-surface-refresh.md
  - 2026-04-18-org-heartbeats-workspace.md
supersedes: []
related_code:
  - ui/src/pages/AgentDetail.tsx
  - ui/src/components/ActivityCharts.tsx
  - ui/src/api/agents.ts
  - server/src/routes/agents.ts
  - server/src/services/heartbeat.ts
commit_refs: []
updated_at: 2026-04-22
---

# RUD-156 Agent Dashboard Skills Analytics

## Summary

Add a dashboard-level skills analysis section to the Agent detail page so the
operator can answer:

- which skills this agent has been loading over time
- which skills dominate recent runs
- whether usage is concentrated or spread across many skills

The target interaction follows the reference issue screenshots: a full-width
time-series chart with stacked daily bars and a tooltip that breaks one day down
by skill.

## Problem

The current agent surface splits skills into two disconnected modes:

- the `Skills` tab shows configuration state
- the `Dashboard` tab shows run, issue, and cost activity

What is missing is the bridge between those surfaces. Today the dashboard cannot
show whether the configured skills are actually showing up in recent execution.

This is mainly an information-architecture and observability gap, not a card
layout gap.

## Data Constraint

Rudder currently records loaded runtime skills in run-time adapter metadata and
in `heartbeat_run_events` as `adapter.invoke` payloads. It does not yet record a
separate "the model invoked skill X" event stream.

Because of that, this implementation should present honest language based on the
available evidence:

- aggregate loaded skills per run/day from `adapter.invoke` events
- avoid claiming exact per-invocation skill execution when that telemetry does
  not exist yet

## Scope

- in scope:
  - backend aggregation for one agent over the last 30 days
  - shared API contract for the skills analytics payload
  - a new dashboard section with stacked daily bars and hover detail
  - tooltip breakdown that highlights the most-used skills for a day
  - automated coverage for aggregation and the visible dashboard surface
- out of scope:
  - new telemetry schema
  - rewriting Skills tab configuration UX
  - org-level skills analytics
  - claiming exact skill invocation counts when only loaded-skill metadata exists

## Implementation Plan

1. Add a dedicated agent-level analytics response type for dashboard skills data.
2. Add a backend route that reads `heartbeat_run_events` for the target agent,
   filters `adapter.invoke`, extracts `loadedSkills`, and returns a 30-day daily
   series plus top-skill rollups.
3. Reuse the compact dashboard chart language to render a full-width stacked bar
   chart on the Agent dashboard with a detail tooltip.
4. Place the new section as dashboard evidence, not as a replacement for the
   existing Skills tab.
5. Add one backend/service test for aggregation correctness and one E2E that
   seeds run events and verifies the dashboard section renders the expected
   totals.

## Design Notes

- The section should read as operational evidence, not marketing analytics.
- Keep the surface dense and scannable: one section title, one short subtitle,
  one chart, one compact legend.
- Tooltip detail should prioritize the top skills for the selected day and roll
  overflow into an `Other skills` row when needed.
- Empty state should explain that no recent run metadata with loaded skills is
  available yet.

## Success Criteria

- Agent dashboard exposes a first-class skills analysis section.
- The chart shows the last 30 days with day-level stacked bars.
- Hovering a day reveals the per-skill breakdown and total for that day.
- The implementation does not mislabel loaded-skill metadata as stronger
  telemetry than Rudder currently has.

## Validation

- `pnpm -r typecheck`
- targeted Vitest coverage for skills analytics aggregation
- targeted E2E for the agent dashboard skills section
- `pnpm test:run`
- `pnpm build`
- visual verification in the browser or desktop shell with screenshot
