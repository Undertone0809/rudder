---
title: Library Project Workspace Contract
date: 2026-06-02
kind: implementation
status: completed
area: workspace
entities:
  - org_workspace
  - project_library
  - agent_runtime_context
issue:
related_plans:
  - 2026-04-20-remove-legacy-project-managed-workspace-paths.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - packages/agent-runtime-utils/src/server-utils.process.ts
  - packages/agent-runtimes/*/src/server/execute.ts
  - server/src/home-paths.ts
  - server/src/services/agent-run-context.ts
  - server/src/routes/orgs.ts
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/resources/bundled-skills/para-memory-files/SKILL.md
commit_refs:
  - fix: align agent library project contract
updated_at: 2026-06-02
---

# Library Project Workspace Contract

## Summary

Rudder is moving the agent-facing durable file contract from legacy
organization-level folders to project-owned Library files. New organizations
already create only the active Library roots. This plan closes the remaining
runtime and instruction gap: agents should no longer be told about separate
organization-level output folders for planning, document, or work-product
storage. When an agent needs to produce durable work files for a project, the
only stable destination it should see is `library:projects/<project-name>/`.

## Problem

The product direction is now Library-first: work files belong in the Library,
and project work should collect inside the corresponding project Library
folder. The code still leaks the older model in three places:

1. runtime prompts list legacy organization-level folders as managed output
   destinations
2. local runtime adapters inject environment variables for those legacy
   destinations
3. agent-facing Library file access still points agents at a generic shared
   folder instead of the project Library folder

This creates a split-brain contract. The UI creates and shows project Library
folders, but agents may still choose older destinations because the prompt and
environment make those destinations look canonical.

## Scope

- In scope:
  - remove legacy output-folder variables from runtime scene context
  - stop local runtime adapters from injecting legacy output-folder env vars
  - update code-owned agent instructions and bundled Rudder skills to name only
    `library:projects/<project-name>/` for durable project files
  - change agent Library file API guidance and access checks from generic
    shared paths to project Library paths
  - align project resource pickers so new Library resources are created only
    from project Library paths
  - remove home-path return fields and helpers that only expose legacy output
    roots
  - update targeted tests for prompts, runtime env, path layout, validators,
    and agent-facing Library API errors
- Out of scope:
  - deleting existing user files from old local instances
  - migrating historical issue documents or old project resources
  - redesigning the full Library UI tree or project resource UI
  - removing repo `doc/plans/`, which remains contributor planning memory for
    this repository

## Implementation Plan

1. Update runtime prompt assembly so the base operating contract names
   `library:projects/<project-name>/` as the durable project file destination
   and does not mention legacy folder roots.
2. Remove legacy output-folder fields from `agent-run-context` and remove the
   matching env injection from Codex, Claude, Gemini, OpenCode, Pi, and Cursor
   local runtime adapters.
3. Update agent-facing Library file access to allow project Library paths and
   reject generic shared output paths with a project-oriented error.
4. Update project resource pickers and validation so pasted Library resource
   locators must point into the relevant project Library folder.
5. Update bundled Rudder and memory skill guidance so agents use project
   Library files for durable work products.
6. Update tests that previously asserted legacy env vars, prompt copy, or
   generic shared Library paths.

## Design Notes

- The org workspace root still exists as a filesystem boundary for Rudder, but
  it should not be presented to agents as a set of output buckets. Agents should
  think in Library paths.
- `library:projects/<project-name>/` is a product-level locator, not a literal
  filesystem path. The runtime can still map it to the organization workspace
  root internally.
- Existing old folders on disk are left untouched. The change prevents new
  prompt/env guidance from creating more work there.
- Project resource UI should not offer or accept generic shared Library paths
  for new `library` resources. Historical paths may still render as existing
  Library links elsewhere, but new resource creation should point at the project
  Library folder.
- Contributor plans in this repository remain under `doc/plans/`; that is a
  repo development convention and is separate from Rudder organization Library
  output.

## Success Criteria

- Agent operating instructions do not expose legacy output folders or a generic
  shared document folder as durable output destinations.
- Runtime context passed to local adapters no longer includes legacy
  output-folder fields.
- Local runtime adapters no longer inject legacy output-folder env vars.
- Agent Library file API checks guide agents toward project Library paths.
- New organization workspace layout returns only active roots.
- Targeted tests prove the new prompt, env, validator, and API behavior.

## Validation

- `pnpm test:run packages/agent-runtime-utils/src/server-utils.test.ts`
- `pnpm test:run server/src/__tests__/agent-run-context.test.ts server/src/__tests__/home-paths.test.ts server/src/__tests__/company-branding-route.test.ts`
- targeted local runtime execute tests for Codex, Claude, Gemini, OpenCode, Pi,
  and Cursor env propagation
- `pnpm --filter @rudderhq/agent-runtime-utils typecheck`
- `pnpm --filter @rudderhq/server typecheck`
- `pnpm -r typecheck`
- `pnpm build`

## Open Issues

- Existing user data may still contain files in old folders. This plan does not
  migrate or delete them.
- Some historical docs and tests still describe old issue document workflows.
  They should be cleaned only when that workflow is intentionally redesigned,
  not as an incidental part of this prompt cleanup.
