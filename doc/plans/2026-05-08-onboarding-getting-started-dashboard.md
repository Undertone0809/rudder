---
title: Onboarding Getting Started dashboard handoff
date: 2026-05-08
kind: implementation
status: implemented
area: ui
entities:
  - onboarding_wizard
  - getting_started_project
issue: ZST-10
related_plans:
  - 2026-04-12-onboarding-project-container.md
supersedes:
  - 2026-04-12-onboarding-project-container.md
related_code:
  - ui/src/components/OnboardingWizard.tsx
  - tests/e2e/onboarding.spec.ts
  - tests/release-smoke/docker-auth-onboarding.spec.ts
commit_refs: []
updated_at: 2026-05-08
---

# Onboarding Getting Started Dashboard Handoff

## Goal

Make the new-organization onboarding path shorter: after the user creates the
first agent, Rudder should create the starter project and send the user to the
organization dashboard instead of asking them to edit a first issue.

## Scope

- Rename the starter project from `onboarding` to `Getting Started`.
- For newly created organizations, finish onboarding immediately after the
  first agent is created.
- Preserve the existing add-agent flow for existing organizations, including
  starter-task creation.
- Update E2E coverage for the new new-organization handoff and project name.

## Validation

- Run the onboarding E2E spec focused on the wizard behavior.
- Run the relevant UI checks if the E2E suite exposes unrelated failures.
