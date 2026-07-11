---
title: Agent Runs
domain: execution
status: active
coverage: seed
contract_ids:
  - RUN.AGENT.UNIFICATION.001
  - RUN.CHAT.AGENT.001
  - RUN.EXECUTION.001
related_code:
  - packages/db/src/schema/issues.ts
  - packages/shared/src/agent-run.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/runtime-kernel/heartbeat.sessions.ts
  - server/src/services/runtime-kernel/model-fallback.ts
related_tests:
  - packages/shared/src/agent-run.test.ts
  - packages/agent-runtime-utils/src/server-utils.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - ui/src/pages/AgentDetail.run-filters.test.ts
  - server/src/__tests__/heartbeat-observability.test.ts
  - server/src/__tests__/heartbeat-process-recovery.test.ts
  - server/src/__tests__/heartbeat-workspace-preflight.test.ts
  - tests/e2e/codex-model-order.spec.ts
edit_policy: user_confirmed_only
---

# Agent Runs

## RUN.AGENT.UNIFICATION.001

Why:

- Rudder historically stored executions in `heartbeat_runs`, but the product
  now treats issue, review, chat, automation, and heartbeat work as one
  operator-facing Agent Run model.
- The unified model prevents UI/API surfaces from re-learning old heartbeat
  naming and lets operators filter by scene, target, status, cost, and result.

Product model:

- `heartbeat_runs` remains the persistence table for compatibility.
- Agent Run is the product facade that derives scene, target type, target id,
  conversation id, message id, automation run id, issue id, and workspace
  context from run columns and context snapshots.
- Manual is a trigger detail, not a scene. For example, an operator clicking
  `Run heartbeat` creates `scene=heartbeat`, `source=on_demand`, and
  `triggerDetail=manual`.
- A Heartbeat Run is the specific Agent Run scene for timer/self-check work.
  Issue Run, Review Run, Chat Run, and Automation Run are Agent Runs but are
  not Heartbeat Runs in the product model.
- `/agent-runs` and Agent Detail Runs surfaces expose Agent Run terminology even
  when underlying routes still use heartbeat-compatible names.

Scene taxonomy:

| Scene | Product name | Trigger families | Primary target | Heartbeat instruction |
| --- | --- | --- | --- | --- |
| `heartbeat` | Heartbeat Run | Timer/self-check/periodic inspection, operator `Run heartbeat` manual trigger | Wakeup request or agent self-check scope | Loaded |
| `issue` | Issue Run | Task assignment, issue checkout, issue follow-up, issue comment mention, comment reopen wake | Issue/comment/task context | Not loaded |
| `review` | Review Run | Reviewer routing, changes-requested reviewer work, review follow-up after missing decision while issue remains `in_review` | Issue/review context | Not loaded |
| `chat` | Chat Run | Runtime-backed chat conversation turn | Chat conversation/message | Not loaded |
| `automation` | Automation Run | Schedule, manual/API/webhook automation trigger, automation dispatch | Automation run and optional linked issue/chat | Not loaded |

Compatibility mapping:

| Storage/API fact | Product interpretation |
| --- | --- |
| Physical table is `heartbeat_runs` | Compatibility persistence table for all Agent Runs until a future storage migration changes the table name. |
| `contextSnapshot.scene` or `contextSnapshot.rudderScene` | Explicit persisted scene override for compatibility records that already know the product job. |
| `invocationSource=timer` | Heartbeat Run. |
| `invocationSource=on_demand` and `triggerDetail=manual` without issue/chat/automation/review target | Operator-triggered Heartbeat Run. |
| `contextSnapshot.issueId` with assignment, checkout, comment, reopen, or issue follow-up context | Issue Run, even if legacy source is `automation` or another wake-compatible source. |
| `invocationSource=review` | Review Run, even when the target is an issue. |
| `invocationSource=chat` or `chatConversationId` | Chat Run. |
| `invocationSource=automation` or `contextSnapshot.automationRunId` without issue-scene override | Automation Run. |
| Historical `targetType=manual` | Legacy target compatibility only; it is not a scene and new no-target manual heartbeat runs should resolve to `wakeup_request`. |

Scene derivation precedence:

1. Use explicit persisted scene metadata first: `contextSnapshot.scene`, then
   `contextSnapshot.rudderScene`.
2. Chat identity wins next: `invocationSource=chat`, `chatConversationId`, or
   `contextSnapshot.conversationId`.
3. `invocationSource=review` maps to Review Run.
4. `invocationSource=timer` maps to Heartbeat Run.
5. `contextSnapshot.automationRunId` maps to Automation Run unless an explicit
   persisted scene above says otherwise.
6. `contextSnapshot.issueId` maps to Issue Run for assignment, checkout,
   comment, reopen, and issue follow-up work.
7. `invocationSource=automation` maps to Automation Run.
8. Remaining no-target compatibility records map to Heartbeat Run.

This precedence means an automation dispatch linked to an issue remains an
Automation Run when `automationRunId` is the owning target, while a
comment/assignment wake that entered through automation-compatible plumbing can
still resolve as an Issue Run through explicit scene metadata or issue context.

Flow:

1. A timer/self-check, issue route, review route, chat turn, or automation
   dispatch creates a run record.
2. Execution stores scene and target context in the run snapshot.
3. Shared conversion code maps the stored run to the Agent Run shape.
4. Agent Detail and run filters present scene and target facts to the operator.
5. Transcript/result pages link back to the originating target where possible.
6. Runtime instruction loading uses the derived scene: only `scene=heartbeat`
   receives `RUDDER_AGENT_HEARTBEAT_INSTRUCTION`.

Invariants:

- The facade must not erase source-specific identity. A chat run remains tied to
  its conversation/message; an automation run remains tied to its
  `automation_runs` record; an issue run remains tied to issue execution.
- The scene must describe the product job, not the historical admission path.
  Task assignment, issue checkout, issue comment mention, and reopen wakes are
  issue runs even when they enter through heartbeat-compatible wakeup code.
- Review follow-up is reviewer-scoped review work, not issue implementation
  work.
- Compatibility naming must not leak into product copy when the UI is describing
  the unified run model.
- Heartbeat-only instruction text must not be loaded into issue, review, chat,
  or automation runs.

Evidence:

- Agent run list can filter/display scenes.
- Run detail exposes linked target context.
- Shared type conversion is the single place for facade semantics.
- Prompt metrics and adapter command notes show heartbeat instruction only for
  heartbeat scene runs.

Related code:

- `packages/shared/src/agent-run.ts`
- `server/src/routes/agents.management-routes.ts`
- `server/src/services/runtime-kernel/heartbeat.execute.ts`
- `ui/src/pages/AgentDetail.runs.tsx`

Related tests:

- `packages/shared/src/agent-run.test.ts`
- `packages/agent-runtime-utils/src/server-utils.test.ts`
- `server/src/__tests__/codex-local-execute.test.ts`
- `server/src/__tests__/heartbeat-workspace-preflight.test.ts`
- `ui/src/pages/AgentDetail.run-filters.test.ts`
- `ui/src/pages/AgentDetail.runs.test.ts`
- `tests/e2e/agent-runs-filter-menu.spec.ts`

## RUN.CHAT.AGENT.001

Why:

- Chat is an intake and lightweight execution surface. When a chat assistant
  turn invokes a runtime, it must be inspectable as a run rather than buried
  inside a message stream.

Flow:

1. A user sends a chat message to a runtime-backed agent.
2. Rudder creates an Agent Run with chat scene and conversation target.
3. Only one active run should own a conversation turn at a time.
4. Runtime output must end with the Rudder chat result sentinel. If the primary
   runtime output has useful text but is missing that sentinel, Rudder may run an
   internal same-adapter repair call marked as chat result repair.
5. When repair succeeds, Rudder persists the repaired assistant message as the
   successful chat result, combines primary and repair usage, and records repair
   evidence on the run result.
6. When repair is not attempted or fails, Rudder records a failed chat result
   with any safe partial body and structured failure metadata.
7. If the adapter exits before Rudder observes any model-output evidence,
   Rudder classifies the failed chat result as a runtime boot failure:
   `chat_runtime_boot_failed`, `phase: "runtime_boot"`,
   `action: "repair_runtime"`, and `retryable: false`. Messenger shows this as
   a runtime-unavailable failure and does not offer an immediate Retry action,
   because the operator needs to fix the runtime command or environment first.
8. If the adapter fails after Rudder observes model-output evidence but before a
   successful final chat result, Rudder classifies the failed chat result as a
   model-generation failure: `chat_adapter_failed`,
   `phase: "model_generation"`, `action: "retry"`, and retryable by default.
   Messenger may show a Retry action for that failed assistant response.
9. If the operator stops an in-flight chat run before completion, Rudder marks
   the run cancelled and may return only the assistant text that was already
   streamed as user-visible content. Provider reasoning, scratchpad/thinking
   events, and incomplete adapter result summaries must not be used as the
   stopped chat bubble body.
10. The assistant message stores a reverse link to the run.
11. Agent Detail Run context and Messenger can navigate between run evidence and
   chat transcript.

Invariants:

- A chat-native run is not an issue-backed run unless the workflow explicitly
  converts or proposes tracked issue work.
- Chat run audit must preserve conversation and message identity.
- Internal repair prompts, repair protocol text, and repair transcript logs must
  not be surfaced as normal assistant chat content.
- Stopped chat runs must not turn provider reasoning/thinking transcript entries
  or incomplete runtime summaries into user-visible assistant message bodies.
- Missing-result-sentinel repair is only for recovering a runtime response that
  otherwise completed successfully. Timeout, nonzero exit, adapter error, or
  malformed result JSON remain failed chat outcomes.
- Repaired successful runs must preserve evidence that repair occurred, including
  `sentinelRepairAttempted`, `sentinelRepairSucceeded`, and
  `repairReason: "missing_result_sentinel"`.
- Runtime boot failures are not recoverable by chat retry alone. They must
  preserve `recoverable: false`, `retryable: false`, `phase: "runtime_boot"`,
  and `action: "repair_runtime"` in the failed assistant message payload and
  run result evidence.
- Model-generation failures after visible model output remain retryable failed
  chat outcomes and must preserve `phase: "model_generation"` and
  `action: "retry"` when Rudder can classify that phase.

Evidence:

- Chat assistant messages expose run attribution.
- Agent Detail Run context can open the source conversation.
- Chat assistant tests cover missing-result-sentinel repair, persisted repair
  metadata, stopped-run partial body filtering, runtime boot failure
  classification, retryable model-generation failures, and primary/repair usage
  aggregation.
- Chat route tests cover persisted non-retryable runtime boot failure payloads.
- Chat UI tests cover runtime-unavailable failed messages without Retry actions.
- Chat streaming E2E covers a missing-result-sentinel turn recovering into a
  succeeded assistant message without exposing the internal protocol failure.
- Chat runtime boot failure E2E covers the real Messenger UI, failed assistant
  payload, runtime-unavailable label, and absent Retry action.

Related code:

- `server/src/services/chat-agent-runs.ts`
- `server/src/services/chat-assistant.ts`
- `server/src/services/chat-assistant.helpers.ts`
- `server/src/routes/chats.ts`
- `server/src/routes/chats.stream-routes.ts`
- `ui/src/pages/AgentDetail.chat-context.tsx`
- `ui/src/pages/Chat.parts.tsx`
- `ui/src/pages/Chat.messages.tsx`

Related tests:

- `server/src/__tests__/chat-agent-runs.test.ts`
- `server/src/__tests__/chat-assistant.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `tests/e2e/agent-detail-chat-run-context.spec.ts`
- `tests/e2e/chat-error-toast.spec.ts`
- `tests/e2e/chat-runtime-boot-failure.spec.ts`
- `tests/e2e/chat-streaming.spec.ts`

## RUN.EXECUTION.001

Behavior:

- `executeRun(runId)` claims queued runs before execution and exits early for
  non-active runs.
- The run resolves the agent, runtime state, issue context, task session,
  execution workspace, project resources, runtime config, enabled runtime
  skills, and scene context before invoking the adapter.
- Running state is written to the agent and published as a live event.
- Runtime services and execution workspaces are realized before adapter
  invocation when configured.
- Supported local adapters receive a local agent JWT as `RUDDER_API_KEY` when
  the adapter supports it and the secret is available.
- For an issue-backed run, persisted assignee runtime overrides are eligible
  only when the issue's current `assigneeAgentId` still matches the running
  agent. A missing issue, unassigned issue, or reassignment makes the old
  assignee-specific override ineligible.
- Runtime config precedence is agent config, then workspace-managed config,
  then the eligible issue assignee runtime config. An issue override replaces
  only the supplied top-level runtime fields, so unrelated agent/workspace
  settings remain available to the adapter.
- The adapter is invoked through model fallback support so configured fallback
  runtimes/models can attempt execution.
- Final outcome is derived from cancellation, timeout, adapter result, and
  forbidden runtime skill marker detection.

Invariant:

- Adapters do not mutate Rudder DB state directly; the heartbeat executor
  records the result, logs, events, usage, sessions, and run status.
- Agent status must be finalized after a terminal run outcome.
- An override created for one assignee must never follow the issue to another
  assignee or affect runs that are not backed by that issue.

Rationale:

- The execution domain must make agent work inspectable and resumable while
  keeping runtime-specific behavior behind adapter contracts.
- Assignee matching prevents stale tuning from silently changing a replacement
  agent's runtime, while issue-last precedence makes the operator's explicit
  one-job choice effective for the intended run.

Related code:

- `packages/db/src/schema/issues.ts`
- `server/src/services/runtime-kernel/heartbeat.execute.ts`
- `server/src/services/runtime-kernel/heartbeat.sessions.ts`
- `server/src/services/runtime-kernel/model-fallback.ts`

Related tests:

- `server/src/__tests__/heartbeat-observability.test.ts`
- `server/src/__tests__/heartbeat-process-recovery.test.ts`
- `server/src/__tests__/heartbeat-workspace-preflight.test.ts`
- `tests/e2e/codex-model-order.spec.ts`
