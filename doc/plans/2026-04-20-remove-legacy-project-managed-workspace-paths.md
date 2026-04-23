---
title: Remove legacy project-managed workspace paths
date: 2026-04-20
kind: implementation
status: completed
area: workspace
entities:
  - org_workspace
  - project_workspace
  - organization_plans
issue: RUD-148
related_plans:
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
  - 2026-04-16-org-workspace-scope.md
  - 2026-04-16-org-workspaces-fixed-root-resources.md
supersedes: []
related_code:
  - server/src/home-paths.ts
  - server/src/services/agent-run-context.ts
  - server/resources/bundled-skills/para-memory-files/SKILL.md
  - server/src/onboarding-assets/ceo/AGENTS.md
commit_refs:
  - fix: remove legacy project workspace fallback
updated_at: 2026-04-20
---

# Remove legacy project-managed workspace paths

## Summary

RUD-148 closes the remaining gap between the org-scoped workspace contract and
agent runtime behavior. The current code still creates managed filesystem paths
under `~/.rudder/.../projects/...` during workspace fallback, and bundled agent
guidance still tells agents to store plans in a generic project-root `plans/`
directory. The intended end state is: no new project-managed workspace folders,
project-linked runs reuse the canonical org workspace root, and shared plans or
other durable work output are directed into org workspaces.

## Problem

The repo already standardized the shared workspace root at the organization
level, but two old assumptions remain live:

1. runtime fallback still treats "project" as a filesystem owner and creates a
   managed checkout under the legacy `projects/` tree
2. the planning guidance in bundled skills still assumes a repo/project-root
   `plans/` folder rather than the org workspace `plans/` root

That mismatch causes agents to write shared planning artifacts into the wrong
place and keeps obsolete project-managed directories alive.

## Scope

- In scope:
  - stop runtime fallback from creating or depending on managed
    `~/.rudder/.../projects/...` directories
  - make project-linked fallback resolve to the canonical org workspace root
  - remove obsolete `projects/` home-path helpers that only supported the old
    managed directory contract
  - update bundled agent guidance so shared plans and similar work output land
    in org workspaces
  - add or update targeted tests for the new behavior
- Out of scope:
  - removing the product concept of projects from Rudder
  - deleting legacy database `project_workspaces` compatibility records in this
    pass
  - redesigning the broader issue document or work product model

## Implementation Plan

1. Replace the runtime fallback path in `agent-run-context` so project-linked
   runs use the org workspace root instead of a project-managed directory.
2. Remove dead `projects/` path helpers and storage-pruning branches that only
   served the old managed project path layout.
3. Update bundled planning/instruction guidance to explicitly use
   `$RUDDER_ORG_PLANS_DIR` and the org workspace for shared outputs.
4. Refresh targeted tests for runtime resolution, home-path cleanup, and
   bundled guidance expectations.

## Design Notes

- Keep `ResolvedWorkspaceForRun.source = "project_primary"` for project-linked
  shared runs in this pass so existing shared-workspace mode behavior remains
  stable.
- Preserve legacy `project_workspaces` row support when a concrete workspace
  cwd already exists; only the fallback path generation changes.
- Shared planning belongs under the org workspace `plans/` root, while
  issue-specific plan content remains in issue documents when the workflow uses
  the plan document surface.
- Prompt guidance should encourage durable shared outputs to use the org
  workspace without forcing every artifact type into one rigid folder.

## Success Criteria

- New runs do not create filesystem paths under `~/.rudder/.../projects/...`.
- A project-linked run without a local project workspace cwd falls back to the
  org workspace root instead of the agent home or a managed project folder.
- Bundled planning guidance points shared plans to `$RUDDER_ORG_PLANS_DIR`.
- Agents receive an explicit hint to place shared workspace-backed output under
  the org workspace when appropriate.

## Validation

- `pnpm vitest run server/src/__tests__/home-paths.test.ts server/src/__tests__/orgs-service.test.ts`
- `pnpm vitest run server/src/__tests__/projects-service.test.ts server/src/__tests__/chat-assistant.test.ts`
- targeted runtime resolution test coverage for `agent-run-context`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

Validated on 2026-04-20:

- `pnpm vitest run server/src/__tests__/agent-run-context.test.ts server/src/__tests__/home-paths.test.ts server/src/__tests__/orgs-service.test.ts server/src/__tests__/projects-service.test.ts`
- `pnpm vitest run server/src/__tests__/chat-assistant.test.ts`
- `pnpm -r typecheck`
- `pnpm build`
- `pnpm test:run` failed in `server/src/__tests__/organization-skills-reference.test.ts` because the existing community preset `skill-creator` seed expectation did not materialize in this environment; this failure is outside the workspace-path changes in RUD-148

## Open Issues

- Legacy exported/imported portability content still references project-scoped
  paths in separate company-package surfaces and is not changed in this pass.
