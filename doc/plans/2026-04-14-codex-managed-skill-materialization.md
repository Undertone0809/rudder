---
title: Codex managed skill materialization
date: 2026-04-14
kind: plan
status: completed
area: agent_runtimes
entities:
  - codex_local
  - runtime_skills
  - managed_codex_home
issue:
related_plans:
  - 2026-04-14-codex-managed-skill-surface-isolation.md
supersedes: []
related_code:
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/codex-local/src/server/skills.ts
  - server/src/__tests__/codex-local-skill-sync.test.ts
commit_refs:
  - fix: materialize codex managed skills into skills home
updated_at: 2026-04-17
---

## Goal

Make `codex_local` load only the skills selected on the Rudder Skills page by materializing those selected skills into the managed `CODEX_HOME/skills` surface that Codex 0.118.0 actually discovers at runtime.

## Problem

- Rudder currently resolves the correct enabled skill set for the agent.
- `codex_local` writes those selected skills into `CODEX_HOME/config.toml` via `[[skills.config]] path = ".../SKILL.md"`.
- Real run `1cfe9c0b-ed97-4329-94ad-f71df9eff25e` showed `para-memory-files` and other selected Rudder skills missing from the Codex session-visible skill list, despite Rudder logging `Realized 4 Rudder-managed Codex skill entries`.

## Verified Evidence

### Real production-path run

- Managed config for the CEO agent contains:
  - `para-memory-files`
  - `rudder`
  - `rudder-create-agent`
  - `rudder-create-plugin`
- Session-visible `skills_instructions` did not include those skills.

### Black-box Codex 0.118.0 experiments

1. `[[skills.config]] path = "/tmp/.../alpha-skill/SKILL.md"`:
   - Codex did **not** expose `alpha-skill` in the session skill list.
2. `CODEX_HOME/skills/alpha-skill/SKILL.md`:
   - Codex **did** expose `alpha-skill` in the session skill list.

Conclusion: for this Codex version, Rudder is writing selected skills to a surface that Codex does not use for session skill discovery.

## Design

1. Keep managed-home isolation from the previous fix.
2. Stop relying on `[[skills.config]]` for Rudder-managed skill realization.
3. Materialize selected Rudder skills into managed `CODEX_HOME/skills/<slug>/...`.
4. Preserve Codex `.system` skills if Codex seeds them, but remove stale non-system managed skills before each run.
5. Keep pruning inherited plugin/MCP tables from managed `config.toml`.
6. Update docs so the adapter contract matches actual runtime behavior.

## Tests

1. Update `codex-local-execute` tests to assert selected skill directories are materialized in managed `CODEX_HOME/skills`.
2. Add a regression test that stale non-system managed skills are pruned while selected Rudder skills are present.
3. Update `codex-local-skill-sync` tests to assert sync creates managed skill directories instead of only config entries.

## Validation

1. Run targeted tests:
   - `pnpm vitest run server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/codex-local-skill-sync.test.ts`
2. Run repo checks:
   - `pnpm -r typecheck`
   - `pnpm test:run`
   - `pnpm build`

## Validation Results

- Passed: `pnpm vitest run server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/codex-local-skill-sync.test.ts`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- `pnpm test:run` still fails outside this change surface:
  - `server/src/__tests__/agent-instructions-service.test.ts`
  - `server/src/__tests__/automations-service.test.ts`

## Notes

- Root cause was not Rudder skill selection. Rudder selected the correct skills.
- The breakage was that `codex_local` realized those skills through `[[skills.config]]`, while Codex `0.118.0` exposes runtime-visible skills from `CODEX_HOME/skills`.
- This fix changes `codex_local` to materialize only the Rudder-selected skills into the managed `CODEX_HOME/skills` surface and to prune stale non-system managed entries there.

## Commit

- `fix: materialize codex managed skills into skills home`
