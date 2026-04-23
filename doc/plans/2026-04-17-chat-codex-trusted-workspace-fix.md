---
title: Fix messenger Codex trusted workspace failures
date: 2026-04-17
kind: plan
status: completed
area: chat
entities:
  - messenger_chat
  - codex_local
  - trusted_workspace
issue:
related_plans:
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-04-14-agent-workspace-canonicalization.md
supersedes: []
related_code:
  - server/src/services/chat-assistant.ts
  - server/src/services/agent-run-context.ts
  - server/src/__tests__/chat-assistant.test.ts
commit_refs:
  - fix: guard codex chat against untrusted workspaces
updated_at: 2026-04-17
---

# Fix Messenger Codex Trusted Workspace Failures

## Summary

Messenger chat turns can currently launch `codex_local` from the canonical agent home instead of the resolved execution workspace. When the conversation is not attached to a project workspace and the runtime config does not provide a repo-backed `cwd`, Codex rejects the run with `Not inside a trusted directory and --skip-git-repo-check was not specified.` The fix will align chat workspace propagation with the resolved execution workspace and add a chat-side preflight that translates this runtime constraint into a user-actionable error.

## Implementation

- Update `agent-run-context` chat scene context so `rudderWorkspace.cwd` carries the resolved execution workspace rather than always forcing the canonical agent home.
- Add chat runtime preflight for `codex_local`:
  - resolve the effective chat working directory using the same precedence as the runtime adapter
  - require that directory to live inside a git working tree
  - return a human-readable availability/error message before attempting adapter execution
- Keep the agent home paths in context for instructions, memory, and skills so non-workspace resources still resolve correctly.

## Tests

- Add a unit test for `agent-run-context` to verify chat scene context exposes the execution workspace cwd while preserving agent home metadata.
- Extend `chat-assistant` tests to verify `codex_local` chat availability fails with a friendly message when only agent home is available.
- Run targeted server tests covering the updated workspace propagation and chat availability guard.

## Assumptions

- Codex's trust gate is adequately approximated by requiring the effective chat cwd to be inside a git work tree.
- Other local runtimes can continue to rely on the resolved workspace cwd without additional preflight changes in this patch.

## Validation

- Targeted tests passed:
  - `pnpm vitest run server/src/__tests__/agent-run-context.test.ts server/src/__tests__/chat-assistant.test.ts server/src/__tests__/chat-routes.test.ts`
- Repository checks passed:
  - `pnpm -r typecheck`
  - `pnpm build`
- Repository-wide `pnpm test:run` still reports pre-existing failures unrelated to this patch:
  - embedded Postgres/shared-memory initialization failures in `server/src/__tests__/automations-service.test.ts`, `server/src/__tests__/heartbeat-paused-wakeups.test.ts`, and `server/src/__tests__/messenger-service.test.ts`
  - existing `packages/db/src/client.test.ts` migration rebuild failure

## Related Commit

- `fix: guard codex chat against untrusted workspaces`
