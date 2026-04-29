---
title: Issue and project chat prefill
date: 2026-04-30
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - issue_mentions
  - project_context
issue:
related_plans:
  - 2026-04-26-chat-project-context-selector.md
supersedes: []
related_code:
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/ProjectDetail.tsx
  - ui/src/pages/Chat.tsx
  - tests/e2e/issue-detail-toolbar-actions.spec.ts
commit_refs: []
updated_at: 2026-04-30
---

# Issue and Project Chat Prefill

## Summary

Object-level Chat actions should open the Messenger new-chat composer with the
originating issue or project already mentioned. They should not create a durable
empty conversation before the user sends a message.

## Problem

The Issue detail Chat action currently calls the chat creation API immediately
and navigates into the new conversation. The resulting conversation has no
messages, which feels like a broken empty thread instead of a new-chat composer
ready for user input. Project detail has the same direct-create pattern.

## Scope

- In scope:
  - change Issue and Project detail Chat actions to navigate to new Messenger
    chat with a prefilled mention
  - use existing Rudder mention markdown links for issue/project references
  - keep conversation creation deferred until send
  - add focused unit and E2E coverage
- Out of scope:
  - changing existing Agent Chat behavior
  - changing saved chat context-link API contracts
  - adding server-side conversation deduplication

## Implementation Plan

1. Add a shared UI helper that builds encoded Messenger new-chat prefill URLs
   from issue and project objects.
2. Replace Issue detail's direct `chatsApi.create` mutation with navigation to
   the prefill URL.
3. Replace Project detail's direct `chatsApi.create` mutation with the same
   prefill navigation pattern.
4. Adjust chat prefill handling so explicit prefill URLs populate the new-chat
   composer for this action instead of leaving the user in an empty thread.
5. Add tests proving Issue chat does not create a conversation and leaves the
   issue mention in the composer.

## Success Criteria

- Clicking Chat on an issue lands on `/messenger/chat`.
- The composer contains a mention of that issue and no chat conversation exists
  until the user sends.
- Project Chat follows the same new-chat prefill pattern.
- Agent Chat remains a no-create route that preselects the agent.

## Validation

- Passed: `pnpm test:run ui/src/lib/chat-object-prefill.test.ts ui/src/pages/IssueDetail.test.tsx`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Added focused E2E coverage in
  `tests/e2e/issue-detail-toolbar-actions.spec.ts`; direct execution did not
  reach assertions because local Chromium headless launch timed out for every
  test in the file, including pre-existing tests.
- `pnpm test:run` passed the new tests and failed only in existing
  `@rudderhq/cli` organization import/export E2E teardown cleanup with
  `ENOTEMPTY` on a temporary `organizations` directory.
