---
title: Chat-native automation output
date: 2026-06-02
kind: implementation
status: verified
area: chat
entities:
  - automation_runs
  - messenger_chat
  - chat_streaming
related_plans:
  - 2026-05-19-automation-chat-output.md
  - 2026-05-22-automation-chat-output-and-activity-polish.md
supersedes:
  - 2026-05-19-automation-chat-output.md
  - 2026-05-22-automation-chat-output-and-activity-polish.md
related_code:
  - server/src/services/automations.ts
  - server/src/services/chats.ts
  - server/src/services/chat-assistant.ts
  - server/src/routes/chats.stream-routes.ts
  - ui/src/pages/AutomationDetail.tsx
  - ui/src/pages/Chat.messages.tsx
commit_refs: []
updated_at: 2026-06-02
---

# Chat-native automation output

## Decision

`Send to chat` automations should execute like normal Chat turns.

The old model treated chat output as `issue-backed execution + result forwarding`.
That contradicts the operator expectation: when an automation is configured to
send to chat, the automation should behave like a scheduled or manually
triggered chat message, and the user should be able to open the result chat and
watch the same streaming process they would see after sending a normal Chat
message.

## Product Contract

- `track_issue` remains the durable issue workflow.
- `chat_output` does not create a user-visible issue and does not consume an
  issue number.
- Each `chat_output` run creates or reuses a run-owned chat conversation.
- The automation instructions are persisted as a normal user-role chat message
  in that conversation.
- The agent reply is persisted as a normal assistant message that starts in
  `streaming`, updates with transcript/body progress, and finishes as
  `completed`, `failed`, `stopped`, or `interrupted`.
- The chat thread remains follow-up capable with the automation assignee as the
  preferred agent.
- `automation_runs` remains the scheduler/audit record. It links to the chat
  conversation and chat messages, not to an execution issue.

## Non-goals

- Do not remove issue-backed execution for `track_issue`.
- Do not hide automation run audit history.
- Do not create arbitrary existing-chat destinations for new automations.
- Do not make Messenger a generic automation inbox.

## Implementation Shape

1. Extract the normal Chat streaming execution workflow into a reusable service
   helper that can be called by both HTTP Chat sends and automation dispatch.
2. Update automation dispatch:
   - for `track_issue`, keep the current issue-backed path;
   - for `chat_output`, create an `automation_runs` row, resolve the
     run-owned chat, append the automation prompt as a user message,
     start the reusable chat stream runner, and update `automation_runs` with
     user/assistant message ids and terminal status.
3. Update docs and tests so `chat_output` no longer expects `linkedIssueId`.
4. Update Activity and detail UI copy so chat-output runs read as chat runs
   rather than execution issues.

## Acceptance Criteria

- Running a `chat_output` automation returns an automation run with
  `linkedIssueId: null` and a non-null `linkedChatConversationId`.
- The organization issue counter does not advance for a `chat_output` run.
- The linked chat contains a user message for the automation prompt and a normal
  assistant message with transcript metadata.
- During an active run, the chat page can render the assistant message in the
  same streaming/process UI used for manual Chat.
- `track_issue` automation tests still prove issue creation and assignment.
- Existing successful `chat_output` issue close-out behavior is removed or
  narrowed to legacy runs only.

## Verification

- `pnpm --filter server typecheck`
- `pnpm -r typecheck`
- `pnpm test:run server/src/__tests__/automations-service.test.ts`
- `pnpm test:run server/src/__tests__/automations-e2e.test.ts`
- `pnpm test:run ui/src/pages/AutomationDetail.test.tsx ui/src/pages/Automations.test.tsx`
- `pnpm test:e2e tests/e2e/automations-index-layout.spec.ts --grep "posts automation run output into Messenger chat"`
- `pnpm build`

The targeted chat-output user workflow passes and proves the terminal surface:
`Run now` navigates to the linked Messenger chat, the run returns
`linkedIssueId: null`, the organization issue counter does not advance, the
linked chat contains the automation prompt as a user message, and the assistant
reply streams/completes in the chat.

Post-review verification also covered ordinary Chat result semantics for
chat-output runs: `ask_user`, proposal approvals, generated attachments, and
stale `running` run recovery.

Reviewer gate: two spawned lifecycle reviewers passed after the stale-run,
proposal-payload, and attachment-coverage fixes.
