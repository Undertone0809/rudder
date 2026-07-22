---
title: Simplify Getting Started onboarding issues
date: 2026-07-22
kind: implementation
status: completed
area: ui
entities:
  - organization_onboarding
  - getting_started_project
  - messenger_chat
issue:
related_plans:
  - 2026-04-12-onboarding-project-container.md
supersedes: []
related_code:
  - server/src/routes/onboarding.ts
  - ui/src/components/IssuesList.tsx
  - ui/src/components/OnboardingWizard.tsx
  - tests/e2e/onboarding.spec.ts
  - tests/release-smoke/docker-auth-onboarding.spec.ts
commit_refs: []
updated_at: 2026-07-22
---

# Simplify Getting Started Onboarding Issues

## Summary

For newly onboarded organizations, replace the Welcome plus eleven tutorial
issues with three concise guide issues: a completed Welcome reference and two
high-priority actions that lead the operator through one real agent-work loop.
Chat and Issues remain equal work surfaces, and the operator completes the two
guide issues manually after inspecting real work and recording a decision.

## Problem

The current twelve-issue starter project creates more onboarding backlog than
first-session guidance. It asks a new operator to manage tutorial inventory
before experiencing Rudder's core value: run useful work, inspect the result,
and decide what happens next.

## Scope

In scope:

- Seed exactly three v2 issues for a fresh full onboarding seed:
  - `👋 Welcome to Rudder — quick reference` as Done / Low.
  - `1. Run one real task` as Todo / High.
  - `2. Review the result and close the loop` as Todo / High.
- Assign the two action issues to the operator, with no agent assignment.
- Give the action issues existing-route CTAs for Chat, Issues, review, and
  Messenger without adding a routing protocol.
- Preserve the seed endpoint and response shape.
- Keep `includeTutorial: false` as a Welcome-only seed.
- Freeze legacy and unrelated non-empty Getting Started projects.
- Preserve legacy recommended/advanced grouping in the Issues UI.
- Update `ORG.ONBOARDING.001` and automated acceptance coverage.

Out of scope:

- Database migrations or schema changes.
- An onboarding state machine.
- Automatic guide completion, status synchronization, or project archival.
- Migration, cleanup, or rewriting of existing organizations.
- A seeded advanced-learning backlog.
- Public API or shared type changes.

## Implementation Plan

1. Update onboarding and release-smoke E2E expectations first, including v2
   idempotency, manual completion persistence, Messenger state, and legacy or
   unrelated-project immutability.
2. Replace the server seed catalog with the three v2 issues and add an explicit
   legacy-title classifier. Seed or repair only empty or v2 projects; return
   frozen projects unchanged before any description, issue, grouping, or
   read-state mutation.
3. Add organization-aware links using existing routes: prefilled Chat, filtered
   Issues, the second guide issue, and Messenger.
4. Update the onboarding checkbox help text and project description.
5. Preserve legacy title grouping in `IssuesList` while covering the new core
   guide copy.
6. Synchronize `ORG.ONBOARDING.001`, leaving
   `MESSENGER.CUSTOM.GROUPS.001` semantically unchanged.
7. Run focused and full validation, browser-check desktop and mobile layouts,
   and obtain independent reviewer and black-box verifier results.

## Design Notes

- The v2 completion standard is a real task followed by an inspectable result
  and a recorded human decision.
- Guide statuses are independent of the real Chat or Issue. Rudder does not
  infer or synchronize their completion.
- The existing twelve seeded titles form a frozen legacy-title set. If any are
  present, explicit reseeding and existing-organization agent onboarding return
  the project and its issues with HTTP 200 without changing project metadata,
  issue fields/order, Messenger membership, or read state.
- A non-empty Getting Started project containing neither legacy nor v2 titles
  is frozen by the same rule.
- Empty projects and projects containing v2 titles may be seeded or repaired
  idempotently. Repeated seeds reuse IDs; false-to-true adds only the action
  issues; true-to-false deletes nothing.
- The route contract remains local to seeded Markdown links. No new endpoint,
  query protocol, database column, or shared model is introduced.

## Success Criteria

- A fresh full seed creates exactly three correctly ordered guide issues with
  the specified status, priority, and assignee behavior.
- An experienced-user seed creates only Welcome.
- Chat, Issues, review, and Messenger CTAs retain organization and relevant
  agent/project context.
- The two action guides remain Done after manual completion and reload.
- Messenger contains exactly three ordered, already-read starter threads with
  no attention or sidebar badge debt.
- V2 reseeding is idempotent and existing frozen projects remain byte-for-byte
  unchanged.
- No database migration, public API, or shared type change is present.

## Validation

- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- focused onboarding E2E
- release smoke onboarding coverage
- desktop and mobile browser verification with screenshots
- independent exploratory reviewer and real-environment black-box verifier PASS

## Open Issues

None. The product and compatibility decisions in this plan are approved.
