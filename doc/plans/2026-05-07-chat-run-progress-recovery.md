---
title: Chat Run Progress Recovery
date: 2026-05-07
kind: implementation
status: completed
area: chat
entities:
  - chat_conversations
  - chat_messages
  - chat_streaming
  - chat_recovery
issue: ZST-29
related_plans:
  - 2026-05-07-remove-copilot-default-runtime.md
supersedes: []
related_code:
  - server/src/routes/chats.ts
  - server/src/services/chats.ts
  - server/src/services/chat-generation-locks.ts
  - packages/shared/src/constants.ts
  - packages/shared/src/types/chat.ts
  - ui/src/pages/Chat.tsx
commit_refs: []
updated_at: 2026-05-07
---

# Chat Run Progress Recovery

## Summary

Persist streamed chat progress incrementally so a desktop force-quit or renderer
reload does not leave a blank gap where process transcript and partial assistant
output used to be visible.

## Diagnosis

Current streaming chat turns keep transcript entries and partial assistant text in
process memory and only create an assistant chat message at final, stopped, or
caught error time. If the app process is force-quit before those code paths run,
the user message is durable but the assistant progress is lost.

## Build-Advisor Criteria

- Preserve what the user already saw before improving resumability depth.
- Use the existing `chat_messages` audit surface instead of a parallel runtime log.
- Avoid duplicate transcript entries by updating one in-flight assistant message.
- Mark stale in-flight messages explicitly after restart when no backend stream is active.
- Keep continuation user-controlled and reversible.

## Implementation Plan

1. Extend chat message status to include `streaming` and `interrupted`.
2. Add chat service helpers to update assistant message body/status/transcript and mark stale streaming messages interrupted.
3. During `/messages/stream`, create or update one assistant progress message as transcript/delta events arrive.
4. Final/stop/error paths update that same progress message instead of creating duplicates when possible.
5. On `GET /chats/:id/messages`, mark stale streaming messages interrupted when no active generation exists.
6. Render interrupted messages with a clear status and a Continue action that starts a new continuation turn.
7. Add unit coverage for incremental persistence, stale interruption marking, and UI continuation affordance.

## Validation

- Passed: `pnpm exec vitest run server/src/__tests__/chat-routes.test.ts ui/src/pages/Chat.test.tsx --maxWorkers=1 --minWorkers=1`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-streaming.spec.ts -g "marks preserved streaming progress interrupted"`
- Passed: `pnpm build`
- Known unrelated failures: `pnpm test:run` failed in `agent-v1-registry.test.ts` (existing CLI reference mismatch), `messenger-service.test.ts` (embedded PostgreSQL shared-memory startup), and `approval-routes-chat-application.test.ts` in full-suite order; the approval test passes in isolation.

## Risks

- True backend stream reattachment is not covered by this smallest fix; active renderer reload still relies on final server persistence or a user-triggered continuation if the process is gone.
- Existing message status consumers must tolerate `streaming` and `interrupted` in addition to completed/stopped/failed.
