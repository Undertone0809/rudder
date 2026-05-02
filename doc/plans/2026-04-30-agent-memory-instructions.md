---
title: Agent Memory Instructions
date: 2026-04-30
kind: implementation
status: completed
area: agent_runtimes
entities:
  - agent_instructions
  - agent_memory
issue:
related_plans:
  - 2026-04-07-agent-prompt-context-injection.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/gemini-local/src/server/execute.ts
  - packages/agent-runtimes/cursor-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - server/src/services/agent-instructions.ts
  - server/src/services/default-agent-instructions.ts
commit_refs:
  - feat: load tacit memory with agent instructions
  - test: cover pi memory instruction loading
updated_at: 2026-05-02
---

# Agent Memory Instructions

## Summary

Make tacit agent memory a first-class instruction file. The canonical tacit
memory path is `$AGENT_HOME/instructions/MEMORY.md`, and local runtimes load it
automatically when it exists beside the configured instructions entry file.

## Problem

Rudder already allowed `$AGENT_HOME/MEMORY.md` to exist, but that file was only
useful when an agent remembered to open it. This made stable operating memory
less reliable than `AGENTS.md`, even though both are instruction-like context.

## Scope

- Add `MEMORY.md` to default managed instruction bundles.
- Load sibling `MEMORY.md` with the configured `instructionsFilePath`.
- Keep daily notes and PARA memory under `$AGENT_HOME/memory` and
  `$AGENT_HOME/life` as file stores, not auto-injected prompt context.
- Copy legacy `$AGENT_HOME/MEMORY.md` into managed `instructions/MEMORY.md`
  only when the new file is missing.
- Preserve runtime-specific prompt transport behavior.

Out of scope:

- Database schema changes.
- Public API contract changes.
- Automatic injection of daily notes or `life/` memory.
- Deleting legacy root-level `MEMORY.md`.

## Implementation Plan

1. Add default `MEMORY.md` assets for default and CEO instruction bundles.
2. Update onboarding `AGENTS.md` copy to name `instructions/MEMORY.md` as the
   automatically loaded tacit memory file.
3. Add a shared `loadAgentInstructionsPrefix` helper in
   `@rudderhq/agent-runtime-utils/server-utils`.
4. Update local runtimes to consume the shared helper and expose split prompt
   metrics.
5. Add managed bundle compatibility copying from legacy root memory.
6. Update `para-memory-files` documentation to distinguish tacit memory from
   daily notes and `life/` stores.
7. Add targeted tests for helper behavior, instruction materialization, runtime
   prompt injection, and metrics.

## Design Notes

The helper treats missing sibling `MEMORY.md` as normal. Missing entry
instructions keep the previous warning behavior and continue without injected
instructions. External instruction bundles get memory injection only when
`MEMORY.md` is a sibling of the configured entry file.

`RUDDER_AGENT_MEMORY_DIR` remains a compatibility path for daily notes and PARA
memory workflows. It is not used as the tacit memory instruction source.

## Success Criteria

- New managed agents include `instructions/MEMORY.md`.
- Existing managed agents with root-level `MEMORY.md` get a non-destructive copy
  into `instructions/MEMORY.md`.
- Codex, Claude, Gemini, Cursor, OpenCode, and Pi receive memory content in the
  same instruction transport they already use.
- Runtime metadata reports `instructionsChars`, `instructionEntryChars`, and
  `memoryChars`.

## Validation

- `pnpm vitest run packages/agent-runtime-utils/src/server-utils.test.ts server/src/__tests__/agent-instructions-service.test.ts server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/cursor-local-execute.test.ts server/src/__tests__/opencode-local-execute.test.ts server/src/__tests__/pi-local-execute.test.ts` passed.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `pnpm test:run` was attempted but failed in embedded Postgres initialization across unrelated DB-backed suites with `Postgres init script exited with code 1 ... data directory might already exist`; targeted memory and runtime tests passed.

## Open Issues

None.
