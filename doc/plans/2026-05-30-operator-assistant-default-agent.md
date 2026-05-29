---
title: Operator Assistant default agent
date: 2026-05-30
kind: implementation
status: implemented
area: ui
entities:
  - onboarding_wizard
  - default_agent
issue:
related_plans:
  - 2026-05-08-onboarding-getting-started-dashboard.md
  - 2026-04-27-rudder-onboarding-issue-system-proposal-v1.md
supersedes: []
related_code:
  - ui/src/components/OnboardingWizard.tsx
  - ui/src/components/OnboardingWizard.parts.tsx
  - ui/src/pages/NewAgent.tsx
  - server/src/onboarding-assets/ceo/SOUL.md
  - docs/get-started/first-organization.mdx
  - docs/how-to/create-agent.mdx
commit_refs:
  - cac423ae
updated_at: 2026-05-30
---

# Operator Assistant Default Agent

## Summary

Change the user-facing default first agent from a CEO persona to an Operator
Assistant while preserving the existing internal `ceo` role as the compatibility
root authority for permissions and organization bootstrap behavior.

## Problem

The current first-agent flow presents the agent as a CEO and seeds a CEO-style
task about hiring a founding engineer. That pushes onboarding toward company
simulation instead of Rudder's first useful loop: turn a real request into a
tracked, reviewable work object with evidence and feedback.

## Scope

- Set the default first-agent title to `Operator Assistant`.
- Keep the internal first-agent role as `ceo` in this pass.
- Rewrite the starter task copy away from hiring and strategy simulation.
- Rewrite the default first-agent SOUL copy away from CEO/P&L language.
- Update public docs that describe the default agent.
- Add focused regression coverage for the default title and onboarding payload.

Out of scope:

- Adding a new `lead` or `operator_assistant` enum role.
- Migrating existing CEO agents.
- Reworking root-agent permissions, invite types, or organization governance.

## Implementation Plan

1. Update onboarding constants and agent creation payload.
2. Update the New Agent first-agent default title and first-agent helper copy.
3. Replace the CEO SOUL content with Operator Assistant identity content.
4. Update user-facing docs to explain the default agent's real workflow role.
5. Update focused tests and onboarding E2E assertions.
6. Run targeted tests, then broader validation as feasible.

## Design Notes

The compatibility boundary is deliberate. Today, `ceo` is both a product persona
and a permission-bearing root role in several backend checks. This change only
removes the CEO persona from the default first-user experience. A later migration
can introduce a neutral internal root role after permission checks and invite
flows are separated from naming.

## Success Criteria

- A new organization's first agent still has a generated name but displays
  `Operator Assistant` as its title.
- The first-agent starter task no longer asks the agent to act as CEO or hire.
- The default first-agent instructions describe assistant/operator work loops.
- Existing CEO compatibility behavior remains intact.

## Validation

- `pnpm test:run server/src/__tests__/agent-instructions-service.test.ts server/src/__tests__/agent-skills-routes.test.ts`
- `pnpm test:run ui/src/lib/agent-labels.test.ts ui/src/components/SidebarAgents.test.ts`
- `pnpm --filter @rudderhq/ui typecheck`
- `pnpm -r typecheck`
- `pnpm build`
- `RUDDER_E2E_USE_EXISTING_SERVER=1 RUDDER_E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-auto-name.spec.ts --project=chromium`

Blocked or partial validation:

- Isolated `pnpm test:e2e -- onboarding.spec.ts` could not start the web server
  because embedded PostgreSQL init exited during bootstrap before scenarios ran.
- Existing-server onboarding proof reached the new `role: "ceo"` plus
  `title: "Operator Assistant"` assertions, then failed later on an unrelated
  issue-board `Welcome` text expectation while the product tour overlay was
  visible in the reused dev instance.
- Full `pnpm test:run` was attempted but failed in unrelated embedded
  PostgreSQL init suites and two pre-existing timeout/socket tests; the targeted
  task tests passed.

## Open Issues

- A later role-model cleanup should decide whether to introduce an internal
  `lead` role and migrate CEO-specific permission checks.
