# Agent Skills UI Simplification And Description Fidelity

## Summary
The Agent Skills page should read like a compact skill-availability dashboard, not a form-heavy management screen. This change reduces control noise, makes descriptions first-class, and reinforces the intended model:

- bundled Rudder skills are always on
- every other skill starts off
- adapters do not decide what looks enabled

## Implementation Changes
- Rebuild the Agent Skills tab as a compact two-column card grid with:
  - a simple title row
  - autosave state
  - search
  - bulk actions in the more menu
- Replace enable/disable buttons with right-aligned switch controls that reuse the existing Rudder toggle visual language.
- Keep bundled Rudder skills pinned first, locked on, and clearly badged as required.
- Keep optional organization skills in the same grid, greyed out when disabled.
- Keep external or user-installed skills in a separate collapsible section below the main grid, collapsed by default but auto-opened when an external skill is enabled or matched by search.
- Remove the meaningless `Available in this organization` provenance copy from runtime snapshots.
- Surface `description` as the primary summary text for all skills. Treat `detail` as secondary operational metadata only.
- Extend runtime skill metadata so managed and observed skills can carry parsed `name` and `description` from `SKILL.md`.
- Add a backfill pass for organization skills whose persisted `description` is still missing but can be recovered from stored markdown or readable local source files.

## Public / Interface Changes
- Extend `AgentSkillEntry` with `description?: string | null` in shared/runtime types and validators.
- Extend runtime skill entry payloads (`rudderRuntimeSkills` / `paperclipRuntimeSkills`) to include parsed `name` and `description`.
- Preserve backward compatibility: old snapshots without `description` still validate.

## Test Plan
- Backend/unit:
  - runtime skill entry parsing returns descriptions for bundled skills
  - codex/claude/opencode observed external skills surface descriptions from `SKILL.md`
  - managed skill origin no longer emits `Available in this organization`
  - organization skill refresh backfills missing descriptions
- Route/integration:
  - fresh agent skill snapshots include only bundled Rudder skills in the desired set by default
  - optional organization and external skills remain off until explicitly enabled
- UI / E2E:
  - required bundled skills render as locked-on switches
  - optional skills start off and can be toggled on and off
  - external skills live under the collapsible external section
  - card copy prefers descriptions and no longer shows `Available in this organization`

## Assumptions
- Bundled Rudder skills remain the only always-on skills.
- Every other skill remains default-off until explicitly enabled for the agent.
- Search plus bulk actions is sufficient; the older scope-filter strip is removed.
- If a legacy skill still has no recoverable description, the UI falls back to `No description provided.` without inventing provenance filler.
