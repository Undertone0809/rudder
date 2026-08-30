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
  - packages/shared/src/chat-transcript-provenance.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/services/chat-inline-annotations.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/runtime-kernel/heartbeat.sessions.ts
  - server/src/services/runtime-kernel/model-fallback.ts
  - ui/src/components/side-panel/RunFeedbackChatPanel.tsx
related_tests:
  - packages/shared/src/agent-run.test.ts
  - packages/shared/src/chat-transcript-provenance.test.ts
  - server/src/services/chat-assistant.annotations.test.ts
  - server/src/services/chat-inline-annotations.test.ts
  - packages/agent-runtime-utils/src/server-utils.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - ui/src/pages/AgentDetail.run-filters.test.ts
  - server/src/__tests__/heartbeat-observability.test.ts
  - server/src/__tests__/heartbeat-process-recovery.test.ts
  - server/src/__tests__/heartbeat-workspace-preflight.test.ts
  - tests/e2e/codex-model-order.spec.ts
  - tests/e2e/agent-run-conversation-grouping.spec.ts
  - ui/src/components/side-panel/RunFeedbackChatPanel.test.tsx
  - tests/e2e/run-transcript-detail.spec.ts
related_plans:
  - doc/plans/2026-07-24-org-skill-runtime-materialization-fix.md
  - doc/plans/2026-08-03-openclaw-hermes-runtime-compatibility-refresh.md
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
- `AgentRunOrigin` is the canonical allowlisted provenance projection shared by
  API and Messenger surfaces. It includes normalized scene/trigger and routing
  identifiers only; it never exposes the raw context snapshot.
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

Trigger-kind derivation precedence:

1. Use explicit `contextSnapshot.triggerKind` when present.
2. Issue comment identity or wake markers resolve to `issue_comment`.
3. Review, timer, and on-demand manual sources resolve to `review_routing`,
   `timer`, and `manual` respectively.
4. Otherwise use `triggerDetail`, falling back to `invocationSource`.

All consumers use this shared normalization rather than interpreting raw run
snapshots independently.

Flow:

1. A timer/self-check, issue route, review route, chat turn, or automation
   dispatch creates a run record.
2. Execution stores scene and target context in the run snapshot.
3. Shared conversion code maps the stored run to the Agent Run shape.
4. Agent Detail and run filters present scene and target facts to the operator.
5. After run filtering and sorting, Agent Detail groups runs with the same
   normalized conversation identity into one navigation entry. The selected
   member remains the representative when present; otherwise the first matching
   run in the current sort order represents the group.
6. Transcript/result pages link back to the originating target where possible.
7. Runtime instruction loading uses the derived scene: only `scene=heartbeat`
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
- Conversation grouping is a navigation projection only. It must not merge run
  identity, status, transcript, result, or retry evidence. Its count reflects
  the members that match the current filters, including when a selected member
  is retained outside those filters.
- Heartbeat-only instruction text must not be loaded into issue, review, chat,
  or automation runs.

Evidence:

- Agent run list can filter/display scenes.
- Run detail exposes linked target context.
- Agent Detail shows one navigation entry per normalized conversation while
  `Chat Replies` continues to open each individual run.
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
- `tests/e2e/agent-run-conversation-grouping.spec.ts`

## RUN.CHAT.AGENT.001

Why:

- Chat is a conversation-driven execution surface. When a chat assistant turn
  invokes a runtime, it must be inspectable as a run rather than buried inside
  a message stream.

Flow:

1. A user sends a chat message to a runtime-backed agent.
2. If the user message owns response annotations, Rudder projects an ordered,
   bounded user-quote section under `CHAT.RESPONSE.ANNOTATION.001`. Selected
   text is explicitly untrusted quoted context rather than system instruction;
   comments retain operator authorship and annotation file metadata preserves
   its quote association. Process selections retain generation-event
   provenance under `RUN.RESULT.001`. Side Panel file selections retain their
   source path as untrusted user context; this prompt projection does not grant
   the runtime or server new filesystem authority.
3. Rudder creates an Agent Run with chat scene and conversation target.
4. Only one active run should own a conversation turn at a time.
5. Runtime output must end with the Rudder chat result sentinel. If the primary
   runtime output has useful text but is missing that sentinel, Rudder may run an
   internal same-adapter repair call marked as chat result repair.
6. For ordinary message results, every registered built-in adapter carries the
   same bounded Chat prompt and normalized final body. When that body contains a
   v1 inline visual under `CHAT.INLINE.VISUAL.001`, Rudder suppresses fragment
   source before any visible transcript/event/result projection and publishes it
   only after successful final-result normalization.
7. When repair succeeds, Rudder persists the repaired assistant message as the
   successful chat result, combines primary and repair usage, and records repair
   evidence on the run result.
8. When repair is not attempted or fails, Rudder records a failed chat result
   with any safe partial body and structured failure metadata.
9. If the adapter exits before Rudder observes any model-output evidence,
   Rudder classifies the failed chat result as a runtime boot failure:
   `chat_runtime_boot_failed`, `phase: "runtime_boot"`,
   `action: "repair_runtime"`, and `retryable: false`. Messenger shows this as
   a runtime-unavailable failure and does not offer an immediate Retry action,
   because the operator needs to fix the runtime command or environment first.
10. If the adapter fails after Rudder observes model-output evidence but before a
   successful final chat result, Rudder classifies the failed chat result as a
   model-generation failure: `chat_adapter_failed`,
   `phase: "model_generation"`, `action: "retry"`, and retryable by default.
   Messenger may show a Retry action for that failed assistant response.
    A failure while preparing an installed skill or runtime file before the
    adapter starts is distinct from a missing/broken provider runtime:
    `chat_runtime_preparation_failed`, `phase: "runtime_boot"`,
    `action: "retry"`. Rudder surfaces only a sanitized skill identity and the
    canonical `SKILL.md` filename when known; it never derives arbitrary
    filenames, paths, query values, or credentials from raw exception text.
    After the operator repairs the local skill, Retry creates a new generation.
11. Each runtime-backed turn starts as an ownerless pending generation while
   Rudder performs legitimate run preparation. The fenced runtime-control
   owner, attempt epoch, control version, and lease are established only when
   the adapter attempt actually takes control. Steer and Stop actions target
   that expected generation and attempt rather than whichever process is
   current when the request eventually arrives.
12. A Steer accepted by a native interactive runtime is submitted to that same
    provider turn. When native Steer is unavailable, Rudder interrupts the old
    attempt and starts one server-owned feedback continuation only after the old
    owner reaches a safe terminal boundary.
13. If the operator stops an in-flight chat run, including a feedback turn
    started from an Agent Run annotation Side Panel, Rudder first commits the
    visible-output cutoff and then interrupts the runtime. The feedback panel
    fences the action to the observed generation, attempt, control version, and
    rendered-body checkpoint; it stages stream events until the server accepts
    or rejects that cutoff and reads back terminal state before leaving the
    stopping state. The stopped message may contain only the accepted assistant
    prefix at that cutoff. Provider reasoning, late deltas, final output, and
    incomplete summaries remain diagnostic evidence and cannot change the
    visible result.
14. Runtime terminal evidence is projected through a retryable outbox so the
    generation, Agent Run, assistant message, queue item, and control action
    converge. Retry exhaustion must release active ownership and preserve an
    actionable failure rather than blocking later turns indefinitely.
15. The assistant message stores a reverse link to the run. The conversation
    menu opens the newest linked Agent Run, and Agent Detail Run context links
    back to Messenger. Within a conversation group, `Chat Replies` opens each
    individual attempt without duplicating the group in Agent Runs navigation.
16. A run-backed failed assistant message can open its exact attributed Agent
    Run directly, independent of the conversation's newest run. Chat omits
    the action when it cannot resolve both the message run id and agent
    identity, so it does not render a dead run link.
17. For an external runtime, the Chat workstream maps to an opaque
    organization/Agent/conversation session record and an upstream run ID. Stop
    uses the provider's run-scoped cancellation when the capability snapshot
    advertises it, freezes the Rudder-visible cutoff first, and waits for
    provider terminal reconciliation. A managed-process fallback or
    `cancel_unverified` outcome remains explicit; closing a whole provider
    session is never presented as run cancellation.
18. Direct Chat follows the same tool-bearing continuity contract as Issue
    workstreams. OpenClaw reuses its mapped provider session. Hermes continues
    from the Rudder-owned canonical transcript and sends a bounded
    `RUDDER_TOOL_CONTEXT_V1` projection when the upstream text-only history
    surface requires it. Within the declared projection bounds, tool calls,
    results, structured content, and approvals do not force a reset.
19. Hermes approval requests are durable governed actions. Rudder presents
    only the V1 `once` and `deny` choices, records the actor decision or
    timeout, and sends only a capability-advertised approval response. Hermes
    `session` and `always` grants are not ordinary approval responses; they
    require a separately named, audited runtime-policy change with explicit
    authorization. Unsupported or unsafe approval states fail closed rather
    than silently enabling broader authority.

Invariants:

- A chat-native run is a first-class task run. It is not issue-backed unless the
  operator explicitly creates or links structured issue work.
- Chat run audit must preserve conversation and message identity.
- Internal repair prompts, repair protocol text, and repair transcript logs must
  not be surfaced as normal assistant chat content.
- Selected annotation text cannot override system/developer policy and must not
  be interpolated into trusted prompt instructions. Annotation comments and
  files remain bounded user context; logs and metrics may record annotation
  counts/source ids but not quoted text, comments, visible Thinking, file
  contents, or temporary paths.
- Stopped chat runs must not turn provider reasoning/thinking transcript entries
  or incomplete runtime summaries into user-visible assistant message bodies.
- Inline visual fragment source is private presentation input. Stop, timeout,
  adapter failure, repair, transcript projection, and client-event replay must
  not expose or persist it as visible Chat/run text.
- Once a Stop cutoff is accepted, no callback, final result, projector retry,
  reconnect, or page reload may admit later bytes into the chat-visible body or
  result summary.
- A control action is idempotent by durable action ID. Retrying the same exact
  Stop or Steer must resolve the original action; it must not target a newer
  attempt or create a second continuation.
- Stale-owner recovery applies only to a generation that has entered
  lease-managed starting/running execution. It must not reclaim an ownerless
  generation during valid preprocessing, even when preparation exceeds the
  lease duration. Retrying a terminal `control_lost` generation creates a new
  generation and control record.
- Browser closure and server restart must not strand accepted Steer feedback.
  Provider-acceptance ambiguity remains explicit and must not trigger blind
  duplicate delivery.
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
- External provider cancellation is scoped to the exact Agent Run attempt and
  upstream run/session identity. A provider acknowledgement is not a terminal
  cancellation; Rudder remains `stopping` until terminal evidence or an honest
  timeout/indeterminate outcome is recorded.
- Hermes tool/approval history projected into Chat is quoted, bounded, escaped,
  redacted, and hash-linked evidence. It is labeled
  `synthetic_tool_continuity`, never native or lossless, and projection failure
  blocks the later turn instead of silently dropping causal records.

Evidence:

- Chat assistant messages expose run attribution.
- The Chat conversation menu exposes a stable Agent Runs action that opens the
  newest linked attempt and remains disabled while loading or before any run
  exists.
- Agent Detail Run context can open the source conversation.
- Chat assistant tests cover missing-result-sentinel repair, persisted repair
  metadata, stopped-run partial body filtering, runtime boot failure
  classification, retryable model-generation failures, and primary/repair usage
  aggregation.
- Annotation prompt tests cover ordered bounded quote projection, explicit
  untrusted/user-quote labeling, comment/file association, prompt-injection
  containment, and the exclusion of raw annotation payload serialization.
- Chat route tests cover persisted non-retryable runtime boot failure payloads.
- Chat generation protocol and route tests cover fenced Steer, immutable Stop
  cutoff, startup Stop, terminal replay, output admission, projector recovery,
  and server-owned continuation delivery.
- Chat UI tests cover runtime-unavailable failed messages without Retry actions.
- Chat streaming E2E covers a missing-result-sentinel turn recovering into a
  succeeded assistant message without exposing the internal protocol failure.
- Chat runtime boot failure E2E covers the real Messenger UI, failed assistant
  payload, runtime-unavailable label, and absent Retry action.
- Chat concurrent-streaming E2E covers native Steer, fallback continuation,
  immediate Stop, Stop-then-Steer, and browser-independent queue delivery.
- Run annotation feedback UI and Run Transcript Detail E2E cover the Side Panel
  Stop action, fenced cutoff request, late-event suppression, terminal
  readback, and continued draft/conversation identity.

Related code:

- `server/src/services/chat-agent-runs.ts`
- `server/src/services/chat-assistant.ts`
- `server/src/services/chat-assistant.helpers.ts`
- `server/src/services/chat-inline-annotations.ts`
- `packages/shared/src/chat-transcript-provenance.ts`
- `server/src/services/chat-generation-locks.ts`
- `server/src/services/chat-generation-protocol.ts`
- `server/src/services/chats.ts`
- `server/src/routes/chats.ts`
- `server/src/routes/chats.stream-routes.ts`
- `ui/src/pages/AgentDetail.chat-context.tsx`
- `ui/src/pages/Chat.parts.tsx`
- `ui/src/pages/Chat.messages.tsx`
- `ui/src/components/side-panel/RunFeedbackChatPanel.tsx`

Related tests:

- `server/src/__tests__/chat-agent-runs.test.ts`
- `server/src/__tests__/chat-assistant.test.ts`
- `server/src/services/chat-assistant.annotations.test.ts`
- `server/src/services/chat-inline-annotations.test.ts`
- `packages/shared/src/chat-transcript-provenance.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `server/src/services/chat-generation-locks.test.ts`
- `server/src/services/chat-generation-protocol.test.ts`
- `tests/e2e/agent-detail-chat-run-context.spec.ts`
- `tests/e2e/chat-error-toast.spec.ts`
- `tests/e2e/chat-runtime-boot-failure.spec.ts`
- `tests/e2e/chat-streaming.spec.ts`
- `tests/e2e/chat-concurrent-streaming.spec.ts`
- `tests/e2e/chat-options-menu.spec.ts`
- `tests/e2e/chat-response-annotations.spec.ts`
- `tests/e2e/agent-run-conversation-grouping.spec.ts`
- `ui/src/components/side-panel/RunFeedbackChatPanel.test.tsx`
- `tests/e2e/run-transcript-detail.spec.ts`

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
- Assignment and automation Runs share a bounded tool-failure guardrail. A Run
  checkpoints after three identical failures, 25 unresolved tool operations,
  or 100 total tool failures. A successful result resolves only the matching
  tool operation; unrelated successful reads do not erase prior failures.
- A guardrail checkpoint may request one Agent-guided continuation after a
  one-second backoff. Rudder never blindly replays the failed tool call. A
  context-drift failure is eligible only when the failed patch reports an
  explicit context-mismatch signature. A transient failure is eligible only
  when the canonical tool contract proves the tool read-only. Invalid requests,
  command failures, unclassified failures, canonical mutations, and unknown
  tools fail closed because recovery or side effects may be indeterminate.
- Rudder actively schedules an eligible continuation after its backoff, with
  the periodic recovery loop retained as a crash fallback. Until the recovery
  request is durably queued, terminal text describes only eligibility. A failed
  enqueue records a request-failed event and leaves the original terminal
  output path intact. Queueing the recovery Run and suppressing the source
  automation output commit atomically, so a process exit cannot lose both.
- An existing retry can satisfy the handoff only when its persisted context
  proves that it is the same bounded recovery attempt. An unrelated retry is
  rejected and cannot suppress the source output.
- When an automation continuation is queued, the source Run does not publish
  its recoverable failure to Chat. The linked recovery Run publishes the single
  final outcome, preventing premature failure and duplicate automation output.
- Guardrail events record the failure class and counts, the single recovery
  request with its backoff and linked Run, and the recovery Run's terminal
  result. Exhausted or unsafe recovery leaves actionable error text naming the
  failure class, attempted recovery, and next operator action.
- Recovery-result recording is an idempotent terminal effect, so succeeded,
  failed, cancelled, and timed-out continuations all update the source Run even
  when the recovery never enters adapter execution.
- Final outcome is derived from cancellation, timeout, adapter result, and
  forbidden runtime skill marker detection.
- Operator cancellation is scoped to the exact Agent Run ID supplied by the
  calling workflow. Cancelling an active queued or running Run may transition
  it to `cancelled`; an already-terminal Run remains in its existing terminal
  status so callers can report that cancellation did not occur.
- For `openclaw_gateway` or `hermes_gateway`, execution revalidates the
  authenticated connection against the supported upstream version/protocol and
  capability matrix before creating provider work. It records the capability
  snapshot used by the attempt and refuses an unverified or changed endpoint.
- Workspace-dependent external work requires a deterministic binding to the
  resolved project/organization/Agent workspace. An attached process without
  that proof is blocked with an actionable remediation; managed mode starts or
  restarts only the recorded provider process in that workspace.
- Provider submission carries the Rudder attempt identity and an idempotency
  key when the upstream supports one. If a side-effecting submission response is
  indeterminate, the run records `submission_indeterminate` and does not retry
  automatically.
- Hermes Run execution persists the Rudder canonical workstream transcript
  hash and the exact bounded `RUDDER_TOOL_CONTEXT_V1` projection metadata used
  for the turn. V1 bounds the projection at 200 events, 64 KiB UTF-8 per event,
  512 KiB UTF-8 aggregate, and a conservative 32,000-token estimate.
  Projection is atomic: unsafe, corrupt, or over-budget history blocks the turn
  before provider submission.
- For Hermes Issue, reviewer, and direct Chat workstreams,
  `synthetic_tool_continuity` is the default supported continuity mode. Within
  the declared bounds, ordinary tool calls, tool results, structured content,
  and approval events do not force a session reset. The mode is explicitly not
  native or lossless Hermes history.

Invariant:

- Adapters do not mutate Rudder DB state directly; the heartbeat executor
  records the result, logs, events, usage, sessions, and run status.
- Agent status must be finalized after a terminal run outcome.
- An override created for one assignee must never follow the issue to another
  assignee or affect runs that are not backed by that issue.
- An external attempt must not execute when readiness, organization binding,
  process identity, or workspace binding is stale or unproven. A connection
  probe alone cannot authorize a later Run after the endpoint or process
  changes.
- Rudder generates idempotency and mapping keys. Upstream Run/session IDs are
  accepted only from the authenticated adapter response and stored in
  organization/Agent/workstream-scoped mappings; arbitrary IDs copied from
  another Agent or organization are rejected.
- A lost provider submission response is never converted into a duplicate
  upstream Run by an automatic retry.
- Tool-failure recovery remains finite across assignment and automation: the
  lifetime cap cannot be reset, only one continuation is allowed, and an
  indeterminate mutation or unclassified tool failure cannot authorize that
  continuation.
- A caller must not present an unchanged succeeded, failed, or timed-out Run as
  successfully cancelled. Recovery UI may restore its prior input only after
  the exact target Run returns `cancelled`.
- Hermes continuity records must retain causally required tool/approval pairs,
  source transcript hash, projection version, and the exact 200-event,
  64 KiB/event, 512 KiB aggregate, and 32,000-token bounds. Dropping a tool
  result to fit a limit is not a valid continuation.

Rationale:

- The execution domain must make agent work inspectable and resumable while
  keeping runtime-specific behavior behind adapter contracts.
- Assignee matching prevents stale tuning from silently changing a replacement
  agent's runtime, while issue-last precedence makes the operator's explicit
  one-job choice effective for the intended run.
- Exact-target cancellation prevents a corrective action for one request from
  stopping another Run owned by the same Agent, while unchanged terminal
  status gives the caller enough evidence for honest failure feedback.

Related code:

- `packages/db/src/schema/issues.ts`
- `server/src/services/runtime-kernel/heartbeat.execute.ts`
- `server/src/services/runtime-kernel/heartbeat.misc.ts`
- `server/src/routes/agents.management-routes.ts`
- `server/src/services/runtime-kernel/heartbeat.sessions.ts`
- `server/src/services/runtime-kernel/model-fallback.ts`

Related tests:

- `server/src/__tests__/heartbeat-observability.test.ts`
- `server/src/__tests__/heartbeat-process-recovery.test.ts`
- `server/src/__tests__/heartbeat-workspace-preflight.test.ts`
- `server/src/services/runtime-kernel/assignment-run-guardrail.test.ts`
- `tests/e2e/codex-model-order.spec.ts`
- `tests/e2e/agent-run-cancel.spec.ts`
- `tests/e2e/new-issue-agent-creation.spec.ts`
