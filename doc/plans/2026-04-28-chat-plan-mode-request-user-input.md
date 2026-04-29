---
title: Chat plan mode request user input
date: 2026-04-28
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_plan_mode
  - request_user_input
issue: RUD-164
related_plans:
  - 2026-04-18-chat-plan-mode.md
supersedes: []
related_code:
  - server/src/services/chat-assistant.ts
  - server/src/routes/chats.ts
  - packages/agent-runtimes/codex-local/src/server/parse.ts
  - packages/shared/src/types/chat.ts
  - ui/src/pages/Chat.tsx
  - tests/e2e/chat-plan-mode-user-input.spec.ts
commit_refs:
  - feat: add plan-mode user input requests
updated_at: 2026-04-28
---

# Chat Plan Mode Request User Input

## Summary

Plan mode now exposes a structured `request_user_input` contract for chat
assistant runs. The assistant can stop on one to three short questions when a
user decision is blocking the plan, and the board can answer those questions
from the chat thread.

## Decisions

- `request_user_input` is plan-mode only. Normal chat prompts do not advertise
  the contract, and default-mode replies that attempt the result kind are
  rejected.
- The persisted chat message kind is `user_input_request`; it is a waiting
  assistant message, not an approval or issue proposal.
- Each request carries `structuredPayload.requestUserInput.questions`, with
  two or three options per question.
- Codex JSONL parsing recognizes future native `request_user_input` tool calls
  and maps them into the shared runtime `question` result shape.
- The UI renders the questions as selectable option groups and sends the chosen
  answers as a normal user message.

## Validation

- `pnpm vitest run server/src/__tests__/chat-assistant.test.ts server/src/__tests__/chat-routes.test.ts server/src/__tests__/codex-local-adapter.test.ts`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `pnpm test:e2e -- tests/e2e/chat-plan-mode-user-input.spec.ts`
