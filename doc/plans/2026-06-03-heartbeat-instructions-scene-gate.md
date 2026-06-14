---
title: Heartbeat instructions scene gate
date: 2026-06-03
kind: implementation
status: completed
area: agent_runtimes
entities:
  - agent_runtime_instructions
  - heartbeat_runs
issue:
related_plans: []
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.instructions.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/cursor-local/src/server/execute.ts
  - packages/agent-runtimes/gemini-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
commit_refs:
  - fix: gate heartbeat instructions to heartbeat scene
updated_at: 2026-06-03
---

# Heartbeat Instructions Scene Gate

Superseded note, 2026-06-14: `HEARTBEAT.md` no longer has runtime meaning in
any scene. Rudder now injects the platform-owned heartbeat instruction prompt
from runtime code and ignores legacy `HEARTBEAT.md` files. See
`2026-06-14-retire-legacy-heartbeat-md.md`. The remainder of this plan is kept
as historical context for the earlier scene-gate design and must not be read as
the current runtime contract.

## Problem

`HEARTBEAT.md` is the agent's heartbeat-run operating protocol. It should be
available when Rudder wakes an agent for a heartbeat run, because that is the
scene where inbox checks, checkout, close-out, reviewer decisions, and passive
follow-up rules apply.

The same file should not be injected into chat or any other non-heartbeat run.
Those scenes have different terminal behavior and should not receive
heartbeat-only instructions such as checking the inbox or exiting cleanly after
assignments.

## Contract

- `HEARTBEAT.md` is loaded only when the runtime invocation scene is
  `heartbeat`.
- Non-heartbeat scenes must not load `HEARTBEAT.md`, even if a user or legacy
  config points `instructionsFilePath` directly at `HEARTBEAT.md`.
- Default stable instruction loading for `SOUL.md`, `TOOLS.md`, and `MEMORY.md`
  remains unchanged.
- Runtime command notes and prompt metrics must make heartbeat instruction
  loading observable for heartbeat runs.

## Implementation Slice

1. Keep the adapter scene gate explicit: local runtimes pass
   `includeHeartbeatInstructions: true` only when `context.rudderScene` is
   `heartbeat`.
2. Harden the shared instruction loader so `HEARTBEAT.md` is skipped outside
   heartbeat scenes, including the direct-entry-file case.
3. Add regression tests for both paths:
   - sibling `HEARTBEAT.md` loads for heartbeat scene runs
   - direct entry `HEARTBEAT.md` does not load for non-heartbeat scene runs
4. Update `doc/SPEC-implementation.md` to describe the scene-gated contract.

## Verification

- Focused runtime instruction loader tests.
- Focused Codex local runtime execution test proving heartbeat scene injection.
- Heartbeat service actor-path test with a fake Codex command that captures the
  final runtime prompt and verifies `HEARTBEAT.md` plus persisted
  `adapter.invoke` prompt metrics.
- Typecheck for all local runtime adapters touched by the scene gate.
- Spawned reviewer gate before handoff.
