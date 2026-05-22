---
title: Messenger pinned thread summary latency fix
date: 2026-05-10
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
issue: ZST-87
related_plans:
  - 2026-04-09-chat-pin-unread-attention.md
  - 2026-05-01-messenger-thread-organization.md
supersedes: []
related_code:
  - packages/shared/src/types/messenger.ts
  - server/src/services/messenger.ts
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/components/MessengerContextSidebar.test.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/lib/inbox.test.ts
  - ui/src/lib/messenger-memory.test.ts
  - server/src/__tests__/messenger-service.test.ts
  - tests/e2e/messenger-contract.spec.ts
commit_refs:
  - fix: render pinned messenger threads from summaries
updated_at: 2026-05-10
---

# Messenger Pinned Thread Summary Latency Fix

## Summary

Make pinned Messenger chats render from `/messenger/threads` data so the `Pinned`
section no longer waits for the heavier `/chats?status=all` sidebar hydration.

## Problem

The Messenger sidebar currently computes pinned grouping from hydrated chat
conversation rows. On cold start, thread summaries can arrive first while the
full chat list is still loading, causing pinned chats to appear late.

## Scope

- Add pinned metadata to chat thread summaries.
- Render and group chat thread rows from summary data when full chat rows are not loaded.
- Keep full chat rows as supplemental data for project grouping and richer context.
- Do not redesign the Messenger sidebar or change pin/unpin persistence semantics.

## Implementation Plan

1. Extend the shared `MessengerThreadSummary` contract with pinned metadata.
2. Populate the pinned fields from chat conversation user state in the Messenger service.
3. Let the sidebar synthesize a lightweight chat row from the thread summary.
4. Restrict the full chat-list fetch to cases that need supplemental context.
5. Add focused server and sidebar regression coverage.

## Success Criteria

- Pinned chat summaries carry `isPinned` from `/messenger/threads`.
- The sidebar renders a `Pinned` section without waiting for `chats?status=all`.
- Pinned/unpinned ordering remains stable inside the thread list.
- Focused server and UI tests pass.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/components/MessengerContextSidebar.test.tsx --reporter=verbose`
- Passed: `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL=<external test db> pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
- Passed: `RUDDER_E2E_DATABASE_URL=<external test db> RUDDER_E2E_PORT=33287 pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/messenger-contract.spec.ts -g "renders pinned Messenger chats from thread summaries" --project=chromium`
- Passed: `pnpm --filter @rudderhq/shared typecheck && pnpm --filter @rudderhq/server typecheck && pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Blocked by local embedded Postgres init failure: `pnpm test:run` failed across unrelated embedded-Postgres suites before tests could execute.

## Open Issues

- Local embedded Postgres initialization still exits during bootstrap script for broad tests. Focused server and E2E coverage passed against an isolated external PostgreSQL database.
