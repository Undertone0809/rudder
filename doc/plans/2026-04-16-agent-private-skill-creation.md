---
title: Agent-private skill creation
date: 2026-04-16
kind: plan
status: completed
area: skills
entities:
  - agent_private_skills
  - agent_skills
  - skill_creation
issue:
related_plans:
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
  - 2026-04-17-agent-skill-ownership-and-workspace-editing.md
supersedes: []
related_code:
  - server/src/routes/organization-skills.ts
  - ui/src/pages/AgentDetail.tsx
  - tests/e2e/agent-private-skill-create.spec.ts
commit_refs:
  - feat: add agent-private skill creation
updated_at: 2026-04-17
---

# Agent-Private Skill Creation

## What Is Actually Wrong
Agent-private skills already exist as a runtime concept: Rudder discovers them from `AGENT_HOME/skills` and agents can enable them once they are present. The missing piece is the authored control-plane surface. There is no first-party create flow for agent-owned skill packages, so the product contract says "agent skills exist" while the mutation surface still behaves as if only organization skills are authorable.

## Diagnosis
- Primary layer: control-plane product/API gap
- Secondary layer: UI workflow gap
- Why: runtime discovery is already implemented, but the only built-in create/edit workflow targets organization skills under `/api/orgs/:orgId/skills`

## Professional Translation
- This is not a runtime loading bug. The agent-private skill path is already mounted and discoverable.
- This is not mainly a permission-model bug. Agents can already sync their own enabled skill refs; they cannot materialize the underlying `SKILL.md` package.
- The current surface forces out-of-band filesystem writes for a first-class Rudder concept.
- The bundled Rudder skill docs are incomplete because they explain org-skill installation but not agent-private skill authoring.

## Implementation Plan
- Add an agent-scoped create endpoint that writes a new skill package into `AGENT_HOME/skills/<slug>/SKILL.md` and allows same-agent auth plus normal board access.
- Keep the request contract aligned with organization skill creation so callers can reuse the same payload shape.
- Relax agent skill snapshot read access from "configuration readers only" to normal same-agent access, since the snapshot is a skill catalog, not sensitive adapter config.
- Add a lightweight "Create agent skill" flow on the Agent Skills page so the authored surface exists in-product, not only through raw API calls.
- Update the bundled Rudder skill references so agent-facing API docs describe the new private-skill workflow.

## Test Plan
- Route/integration:
  - same-agent auth can create a private skill for itself
  - another non-privileged agent cannot create a private skill for a peer
- E2E:
  - create a private skill from the Agent Skills page
  - verify the skill appears under the Agent skills section
  - verify the skill package exists under the agent workspace `skills/` directory

## Assumptions
- Agent-private skills remain private runtime/discovery artifacts and are not added to the organization library.
- Creation should not auto-enable the new skill; enabling remains an explicit per-agent choice.
- `SKILL.md` creation is sufficient for this issue; richer multi-file editing can remain a follow-up.

## Validation
- Passed: `pnpm vitest run server/src/__tests__/agent-private-skills-routes.test.ts server/src/__tests__/agent-skills-routes.test.ts`
- Failed outside this issue surface: `pnpm -r typecheck`
  - existing UI fixture/type drift in `ui/src/lib/organization-order.test.ts`
  - existing UI fixture/type drift in `ui/src/lib/organization-portability-sidebar.test.ts`
- Failed outside this issue surface: `pnpm build`
  - existing shared/server contract drift around `OrganizationWorkspace`, `ProjectWorkspaceSourceType`, and organization shape fields
- Failed before reaching the new flow body: `RUDDER_E2E_PORT=3290 pnpm test:e2e --grep "lets users create an agent-private skill from the Agent Skills page"`
  - existing embedded test database schema mismatch: `column "workspace_config" of relation "organizations" does not exist`

## Related Commit
- `f9592af` `feat: add agent-private skill creation`
