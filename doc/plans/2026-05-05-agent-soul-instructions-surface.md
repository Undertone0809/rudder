---
title: Agent Soul Instructions Surface Cleanup
date: 2026-05-05
kind: implementation
status: completed
area: agent_runtimes
entities:
  - agent_instructions
  - agent_operating_contract
  - rudder_create_agent_skill
issue:
related_plans:
  - 2026-05-04-agent-operating-contract-runtime.md
  - 2026-04-19-rudder-create-agent-cli-migration.md
supersedes: []
related_code:
  - server/src/services/agent-instructions.ts
  - ui/src/pages/AgentDetail.tsx
  - ui/src/components/agent-config-primitives.tsx
  - server/resources/bundled-skills/rudder-create-agent/SKILL.md
  - doc/spec/agents-runtime.md
commit_refs:
  - feat: use soul as managed agent instruction entry
updated_at: 2026-05-05
---

# Agent Soul Instructions Surface Cleanup

## Summary

Finish the follow-up cleanup after moving Rudder's shared agent operating
contract into runtime code. New managed local agents should treat `SOUL.md` as
the default identity/persona entry file across server defaults, instruction
editing UI, docs, and `rudder-create-agent` guidance.

## Problem

The runtime and hire path already use code-owned operating contract injection
and materialize new hire role content as `SOUL.md`. Several surrounding surfaces
still imply that `AGENTS.md` is the managed runtime instruction entry:

- the instruction bundle service default entry
- the agent Prompts tab defaults and help text
- the user-facing runtime guide
- create-agent examples that show a one-line `promptTemplate` instead of a
  structured SOUL-style identity document

This leaves a split mental model: Rudder runtime identity is now `SOUL.md`, but
contributors and operators still see `AGENTS.md` in key configuration surfaces.

## Scope

- In scope:
  - Change managed instruction defaults from `AGENTS.md` to `SOUL.md`.
  - Update Prompts tab defaults and helper copy.
  - Update focused route/service/E2E expectations affected by the default.
  - Upgrade `rudder-create-agent` guidance to draft structured SOUL content.
  - Clarify that portability `AGENTS.md` remains a package convention, not the
    runtime identity entry.
- Out of scope:
  - Migrating existing agent files on disk.
  - Changing HTTP/external adapter contract injection.
  - Redesigning the full agent configuration form.
  - Replacing `promptTemplate` with a new API field in this pass.

## Implementation Plan

1. Update the instruction bundle service default entry and fallback messages.
2. Retarget the Prompts tab default entry, empty-entry fallback, and tooltip to
   `SOUL.md`.
3. Keep `promptTemplate` runtime help accurate while adding hire-path
   clarification where the create-agent skill owns that behavior.
4. Update `rudder-create-agent` examples and quality bar to produce a structured
   SOUL-style prompt.
5. Update docs and tests that encode the old managed `AGENTS.md` default.

## Success Criteria

- A new managed bundle without an explicit entry defaults to `SOUL.md`.
- The UI no longer tells operators that managed instruction bundles default to
  `AGENTS.md`.
- `rudder-create-agent` produces role/persona content that is rich enough to
  become a durable `SOUL.md`.
- Runtime docs distinguish `SOUL.md` managed identity from portability
  `AGENTS.md` package conventions.

## Validation

- `pnpm exec vitest run server/src/__tests__/agent-instructions-service.test.ts server/src/__tests__/agent-instructions-routes.test.ts server/src/__tests__/agent-run-context.test.ts server/src/__tests__/agent-skills-routes.test.ts` passed.
- `pnpm --filter @rudderhq/server typecheck` passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm -r typecheck` passed.
- `pnpm exec vitest run packages/agent-runtime-utils/src/server-utils.test.ts` passed.
- `pnpm build` passed.
- `git diff --check` passed.

Known validation gap:

- `pnpm test:run` and `pnpm test:e2e tests/e2e/agents-toolbar.spec.ts` were attempted, but both were blocked before the relevant assertions by embedded PostgreSQL init failing during the bootstrap script with `Postgres init script exited with code 1`. This matches the local DB startup failure mode seen during the broader test run and is not specific to the SOUL instruction changes.

## Notes

The external OpenClaw SOUL guidance treats `SOUL.md` as the durable identity,
mission, behavioral, and boundary layer for an agent. This cleanup follows that
division: Rudder's shared operating contract stays in runtime code for managed
local runtimes, while `SOUL.md` carries the role/persona layer that should be
safe to customize per agent.
