---
title: Remove resources.md special handling
date: 2026-04-18
kind: implementation
status: completed
area: workspace
entities:
  - resources_md
  - org_resources
  - agent_run_context
issue:
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-17-org-resource-catalog-and-agent-run-context.md
  - 2026-04-17-org-resources-onboarding-and-ready-state.md
supersedes: []
related_code:
  - server/src/services/agent-run-context.ts
  - server/src/services/organization-workspace-browser.ts
  - server/src/home-paths.ts
  - ui/src/pages/OrganizationResources.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/OrganizationSettings.tsx
  - ui/src/components/ProjectProperties.tsx
commit_refs: []
updated_at: 2026-04-18
---

# Remove resources.md special handling

## Summary

Rudder now has an org-level structured resource catalog plus project-level
resource attachments. `resources.md` no longer clarifies the model; it creates a
second operator-facing setup path and still carries runtime-special semantics.
This change removes `resources.md` as a special product/runtime object and makes
structured resources the only shared resource model.

## Problem

- operators currently have two overlapping ways to describe shared context:
  structured `Resources` and special-case `resources.md`
- the Workspaces page still carries onboarding, ready/draft, and agent-loading
  controls that no longer belong to a generic file browser
- runtime prompt assembly still depends on `resources.md`, so deleting the UI
  affordance without replacing runtime behavior would regress org-level context

## Scope

- in scope:
  - remove `resources.md`-specific UI copy, badges, activation flow, and deep
    links
  - remove `resources.md` metadata/status from shared contracts and workspace
    browser responses
  - stop auto-creating or specially encoding `resources.md`
  - compile org/project resource context for agent runs from structured
    resources instead of markdown notes
  - update tests and contributor docs that still describe `resources.md` as a
    special shared surface
- out of scope:
  - deleting existing `resources.md` files from user workspaces
  - redesigning the overall Resources catalog UX again
  - changing the project resource attachment model

## Implementation Plan

1. Remove `resources.md`-specific metadata helpers and workspace-browser
   contract fields from shared/server layers.
2. Update organization workspace bootstrapping so it only ensures the generic
   workspace layout, without creating a special markdown file.
3. Rework agent run context assembly to build prompt/context from structured org
   resources plus project attachments, with no `resources.md` dependency.
4. Simplify Workspaces, Resources, Settings, and Project properties UI so they
   no longer mention or control `resources.md`.
5. Update unit/E2E coverage and bundled Rudder docs to match the new single
   source of truth.

## Design Notes

- `resources.md` may still exist as a user-created file, but Rudder should treat
  it exactly like any other workspace file.
- org-level runtime context should come from the structured org resource catalog;
  project runs should add project attachment roles and notes on top.
- keep Workspaces valuable by centering it on generic shared files and skill
  editing, not on one privileged file.

## Success Criteria

- no user-facing surface treats `resources.md` as a required or special object
- new orgs do not get an auto-created `resources.md`
- runtime context still includes reusable org/project resource information after
  removing markdown injection
- automated coverage proves the new runtime/context behavior and the simplified
  UI flow

## Validation

- `pnpm -r typecheck`
- `pnpm test:run`
- targeted Playwright coverage for org Resources/Workspaces and project
  Resources tab
- visual verification of org sidebar, Resources page, Workspaces page, and
  project Resources tab
- `pnpm build`

## Open Issues

- decide later whether Rudder should offer a generic notes file template inside
  Workspaces, but without special runtime semantics
