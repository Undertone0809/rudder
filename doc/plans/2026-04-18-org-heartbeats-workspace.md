---
title: Org heartbeats workspace
date: 2026-04-18
kind: implementation
status: planned
area: ui
entities:
  - org_heartbeats
  - heartbeat_runs
  - agent_runtime_control
issue:
related_plans:
  - 2026-03-28-heartbeats-on-off-buttons.md
supersedes: []
related_code:
  - ui/src/App.tsx
  - ui/src/components/ThreeColumnContextSidebar.tsx
  - ui/src/components/OrganizationSettingsSidebar.tsx
  - ui/src/pages/InstanceSettings.tsx
  - ui/src/api/heartbeats.ts
commit_refs: []
updated_at: 2026-04-18
---

# Org Heartbeats Workspace

## Summary

Add an organization-scoped `Heartbeats` workspace page so operators can manage
timer heartbeat policy and inspect recent org activity without leaving the org
surface or drilling into one agent at a time.

The new page should sit alongside `Structure`, `Resources`, `Workspaces`,
`Goals`, `Skills`, `Costs`, and `Activity` as an org workspace destination
instead of being hidden behind cross-org instance settings.

## Problem

Rudder already exposes heartbeat data and controls, but the current surface
split is wrong for normal org operations:

- instance settings show timer heartbeat rows across all organizations
- agent detail shows one agent's run history and run detail
- dashboard and agents pages show partial run summaries

What is missing is the org-scoped control plane view that answers:

- which agents in this org are scheduled
- which are configured but inactive
- when they last ran
- what happened most recently
- what the operator can do right now

## Scope

- in scope:
  - new org route and sidebar item for `Heartbeats`
  - org-level page that groups heartbeat control by agent
  - reuse of existing org heartbeat APIs where possible
  - direct row actions for enable/disable and open/run navigation
  - automated coverage for the org heartbeats page
- out of scope:
  - scheduler backend redesign
  - new database schema
  - replacing agent run detail
  - changing instance-wide heartbeats settings behavior

## Implementation Plan

1. Add a new org workspace route and sidebar nav item for `/:orgPrefix/heartbeats`.
2. Extract or reuse the existing heartbeat enable/disable mutation logic so the
   org page and instance page stay behaviorally aligned.
3. Build an org-scoped page that:
   - shows summary counts for live, scheduled, configured inactive, and disabled
   - renders one row per agent with scheduler state, interval, last heartbeat,
     and latest run summary
   - links to the agent detail and most recent run when available
4. Keep the org page focused on operator control and summary, not full transcript
   inspection.
5. Add or update tests for route rendering, heartbeat toggling behavior, and
   page summaries.

## Design Notes

- This is an org workspace, not an org settings subpage. Heartbeats are part of
  runtime operations, not static org configuration.
- The page should aggregate by agent. Raw run history remains a secondary block
  so the surface does not collapse into a log browser.
- Existing instance heartbeats settings remain useful for cross-org admin scan
  and bulk control, but the normal operator path should be org-scoped.
- Reuse the same scheduler state language as the instance page:
  `Scheduled`, `Configured, inactive`, and `Disabled`.

## Success Criteria

- Org navigation exposes a first-class `Heartbeats` destination.
- The page loads within the current organization context only.
- Operators can tell which agents are scheduled, inactive, or disabled at a
  glance.
- Operators can change heartbeat enabled state from the org page without opening
  instance settings.
- The page does not duplicate the full agent run-detail experience.

## Validation

- `pnpm -r typecheck`
- targeted UI test coverage for the org heartbeats page
- relevant E2E or route-level coverage for org navigation and heartbeat control
- `pnpm test:run`
- `pnpm build`
- visual verification in a rendered browser or desktop shell with screenshot

## Open Issues

- Whether `Run now` should be exposed as a first-class row action or remain an
  agent-detail action if the current mutation plumbing is awkward.
