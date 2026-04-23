# Agent Skill Loading Boundary

## Summary

- Rudder owns the runtime skill set for every agent run.
- Runtime-loaded skills are exactly:
  - the 4 bundled Rudder skills, always loaded and not user-configurable
  - plus any optional skills explicitly enabled on that agent's Skills page
- Adapter homes and user homes may be discovery sources for optional skills, but they are not implicit runtime sources.
- This pass changes skill discovery, persistence, validation, runtime realization, UI grouping, and docs for skill loading only.
- This pass does not change non-skill instruction discovery such as repo `AGENTS.md`.

## Implementation Changes

- Build `GET /agents/:id/skills` from a Rudder-owned catalog instead of adapter `listSkills()` output.
- Catalog sources:
  - bundled Rudder skills
  - organization skill library
  - global user skills from `~/.agents/skills`
  - adapter-home skills from the current runtime home such as `~/.codex/skills`, `~/.claude/skills`, `~/.cursor/skills`, `~/.gemini/skills`, `~/.pi/agent/skills`
- Keep bundled Rudder skills pinned first, locked on, and excluded from persisted optional selection state.
- Keep optional organization skills toggleable.
- Split external skills into two UI groups:
  - Global skills
  - Adapter skills
- Add source-aware persisted optional refs in `agent_enabled_skills`:
  - `org:<organizationSkillKey>`
  - `global:<slug>`
  - `adapter:<agentRuntimeType>:<slug>`
- Keep backward-compatible request parsing for legacy organization skill keys where unambiguous, but normalize persisted state and API responses to source-aware refs.
- Enforce same-name collision rules centrally:
  - same runtime skill name across sources is one conflict group
  - UI auto-switches to one active row in draft state
  - server rejects conflicting enabled refs with `422`
- Make runtime realization match saved state exactly:
  - bundled Rudder skills
  - plus optional refs enabled in `agent_enabled_skills`
- Keep `claude_local` and `opencode_local` on Rudder-managed isolated homes, but only mount bundled plus enabled optional refs.
- Add a true Codex realization layer through managed `CODEX_HOME/config.toml` skill path entries and prune Rudder-managed entries on each run.
- Move `cursor`, `gemini_local`, and `pi_local` off real user skill homes for active runtime loading and onto Rudder-managed isolated skill surfaces.
- Keep external discovery limited to user-home local skill roots. Do not scan project or workspace directories for this feature.

## Interfaces

- Extend public `AgentSkillEntry` with:
  - `selectionKey`
  - `sourceClass`
  - `configurable`
  - `alwaysEnabled`
- Keep `key` as the logical display and collision-group key.
- Keep `desiredSkills` in the API for compatibility, but redefine it to contain source-aware selection refs.
- `GET /agents/:id/skills` remains a flat entry list with enough metadata for UI grouping and collision handling.

## Test Plan

- Run `pnpm -r typecheck`.
- Run targeted unit and adapter tests for skill catalog, validation, and runtime realization.
- Run relevant UI and E2E coverage for the Agent Skills page.
- Run `pnpm test:run`.
- Run `pnpm build`.
- Update and run E2E coverage to verify:
  - bundled Rudder skills are locked on
  - external skills are split into Global and Adapter groups
  - same-name collisions auto-switch in the draft and reject conflicting payloads on the server
  - enabling and disabling optional external skills changes the next-run runtime surface

## Assumptions

- The bundled Rudder 4 skills remain mandatory for every agent run.
- Optional skills are exactly the enabled rows from the Agent Skills page.
- External skills do not need to be imported into the organization library before use.
- This work is skill-only and does not alter non-skill instruction loading behavior.
