---
title: Automation chat output and activity polish
date: 2026-05-22
kind: implementation
status: in_progress
area: chat
entities:
  - automation_chat_output
  - messenger_chat
  - automation_detail
issue:
related_plans:
  - 2026-05-19-automation-chat-output.md
  - 2026-05-08-issue-detail-activity-stream.md
  - 2026-05-01-messenger-thread-organization.md
supersedes:
  - 2026-05-19-automation-chat-output.md
related_code:
  - packages/shared/src/validators/automation.ts
  - server/src/services/automations.ts
  - server/src/services/automation-chat-output.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - ui/src/pages/AutomationDetail.tsx
  - ui/src/pages/AutomationDetail.parts.tsx
  - ui/src/pages/AutomationDetail.test.tsx
  - ui/src/pages/Chat.tsx
commit_refs: []
updated_at: 2026-05-22
---

# Automation Chat Output And Activity Polish

## Problem

The current Automation detail work made the page quieter, but the follow-up
review exposed two separate product problems:

1. The Activity stream is visually too simple. Per-row icons create clutter
   without adding information, while the row heights vary enough that the list
   stops feeling like a stable time-ordered log.
2. `Send to chat` currently behaves like a signal delivery option. It can create
   or point at a chat, then post an automation marker, but the user job is not
   "tell me an automation fired." The user job is: after an automation run
   completes, show the agent's final result in a chat so the operator can
   continue the conversation with the same agent and context.

The old plan allowed selecting an existing chat destination. That creates a
weak product model: arbitrary old chats are not a durable automation result
surface, agent identity can mismatch the automation assignee, and the output
does not naturally become the next conversational turn.

## Decision

Treat `chat_output` as an automation-owned result conversation.

- `Send to chat` means Rudder will create or reuse the automation's own chat
  thread, not let the operator choose any existing chat.
- The configured destination is conceptually "New chat" from the UI, but it is
  persisted as the automation's chat conversation after creation.
- The chat must show a real final result message when a run reaches a terminal
  state. A start/status marker may exist, but it is not the product value.
- The result chat should be ready for follow-up: same preferred agent, same
  project context when available, and enough structured links to the automation
  run and execution issue for traceability.
- Activity should use timeline structure, not repeated per-row icons, to express
  chronology.

## UX Requirements

### Automation Detail Sidebar

- `Output` stays as a compact property row with `Track as issue` or
  `Send to chat`.
- When `Send to chat` is selected, the sidebar shows a non-selecting `Chat`
  row:
  - before the first chat run: `New chat`
  - after a chat conversation exists: a link/name for the automation-owned chat
- No picker for existing chats.
- The chat row should not pretend the user is choosing a destination; it is
  explaining where results will appear.

### Automation Create Surface

- The create composer follows the same output contract as detail.
- `Send to chat` shows that Rudder will create a new result chat after the
  first run; it does not expose existing chat search or selection.
- New automation create requests must not bind `chatConversationId` to an
  arbitrary existing conversation.

### Trigger Editing

- The collapsed trigger item stays compact and uniform.
- The expanded edit state should not become a heavy nested form panel. It should
  read as inline editing for the selected trigger.
- Item height should be stable in collapsed state; expanded state may grow only
  for active editing.

### Activity

- Remove per-row glyph icons.
- Preserve time order through layout: a left timeline rule, row spacing, and
  aligned timestamps.
- Rows should have a stable height for common one-line events.
- Long event text must not make the list look ragged; use truncation or a
  consistent secondary line only when necessary.
- The visual language should be closer to Issue detail activity: calm, dense,
  scannable, and timeline-like.

### Messenger Result Thread

- A chat-output automation run should surface the final result in the chat.
- The first visible chat content after completion should answer "what did the
  agent produce?", not just "from automation X."
- The operator should be able to type a follow-up immediately in that thread.

## Implementation Shape

1. UI contract:
   - Remove the existing chat conversation selector from Automation detail for
     `chat_output`.
   - When the user switches to `chat_output`, persist `chatConversationId:
     null` unless the automation already owns a linked chat.
   - Render the chat row as read-only status/link text.

2. Server contract:
   - Relax validation so `chat_output` does not require an existing
     `chatConversationId`.
   - Create requests for `chat_output` reject any non-null
     `chatConversationId`; the only valid configured destination is the
     automation-owned chat.
   - Update requests for `chat_output` reject a non-null `chatConversationId`
     unless it is the automation's already persisted conversation id. This keeps
     legacy automation-owned rows safe while preventing a new arbitrary
     destination from being selected.
   - `allowAssigneeChatMismatch` is removed from the public automation request
     contract for this flow.
   - On first issue-backed dispatch, create an automation-owned chat
     conversation when needed, scoped to the same organization and assignee
     agent.
   - While holding the automation dispatch lock, write the created conversation
     id to both `automation_runs.linked_chat_conversation_id` and
     `automations.chat_conversation_id`. Later runs reuse
     `automations.chat_conversation_id`.
   - If a finalization path somehow creates the result chat before dispatch
     persisted one, it must also backfill `automations.chat_conversation_id`.
   - Coalesced and skipped runs must not create an empty chat when no
     automation-owned chat already exists.

3. Final result publishing:
   - Canonical source is the runtime final observation output passed from
     `heartbeat.execute.ts` into `publishAutomationRunOutputToChat`.
   - The terminal assistant message uses that final observation body exactly
     after trimming. It is the chat content the operator should continue from.
   - If no final observation exists, publish a concise terminal fallback:
     failure/timed-out/cancelled states explain that no final response was
     produced; successful completion says only that the run completed.
   - Dedupe by `(conversationId, eventType=automation_run_result, runId)` so
     retries do not post multiple terminal results.
   - Persist `terminalChatMessageId` and `lastChatMessageId`.
   - Status mapping:
     - `succeeded` / `completed`: assistant message status `completed`.
     - `failed`, `timed_out`, `cancelled`: assistant message status `failed`.
     - `skipped` and `coalesced`: no result chat is created unless an
       automation-owned chat already exists; when one exists, use a terminal
       system event rather than pretending there was agent output.

4. Activity UI:
   - Replace row glyphs with a timeline rule.
   - Normalize collapsed row height.
   - Keep issue/run identifiers aligned and non-wrapping.

## Acceptance Criteria

- Automation detail no longer lets users select an existing chat for
  `Send to chat`.
- Automation create no longer lets users select an existing chat for
  `Send to chat`.
- API create/update cannot bind a new arbitrary existing chat as the destination
  for `chat_output`.
- Switching `Output` to `Send to chat` communicates that Rudder will create the
  automation result chat.
- Running a chat-output automation creates or reuses the automation-owned chat.
- Messenger displays a meaningful final result for completed runs and a clear
  terminal fallback for failed, timed-out, or cancelled runs that have no final
  observation.
- Follow-up composer is available in that result chat with the automation
  assignee as the preferred agent.
- Activity rows no longer use icons and common rows have a stable visual rhythm.
- Trigger collapsed items have uniform height.
- Trigger expanded edit state reads as lightweight inline editing, not a nested
  form panel.
- Tests prove the no-existing-chat selection contract and final-result publish
  path.

## Non-Goals

- Do not remove issue-backed automation execution.
- Do not create a generic automation inbox in Messenger.
- Do not redesign the whole Messenger shell.
- Do not add a new chat message kind unless the existing `system_event` and
  message body model cannot represent the final result cleanly.
- Do not migrate existing arbitrary chat-output destinations in this pass beyond
  keeping them safe to render.

## Validation Plan

- Targeted UI tests for Automation detail:
  - output mode row,
  - read-only `New chat` row,
  - no existing-chat selector,
  - activity timeline structure,
  - stable trigger collapsed rows.
- Targeted UI tests for Automation create:
  - chat output shows read-only `New chat`,
  - no existing-chat selector.
- Targeted server tests for automation chat output:
  - chat-output create/update without a destination,
  - create/update reject arbitrary existing chat ids,
  - run creates or reuses the automation-owned chat,
  - terminal final result is posted and refs are persisted,
  - `track_issue` behavior remains unchanged.
- Route-level E2E:
  - create a chat-output automation without an existing chat,
  - run it,
  - confirm the created run links an automation-owned chat,
  - publish the final result,
  - confirm the chat message contains the final result and the conversation is
    ready for follow-up through the same preferred agent.
- Browser visual checks:
  - Automation detail desktop screenshot,
  - chat-output sidebar screenshot,
  - expanded trigger editor screenshot,
  - Messenger result thread screenshot.
- Standard checks:
  - relevant typecheck,
  - targeted vitest suites,
  - broader build if contracts change.

## Closed Decisions

- Automation-owned chats keep the automation title as the chat title. This keeps
  the first-viewport label short and matches the existing conversation model.
- The runtime final observation is the canonical final result source for this
  pass.
- New API writes reject arbitrary existing chat ids for `chat_output`; existing
  persisted automation-owned chat ids can be preserved.
