---
title: Chat Agent Runs conversation grouping
date: 2026-07-21
kind: implementation
status: approved
area: chat
entities:
  - messenger_chat
  - agent_runs
issue:
related_plans:
  - 2026-06-20-agent-run-unification-completion.md
  - 2026-05-29-agent-runs-sort-and-trigger-distribution.md
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - ui/src/pages/AgentDetail.runs.tsx
  - ui/src/pages/AgentDetail.chat-context.tsx
commit_refs: []
updated_at: 2026-07-21
---

# Chat Agent Runs Conversation Grouping

## Summary

Add a `View agent runs` action to the Chat conversation menu and collapse runs
that belong to the same conversation into one Agent Runs navigation entry.
The conversation entry uses the first run in the current filtered and sorted
result by default, while the existing `Chat Replies` section remains the place
to switch between individual runs.

No database field or backend API is required. Chat messages already preserve
`runId` and `replyingAgentId`, and the Agent Run facade already exposes the
normalized conversation identity.

## Implementation

1. Resolve the newest runtime-backed assistant message in the active Chat and
   add a stable menu action that opens its Agent Run. Fall back from the
   message's replying agent to the conversation runtime agent and preferred
   agent. Keep the menu entry visible but disabled while messages load or when
   the conversation has no linked run.
2. Build an internal Agent Runs rail-entry model after the existing filter and
   sort pass. Group matching runs by normalized conversation id, keep unlinked
   runs standalone, and use the selected member as the representative for the
   active group.
3. Render one dense conversation entry on desktop and mobile with the short
   conversation id, matching run count, representative status, timing, and
   summary. Individual run navigation remains in `Chat Replies`.
4. Add English and Chinese copy for the new menu and grouped-run labels.
5. Synchronize `RUN.CHAT.AGENT.001`, `RUN.AGENT.UNIFICATION.001`, and
   `CHAT.LIFECYCLE.001` with the approved reverse-navigation and grouping
   behavior.

## Interfaces

- Database schema, REST routes, and shared Agent Run and Chat Message types do
  not change.
- The Agent detail history remains bounded to its existing 200-run list. The
  selected conversation's full linked run history remains reachable through
  the existing message-to-run links in `Chat Replies`.

## Test Plan

- Unit-test latest-run resolution, agent fallback, disabled menu states,
  conversation grouping, legacy snapshot fallback, filters, sorting, and
  selected older runs.
- Add an end-to-end workflow that enters Agent Runs from Chat, verifies one
  grouped rail entry for multiple conversation runs, switches to an older run
  through `Chat Replies`, and confirms an unlinked run remains standalone.
- Run focused tests and E2E, `pnpm product-logic:check`, `pnpm lint`,
  `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
- Verify the rendered desktop workflow in a real local environment, capture a
  final screenshot, and complete independent review and black-box verification.

## Assumptions

- The action is named `View agent runs`, not `View original agent run`.
- Newest means the latest created runtime-backed assistant attempt across all
  message variants, including superseded and failed attempts.
- The rail does not expand nested runs; `Chat Replies` owns individual run
  switching.
