---
title: Migrate rudder-create-agent to CLI-first hiring workflow
date: 2026-04-19
kind: implementation
status: completed
area: skills
entities:
  - rudder_create_agent_skill
  - rudder_cli
  - agent_hiring
issue:
related_plans:
  - 2026-02-19-ceo-agent-creation-and-hiring.md
  - 2026-04-17-rudder-core-tools-hybrid-surface.md
supersedes: []
related_code:
  - cli/src/commands/client/agent.ts
  - cli/src/agent-v1-registry.ts
  - server/resources/bundled-skills/rudder-create-agent/SKILL.md
  - server/resources/bundled-skills/rudder-create-agent/references/cli-reference.md
  - server/resources/bundled-skills/rudder-create-agent/references/api-reference.md
commit_refs:
  - feat: migrate create-agent skill to cli
  - docs: add create-agent cli migration plan
updated_at: 2026-04-19
---

# Migrate rudder-create-agent to CLI-first hiring workflow

## Summary

This change closes the contract gap where the bundled `rudder` skill had
already moved to a CLI-first control-plane workflow, but
`rudder-create-agent` still taught raw `curl` calls against `/llms/...`,
`/api/orgs/:orgId/agent-hires`, and approval endpoints. The implemented end
state is a CLI-first create-agent path with dedicated hire/config/icon
commands, synchronized bundled-skill references, and E2E coverage for both
direct-create and pending-approval hire behavior.

This plan record was added retroactively after implementation. That is process
debt, not the intended workflow.

## Problem

- `rudder-create-agent` was still transport-first while the rest of Rudder's
  core control-plane guidance had already standardized on `rudder ... --json`
- the skill exposed low-level API sequencing instead of the canonical hiring
  behavior owned by `POST /api/orgs/:orgId/agent-hires`
- there was no first-class CLI wrapper for agent hiring, redacted config
  discovery, or icon discovery, so the skill could not become truly CLI-driven
- the reference docs were split across old API-first guidance and newer
  CLI-first guidance, which made it easy for bundled skills to drift

## Scope

- in scope:
  - add CLI commands for canonical agent hiring, config discovery, config
    comparison, and icon discovery
  - keep approval follow-up on CLI surfaces instead of raw API examples
  - rewrite the bundled `rudder-create-agent` skill and references to be
    CLI-first
  - align the shared Rudder CLI reference with the new create-agent surfaces
  - add automated CLI E2E coverage for the create-agent flow
- out of scope:
  - replacing create-agent with host-owned built-in tools
  - removing low-level approval compatibility commands
  - redesigning the hiring UX in board UI
  - changing the underlying `agent-hires` server semantics

## Implementation Plan

1. Add missing CLI surfaces:
   `agent hire`, `agent config index`, `agent config doc`,
   `agent config list`, `agent config get`, and `agent icons`.
2. Extend CLI discovery metadata so the new commands appear in the Rudder
   command registry and references.
3. Rewrite `rudder-create-agent` to use the CLI-first hiring flow and demote
   direct API usage to compatibility/debug documentation.
4. Update bundled Rudder references that still claimed create-agent was outside
   the CLI migration wave.
5. Add E2E coverage that proves:
   - config and icon discovery work through CLI
   - direct-create hire returns `approval: null`
   - approval-required hire returns both `agent` and `approval`
   - approval comments and linked issues remain reachable through CLI

## Design Notes

- `rudder approval create --type hire_agent` stays available as a compatibility
  command, but the skill should not treat it as equivalent to `agent hire`
  because it bypasses the canonical direct-create vs pending-approval branch.
- `agent get` and `agent config get` need shortname-friendly lookup, otherwise
  the CLI-first skill contract stays awkward compared with the existing server
  reference behavior.
- `references/api-reference.md` stays useful for debugging and route-level work,
  but it should no longer be the primary runtime interface for the bundled
  skill.
- The authoritative source files remain under `server/resources/bundled-skills`.
  Packaged desktop copies are build artifacts, not the editing surface.

## Success Criteria

- `rudder-create-agent` no longer teaches raw `curl` as the normal path
- Rudder CLI exposes a canonical wrapper for `agent-hires`
- create-agent docs clearly separate normal CLI usage from low-level API
  compatibility
- automated CLI coverage proves both hire governance branches
- shared Rudder references no longer claim create-agent is outside the CLI
  migration wave

## Validation

- `pnpm --filter @rudder/cli typecheck`
- `pnpm exec vitest run cli/src/__tests__/agent-v1-registry.test.ts cli/src/__tests__/agent-cli-e2e.test.ts`
- `pnpm -r typecheck`
- `pnpm build`
- `pnpm test:run`
  - the full suite still has unrelated existing failures in
    `ui/src/lib/organization-skill-picker.test.ts` and
    `server/src/__tests__/instance-settings-routes.test.ts`

## Open Issues

- `rudder-create-agent` is now CLI-first, but Rudder still has a broader open
  question about whether high-frequency control-plane actions should stay CLI
  mediated or move to host-owned core tools as proposed in
  `2026-04-17-rudder-core-tools-hybrid-surface.md`.
- This plan record was written after the implementation shipped. Future work in
  this repo should restore the intended order: plan doc first, implementation
  second.
