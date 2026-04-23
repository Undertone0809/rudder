---
title: Community preset skills
date: 2026-04-19
kind: implementation
status: completed
area: skills
entities:
  - community_preset_skills
  - organization_skills
  - agent_skills
issue:
related_plans:
  - 2026-04-09-org-skill-agent-enabled-skills-refactor.md
  - 2026-04-12-agent-skill-loading-boundary.md
  - 2026-04-17-agent-skill-ownership-and-workspace-editing.md
supersedes: []
related_code:
  - server/src/services/organization-skills.ts
  - ui/src/pages/OrganizationSkills.tsx
  - ui/src/pages/AgentDetail.tsx
  - tests/e2e/organization-agent-skills.spec.ts
commit_refs: []
updated_at: 2026-04-19
---

# Community Preset Skills

## Goal

Seed a small set of optional community-facing skills into every organization's
skill library without conflating them with the bundled Rudder runtime skills.

Initial preset set:

- `skill-creator`
- `software-product-advisor`
- `deep-research`

## Problem

Rudder currently has two clear skill classes:

- bundled Rudder skills under `server/resources/bundled-skills/`
- optional organization / agent / external skills

There is no first-class source for "recommended preset skills we ship with the
product but do not own as core runtime contract". Copying these skills into
repo `.agents/skills/` would leave them in a maintainer-only lane, while moving
them into bundled Rudder skills would incorrectly imply they are part of the
mandatory control-plane baseline.

## Decisions

1. Add a new source layer for preset community skills:
   - repo-owned preset packages under `server/resources/community-skills/<slug>/`
   - GitHub-backed presets when vendoring the package is unnecessary
2. Seed these skills into the organization skill library alongside bundled
   Rudder skills when the org skill inventory is refreshed.
3. Mark these skills with metadata `sourceKind: "community_preset"`.
4. Keep community presets optional:
   - visible in the organization skill library by default
   - visible in the agent skill picker as organization skills
   - never always-enabled
   - removable and replaceable like other organization-managed skills
5. Differentiate them in UI copy and badges from:
   - bundled Rudder skills
   - imported local/GitHub/URL/catalog skills

## Implementation Outline

### Service layer

- add a resolver for `server/resources/community-skills`
- seed the preset directories during organization skill inventory refresh
- preserve stable organization skill keys for seeded presets
- ensure preset seeding is idempotent and does not overwrite user-edited local
  skills that no longer resolve to the preset source kind

### Source presentation

- extend organization skill source badge handling with a community preset badge
- show a source label such as `Community preset`
- keep presets read-only from their repo source, the same as other shipped
  assets

### UI

- organization skills page should distinguish community presets from bundled
  Rudder skills
- agent skills page should not imply community presets are always enabled or
  locked on
- helper copy should clarify that only bundled Rudder skills are always loaded

### Coverage

- service/unit coverage for org seeding and source metadata
- UI/unit coverage for source badge handling
- E2E coverage that a fresh org exposes the three preset skills in the skills
  library and agent skills page without auto-enabling them

## Open Assumptions

- The initial preset set is curated manually; this pass does not introduce a
  remote community registry or update mechanism.
- Community preset skills remain organization-managed assets after seeding; they
  are not a new external discovery source.
- `skill-creator` should stay GitHub-backed from
  `https://github.com/Undertone0809/skill-creator/tree/main/.agents/skills`
  instead of a vendored repo copy.

## Follow-up Notes

- Deleting a seeded community preset from an organization currently does not
  leave a tombstone. A later skill inventory refresh can seed it again.
