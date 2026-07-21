---
title: Chat title generation token budget
date: 2026-07-21
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_titles
issue:
related_plans:
  - 2026-06-18-chat-title-defaults.md
supersedes: []
related_code:
  - server/src/services/title-generation.ts
  - server/src/services/chat-title-generation.ts
  - server/src/routes/chats.ts
commit_refs: []
updated_at: 2026-07-21
---

# Chat Title Generation Token Budget

## Goal

Make manual chat-title regeneration reflect the current conversation while
keeping title prompts predictably small. Manual regeneration uses the latest
five eligible user messages; automatic naming for a new chat continues to use
only its first user message.

## Decisions

- Count the complete generated prompt with the `o200k_base` tokenizer and keep
  it at or below 1,500 tokens, including instructions, labels, separators, and
  message bodies.
- Add a server-internal query that reads at most the latest five non-empty,
  non-superseded ordinary user messages, then restores chronological order for
  the prompt. Assistant, system, transcript, and attachment content is excluded.
- Normalize whitespace per message. Give each selected message a fair share of
  the remaining token budget, redistribute unused shares from short messages,
  and give indivisible remainder to newer messages.
- When a message exceeds its allocation, preserve token-aligned content from
  both the beginning and end and place ` ... ` between them. Decode only complete
  tokenizer output so truncation remains valid Unicode.
- Keep automatic-title trigger timing, deterministic fallback, asynchronous AI
  replacement, fork exclusion, manual-rename protection, title sanitization,
  authorization, activity logging, and failure behavior unchanged.
- Do not change Messenger group-title generation or public API wire shapes.

## Implementation

1. Add token-counting and middle-truncation helpers around a single
   `o200k_base` tokenizer instance, then assemble bounded one-message and
   multi-message chat-title prompts through the same code path.
2. Add a bounded recent-user-message query to the Chat service and use it from
   `POST /api/chats/:id/title/regenerate` instead of loading full chat history.
3. Preserve the automatic first-message flow while applying the new complete
   prompt budget to long first messages.
4. Update `CHAT.TITLE.GENERATION.001` with the approved source eligibility,
   five-message limit, tokenizer, and complete-prompt budget.
5. Extend unit, route, service, and Messenger E2E coverage before completing
   the repository verification suite.

## Acceptance Criteria

- Every automatic or manual Chat title prompt contains at most 1,500
  `o200k_base` tokens.
- Manual regeneration includes at most the latest five eligible user messages,
  in chronological order, and excludes older user and all assistant messages.
- A long selected message visibly retains both its beginning and end around
  ` ... `; short messages remain intact and release unused budget to long ones.
- New-chat behavior still uses only the first user message and retains its
  current non-blocking fallback and overwrite guards.
- Existing permission, organization, Feishu-bound chat, fork, failure, and
  activity-log behavior remains green.

## Verification

- Focused prompt-helper, Chat service, and Chat route Vitest coverage.
- `tests/e2e/messenger-chat-title-regenerate.spec.ts` with more than five user
  messages, assistant noise, and long content through the visible menu action.
- `pnpm product-logic:check`, `pnpm lint`, `pnpm -r typecheck`,
  `pnpm test:run`, and `pnpm build`.
- Independent code review plus black-box verification against the local app.
