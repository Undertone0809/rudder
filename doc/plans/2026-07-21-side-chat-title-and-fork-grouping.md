---
title: Side Chat source title and fork-family grouping
date: 2026-07-21
kind: implementation
status: complete
area: chat
entities:
  - messenger_chat
  - side_panel
issue:
related_plans:
  - 2026-06-22-chat-fork-conversation-groups.md
  - 2026-06-30-chat-side-panel.md
supersedes: []
related_code:
  - server/src/services/chats.ts
  - server/src/services/side-chats.ts
  - server/src/__tests__/side-chats.test.ts
  - tests/e2e/chat-side-chat.spec.ts
commit_refs: []
updated_at: 2026-07-21
---

# Side Chat Source Title and Fork-Family Grouping

## Summary

Give each newly persisted Side Chat the stable title
`Side chat from: {direct source title}` and, when it is moved to Messenger,
place it in the same automatic conversation-family grouping used by Fork.
Hidden Side Chats remain absent from Messenger and custom groups.

## Product Logic Alignment

Affected contracts:

- `CHAT.SIDE.CHAT.001`: define the source-title snapshot and automatic family
  grouping performed by `Move to Messenger`.
- `CHAT.TITLE.GENERATION.001`: clarify that the Side Chat workflow title is not
  replaced by first-message automatic title generation.
- `CHAT.FORK.001`: preserve its existing grouping behavior while sharing the
  internal family-group helper with Side Chat.

## Implementation

- Generate the persisted Side Chat title from the direct source title at first
  Send, preserving the prefix and truncating the source portion to the existing
  200-character chat-title limit.
- Extract the existing Fork family-group lookup, creation, and membership logic
  into a server-internal helper shared by Fork and Side Chat.
- Keep hidden Side Chats ungrouped. During the successful active-to-kept
  transition, reuse the root conversation's current custom group or create a
  new source-family group with the default leaf icon, then ensure the root,
  direct source, and Side Chat are members in the same transaction.
- Do not migrate or lazily regroup Side Chats that were already kept before
  this change.

## Tests and Verification

- Service tests cover title snapshot/truncation, hidden-state exclusion, new
  group creation, existing-group reuse, moving a source out of a conflicting
  group, nested Fork family reuse, concurrent promotion, and rollback after
  source deletion.
- Side Chat E2E verifies the visible title and expanded family group after Move
  to Messenger and captures the resulting Messenger UI.
- Run focused tests, Side Chat E2E, `pnpm product-logic:check`, lint, recursive
  typecheck, the full test suite, and build; complete independent reviewer and
  black-box verifier checks before handoff.
