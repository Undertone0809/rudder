---
title: Agent project CLI capability
date: 2026-06-02
kind: implementation
status: completed
area: api
entities:
  - agent_cli
  - projects
  - agent_permissions
issue:
related_plans:
  - 2026-05-09-agent-issue-search-capability.md
  - 2026-04-17-org-resource-catalog-and-agent-run-context.md
supersedes: []
related_code:
  - cli/src/agent-v1-registry.ts
  - cli/src/commands/client/project.ts
  - cli/src/program.ts
  - server/src/routes/projects.ts
  - server/src/services/projects.ts
  - server/src/__tests__/projects-service.test.ts
  - server/resources/bundled-skills/rudder/references/cli-reference.md
  - server/resources/bundled-skills/rudder/references/api-reference.md
commit_refs: []
updated_at: 2026-06-02
---

# Agent Project CLI Capability

## Context

Agents can already create and update issues through the stable Rudder CLI, but
project operations are only partially visible in agent-facing references. The
server exposes project API routes, and the bundled `rudder` skill mentions
project context, but the `agent-v1` capability manifest does not include
`project.create` or `project.update`. That leaves agents unable to confidently
answer whether they can create a project without falling back to ad hoc API
calls.

## Scope

Add the smallest durable project surface that lets an authenticated agent list,
read, create, and update projects through the stable CLI contract.

In scope:

- Add `rudder project list`, `rudder project get`, `rudder project create`, and
  `rudder project update`.
- Register these commands in the agent-v1 capability manifest.
- Keep JSON output and run-id attachment behavior consistent with issue
  commands.
- Update bundled Rudder CLI/API references so runtime prompts and docs agree.
- Add focused CLI tests for request paths, payload parsing, auth headers, and
  registry-doc synchronization.

Out of scope for this slice:

- Project resource attachment CLI commands.
- Project workspace creation/update commands.
- A new visible UI permission editor.
- Any database migration.

## Implementation Notes

- Reuse `createProjectSchema` and `updateProjectSchema` from shared validators.
- Require `--org-id` for list/create, defaulting from `RUDDER_ORG_ID`.
- Let `get` and `update` accept project id or shortname, matching server route
  shortname resolution.
- For agent-authenticated mutating calls, rely on the existing CLI client to
  attach `x-rudder-agent-id` and `x-rudder-run-id` when available.
- Keep server authorization unchanged in this slice: project routes remain
  organization-scoped via `assertCompanyAccess`, matching current V1 coarse
  access policy.

## Verification

- `pnpm --filter @rudderhq/cli exec vitest run src/__tests__/project-command.test.ts src/__tests__/agent-v1-registry.test.ts --reporter=verbose`
- `pnpm exec vitest run server/src/__tests__/projects-service.test.ts server/src/__tests__/project-routes.test.ts --reporter=verbose`
- `pnpm --filter @rudderhq/cli exec vitest run src/__tests__/project-command.test.ts src/__tests__/agent-v1-registry.test.ts src/__tests__/agent-cli-e2e.test.ts --reporter=verbose`
- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/cli typecheck`

Full-repo checks run during handoff:

- `pnpm -r typecheck` is currently blocked by an unrelated UI type error in
  `ui/src/components/MarkdownEditor.tsx`.
- `pnpm build` is currently blocked by the same unrelated UI type error.
- `pnpm test:run` is currently blocked by unrelated failures in
  `ui/src/pages/Chat.attachment-preview.test.tsx` and
  `cli/src/__tests__/start.test.ts`.
