---
title: Heartbeat Wakeups
domain: execution
status: active
coverage: seed
contract_ids:
  - RUN.WAKEUP.001
related_code:
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
  - server/src/services/runtime-kernel/heartbeat.ts
related_tests:
  - packages/shared/src/agent-run.test.ts
  - server/src/__tests__/heartbeat-paused-wakeups.test.ts
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
edit_policy: user_confirmed_only
---

# Heartbeat Wakeups

## RUN.WAKEUP.001

Behavior:

- `heartbeat.wakeup(agentId, opts)` is the historical compatibility admission
  entrypoint for timer, assignment, review, on-demand, and automation wakes.
  It may admit any Agent Run scene; it does not make every admitted run a
  Heartbeat Run in the product model.
- A Heartbeat Run is only `scene=heartbeat`: timer/self-check/periodic
  inspection, plus operator `Run heartbeat` manual trigger.
- Wakeup context is enriched and hydrated before queueing so issue, task,
  comment, and resume context are available to the run.
- Terminated and pending-approval agents are not invokable.
- Paused agents receive deferred wakeup requests instead of immediate runs.
- Timer wakes respect heartbeat enablement and timer preflight
  (`RUN.PREFLIGHT.001`).
- Non-timer wakes respect demand wake policy.
- Same-scope queued/running wakes coalesce when safe; comment mention follow-up
  wakes may queue behind a running same-scope run instead of being swallowed.
- Queued runs are started through `startNextQueuedRunForAgent`, respecting
  `maxConcurrentRuns`.

Invariant:

- Wakeup requests must leave durable `agent_wakeup_requests` records for queued,
  skipped, deferred, or coalesced outcomes.
- Wakeup admission must preserve the downstream Agent Run scene. Assignment,
  checkout, issue comment mention, and reopen wakes become Issue Runs; reviewer
  routing and review follow-up become Review Runs; automation dispatch becomes
  Automation Runs unless the run is explicitly issue/chat-scoped; timer and
  manual `Run heartbeat` become Heartbeat Runs.
- Budget-blocked wakes must not start runs.
- Pending deferred wakeups must not create duplicate runs for the same task
  scope.
- Only Heartbeat Runs load `RUDDER_AGENT_HEARTBEAT_INSTRUCTION`; issue, review,
  chat, and automation runs admitted through this compatibility path do not.

Rationale:

- Rudder needs one admission surface so timer, issue, review, chat, and
  automation triggers do not race into hidden duplicate agent work.
- Keeping the old entrypoint while deriving a product scene lets Rudder avoid a
  risky persistence-table rename and still prevent heartbeat-only instructions
  from leaking into task assignment, review, chat, or automation work.

Scene outcomes:

| Trigger | Product run scene | Instruction consequence |
| --- | --- | --- |
| Timer scheduler | Heartbeat Run | Load heartbeat instruction. |
| Operator `Run heartbeat` | Heartbeat Run with manual trigger detail | Load heartbeat instruction. |
| Task assignment or checkout wake | Issue Run | Do not load heartbeat instruction. |
| Issue follow-up or comment mention | Issue Run | Do not load heartbeat instruction. |
| Comment reopen wake | Issue Run with `issue_reopened_via_comment` | Do not load heartbeat instruction; reopen comment carries assignee wake mention when needed. |
| Reviewer route or review follow-up | Review Run | Do not load heartbeat instruction. |
| Automation dispatch | Automation Run unless issue/chat-scoped context overrides | Do not load heartbeat instruction. |

Related code:

- `server/src/services/runtime-kernel/heartbeat.wakeup.ts`
- `server/src/services/runtime-kernel/heartbeat.recovery.ts`
- `server/src/services/runtime-kernel/heartbeat.ts`
- `packages/shared/src/agent-run.ts`

Related tests:

- `packages/shared/src/agent-run.test.ts`
- `server/src/__tests__/heartbeat-paused-wakeups.test.ts`
- `server/src/__tests__/heartbeat-run-concurrency.test.ts`
