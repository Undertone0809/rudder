---
title: Automation chat output destination
date: 2026-05-19
kind: proposal
status: in_progress
area: chat
entities:
  - automation_chat_output
  - messenger_chat
issue:
related_plans:
  - 2026-03-30-rename-routines-to-automations.md
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-05-01-messenger-thread-organization.md
supersedes: []
related_code:
  - packages/db/src/schema/automations.ts
  - packages/shared/src/validators/automation.ts
  - packages/shared/src/types/automation.ts
  - server/src/services/automations.ts
  - server/src/services/chats.ts
  - ui/src/pages/Automations.tsx
  - ui/src/pages/AutomationDetail.tsx
commit_refs: []
updated_at: 2026-05-19
---

# Automation Chat Output Destination

## Overview

Automation runs should be able to post their status and result into Messenger
chat while preserving Rudder's issue-backed execution model. The change turns
the current composer-only `Send to chat` choice into a persisted automation
contract: chat can become the output and attention destination, but the issue
remains the durable execution and recovery record.

## What Is The Problem?

The Automation composer already exposes a run output choice, including `Send to
chat`, but the choice is only local UI state and instruction text. The create
API persists title, description, project, assignee, priority, concurrency, and
catch-up policy; it does not persist output mode or chat destination. The
Automation detail sidebar also hard-codes `Track as issue`.

This creates a product mismatch: users can choose a chat-oriented template, but
the backend still always creates issue-backed work and never posts visible run
events into Messenger.

## What Will Be Changed?

- Add an automation output mode: `track_issue | chat_output`.
- Keep existing automations on `track_issue`.
- Add an optional destination chat conversation on automations.
- For `chat_output`, still create the execution issue and run assignment wakeup,
  then write system-owned run events into the selected chat conversation.
- Persist chat message references on automation runs so detail views, run
  history, idempotency, and recovery do not need to reverse-query message JSON.
- Keep chat message kinds and context links narrow: automation run events use
  existing `system_event` messages with structured payload.

## Success Criteria For Change

- Creating an automation with `track_issue` behaves exactly as before.
- Creating an automation with `chat_output` requires an active same-org chat
  destination and persists that destination.
- Running a chat-output automation creates a normal execution issue and also
  posts a visible Messenger event that links to the automation run and issue.
- Terminal run states write a final chat event without relying on the agent to
  post manually.
- Automation detail and recent runs show the configured output mode and chat
  destination instead of hard-coded issue output.

## Out Of Scope

- No non-issue automation execution path in this phase.
- No new chat message kind.
- No `automation` entry in `CHAT_CONTEXT_ENTITY_TYPES`.
- No hidden conversation creation during dispatch.
- No generic automation thread filter in Messenger until there is a clear
  retrieval or navigation job for it.

## Non-Functional Requirements

- Security: all automation/chat references must be organization-scoped.
- Maintainability: the writeback path should be centralized around automation
  run finalization, not scattered through agent prompts.
- Observability: activity logs and run history must remain sufficient to answer
  which automation fired, which issue executed, and which chat message surfaced
  the result.
- Usability: the UI must make assignee/chat-agent mismatches explicit instead
  of silently routing output to an unrelated agent's conversation.

## User Experience Walkthrough

1. A board user creates or edits an automation.
2. In Run output, they choose either `Track as issue` or `Send to chat`.
3. If they choose `Send to chat`, they explicitly select an active Messenger
   conversation. The UI warns or blocks if the conversation's preferred agent
   differs from the automation assignee unless the user confirms the mismatch.
4. When the automation fires, Rudder creates the normal execution issue and
   wakes the assignee.
5. Messenger receives a system event such as "Bug triage started" with links to
   the automation, run, and execution issue.
6. When the issue completes, blocks, cancels, coalesces, skips, or dispatch
   fails, Rudder posts a terminal system event to the same chat.

## Implementation

### Product Or Technical Architecture Changes

- `automations.output_mode`: `track_issue | chat_output`, default
  `track_issue`.
- `automations.chat_conversation_id`: nullable FK to `chat_conversations`.
- `automation_runs.linked_chat_conversation_id`: nullable FK to
  `chat_conversations`.
- `automation_runs.started_chat_message_id`,
  `automation_runs.terminal_chat_message_id`, and
  `automation_runs.last_chat_message_id`: nullable FKs to `chat_messages`.
- Shared validators enforce that `chat_output` requires a chat conversation.
- Server service validates destination org/status and agent mismatch rules.
- Automation dispatch writes a started `system_event` for chat-output runs after
  the execution issue is known.
- Automation finalization writes one terminal event and updates run chat refs.

### Breaking Change

No intentional breaking change. Existing rows default to `track_issue`, and
existing API clients that omit output fields keep the current issue behavior.

### Design

Use `system_event` messages with structured payload:

```json
{
  "eventType": "automation_run_started",
  "automationId": "...",
  "runId": "...",
  "issueId": "...",
  "status": "issue_created",
  "source": "manual"
}
```

Terminal events use `automation_run_completed`, `automation_run_failed`,
`automation_run_skipped`, or `automation_run_coalesced`.

`chat_context_links` remains unchanged in this phase. Run history and UI links
use persisted refs on `automation_runs`.

### Security

No new remote calls or credentials are introduced. The new boundary is a local
org-scoped reference from automation to chat. The service must reject cross-org
or inactive chat destinations.

## What Is Your Testing Plan (QA)?

### Goal

Prove that chat output is a real persisted delivery path while the durable
automation execution behavior remains issue-backed.

### Test Scenarios / Cases

- Service: `track_issue` create/run remains unchanged.
- Service: `chat_output` requires an active same-org chat and writes started
  plus terminal chat refs.
- Service: cross-org, archived, and agent-mismatch destinations are rejected.
- Service: coalesced, skipped, failed, done, blocked, and cancelled states write
  stable terminal chat events without duplicates.
- UI: composer persists output mode and destination.
- UI: detail page renders real output mode/destination and recent run links.
- E2E: run a chat-output automation and verify Messenger shows the run event.

### Expected Results

All changed API contracts stay synchronized across db, shared, server, and UI.
No existing automation is forced into chat output.

### Pass / Fail

- Passed: `./node_modules/.bin/tsc -p packages/shared/tsconfig.json --noEmit`
- Passed: `./node_modules/.bin/tsc -p packages/db/tsconfig.json --noEmit`
- Passed: `./node_modules/.bin/tsc -p server/tsconfig.json --noEmit --pretty false`
- Passed: `./node_modules/.bin/tsc -p ui/tsconfig.json --noEmit`
- Passed: `PATH=/opt/homebrew/bin:$PATH RUDDER_AUTOMATIONS_SERVICE_TEST_DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54329/rudder_automation_chat_output_test ./node_modules/.bin/vitest run server/src/__tests__/automations-service.test.ts --reporter=verbose`
- Passed: `PATH=/opt/homebrew/bin:$PATH ./node_modules/.bin/vitest run ui/src/pages/Automations.test.tsx ui/src/pages/AutomationDetail.test.tsx --reporter=verbose`
- Passed: `PATH=/opt/homebrew/bin:$PATH ./node_modules/.bin/playwright test --config tests/e2e/playwright.config.ts tests/e2e/automations-index-layout.spec.ts --list`
- Not run: full browser E2E execution. The current dev server reports pending migration
  `0072_overjoyed_red_hulk.sql` and `restartRequired`, so the browser run needs a
  dev restart/migration pass before it is meaningful.

## Documentation Changes

- Update internal spec sections for automation output mode when behavior lands.
- Update public automation/chat documentation only if the UI ships in the same
  change.

## Open Issues

- Decide final terminal field name: prefer `terminalChatMessageId` over
  `completedChatMessageId` because skipped and coalesced runs are terminal but
  not completed.
