---
title: Agent Library Local Filesystem First
date: 2026-06-06
kind: implementation
status: implemented
area: agent_runtimes
entities:
  - project_library
  - agent_runtime_context
  - agent_output_references
issue:
related_plans:
  - 2026-06-02-library-project-workspace-contract.md
  - 2026-06-05-agent-renderable-content-library-identity.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - packages/agent-runtimes/*/src/server/execute.ts
  - server/src/services/agent-run-context.ts
  - cli/src/commands/client/library.ts
  - cli/src/agent-v1-registry.ts
  - server/resources/bundled-skills/rudder/SKILL.md
commit_refs: []
updated_at: 2026-06-06
---

# Agent Library Local Filesystem First

## Summary

Rudder Library exists because durable work files are local files. The user value
is that agents can read, edit, search, transform, and compose project files with
normal filesystem tools. Special render syntax such as `library-entry://...`
exists only so Rudder's user-facing surfaces can render stable links and chips.
It must not become the agent's primary file-operation model.

This plan tightens the Agent journey after the strong Library entry reference
work. Local trusted runtimes should expose the project Library folder as a
filesystem path, agents should write files directly under that folder, and the
Rudder CLI should mainly provide references for comments and handoff text.
`rudder library file get/put` remains useful for remote or restricted runtimes,
but it should not be taught as the default local workflow.

## Problem

The previous `library-entry://` implementation made references durable after
rename or move, but the authoring guidance over-corrected toward CLI-mediated
file writes:

- `rudder library file put/get/link --json` was described as the normal agent
  path for durable Library files.
- Runtime prompts still described `library:projects/...` as the place to write,
  but did not provide a concrete local project Library path.
- The runtime operating contract still mentioned hand-written
  `library-file://...` links.

That is backwards from the product principle. The Library is a file workspace
first and a render protocol second. A local agent should not need to upload a
Markdown body through Rudder just to create a PRD. It should write
`$RUDDER_PROJECT_LIBRARY_ROOT/PRD.md`, then ask Rudder for a stable
`markdownLink` only when it needs to cite the file in an issue comment, chat
reply, blocker, review, or done note.

## First-Principles Model

Separate three layers:

1. Filesystem operation layer
   - Local trusted agents work with normal files.
   - Default durable path:
     `$RUDDER_PROJECT_LIBRARY_ROOT/<relative-file>`.
   - `library:projects/<project-key>/...` is a product locator, not the file
     contents API and not Markdown syntax.

2. Rudder identity and index layer
   - Rudder maps local project Library files to `libraryEntryId`.
   - Rudder tracks current path/state across rename, move, and delete.
   - Remote or restricted runtimes may still use API/CLI file commands when
     they do not have filesystem access.

3. Render reference layer
   - User-facing text should cite files with a ready-to-paste Markdown link.
   - Agents should obtain that link from Rudder with a reference command, not by
     hand-writing `library-entry://...` or `library-file://...`.
   - Render syntax is for UI stability, not for day-to-day file editing.

## Scope

In scope:

- Expose `projectLibraryRoot` and `projectLibraryRelativePath` in runtime scene
  context when a run has project context.
- Inject `$RUDDER_PROJECT_LIBRARY_ROOT` and `$RUDDER_PROJECT_LIBRARY_PATH` into
  local runtime environments.
- Update code-owned runtime prompts and bundled skills so local agents write
  files directly under `$RUDDER_PROJECT_LIBRARY_ROOT`.
- Add a clearer `rudder library file ref <path> --json` command for obtaining
  `markdownLink`, while keeping `link` as a compatibility alias.
- Reword `rudder library file get/put` as remote/restricted fallback, not the
  default local workflow.
- Teach that direct filesystem writes become Rudder-visible handoff evidence
  only after the agent obtains and posts a `markdownLink` with `ref`.
- Update tests that assert runtime prompt/env and CLI authoring behavior.

Out of scope:

- Removing `rudder library file get/put`; they remain needed for non-local
  runtimes and compatibility.
- Changing Library DB identity or renderer behavior already introduced by the
  strong entry reference plan.
- Full binary asset upload support. Local agents may create local files, but the
  stable remote/binary asset contract remains future work.

## Implementation Plan

1. Compute project Library root and relative path in `agent-run-context` using
   existing `resolveProjectLibraryDir` and `resolveProjectLibraryRelativePath`
   helpers when `projectId` is available.
2. Add local runtime env injection for:
   - `RUDDER_PROJECT_LIBRARY_ROOT`
   - `RUDDER_PROJECT_LIBRARY_PATH`
3. Update the runtime operating contract:
   - local agents write directly under `$RUDDER_PROJECT_LIBRARY_ROOT`
   - `library:projects/...` remains the product locator
   - `rudder library file ref ... --json` returns the stable `markdownLink`
  - `get/put "$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>"` is the fallback
    path when local filesystem access is unavailable
  - posting the `markdownLink` returned by `ref` is the handoff checkpoint for
    direct filesystem writes
4. Add `rudder library file ref <path>` as the primary reference command and
   retain `rudder library file link <path>` as an alias.
5. Update bundled Rudder skill and CLI/API reference docs.
6. Update focused tests for scene context, runtime prompt, CLI e2e, and at least
   one local runtime env injection path.

## Success Criteria

- A project-scoped local run receives a concrete
  `$RUDDER_PROJECT_LIBRARY_ROOT`.
- Agent-facing guidance says to edit local files directly when local filesystem
  access exists.
- Agent-facing guidance says to call `rudder library file ref ... --json` only
  to obtain a stable UI-renderable citation.
- `rudder library file get/put` remains documented and tested as fallback, but
  is no longer presented as the normal local write path.
- Existing strong `library-entry://` rendering remains unchanged.
- Focused tests prove the prompt/env/CLI contract.

## Validation Ledger

- Passed: `pnpm test:run server/src/__tests__/agent-run-context.test.ts packages/agent-runtime-utils/src/server-utils.test.ts cli/src/__tests__/agent-cli-e2e.test.ts server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/opencode-local-execute.test.ts server/src/__tests__/pi-local-execute.test.ts server/src/__tests__/cursor-local-execute.test.ts server/src/__tests__/company-branding-route.test.ts server/src/__tests__/issue-lifecycle-routes.test.ts`
  - 11 files / 144 tests.
  - proves project Library root context, runtime prompt copy, direct filesystem
    write followed by `rudder library file ref`, Codex/Claude/Gemini/OpenCode/
    Pi/Cursor env injection, and updated agent-facing route errors.
- Passed: `pnpm --filter @rudderhq/server typecheck`
- Passed: `pnpm --filter @rudderhq/cli typecheck`
- Passed: `pnpm --filter @rudderhq/agent-runtime-utils typecheck`
- Passed before reviewer rework: local runtime typechecks for Codex, Claude,
  Gemini, OpenCode, Pi, and Cursor.
- Pending: reviewer gate after staged diff re-review.
