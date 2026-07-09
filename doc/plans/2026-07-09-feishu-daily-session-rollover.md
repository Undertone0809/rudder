---
title: Feishu Daily Session Rollover
date: 2026-07-09
kind: proposal
status: completed
area: chat
entities:
  - messenger_chat
  - feishu_integration
  - chat_sessions
issue:
related_plans:
  - 2026-06-23-feishu-read-only-chat-fork.md
supersedes: []
related_code:
  - packages/db/src/schema/agent_integrations.ts
  - packages/db/src/schema/agent_integration_chat_bindings.ts
  - packages/shared/src/types/agent-integration.ts
  - packages/shared/src/validators/agent-integration.ts
  - server/src/services/integrations/agent-integrations.ts
  - server/src/services/integrations/feishu/inbound-dispatcher-db.ts
  - server/src/routes/agents.ts
  - ui/src/pages/AgentDetail.integrations.tsx
  - server/src/__tests__/agent-integration-feishu-db-dispatcher.test.ts
  - ui/src/pages/AgentDetail.integrations.test.tsx
commit_refs:
  - decfb8f45
updated_at: 2026-07-09
---

# Feishu Daily Session Rollover

## Overview

Feishu-origin conversations should stay comfortable for day-to-day work without
turning one external IM thread into an indefinitely growing runtime context.
Rudder should keep the Feishu external chat stable, but split the Rudder-side
Feishu-bound conversation into daily sessions when the user next chats after the
current session is older than 24 hours.

This is a lazy rollover, not a background scheduler. Rudder creates the next
session only when a new Feishu inbound message arrives. If the user does not
talk to the bot for several days, no empty conversations are created.

## What Is The Problem?

Current Feishu binding maps one external Feishu chat id to one active Rudder
conversation. This is good for auditability, but a long-lived Feishu chat causes
three product problems:

- The Rudder chat transcript becomes too long for efficient assistant context.
- Messenger shows one permanent Feishu row instead of readable daily work
  sessions.
- Operators lose a clean boundary between "today's working context" and older
  Feishu history.

The existing `/new` quick command proves that switching the active Rudder
conversation for the same external Feishu chat is already a valid concept.
Daily rollover should productize that model with a time-based trigger.

## What Will Be Changed?

1. Feishu integrations get a small settings object:
   - `dailySessionRolloverEnabled`, default `true`
   - `dailySessionRolloverHours`, default `24`
   - `dailySessionRolloverNotifyFeishu`, default `true`

2. On Feishu inbound, Rudder resolves the active chat binding. If the active
   conversation was created at least 24 hours before the inbound event time,
   Rudder opens a new Feishu-bound Rudder conversation before appending the new
   inbound user message.

3. Rollover waits when the active conversation has an active or closing
   generation. The current inbound message remains in the current session so
   the user experience is not interrupted while a reply is still generating.
   The next inbound after the generation reaches a terminal state can roll over.

4. The previous session remains visible and read-only. It is not archived or
   deleted. Messenger may group related Feishu sessions by external chat and
   date so old sessions remain inspectable without crowding the loose thread
   list.

5. The new session stores continuity metadata and, when available, a concise
   previous-session summary. Summary generation should prefer the organization's
   Smart Intelligence profile. If Smart Intelligence is unavailable, Rudder
   falls back to the configured agent runtime. If both AI paths fail, rollover
   still succeeds with deterministic metadata.

6. When `dailySessionRolloverNotifyFeishu` is enabled, Rudder sends or returns
   the short text `New daily session started.` for the rollover acknowledgement.
   The setting is managed from the Agent Detail Feishu/Lark manage modal and is
   enabled by default.

## Success Criteria For Change

- A Feishu chat that is younger than 24 hours continues to append messages to
  the current bound Rudder conversation.
- A Feishu chat whose active Rudder conversation was created 24 or more hours
  earlier rolls over on the next inbound message, not before.
- The new inbound message lands in the new conversation.
- The previous conversation receives a system event recording the daily
  rollover, previous and next conversation ids, external chat id, and summary
  status.
- Rollover does not happen while an active generation is still running.
- `/new` continues to work and uses the same session-switching primitive.
- The Feishu/Lark manage modal exposes the rollover notification setting and
  persists it with default enabled behavior.
- Tests prove the lazy rollover, no-rollover while active generation is in
  progress, settings persistence, and UI toggle.

## Out Of Scope

- Creating new Feishu groups, channels, or external chats.
- Archiving old Rudder Feishu sessions automatically.
- Mirroring local Rudder fork messages back to Feishu.
- A complete branch graph or timeline UI for all Feishu sessions.
- Hard real Feishu long-connection validation in this proposal slice; mocked
  long-connection and DB-backed dispatcher tests are the implementation gate.

## Non-Functional Requirements

- **Usability:** The rollover is invisible during normal chatting. The optional
  Feishu notice is short and configurable.
- **Performance:** Rollover must be lazy and bounded. It must not scan or create
  conversations in the background.
- **Maintainability:** `/new` and automatic daily rollover should share one
  helper for switching bindings.
- **Reliability:** Failed summary generation must not block incoming Feishu
  messages.
- **Observability:** System-event payloads must record rollover reason, session
  window, summary source, and notification setting.

## User Experience Walkthrough

1. An operator connects a Feishu/Lark bot from Agent Detail Integrations.
2. In the manage modal, `Notify Feishu when a daily session starts` is enabled
   by default. The operator can turn it off for quieter Feishu chats.
3. A Feishu user chats with the bot. Rudder creates or uses today's
   Feishu-bound conversation.
4. More than 24 hours later, the same Feishu user sends another message.
5. If the previous session has no active reply generation, Rudder creates a new
   Feishu-bound Rudder conversation, points the external chat binding at it, and
   appends the new message there.
6. The previous session remains readable in Messenger with its Feishu badge and
   a system event saying a daily session started.
7. If notifications are enabled, Feishu receives `New daily session started.`
8. If the user sends while a previous reply is still generating, Rudder keeps
   that message in the current session. The next inbound after completion can
   roll over.

## Implementation

### Product Or Technical Architecture Changes

- Add `settings` JSON to `agent_integrations`.
- Extend shared types and validators with Feishu daily session settings.
- Add a patch route for updating an integration's settings.
- Centralize Feishu session switching in `inbound-dispatcher-db.ts`.
- Reuse that helper for `/new` and automatic daily rollover.
- Store previous-session summary or deterministic metadata on the rollover
  system event.

### Breaking Change

No external API breaking change is intended. Existing Feishu integrations get
default settings at read time.

There is a storage migration to add `agent_integrations.settings`.

### Design

The active session boundary is based on `chat_conversations.created_at`. The
rollover check uses the inbound event's `receivedAt` when present, otherwise
server time.

Rollover is evaluated after dedup and user binding, and before appending the
inbound message. That ordering prevents duplicate events from creating sessions
and ensures the first message after the 24-hour boundary lands in the new
session.

Pseudo-flow:

```text
resolve integration
resolve user binding
ensure chat binding
if regular inbound and active session age >= 24h:
  if active generation exists:
    keep current chat
  else:
    summarize previous session best-effort
    create next Feishu-bound conversation
    update binding to next conversation
    write rollover system event to previous session
append inbound user message to selected conversation
enqueue run/outbound as usual
```

Summary generation should be best effort:

1. Smart Intelligence profile.
2. Current agent runtime fallback.
3. Deterministic no-summary metadata.

### Security

No new external provider permissions are needed. The new settings route must
reuse board operator update permission for the owning agent and must remain
organization-scoped.

## What Is Your Testing Plan (QA)?

### Goal

Prove that daily rollover creates exactly the next needed Rudder conversation
at inbound time, preserves auditability, respects active generation state, and
persists the operator notification setting.

### Prerequisites

- DB-backed Feishu dispatcher tests with disposable organizations, agents,
  integrations, and Feishu inbound events.
- Agent Detail integration UI test fixtures.

### Test Scenarios / Cases

1. Lazy rollover after 24 hours:
   - seed a Feishu-bound conversation with an old `createdAt`
   - send a new inbound event
   - expect a new conversation, updated binding, previous-session system event,
     and the inbound message in the new conversation

2. No background rollover:
   - no inbound event means no new conversation is created
   - this is covered by making rollover only execute inside inbound dispatch

3. Active generation deferral:
   - seed an old session and active generation
   - send inbound
   - expect the message to remain in the current conversation

4. Notification setting:
   - default setting is enabled in summaries returned by the API
   - patching the setting persists and is reflected in the manage modal

5. `/new` regression:
   - existing `/new` tests continue to pass and still switch the binding

### Expected Results

All focused server and UI tests pass. The implementation landed in
`decfb8f45`, and the proposal is complete after implementation, verifier, and
review gates finished.

### Pass / Fail

Passed for the shipped slice:

- focused server and UI tests passed
- DB-backed Feishu dispatcher/runtime tests passed against a disposable local
  Postgres database
- TypeScript checks passed for `@rudderhq/db`, `@rudderhq/shared`,
  `@rudderhq/server`, and `@rudderhq/ui`
- `pnpm lint:changed` passed
- browser proof confirmed the Feishu/Lark manage modal exposes
  `Notify Feishu when a daily session starts` enabled by default

## Documentation Changes

If this implementation lands, guarded product docs should be updated with
explicit approval:

- `IM.FEISHU.001` for daily session rollover and settings behavior.
- `MESSENGER.CUSTOM.GROUPS.001` if automatic date grouping is implemented.
- `doc/product/registry.yml` traceability for related code/tests.

## Open Issues

- Exact Messenger grouping UX can be implemented after the backend session
  boundary is stable.
- Hard real Feishu validation requires an installed local Feishu app and live
  long-connection path; mocked DB-backed tests are the practical default for
  this slice.
