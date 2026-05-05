---
title: Agent Operating Contract Runtime Injection
date: 2026-05-04
kind: implementation
status: completed
area: agent_runtimes
entities:
  - agent_instructions
  - agent_operating_contract
  - rudder_create_agent_skill
issue:
related_plans:
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
  - 2026-04-19-rudder-create-agent-cli-migration.md
  - 2026-04-30-agent-memory-instructions.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.ts
  - server/src/services/default-agent-instructions.ts
  - server/src/onboarding-assets/default/SOUL.md
  - server/src/onboarding-assets/ceo/SOUL.md
  - server/resources/bundled-skills/rudder-create-agent/SKILL.md
commit_refs:
  - feat: inject agent operating contract at runtime
updated_at: 2026-05-04
---

# Agent Operating Contract Runtime Injection

## Summary

Move Rudder's baseline agent operating contract out of per-agent `AGENTS.md`
files and into runtime prompt assembly. New managed instruction bundles should
use `SOUL.md` as the role/persona entry file, while the code-owned contract
provides shared filesystem, memory, language, and safety rules for every
supported local runtime.

## Problem

The current default `AGENTS.md` is a mutable template for rules that are really
platform invariants. It also diverges from the CEO template, and direct agent
creation can replace `AGENTS.md` with `promptTemplate`, dropping Rudder's memory
and workspace guidance. That makes old and newly customized agents behave
differently after the platform contract changes.

## Scope

- In scope:
  - Add a code-owned Rudder agent operating contract to the runtime instruction
    prefix helper.
  - Keep loading role/persona instructions and `MEMORY.md` automatically.
  - Change default managed bundles to use `SOUL.md` as their entry file.
  - Remove `AGENTS.md` from default onboarding bundles.
  - Update `rudder-create-agent` guidance so new hires define role/persona
    content, not the platform contract.
  - Add targeted tests for contract injection and bundle materialization.
- Out of scope:
  - Injecting this contract into HTTP external agents.
  - Rewriting existing managed `AGENTS.md` files.
  - Database schema changes.
  - UI redesign for instruction editing.

## Implementation Plan

1. Add a reusable code-owned operating contract section in
   `@rudderhq/agent-runtime-utils`.
2. Update `loadAgentInstructionsPrefix` to always include the operating
   contract before optional role instructions and sibling `MEMORY.md`.
3. Update prompt metrics and command notes so runtime observability separates
   contract, role instruction, and memory sizes.
4. Retarget managed default instruction bundles from `AGENTS.md` to `SOUL.md`
   for default and CEO agents.
5. Remove duplicated platform contract text from onboarding assets.
6. Update bundled `rudder-create-agent` skill docs to treat `SOUL.md` or
   role-specific prompt content as the hire-specific surface.
7. Update unit and route tests that assert instruction materialization.

## Design Notes

The contract is only injected by local runtimes that already use
`loadAgentInstructionsPrefix`. HTTP adapters remain responsible for their own
contract delivery for now.

No compatibility rewrite is needed for old agents. Existing agents with
`instructionsFilePath` still get the new runtime contract before their existing
file content. New managed agents use `SOUL.md` as the entry file and no longer
need an `AGENTS.md` file.

`MEMORY.md` remains a sibling instruction file and is still loaded when present.
Daily notes and PARA memory remain file stores under `$AGENT_HOME`.

## Success Criteria

- A runtime run receives the Rudder operating contract even when the configured
  instruction entry is missing or empty.
- `promptTemplate` can customize role/persona content without replacing the
  platform contract.
- New managed default and CEO agents materialize `SOUL.md`, `MEMORY.md`,
  `HEARTBEAT.md`, and `TOOLS.md`, with `SOUL.md` as the entry file.
- `rudder-create-agent` no longer tells agents to author the shared operating
  contract in the hire payload.

## Validation

- `pnpm exec vitest run packages/agent-runtime-utils/src/server-utils.test.ts server/src/__tests__/agent-instructions-service.test.ts server/src/__tests__/agent-instructions-routes.test.ts server/src/__tests__/agent-skills-routes.test.ts server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/cursor-local-execute.test.ts server/src/__tests__/opencode-local-execute.test.ts server/src/__tests__/pi-local-execute.test.ts` passed.
- `pnpm --filter @rudderhq/agent-runtime-utils typecheck` passed.
- `pnpm --filter @rudderhq/server typecheck` passed.
- `pnpm -r typecheck` was attempted. It failed in `@rudderhq/ui` on pre-existing dirty `ui/src/pages/Calendar.tsx` type errors around collision-cluster display items, outside this change.
- `pnpm test:run` was attempted. It failed on embedded Postgres init errors plus unrelated dirty UI dialog/confirmation changes; the targeted instruction/runtime tests above passed.
- `pnpm build` was attempted. It failed while building the UI for the same dirty `ui/src/pages/Calendar.tsx` type errors.

## Open Issues

None.
