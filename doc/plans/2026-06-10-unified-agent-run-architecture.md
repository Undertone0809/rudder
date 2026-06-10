---
title: Unified agent run architecture
date: 2026-06-10
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - agent_runs
  - heartbeat_runs
  - wakeup_requests
  - chat_streaming
issue:
related_plans:
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-04-27-agent-run-concurrency.md
  - 2026-04-30-heartbeat-runtime-kernel-refactor.md
  - 2026-05-19-automation-chat-output.md
  - 2026-06-02-chat-native-automation-output.md
  - 2026-06-03-heartbeat-instructions-scene-gate.md
supersedes: []
related_code:
  - packages/db/src/schema/heartbeat.ts
  - packages/shared/src/types/heartbeat.ts
  - server/src/services/runtime-kernel/heartbeat.ts
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - server/src/services/chat-assistant.ts
  - server/src/routes/chats.stream-routes.ts
  - ui/src/pages/AgentDetail.runs.tsx
  - ui/src/pages/Chat.tsx
commit_refs: []
updated_at: 2026-06-10
---

# Unified Agent Run Architecture

## Overview

Rudder should treat `Agent Run` as the canonical execution audit entity for all
agent work. Scheduler heartbeats, issue execution, review wakeups, manual runs,
automation chat output, and ordinary Chat turns should all be represented as
bounded agent executions with one run identity, one runtime session, one log and
cost trail, and a clear target.

The first implementation should be a compatibility-preserving semantic
migration. Keep the current `heartbeat_runs` physical table while introducing
an `AgentRun` service/API/type facade and explicit run metadata. Do not start
with a table rename or foreign-key migration.

## What Is The Problem?

`heartbeat_runs` has outgrown its original name. It now carries runtime
execution state, queueing, process recovery, cost/log/session links, issue
execution locks, review wakeups, manual wakeups, automation wakeups, and UI run
history. Product copy already refers to "Agent Runs" in several places, but the
underlying services and routes still make most work look like a scheduler
heartbeat.

Chat has a related split. A Chat assistant turn is also an agent execution: it
has an agent identity, runtime config, scene-specific instructions, streamed
transcript, interruption state, cost, logs, and a user-visible result. Today
that execution is mostly represented through chat messages and streaming state
rather than through the same run audit surface used by issue and heartbeat
work.

The mismatch creates recurring product and engineering problems:

- operators cannot inspect all work for an agent from one run history;
- runtime code keeps using heartbeat language for non-heartbeat scenes;
- Chat turns cannot reliably deep-link to the same detail, trace, cost, retry,
  and cancellation surface as issue runs;
- automation `chat_output` has to bridge between automation records and Chat
  records without a unified execution identity;
- future architecture discussions keep confusing trigger/admission,
  execution, target, and scene.

## Target Concepts

### Agent Run

An `Agent Run` is one bounded agent execution. It answers:

- which organization and agent executed;
- why execution started;
- which scene contract was used;
- which target the run acted on;
- what runtime session, logs, transcript, trace, and cost were produced;
- how it finished.

This is the canonical audit identity, even while the first storage
implementation remains backed by `heartbeat_runs`.

### Wakeup Request

A `Wakeup Request` is an admission record. It explains why Rudder considered
starting an agent, but it is not the execution itself. A wakeup can be queued,
deferred, skipped, coalesced, failed before runtime launch, or bound to an
Agent Run.

Scheduler heartbeat is one wakeup source. Assignment, review, mention,
automation, manual action, retry, and process recovery are also wakeup sources.

### Run Target

A run target is the domain object the execution is for. Initial target types:

- `issue`: issue execution, issue follow-up, or reviewer work;
- `chat_conversation`: ordinary Chat assistant turn;
- `automation_run`: scheduled/manual automation execution;
- `review_request`: explicit review workflow when not represented by an issue
  reviewer run;
- `project`: project-scoped exploratory or maintenance run;
- `manual`: operator-triggered run without a durable domain target.

Target metadata should be explicit enough for filtering, navigation, and
authorization. It should not overload `issueId` or hide Chat runs in message
payloads.

### Scene

The scene defines the runtime prompt contract and terminal protocol. Examples:

- `heartbeat`: inbox-oriented issue/review work with heartbeat-only
  instructions;
- `chat`: Chat sentinel/JSON-result contract and streaming message surface;
- `issue_execution`: issue-focused execution when separated from generic
  heartbeat scheduling;
- `review`: review decision workflow;
- `automation`: automation-owned execution context.

`heartbeat` must stop meaning "all runs." It should mean scheduler heartbeat
or heartbeat scene only.

## What Will Be Changed?

### Phase 1: Semantic Facade And Metadata

- Keep the `heartbeat_runs` physical table.
- Introduce `AgentRun` naming in shared types, server services, API clients,
  and UI surfaces that represent execution history.
- Add or normalize explicit run metadata:
  - `scene`;
  - `triggerKind` or normalized wakeup source;
  - `targetType`;
  - `targetId`;
  - optional `conversationId`;
  - optional `messageId`;
  - optional `automationRunId`;
  - optional `wakeupRequestId`.
- Add `/agent-runs` API aliases while keeping existing `/heartbeat-runs`
  compatibility routes.
- Keep issue lock fields such as `checkoutRunId` and `executionRunId` pointing
  to the same underlying run record for issue execution.
- Update UI vocabulary:
  - Agent detail uses `Agent Runs` for execution history.
  - Heartbeats pages describe scheduler/timer state only.
  - Run detail labels scene, trigger, and target separately.

### Phase 2: Chat Turns Bind To Agent Runs

- Each assistant Chat turn creates or binds one Agent Run with `scene=chat` and
  `targetType=chat_conversation`.
- The user-visible assistant message remains the Chat result surface.
- Chat message lifecycle remains Chat-owned: `streaming`, `completed`,
  `failed`, `stopped`, and `interrupted` are not collapsed into run status.
- The run owns execution audit state: runtime process/session metadata, logs,
  cost, trace, cancel/retry handles, and final runtime status.
- `chat_messages` should carry a durable `runId` reference for assistant turns
  produced by a runtime.
- Chat process UI can deep-link to Agent Run detail for full transcript/log
  inspection.

### Phase 3: Automation And Review Alignment

- `automation_runs` remains the business scheduler/audit record for automation.
- A `chat_output` automation that executes through Chat gets an Agent Run with
  `targetType=automation_run` and linked Chat conversation/message references.
- A `track_issue` automation that creates issue work gets issue execution
  Agent Runs as today, but no longer needs heartbeat wording in product copy.
- Review wakeups become Agent Runs with review/issue target metadata instead
  of being inferred only from heartbeat invocation reason strings.

### Phase 4: Optional Storage Rename

Only after the semantic layer is stable, decide whether to rename the physical
table from `heartbeat_runs` to `agent_runs`. That migration should be separate,
mechanical, and low-risk:

- add database compatibility views or aliases where needed;
- migrate foreign keys and indexes deliberately;
- preserve API compatibility for external or plugin consumers;
- update events and activity payloads after consumers support both names.

## Success Criteria For Change

- Agent detail run history can show issue, chat, automation, review, manual,
  and scheduler-originated runs in one list.
- Operators can filter runs by scene, trigger, target type, and target object.
- A Chat assistant message can open its corresponding Agent Run detail.
- Run detail can navigate back to the Chat conversation/message, issue,
  automation run, or review target.
- Heartbeat scheduler controls and timer status no longer masquerade as the
  complete execution history product surface.
- Non-heartbeat scenes do not receive heartbeat-only instructions.
- Issue execution locking remains unchanged for issue targets and is not
  polluted by ordinary Chat runs.
- Existing integrations using heartbeat routes continue to work during the
  migration.

## Out Of Scope

- No first-step physical rename of `heartbeat_runs`.
- No removal of `automation_runs`; automation still needs its own business
  scheduling and recurrence record.
- No conversion of every Chat message into an issue.
- No broad redesign of Chat branching, approvals, or proposal payloads.
- No external plugin breaking change without a staged alias period.

## Non-Functional Requirements

- Maintainability: runtime code should use Agent Run vocabulary at the
  boundaries while preserving compatibility shims internally.
- Observability: all runtime logs, process metadata, transcript events, cost
  events, and traces should have one run id.
- Security: target references and Chat/message links must remain
  organization-scoped.
- Compatibility: old heartbeat route names and payload fields should remain
  readable until a deliberate API version cut.
- Usability: UI must present scene, trigger, and target as separate facts so
  operators can understand why a run happened.

## User Experience Walkthrough

1. An operator opens an agent.
2. The Runs tab shows all recent Agent Runs, including Chat turns, issue
   execution, review work, automation output, manual wakes, and timer
   heartbeat-originated runs.
3. The operator filters to `scene=chat`.
4. They open a failed Chat run and see runtime logs, streamed transcript,
   cost, selected project resources, and the linked assistant message.
5. From the same detail page they navigate back to the Chat conversation.
6. They filter to `trigger=scheduler` to inspect timer heartbeat behavior.
   This view now describes scheduler admission and timer state, not the whole
   run architecture.

## Implementation

### Product Or Technical Architecture Changes

- Add an Agent Run domain facade around the current heartbeat runtime kernel.
- Normalize run metadata during run creation rather than inferring it later
  from fragmented payloads.
- Make Chat runtime execution allocate an Agent Run before or at the same time
  as the assistant message enters `streaming`.
- Store the assistant message to run link durably.
- Update API/UI naming to consume Agent Run concepts while existing heartbeat
  names stay as compatibility aliases.

### Breaking Change

Phase 1 should introduce no intentional breaking change. Storage, existing
routes, existing issue lock fields, and old heartbeat payload shapes remain
compatible.

The optional physical table rename is a later breaking-risk migration and
requires its own plan.

### Design

The first implementation should prefer adapter/facade naming over a database
rewrite:

```ts
type AgentRunScene = "heartbeat" | "chat" | "issue_execution" | "review" | "automation";

type AgentRunTargetType =
  | "issue"
  | "chat_conversation"
  | "automation_run"
  | "review_request"
  | "project"
  | "manual";

interface AgentRun {
  id: string;
  orgId: string;
  agentId: string;
  scene: AgentRunScene;
  triggerKind: string;
  targetType: AgentRunTargetType;
  targetId: string | null;
  wakeupRequestId: string | null;
  conversationId: string | null;
  messageId: string | null;
  status: string;
}
```

The exact database columns can be narrower or staged, but the external product
contract should keep these separations intact.

### Security

This proposal introduces new cross-entity links between runs and Chat
messages. Server reads and writes must verify same-organization ownership for
every linked target. A run detail request should not reveal Chat, issue,
automation, or project metadata outside the caller's active organization.

## What Is Your Testing Plan (QA)?

### Goal

Prove that Agent Run becomes the unified execution audit surface without
breaking issue execution, heartbeat scheduling, Chat streaming, or automation
output.

### Prerequisites

- Local database migration state is current.
- Existing Chat, agent runtime, automation, and heartbeat tests pass in the
  baseline branch or have documented unrelated failures.

### Test Scenarios / Cases

- Server: issue assignment wakeup still creates an issue-targeted run and
  preserves issue lock behavior.
- Server: timer heartbeat preflight still skips no-op work and records wakeup
  status without creating an execution run.
- Server: Chat send creates an assistant message linked to an Agent Run.
- Server: Chat stop/interruption maps to both message lifecycle and run status
  without losing the ability to continue.
- Server: `chat_output` automation creates an automation run and a linked Chat
  Agent Run without creating a user-visible issue.
- API: `/agent-runs` aliases return the same compatible rows as existing
  heartbeat run routes.
- UI: Agent detail shows mixed run types and filters by scene/target.
- UI: Chat assistant message opens linked run detail and returns to the
  conversation.
- E2E: normal issue execution, ordinary Chat turn, and chat-output automation
  all produce inspectable Agent Runs.

### Expected Results

- Existing heartbeat routes and issue lock semantics remain green.
- Chat message status and run status remain distinct but linked.
- Operators can inspect all agent execution through one run history.
- Heartbeat wording is limited to scheduler/timer/heartbeat scene surfaces.

### Pass / Fail

Not run. This is an architecture proposal; implementation validation should be
filled in as the staged changes land.

## Documentation Changes

- Update `doc/SPEC-implementation.md` to rename the runtime execution contract
  from heartbeat-centric wording to Agent Run wording.
- Update product docs that describe Agent Runs, Chat execution, automation
  output, and heartbeat scheduling.
- Add migration notes for API/plugin consumers when `/agent-runs` aliases are
  introduced.

## Open Issues

- Decide whether Phase 1 stores new target metadata as explicit columns,
  context JSON fields, or a mixed staged approach.
- Decide whether `issue_execution` should be its own scene immediately or a
  target subtype under `heartbeat` until prompt contracts are split.
- Decide how much historical `heartbeat_runs` data should be backfilled for
  scene/target filters.
- Decide the final public deprecation window for `/heartbeat-runs` naming.
