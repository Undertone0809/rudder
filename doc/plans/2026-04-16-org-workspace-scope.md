---
title: Org workspace scope
date: 2026-04-16
kind: plan
status: completed
area: workspace
entities:
  - org_workspace
  - project_workspace
  - execution_workspace
issue: RUD-102
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
supersedes: []
related_code:
  - server/src/services/orgs.ts
  - server/src/services/workspace-runtime.ts
  - server/src/__tests__/projects-service.test.ts
commit_refs:
  - feat: scope workspaces to organizations
updated_at: 2026-04-17
---

# Org Workspace Scope

## What Changed

RUD-102 changes workspace ownership from project-scoped codebase setup to organization-scoped codebase setup.

Current behavior:

- projects can create and own a `project_workspace`
- project creation UI can immediately create a workspace
- issue defaults and run resolution infer shared codebase from project workspaces

Target behavior:

- each organization owns one shared codebase/workspace configuration
- creating a project does not create a workspace
- project and issue flows reuse the organization workspace by default

## Diagnosis

Primary layer: engineering architecture

Secondary layer: information architecture

Why this is the real issue:

- the current system conflates "project" with "codebase root"
- workspace selection is embedded in project CRUD, issue defaults, and runtime resolution
- changing only project creation would leave hidden fallback behavior still tied to project workspaces

## Decision

Use a compatibility-preserving transition:

1. Add organization-scoped workspace/codebase fields to the organization contract.
2. Route new project codebase behavior through the organization workspace.
3. Stop project creation UI/API from creating a workspace.
4. Keep legacy `project_workspaces` support for existing records and compatibility paths, but do not rely on it for new org-scoped flows.

This avoids a large destructive migration of all `project_workspace_id` references while still making org workspace the new canonical shared codebase source.

## Implementation Plan

1. Extend org schema/shared types/validators/API to carry org workspace config.
2. Update organization service and settings UI so board users can read and update the org workspace.
3. Remove workspace creation from project creation flow and project detail codebase editing; point those surfaces to org settings instead.
4. Change project hydration to derive codebase from org workspace first, with legacy project workspace fallback only for old data.
5. Change issue defaults and run workspace resolution to use org workspace when no valid project workspace is selected.
6. Update relevant docs/tests, especially service tests and UI/route tests affected by the new contract.

## Evaluation Criteria

- a newly created project has no workspace side effect
- project detail shows the org codebase rather than requiring a project workspace
- new issues in a project still resolve a shared workspace cwd/repo through the organization
- existing legacy project workspace data still works
- automated coverage exercises at least one new org-scoped path and one legacy fallback path

## Validation Plan

- `pnpm -r typecheck`
- targeted tests for org/project/issue workspace resolution
- relevant UI test coverage if the changed surface already has a nearby suite
- `pnpm test:run`
- `pnpm build`

## Related Commit

- `feat: scope workspaces to organizations`
