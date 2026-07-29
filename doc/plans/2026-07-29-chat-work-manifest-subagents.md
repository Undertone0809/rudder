---
title: Chat Work Manifest Subagents
date: 2026-07-29
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_work_manifest
  - side_panel
issue:
related_plans:
  - 2026-07-12-chat-work-manifest.md
  - 2026-07-23-chat-created-issue-work-manifest.md
supersedes: []
related_code:
  - packages/shared/src/types/chat.ts
  - packages/shared/src/chat-subagents.ts
  - server/src/services/chat-work-manifest.ts
  - ui/src/pages/Chat.work-manifest.tsx
  - ui/src/components/side-panel/SubagentsPanelView.tsx
  - ui/src/lib/side-panel-targets.ts
  - doc/product/domains/collaboration/chat-messenger-im.md
  - tests/e2e/chat-work-manifest-subagents.spec.ts
commit_refs: []
updated_at: 2026-07-29
---

# Chat Work Manifest Subagents Implementation Plan

## Goal

Add a conversation-scoped Subagents projection to Chat Work Manifest. The
compact manifest summary opens a Codex-inspired Active/Done Side Panel list,
and each row opens Rudder's existing read-only subagent transcript detail.

## Product Decisions

- Aggregate direct subagents across the current Chat, not only the latest run
  or turn.
- Derive summaries from the accepted transcript ledger and legacy message
  transcript payloads; do not add a persistence table.
- Keep the Work Manifest payload compact. Fetch a source message transcript
  only when the operator opens a subagent detail.
- Group live statuses under Active and every terminal outcome under Done while
  preserving failure/interruption styling.
- Keep the Subagents list tab open when navigating into a detail tab.
- Keep subagent operation read-only; this change does not add send, resume, or
  interrupt actions.

## Implementation

1. Add shared subagent summary types plus a transcript parser that normalizes
   names, statuses, timestamps, and thread identity.
2. Extend the organization-scoped Work Manifest service to project subagents
   from current, non-superseded assistant transcript evidence.
3. Render `Outputs -> Subagents -> Sources -> References` in the compact shelf
   and add the conversation-scoped Subagents Side Panel target and list.
4. Lazy-load the source message transcript when a row opens, then focus the
   existing read-only subagent detail keyed by thread identity.
5. Update `CHAT.THREAD.MANIFEST.001` and `CHAT.SIDE.PANEL.001`.

## Verification

- Cover parser normalization, deduplication, accepted-generation boundaries,
  legacy payloads, organization isolation, superseded rows, and active-to-done
  transitions.
- Cover manifest summary rendering, empty states, ordering, accessibility,
  target deduplication, and detail-load failures.
- Add a real Playwright workflow from manifest summary through the Active/Done
  list into active and completed details, including screenshots outside the
  repository.
- Run lint, recursive typecheck, unit/integration tests, build, the targeted
  E2E suite, and `pnpm product-logic:check`.
