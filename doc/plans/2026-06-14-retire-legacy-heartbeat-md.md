---
title: Retire legacy HEARTBEAT.md instruction files
date: 2026-06-14
kind: implementation
status: implemented
area: agent_runtimes
entities:
  - heartbeat_runs
  - agent_runtime_instructions
  - agent_workspace
issue:
related_plans:
  - 2026-06-14-runtime-heartbeat-prompt-and-studio-practices.md
  - 2026-06-03-heartbeat-instructions-scene-gate.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.instructions.ts
  - server/src/onboarding-assets/default/HEARTBEAT.md
  - server/src/onboarding-assets/ceo/HEARTBEAT.md
  - server/src/services/organization-workspace-browser.ts
  - server/src/routes/orgs.ts
  - ui/src/pages/OrganizationWorkspaces.tsx
  - doc/SPEC-implementation.md
commit_refs: []
updated_at: 2026-06-14
---

# Retire Legacy HEARTBEAT.md Instruction Files

## Summary

`HEARTBEAT.md` should no longer have runtime meaning. Rudder's heartbeat
pipeline is now a platform-owned runtime instruction prompt injected only for
heartbeat-scene invocations. Existing workspace files named
`agents/<workspaceKey>/instructions/HEARTBEAT.md` are legacy artifacts.

## Problem

The previous compatibility policy still allowed a legacy `HEARTBEAT.md` to be
loaded as supplemental heartbeat notes. That keeps the obsolete mental model
alive: users may think every agent needs a manually maintained heartbeat file.
It also creates a second source of truth beside the runtime heartbeat prompt.

## Scope

- Stop loading sibling or explicit-entry `HEARTBEAT.md` files in runtime prompt
  assembly.
- Remove the stale bundled onboarding `HEARTBEAT.md` source assets so new
  managed agents cannot reintroduce the old file by accident.
- Update docs/tests so `HEARTBEAT.md` is described as ignored legacy content,
  not supplemental instructions.
- Add a board-only bulk cleanup endpoint that deletes only
  `agents/*/instructions/HEARTBEAT.md`.
- In the Library UI, intercept opening such legacy files and show a deprecation
  dialog with a bulk delete action.

Out of scope:

- Deleting arbitrary agent instruction files.
- Replacing the runtime heartbeat prompt.
- Removing existing `SOUL.md`, `TOOLS.md`, or `MEMORY.md` protections.

## Implementation Plan

1. Change `loadAgentInstructionsPrefix` so `HEARTBEAT.md` is always ignored as
   a file-backed instruction source.
2. Remove stale bundled onboarding `HEARTBEAT.md` assets from source.
3. Add service/API support for deleting all current legacy agent heartbeat
   files in one board-only operation.
4. Add a shared UI path guard and modal in the Library browser/sidebar.
5. Update unit/integration/E2E coverage around runtime loading, bulk deletion,
   and the visible Library workflow.
6. Verify with targeted tests, type/lint checks where practical, browser proof,
   spawned reviewer gates, then commit and push only this task's files.

## Design Notes

The cleanup endpoint is intentionally narrow. It bypasses the protected
instruction-file delete guard only for exact paths matching
`agents/<workspaceKey>/instructions/HEARTBEAT.md` for current DB-backed agents,
preserving protections for role, tool, and memory instruction files and leaving
stale or manually created `agents/*` directories untouched.

The UI dialog should appear when the operator tries to open a legacy heartbeat
file from the Library tree or URL. It should not display the file as live agent
instructions because the runtime will not consume it.

## Success Criteria

- Heartbeat runs inject the code-owned runtime heartbeat prompt and never append
  legacy `HEARTBEAT.md` content.
- Runtime metrics keep `heartbeatFileChars` at zero and `heartbeatChars` equal
  to runtime heartbeat prompt bytes.
- Library users who click a legacy heartbeat file see a deprecation modal.
- The modal can delete all current legacy heartbeat files while leaving other
  current-agent instruction files intact.
- Relevant tests and visible UI verification pass before handoff.

## Validation

- Targeted runtime loader and heartbeat service tests.
- Workspace browser service/API tests for bulk deletion.
- UI tests for modal display and delete action.
- E2E or browser verification for the real Library click path.
- `pnpm -r typecheck`, `pnpm lint`, and `git diff --check` where practical.

## Open Issues

None.
