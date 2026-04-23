---
title: Org-scoped agent workspace and skill ownership contract
date: 2026-04-14
kind: plan
status: completed
area: workspace
entities:
  - agent_workspace
  - organization_skills
  - agent_private_skills
issue:
related_plans:
  - 2026-04-16-agent-private-skill-creation.md
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-17-agent-workspace-key-contract.md
supersedes: []
related_code:
  - server/src/home-paths.ts
  - server/src/services/workspace-runtime.ts
  - server/src/services/organization-skills.ts
commit_refs:
  - fix: adopt org-scoped agent workspace and skill ownership
updated_at: 2026-04-17
---

# Org-Scoped Agent Workspace And Skill Ownership Contract

## Summary

Adopt the org-scoped workspace tree as the canonical runtime filesystem contract, and move runtime skill ownership fully into Rudder's control plane.

Canonical paths:

- Agent personal root: `~/.rudder/instances/<instance>/organizations/<org-id>/workspaces/agents/<workspace-key>`
- Agent instructions: `.../agents/<workspace-key>/instructions`
- Agent memory: `.../agents/<workspace-key>/memory`
- Agent private skills: `.../agents/<workspace-key>/skills`
- Org shared skills: `.../organizations/<org-id>/workspaces/skills`
- Org shared plans: `.../organizations/<org-id>/workspaces/plans`

## Decisions

- Bundled Rudder four skills remain mandatory and locked on.
- Default per-agent execution `cwd` equals the agent personal root unless a project or worktree override is active.
- `AGENT_HOME` points to the agent personal root, never to `instructions/`.
- External global and adapter-home skills remain discovery sources only. Runtime loading still comes only from Rudder's bundled baseline plus the explicit enabled selections for that agent.
- Agent-private authored skills are discovered from `agents/<workspace-key>/skills`.
- Org-shared imported or materialized skills live under the org `workspaces/skills` root.

## Implementation Notes

- Add org-scoped workspace path helpers and lazy copy-forward migration from legacy per-agent workspace and legacy managed instructions roots.
- Extend runtime context with explicit agent and org workspace subdirectory paths and mirror them into env vars for adapters.
- Materialize managed instructions and managed org skill roots under the new org-scoped workspace tree.
- Reconcile stale managed instructions metadata on read and persist the healed org-scoped root back to the agent config so existing agents stop pointing at legacy managed paths.
- Extend the agent skill catalog with agent-private skills from `AGENT_HOME/skills`.
- Keep adapter-specific isolated realization surfaces, but only realize the Rudder-computed skill set.

## Validation

- `pnpm -r typecheck`
- Targeted runtime, service, adapter, and E2E tests for workspace paths, managed instructions, and skill loading
- `pnpm test:run` reached a known embedded-Postgres init flake in parallel mode; the affected suites were rerun directly and passed
- `pnpm build`

## Related Commit

- `48e13b8` `fix: adopt org-scoped agent workspace and skill ownership`
- Follow-up: persist healed managed instruction bundle metadata when legacy managed roots are encountered on read
