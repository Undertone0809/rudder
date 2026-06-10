---
title: Run workspace language migration
date: 2026-06-10
kind: implementation
status: completed
area: workspace
entities:
  - run_workspace
  - workspace_runtime
  - activity_log
issue:
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-14-agent-workspace-canonicalization.md
  - 2026-03-10-workspace-strategy-and-git-worktrees.md
supersedes:
  - 2026-03-10-workspace-strategy-and-git-worktrees.md
  - 2026-03-13-workspace-product-model-and-work-product.md
related_code:
  - packages/db/src/schema/execution_workspaces.ts
  - packages/shared/src/types/workspace-runtime.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/execution-workspaces.ts
  - server/src/routes/execution-workspaces.ts
  - ui/src/pages/IssueDetail.parts.tsx
  - docs/concepts/goals-projects-issues.mdx
commit_refs:
  - "refactor: rename execution workspace surface"
updated_at: 2026-06-10
---

# Run Workspace Language Migration

## Decision

Rudder no longer treats "execution workspace" as a product concept. Operators
choose projects, issues, agents, Library files, and project resources. The
runtime still needs an internal record of the concrete workspace a run used:
cwd, branch/worktree metadata, provider reference, lifecycle status, runtime
services, operation logs, cleanup state, and work products.

That internal object should be named **run workspace** in code, APIs, activity,
and docs. Existing database table and column names may remain temporarily for
compatibility, but new source-level contracts should stop introducing
`executionWorkspace*` names.

## Scope

In scope:

- Rename source-level runtime/domain types, services, API clients, UI routes,
  and user-visible labels from execution workspace to run workspace.
- Keep backward-compatible database table and column names where a physical
  migration would add unnecessary risk in this slice.
- Keep compatibility aliases only where older code, plugins, or persisted API
  consumers may still send or read the old shape.
- Remove product-facing docs that describe execution workspace policy/settings
  as project or issue concepts.
- Stop activity timelines from surfacing internal workspace reset events as
  operator-facing work history.

Out of scope:

- Dropping historical database columns or rewriting old migrations.
- Removing runtime workspace tracking, runtime-service scoping, work-product
  links, operation logs, or cleanup behavior.
- Reopening the HOME-path decision. Default local runs must preserve the
  current invariant that user HOME is not rewritten.

## Implementation Plan

1. Add run-workspace vocabulary in shared types, validators, route names, API
   clients, and UI labels while preserving deprecated compatibility aliases.
2. Rename the server service and route implementation to run-workspace
   terminology, with legacy `/execution-workspaces` routes kept as aliases.
3. Update heartbeat/runtime code to treat the persisted record as a run
   workspace and only write deprecated issue fields for compatibility when
   needed.
4. Update activity formatters so internal run-workspace fields do not appear as
   standalone timeline text; project changes should remain visible.
5. Update public docs to describe project resources and internal run workspace
   diagnostics without presenting execution workspace as a user model.
6. Add focused tests for hidden UI controls, activity language, legacy route
   compatibility, and runtime persistence.

## Acceptance Criteria

- No user-visible UI copy says "execution workspace" in normal board flows.
- Public docs no longer list execution workspace policy/settings as core
  Project or Issue capabilities.
- The runtime can still persist the concrete workspace used by a run, attach
  workspace operations and runtime services, and clean up owned workspaces.
- Legacy API/database compatibility remains intact for existing installations.
- Focused typecheck/tests pass for touched shared/server/ui surfaces.
- Reviewer gate checks that this migration removes stale product language
  without deleting required runtime audit and cleanup behavior.

## Verification

- `pnpm test:run server/src/__tests__/issue-lifecycle-routes.test.ts packages/shared/src/issue-activity.test.ts server/src/__tests__/run-workspace-routes.test.ts ui/src/pages/IssueDetail.test.tsx ui/src/components/NewIssueDialog.test.tsx ui/src/components/IssueProperties.test.tsx`
  passed with 6 files and 107 tests.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `git diff --check` passed.
- Full `pnpm test:run` was attempted and failed on embedded Postgres init
  data-directory errors across DB-backed suites; the focused affected suites
  above passed after the migration fixes.

## Reviewer Gate

- Functional trust reviewer: conditional accept; functional blockers resolved.
- Adversarial reviewer: conditional accept; no remaining blockers after
  canonical alias normalization and scoped-staging commitment.
- Heuristic/product-systems reviewer: accept; contributor docs and superseded
  historical plan conflict resolved.
