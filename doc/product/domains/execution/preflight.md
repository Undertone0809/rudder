---
title: Preflight Gates
domain: execution
status: active
coverage: detailed
contract_ids:
  - RUN.PREFLIGHT.001
  - RUN.WORKSPACE.PREFLIGHT.001
related_code:
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/managed-workspace-preflight.ts
  - server/src/services/chat-assistant.ts
  - ui/src/components/AgentConfigForm.tsx
  - ui/src/components/agent-config-defaults.ts
related_tests:
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - server/src/__tests__/heartbeat-workspace-preflight.test.ts
  - server/src/__tests__/managed-workspace-preflight.test.ts
  - server/src/__tests__/chat-assistant.test.ts
  - tests/e2e/agent-config-advanced-options.spec.ts
edit_policy: user_confirmed_only
---

# Preflight Gates

Rudder has two product mechanisms that use the word "preflight". They protect
different boundaries and must not be collapsed into one concept.

- Timer preflight is a scheduling/admission gate. It decides whether a generic
  timer heartbeat should launch an agent runtime at all.
- Managed workspace preflight is an execution-safety gate. It verifies the
  local managed workspace paths needed by an agent run before the adapter is
  invoked.

## RUN.PREFLIGHT.001

Why:

- Timer heartbeats are intentionally cheap and frequent, but launching a local
  runtime when the agent has no visible work wastes tokens, process time, and
  operator attention.
- Rudder's product model is not "wake every agent on every timer"; it is "wake
  the agent when Rudder can point to work the agent can act on, or when there is
  an existing wakeup that should be recovered."
- The preflight gate keeps the timer loop aligned with the compact inbox and
  routing contracts. If the agent would immediately open Rudder and see no
  actionable assignee or reviewer work, a timer run should normally not start.

Scope:

- Applies only to timer wakeups with `source === "timer"`.
- Applies only when the agent heartbeat policy has `preflightEnabled` true.
- Applies only to generic timer wakeups that do not already carry an `issueId`.
- Does not gate assignment, comment mention, review, manual, chat, automation,
  or other on-demand wakes. Those follow `RUN.WAKEUP.001`,
  `RUN.ADMISSION.001`, and their source-specific routing contracts.

Operator control:

- The agent configuration UI exposes this as "Preflight before timer run".
- New agents default the setting on.
- The setting is stored under `runtimeConfig.heartbeat.preflightEnabled`; legacy
  `timerPreflightEnabled` is still read as a compatibility alias.
- Turning the setting off means timer heartbeats can launch a runtime even when
  no actionable Rudder work is currently visible. That is useful for special
  polling-style agents, but it is not the default team-work behavior.

Object model:

- `runtimeConfig.heartbeat.preflightEnabled`: per-agent switch that enables or
  disables timer preflight.
- Timer wakeup request: a due scheduler wake with `source: "timer"` and reason
  `heartbeat_timer`.
- Pending runless wakeup: an `agent_wakeup_requests` row for the same agent with
  status `queued` or `deferred_issue_execution`, no `runId`, and due
  `requestedAt`.
- Actionable assignee issue: an organization-scoped issue assigned to the agent
  in `todo`, `in_progress`, or `blocked`.
- Actionable reviewer issue: an organization-scoped issue where the agent is
  reviewer in `in_review` or `blocked`, excluding blocked reviewer work that
  already has a recorded blocked reviewer decision.
- Skipped preflight wakeup: an `agent_wakeup_requests` row with status
  `skipped`, no linked run, a preflight skip reason, optional diagnostics, and a
  finished timestamp.
- `heartbeat_runs`: created only when preflight admits or recovery promotes a
  run. A no-work timer skip does not create a run.
- `agents.lastHeartbeatAt`: updated after a skipped preflight so the timer
  scheduler records that the interval was checked.

Flow:

1. The heartbeat timer scheduler finds agents whose heartbeat interval has
   elapsed and calls wakeup with `source: "timer"` and reason
   `heartbeat_timer`.
2. Wakeup parses heartbeat policy. If timer heartbeat is disabled, it writes a
   skipped wakeup request with reason `heartbeat.disabled` and does not run
   preflight.
3. If timer heartbeat is enabled and preflight is enabled, wakeup first attempts
   timer recovery. Recovery can promote a pending runless wakeup, such as an
   issue-backed wake deferred by execution-lock pressure, instead of creating a
   new generic timer run.
4. If recovery does not produce a run, `evaluateTimerPreflight` reads pending
   runless wakeup requests for the agent with status `queued` or
   `deferred_issue_execution` whose `requestedAt` is due.
5. The gate checks for actionable assignee work in issue statuses `todo`,
   `in_progress`, and `blocked`.
6. If no assignee work exists, the gate checks for actionable reviewer work in
   statuses `in_review` and `blocked`, excluding blocked reviewer work that
   already has a recorded blocked reviewer decision.
7. If assignee work exists, preflight admits the timer wake with reason
   `assignee_issue`.
8. If reviewer work exists, preflight admits the timer wake with reason
   `reviewer_issue`.
9. If no actionable work exists but pending runless wakeups exist, preflight
   skips the generic timer wake with reason
   `heartbeat.preflight.pending_wakeup_request` and records diagnostics about
   pending wakeup count and statuses.
10. If no actionable work and no pending runless wakeups exist, preflight skips
    with reason `heartbeat.preflight.no_actionable_work`.
11. A skipped preflight writes an `agent_wakeup_requests` row with status
    `skipped`, does not create a `heartbeat_runs` row, does not invoke the
    runtime adapter, and marks `agents.lastHeartbeatAt` so the timer loop does
    not immediately retry the same no-work check.

Actionable-work definition:

- Assignee actionable work is organization-scoped issue work assigned to the
  agent in `todo`, `in_progress`, or `blocked`.
- Reviewer actionable work is organization-scoped issue work where the agent is
  reviewer in `in_review` or `blocked`, as long as a blocked reviewer decision
  has not already been recorded.
- The definition intentionally mirrors the agent inbox and reviewer-routing
  contracts. Hidden operating-layer rows should not wake a timer run that the
  agent cannot understand from its visible work list.

Skip and admit outcomes:

- `assignee_issue`: timer can launch because assigned work is visible.
- `reviewer_issue`: timer can launch because review work is visible.
- `heartbeat.preflight.pending_wakeup_request`: timer should not create a
  duplicate generic run while due runless wakeups already exist.
- `heartbeat.preflight.no_actionable_work`: timer should not launch because the
  agent has no current visible assignee or reviewer work.

Invariants:

- A skipped timer preflight is still an auditable wakeup outcome, not a silent
  no-op.
- Timer preflight must not consume, complete, or delete pending wakeups. It can
  recover/promote work through the timer-recovery path, or skip and record why.
- A no-work timer skip must not create a `heartbeat_runs` row.
- Turning preflight off is an explicit product escape hatch; it must not change
  non-timer wake semantics.

Evidence:

- `heartbeat.wakeup.ts` runs timer preflight only for timer wakes with
  preflight enabled and without an attached issue.
- `heartbeat.recovery.ts` owns `parseHeartbeatPolicy`,
  `markAgentHeartbeatChecked`, and `evaluateTimerPreflight`.
- `heartbeat-run-concurrency.test.ts` proves no-actionable-work skips, disabled
  preflight launching a runtime, assignee-work admission, reviewer-work
  admission, and pending-wakeup diagnostics.
- `agent-config-advanced-options.spec.ts` proves the UI exposes and persists
  the "Preflight before timer run" setting.

Related contracts:

- `RUN.WAKEUP.001`: owns wakeup request creation, source policy, and queueing.
- `RUN.ADMISSION.001`: owns issue execution locks after a wake has enough
  context to become issue-backed execution.
- `ROUTING.ATTENTION.001`: owns attention routing and references timer
  preflight's no-hidden-work principle.
- `AGENT.INBOX.001`: owns the agent-facing compact inbox that timer preflight
  intentionally mirrors.

Known gaps:

- The preflight reason is used internally for admission diagnostics, but the
  current operator-facing UI primarily exposes timer-skip evidence through
  wakeup history and agent heartbeat status rather than a dedicated preflight
  explainer. Run detail applies to execution preflight failures, not no-work
  timer skips, because those skips intentionally create no run.
- The skip path records pending wakeup diagnostics, but it does not currently
  provide a one-click repair action when repeated pending-wakeup skips reveal a
  stuck execution lock.

## RUN.WORKSPACE.PREFLIGHT.001

Why:

- Local agent runtimes depend on a managed workspace layout: agent home,
  instructions, memory, life, and skills directories.
- If those paths are missing, non-directories, or unwritable, invoking the
  adapter produces confusing runtime failures. The product should fail before
  adapter execution with an operator-actionable repair message.
- This gate protects run correctness and agent isolation. It is not deciding
  whether there is work to do; it is deciding whether Rudder can safely start
  the selected runtime process.

Scope:

- Applies during heartbeat run execution before adapter invocation.
- Applies during preferred-agent chat execution before attachments, prompt
  construction, and adapter invocation.
- Checks managed workspace paths derived from the runtime scene context.
- Does not replace timer preflight. A run may pass timer preflight and still
  fail workspace preflight if the local managed workspace is broken.

Object model:

- Managed workspace path set: `agent_home`, `instructions`, `memory`, `life`,
  and `skills`, resolved from the runtime scene context.
- Workspace configuration error: `managed_workspace_configuration_error`,
  emitted when Rudder built an empty required path before preflight.
- Workspace permission error: `workspace_permission_repair_needed`, emitted when
  a path cannot be created, verified as a directory, or write-probed.
- Temporary write probe: a per-check file created under each managed directory
  and removed before preflight returns.
- Failed run evidence: a failed `heartbeat_runs` row with preflight error code,
  failed wakeup status, and a `runtime.workspace_preflight_failed` run event.
- Operator display evidence: run-detail failure copy that labels workspace
  permission repair separately from generic adapter failure.

Flow:

1. Run or chat execution builds the runtime scene context, including the managed
   Rudder workspace paths.
2. `preflightManagedAgentWorkspace` expands the path set: `agent_home`,
   `instructions`, `memory`, `life`, and `skills`.
3. Each path must be configured. An empty path is a Rudder configuration error
   with code `managed_workspace_configuration_error`.
4. Each path is created recursively if missing.
5. Each path must stat as a directory.
6. Each path receives a temporary write probe file. The probe is removed after
   the check.
7. If every path passes, execution continues to prompt preparation and adapter
   invocation.
8. If any path fails mkdir, stat, or write probe, execution fails before the
   adapter starts with code `workspace_permission_repair_needed`.
9. Heartbeat-run failures persist a failed run, mark the wakeup failed, append a
   `runtime.workspace_preflight_failed` event with failure details, release
   issue execution, and avoid updating runtime session state as if the adapter
   had run.
10. Chat assistant execution wraps the same preflight in the active-run guard so
    unhandled preflight failures finalize the chat run rather than leaving it
    active.

Failure model:

- `managed_workspace_configuration_error` means Rudder failed to construct a
  required managed workspace path. This is a runtime bootstrap bug.
- `workspace_permission_repair_needed` means the managed path could not be
  created, verified as a directory, or written. This is usually repaired by
  fixing directory permissions or moving `RUDDER_HOME` to a writable location.
- Workspace preflight errors are classified separately from adapter failures so
  run detail can tell operators that the runtime did not actually start.

Invariants:

- Adapter execution must not begin until the managed workspace preflight passes.
- A workspace preflight failure must be visible as run evidence, not only server
  logs.
- A workspace preflight failure must not be normalized into a generic adapter
  failure.
- The write probe must be temporary and must not leave durable runtime content
  in the managed directories.

Evidence:

- `managed-workspace-preflight.ts` owns path expansion, directory creation,
  directory stat, write probe, and typed error construction.
- `heartbeat.execute.ts` calls workspace preflight before marking the runtime
  ready for adapter execution and records `runtime.workspace_preflight_failed`
  on failure.
- `chat-assistant.ts` runs the same workspace preflight before preferred-agent
  chat execution.
- `run-detail-display.ts` maps `workspace_permission_repair_needed` to
  operator-facing repair copy instead of generic run failure copy.
- `heartbeat-workspace-preflight.test.ts` proves failure happens before adapter
  execution and records a workspace preflight event.
- `managed-workspace-preflight.test.ts` proves directory creation and
  configuration/permission failure behavior.
- `chat-assistant.test.ts` proves preferred-agent chat runs after workspace
  preflight.
- `run-detail-display.test.ts` proves workspace permission preflight failures
  are labeled separately from agent/runtime failures.

Related contracts:

- `RUN.EXECUTION.001`: owns adapter invocation and run finalization after this
  preflight passes.
- `RUN.RESULT.001`: owns how preflight failure evidence is rendered through run
  events, error codes, and transcripts.
- `WORKSPACE.RUN.001`: owns execution workspace isolation and cleanup.
- `AGENT.INSTRUCTIONS.001`: depends on the instructions path being present
  before instruction files are prepared for the runtime.

Known gaps:

- The current check proves local filesystem writability, not semantic
  correctness of every file that will later be written into the workspace.
- Repair guidance is text-based. A future Desktop-native repair flow could make
  repeated permission failures easier for non-terminal users to resolve.
