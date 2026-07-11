---
title: Automation Output Routing
domain: automations
status: active
coverage: detailed
contract_ids:
  - AUTOMATION.OUTPUT.001
related_code:
  - server/src/services/automations.ts
  - server/src/services/automation-chat-output.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - ui/src/pages/AutomationDetail.tsx
related_tests:
  - server/src/__tests__/automations-service.test.ts
  - server/src/__tests__/automations-e2e.test.ts
  - tests/e2e/automation-chat-output-ambiguity.spec.ts
  - tests/e2e/chat-automation-create.spec.ts
edit_policy: user_confirmed_only
---

# Automation Output Routing

## AUTOMATION.OUTPUT.001

Why:

- Automation output determines whether repeated work becomes durable issue work
  or a chat-native result. The two modes have different audit, attention, and
  close-out contracts.

Tracked issue flow:

1. Dispatch creates an execution issue with automation origin metadata.
2. The issue is assigned according to automation assignee/context.
3. Assignment wake routes the agent into the normal issue work loop.
4. Automation run stores `linkedIssueId`.
5. Optional notify-created-issue behavior affects only the subscribed operator
   and does not mean everyone follows/pins the issue.

Chat output flow:

1. The create composer defaults custom automations to chat output while keeping
   tracked issue available as an explicit selectable alternative.
2. Each real automation execution run gets its own Messenger chat conversation.
3. `automation_runs.linkedChatConversationId` is the source of truth for the
   per-run conversation.
4. Rudder writes a chat-native user/input message that represents automation
   run input, then streams or records the assistant result.
5. The chat assistant turn is linked to Agent Run semantics when a runtime is
   invoked.
6. Failed chat output leaves visible partial/fallback evidence instead of
   silently creating an empty unread thread.

Invariants:

- `chat_output` must not reuse an arbitrary existing human chat as the sink for
  every future run.
- Coalesced or skipped runs must not create empty chat conversations.
- `track_issue` output enters normal issue/review/run contracts after issue
  creation.

Evidence:

- Automation detail links to created issue or chat.
- Service tests cover tracked issue and chat-output routing.
- E2E covers ambiguity where chat input could be misread as automation
  creation.
