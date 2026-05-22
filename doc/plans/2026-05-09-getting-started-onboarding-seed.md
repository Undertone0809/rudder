---
title: Getting Started onboarding seed
date: 2026-05-09
kind: implementation
status: implemented
area: ui
entities:
  - onboarding_seed
  - getting_started_project
  - agent_work_loop
issue: ZST-10
related_plans:
  - 2026-05-08-onboarding-getting-started-dashboard.md
supersedes: []
related_code:
  - server/src/routes/onboarding.ts
  - ui/src/components/OnboardingWizard.tsx
  - ui/src/components/IssuesList.tsx
  - tests/e2e/onboarding.spec.ts
commit_refs: []
updated_at: 2026-05-09
---

# Getting Started Onboarding Seed

## Context

The first implementation of ZST-10 only renamed the starter project and handed new organizations directly to the dashboard after agent creation. The issue proposal is broader: new workspaces should receive a `Getting Started` project, one welcome reference issue, and a compressed set of guided onboarding issues that teach the first real agent work loop.

## Requirements From Proposal

- Generate a `Getting Started` project automatically for new workspaces.
- Generate the welcome issue once per workspace as a Done, high-priority reference.
- Generate four core Todo issues, two recommended Backlog issues, and four advanced Backlog issues.
- Assign onboarding action-card issues to the current operator, not the agent.
- Keep new-organization onboarding as a dashboard handoff after the first agent is created.
- Visually group Getting Started issues into welcome, core loop, recommended next, and advanced sections.
- Preserve the existing add-agent flow for existing organizations.

## Implementation Plan

1. Add a server-side idempotent onboarding seed endpoint so the server can assign issues to the current board operator.
2. Move the proposal copy into structured seed templates with stable titles and statuses.
3. Call the seed endpoint from the new-organization onboarding handoff after the first agent is created.
4. Add a Getting Started project grouping path in the issues list UI.
5. Update onboarding E2E and release smoke coverage to assert seeded project and issues.

## Validation

- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- Focused onboarding E2E passed with an external PostgreSQL database: `RUDDER_E2E_DATABASE_URL=... RUDDER_E2E_SKIP_LLM=true npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/onboarding.spec.ts`.
- `pnpm test:run` was attempted and failed on local embedded PostgreSQL init failures unrelated to this onboarding seed.

## Non-Goals

- Do not add full issue pinning data model in this pass; represent the welcome reference as the first Done/high-priority Getting Started seed item until issue pinning exists.
- Do not change the existing organization add-agent flow that still creates a first agent task.
