---
title: Org workspaces fixed root and resources
date: 2026-04-16
kind: plan
status: completed
area: workspace
entities:
  - org_workspace
  - resources_md
  - workspace_browser
issue:
related_plans:
  - 2026-04-16-org-workspace-scope.md
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
supersedes: []
related_code:
  - server/src/services/organization-workspace-browser.ts
  - ui/src/pages/OrganizationWorkspaces.tsx
  - server/src/home-paths.ts
commit_refs:
  - feat: move workspaces to organization root
updated_at: 2026-04-17
---

# Org Workspaces Fixed Root And Resources

## Summary

Rudder should treat `workspaces/` as a fixed org-owned filesystem root, not as a configurable repo binding.

Target model:

- every org has exactly one workspace root at `~/.rudder/instances/<instance>/organizations/<org-id>/workspaces`
- the path is system-managed and cannot be changed by the user
- project creation no longer asks for or creates project workspaces
- `resources.md` lives under the org workspace root and is created from a template
- all agent runs inject `resources.md` into the runtime instruction context
- agent-specific files continue to live under `workspaces/agents/<workspace-key>/...`

## Implementation Plan

1. Remove org workspace path/repo configuration from shared validators, organization services, and settings UI.
2. Bootstrap the org workspace root and `resources.md` during organization creation, while preserving the existing org-scoped agent layout under `workspaces/agents`.
3. Change the org workspace browser service and `/workspaces` page to always browse the fixed org root and never show an "unconfigured" state for a valid org.
4. Remove project workspace inputs and public CRUD routes, plus project read-model fields that expose project workspace concepts.
5. Keep the current agent cwd strategy, but inject `resources.md` content and path into all runtime scene contexts.
6. Update bundled Rudder skills and reference docs so they describe org workspaces and `resources.md` instead of project workspaces as the shared coordination layer.
7. Add or update tests across service, runtime, UI, and E2E coverage for the new fixed-root behavior.

## Validation Plan

- `pnpm -r typecheck`
- `pnpm test:run`
- targeted Playwright coverage for:
  - fresh org `/workspaces` loads immediately and shows `resources.md`
  - project creation no longer shows workspace/codebase controls
  - org settings no longer show editable workspace path fields
- `pnpm build`

## Assumptions

- `resources.md` is org-level shared guidance, not per-project generated sections
- if `resources.md` is missing when an org or project flow touches the workspace bootstrap, Rudder should recreate it from the template
- legacy `project_workspaces` rows may remain in storage temporarily, but public APIs and user-facing flows should stop exposing them

## Related Commit

- `87776a9` `feat: move workspaces to organization root`
