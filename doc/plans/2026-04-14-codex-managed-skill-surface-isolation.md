---
title: Codex managed skill surface isolation
date: 2026-04-14
kind: plan
status: completed
area: agent_runtimes
entities:
  - codex_local
  - managed_codex_home
  - runtime_skills
issue: cb1451f2-00dc-460c-af0c-cdec97a7e221
related_plans:
  - 2026-04-14-codex-managed-skill-materialization.md
supersedes: []
related_code:
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - server/src/__tests__/codex-local-execute.test.ts
commit_refs: []
updated_at: 2026-04-17
---

## Context

Issue `cb1451f2-00dc-460c-af0c-cdec97a7e221` exposed a runtime-skill isolation bug for `codex_local`.

User expectation:

- Runtime skill loading must be determined only by the agent's enabled selections on the Skills page.
- The adapter must not leak global Codex skills, system skills, or seed-home skill config into an agent run.

Observed on `2026-04-14` in run `1cfe9c0b-ed97-4329-94ad-f71df9eff25e`:

- Rudder logged `Realized 4 Rudder-managed Codex skill entries`.
- The Codex session still exposed unrelated skills such as `code-reviewer`, `deep-research`, `software-product-advisor`, and `.system/*`.
- The managed Codex home inherited `[[skills.config]]` entries from the shared `~/.codex/config.toml`.
- The managed Codex home also retained a `skills/.system` directory from prior seed state.

## Diagnosis

Primary layer: engineering architecture / correctness.

The `codex_local` managed-home preparation logic treats the shared `~/.codex` home as a safe seed and only overlays Rudder-managed skill entries. That preserves unrelated skill discovery state inside the agent runtime surface.

Concretely:

1. `syncManagedCodexConfigToml` preserves inherited `[[skills.config]]` entries with `path`, even when they do not belong to Rudder-managed selections.
2. `prepareManagedCodexHome` prunes plugin state, but not inherited skill directories such as `skills/.system`.
3. Existing tests lock in the wrong behavior by asserting that inherited disabled skill entries remain in the managed config.

## Target Behavior

For `codex_local` agent runs:

- The managed `CODEX_HOME` must expose only the skill entries explicitly realized by Rudder for that agent.
- Shared-home skill config must not survive into the managed home unless Rudder selected it for the agent.
- Residual skill directories in the managed home that are not part of the selected Rudder-managed set must not remain discoverable.

## Implementation Plan

1. Tighten Codex config sanitization in `packages/agent-runtimes/codex-local/src/server/codex-home.ts`.
2. Prune inherited skill-surface directories from managed `CODEX_HOME`, especially `skills/.system` and other stale skill roots.
3. Update `server/src/__tests__/codex-local-execute.test.ts` to assert that inherited shared-home skill entries are removed rather than preserved.
4. Add regression coverage for stale managed-home skill directories so legacy leakage does not return.
5. Run targeted Codex adapter tests, then broader repo verification as feasible.

## Verification Plan

- `pnpm vitest run server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/codex-local-skill-sync.test.ts`
- If time permits and the environment is stable, run the nearest broader test slice covering agent skill sync/runtime execution.

## Outcome

Implemented:

1. `codex_local` now strips inherited `[[skills.config]]` entries from managed `CODEX_HOME/config.toml` instead of preserving them as disabled.
2. Managed Codex home preparation now prunes stale `skills/` directories so legacy `.system` skill payloads do not remain discoverable.
3. Codex child execution now isolates `HOME` and `USERPROFILE` to the agent home (or an isolated managed-home fallback) so global `~/.agents/skills` discovery does not leak into agent runs.
4. Codex adapter documentation now states the HOME isolation behavior explicitly.
5. Regression tests now assert the stricter isolation contract.

Verification completed:

- `pnpm vitest run server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/codex-local-skill-sync.test.ts`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
