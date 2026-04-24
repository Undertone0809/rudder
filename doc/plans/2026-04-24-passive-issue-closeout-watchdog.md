---
title: Passive issue closeout watchdog
date: 2026-04-24
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - issue_execution
  - issue_closeout_watchdog
  - heartbeat_runs
issue:
related_plans:
  - 2026-02-20-issue-run-orchestration-plan.md
  - 2026-04-08-paused-wakeup-replay-and-comment-context.md
  - 2026-03-14-budget-policies-and-enforcement.md
supersedes: []
related_code:
  - server/src/services/heartbeat.ts
  - server/src/services/issues.ts
  - server/src/routes/issues.ts
  - packages/db/src/schema/issues.ts
  - packages/shared/src/constants.ts
commit_refs:
  - "docs: add passive issue closeout watchdog proposal"
updated_at: 2026-04-24
---

# Passive Issue Closeout Watchdog

## Overview

Rudder already has durable issue ownership, issue execution locking, deferred
issue wake promotion, and heartbeat runs. That gives the platform a strong
execution loop, but it still leaves one important gap at the end of each
issue-scoped run.

Today a run can finish cleanly while the linked issue still remains in `todo` or
`in_progress`. If the agent forgot to leave a final comment, forgot to mark the
issue `blocked`, forgot to move the issue into `in_review`, or simply exited
without a clear closing mutation, the durable work object is left in an open
state without a reliable continuation path.

This proposal adds a bounded recovery mechanism called the **Passive Issue
Closeout Watchdog**. After an issue-scoped run finishes, the system performs a
post-run reconciliation. If the issue is still open and there is no reliable
continuation already queued, the system launches a low-budget closeout-focused
heartbeat attempt for the assignee agent. The goal is not to blindly rerun the
original task. The goal is to force the issue into a legible state: completed,
blocked, in review, handed off, or explicitly continued with durable progress.

If three consecutive passive closeout attempts still leave the issue in `todo`
or `in_progress` without accepted progress, the system automatically marks the
issue `blocked`, records a structured reason, and escalates the issue to a human
operator surface.

The core product guarantee becomes:

> An assigned issue must not silently remain in `todo` or `in_progress` after an
> issue-scoped run ends unless the platform can point to a reliable continuation.

## What Is The Problem?

### Current state

Rudder already enforces important control-plane invariants around issue
execution:

- only one active execution owner per issue via `issues.executionRunId`
- deferred wakeup promotion when another issue-scoped wake arrives during an
  active run
- activity logs and issue lifecycle routes for durable work mutation
- agent heartbeats as the execution engine

That solves concurrency and wakeup correctness, but it does not solve closeout
correctness.

### Problem

When an issue-scoped run terminates, Rudder currently guarantees that the run is
finished. It does **not** yet guarantee that the issue has been brought to a
truthful durable state.

This causes a repeated failure pattern:

1. An issue is assigned to an agent.
2. A heartbeat run starts and does meaningful work.
3. The run ends.
4. The issue is still `todo` or `in_progress`.
5. No queued run, deferred wake, approval wait, or structured blocker exists.
6. The issue now looks active, but is effectively stranded.

This happens for several reasons:

- the agent forgets to write a final comment before exit
- the agent completes the work but forgets to set `done`
- the agent hits a blocker but forgets to set `blocked`
- the run fails or times out after doing partial work
- active timer heartbeats are disabled, so no later nudge ever arrives
- a prompt or runtime path exits early without performing closeout mutations

### Impact

The impact is larger than a cosmetic stale status.

- **Durable work loses truthfulness.** The issue no longer reflects the real
  state of the work.
- **Ownership becomes ambiguous.** The issue is still assigned, but no actor is
  actually carrying the baton.
- **Board visibility degrades.** Operators cannot easily distinguish “still
  being worked” from “forgotten after last run.”
- **North-star completion quality drops.** Rudder may count successful runs, but
  not successful end-to-end work loops.
- **Human follow-up cost increases.** Operators must manually inspect and chase
  issues that should have been automatically closed out or explicitly blocked.

The first-principles problem is not “the system needs more heartbeats.” The
problem is that Rudder lacks an issue-level **closeout guarantee** after run
termination.

## What Will Be Changed?

This proposal introduces six concrete changes.

### 1. Add post-run issue reconciliation

After every issue-scoped heartbeat run reaches a terminal run status, the system
will run a reconciliation step that evaluates the linked issue.

That reconciliation will answer four questions:

1. Is the issue still assigned to an agent?
2. Is the issue still in `todo` or `in_progress`?
3. Is there already a reliable continuation path?
4. If not, should the system start or advance a closeout watchdog?

### 2. Add a new internal watchdog object

Introduce a durable watchdog record for issue closeout recovery.

Suggested table:

- `issue_closeout_watchdogs`

Suggested fields:

- `id`
- `org_id`
- `issue_id`
- `assignee_agent_id`
- `status` (`active | resolved | exhausted | cancelled`)
- `attempt_count`
- `last_outcome` (`resolved | progress | no_progress | hard_failure`)
- `last_observed_run_id`
- `last_observed_issue_status`
- `last_progress_at`
- `next_check_at`
- `resolution_reason`
- `created_at`
- `updated_at`

Use a unique partial constraint so only one active watchdog can exist per issue.

### 3. Add passive closeout heartbeat attempts

When reconciliation finds an open issue without a reliable continuation, Rudder
will enqueue a closeout-focused wake for the assignee agent.

This should reuse the existing heartbeat run machinery with an internal wake
shape, for example:

- `invocationSource: "automation"`
- `triggerDetail: "system"`
- `reason: "issue_closeout_watchdog"`
- context snapshot flag such as `closeoutMode: "passive_issue_closeout"`

The prompt contract for this run should be narrow. The agent is not asked to
“start the issue over.” It is asked to reconcile the issue and must do one of
these things:

- mark the issue `done`
- mark the issue `blocked` with a blocker explanation
- move the issue to `in_review` with review context
- hand the issue off or release it with a clear reason
- create a follow-up issue and narrow the current one
- leave the issue in `todo` or `in_progress` only if it also writes durable,
  specific, accepted progress plus a concrete continuation path

### 4. Define reliable continuation explicitly

The watchdog should **not** trigger merely because timer heartbeats are off. It
should trigger only when the issue lacks a reliable continuation.

Initial accepted continuation signals should include:

- `issues.executionRunId` points to a `queued` or `running` heartbeat run
- an `agent_wakeup_requests` row exists in `deferred_issue_execution` for the
  same issue
- an `agent_wakeup_requests` row exists in `deferred_agent_paused` for the same
  issue and same assignee agent
- the issue has been reassigned or unassigned since the observed run ended
- the issue has already left `todo` / `in_progress`
- the issue is explicitly waiting on an approval or other governed gate that the
  platform can point to durably

This is an issue-level guarantee, not an agent-config guarantee.

### 5. Add bounded retry and exhaustion behavior

A watchdog may launch at most **three consecutive passive closeout attempts**
without accepted progress.

Failure should be counted in two buckets:

- `hard_failure`: the passive run itself failed, timed out, hit a runtime error,
  or could not be invoked
- `no_progress`: the passive run completed but left the issue in `todo` or
  `in_progress` without a status change, blocker, review handoff, durable
  artifact, or reliable continuation

Progress resets exhaustion risk. Three consecutive failures exhaust the
watchdog.

On exhaustion the system must:

- set the issue status to `blocked`
- clear stale execution ownership if still present
- write a structured activity entry
- write a system-authored issue comment explaining the auto-block
- notify a human-visible surface

### 6. Add structured visibility

The system should emit explicit issue activities such as:

- `issue.closeout_watchdog_started`
- `issue.closeout_watchdog_attempted`
- `issue.closeout_watchdog_progress_detected`
- `issue.closeout_watchdog_exhausted`
- `issue.auto_blocked`

These events should be tied to the issue and, where possible, to the passive
heartbeat run that produced them.

## Success Criteria For Change

This proposal is successful when all of the following are true.

### Product and behavior

- An assigned issue no longer silently strands in `todo` or `in_progress` after
  an issue-scoped run ends without either:
  - a reliable continuation, or
  - an explicit closeout outcome.
- Passive closeout does not create concurrent duplicate recovery runs for the
  same issue.
- Exhausted recovery attempts produce a visible, durable `blocked` state instead
  of endless retries.

### Operator experience

- An operator can inspect an issue and understand whether it was recovered,
  still actively continuing, or auto-blocked by the watchdog.
- Human-visible traces exist in issue comments and activity history.

### Engineering and verification

- The behavior is covered by automated heartbeat/issue orchestration tests.
- The behavior is covered by at least one end-to-end issue workflow test.
- The implementation preserves current issue-execution lock semantics and
  deferred promotion behavior.

### Metrics to watch after rollout

- reduced count of stranded assigned issues with no active run
- reduced mean time between issue-run termination and truthful issue state
- low false-positive watchdog trigger rate
- high recovery rate on first passive closeout attempt

## Out Of Scope

This proposal intentionally does **not** do the following.

- It does not guarantee that the agent always finishes the underlying task.
- It does not turn passive closeout into an unbounded background worker.
- It does not redesign the issue status model.
- It does not add a generic stalled-work scanner for all issues in the system.
- It does not replace active timer heartbeats.
- It does not redesign approval waiting, budget policy, or manual pause policy,
  though those states influence watchdog suppression.
- It does not promise a dedicated new Messenger product surface in the first
  implementation pass.

## Non-Functional Requirements

### Performance

- Reconciliation must be constant-bounded and keyed by `issue_id` / `run_id`.
- The watchdog must not fan out repeated scans across the entire issue table.
- Passive closeout attempts should use a smaller execution budget than ordinary
  work runs.

### Scalability

- Only issue-scoped terminal runs should trigger reconciliation.
- The watchdog object must be indexable by `issue_id`, `status`, and
  `next_check_at` for efficient scheduling.

### Availability

- A failed passive attempt must not wedge issue execution.
- Recovery bookkeeping must survive process restart because the watchdog is a
  durable object, not an in-memory timer.

### Security

- No new public HTTP surface is required in the first pass.
- Passive closeout must respect the same organization scoping and permission
  boundaries as ordinary issue mutations.
- Closeout mode must avoid repeating high-risk external side effects unless the
  agent explicitly determines a continuation run is required.

### Maintainability

- The design should reuse existing heartbeat run infrastructure instead of
  building a second run executor.
- The watchdog should be represented by a dedicated service module rather than
  scattering retry logic across multiple finalize branches.
- Progress detection should begin with a conservative allowlist of durable
  signals rather than heuristics based on generated text alone.

### Observability

- Every watchdog attempt should leave an issue-level activity record.
- Exhaustion should be queryable without reading freeform comments.
- Passive closeout runs should be identifiable in run detail and internal
  tracing.

### Usability

- Operators should see why the issue was auto-blocked and what to do next.
- The closeout comment should be short, plain, and action-oriented.

## User Experience Walkthrough

### Scenario A: normal issue completion

1. An assigned agent works on an issue.
2. The issue-scoped run finishes.
3. The issue is already `done` or `in_review`.
4. Post-run reconciliation sees no action is needed.
5. No watchdog is created.

Result: normal path stays unchanged.

### Scenario B: agent forgets to close out

1. An assigned agent works on an issue.
2. The run finishes successfully.
3. The issue is still `in_progress`.
4. There is no queued run, no deferred wake, and no governed wait state.
5. Rudder creates or advances a closeout watchdog.
6. Rudder enqueues a passive closeout heartbeat.
7. The agent wakes in closeout mode, reviews the issue, and marks it `done`
   with a short result summary.
8. The watchdog resolves and writes activity.

Result: the platform fixes the missing closeout without human intervention.

### Scenario C: agent is actually blocked but forgot to say so

1. An assigned agent exits a run after partial work.
2. The issue remains `todo`.
3. No continuation exists.
4. Passive closeout wakes the agent.
5. The agent recognizes the blocker and marks the issue `blocked` with a blocker
   comment.
6. The watchdog resolves.

Result: the issue is no longer silently stranded. It is durably blocked.

### Scenario D: passive closeout makes no progress

1. An assigned issue run ends.
2. The issue remains open with no continuation.
3. Rudder launches passive closeout attempt 1.
4. The run exits without meaningful progress.
5. Rudder schedules attempt 2.
6. Attempt 2 also leaves no accepted progress.
7. Rudder schedules attempt 3.
8. Attempt 3 also fails or makes no progress.
9. Rudder auto-blocks the issue, records a structured reason, and surfaces the
   event to a human-visible channel.

Result: the issue ends in a truthful, inspectable state instead of floating
forever in `todo` or `in_progress`.

## Implementation

### Product Or Technical Architecture Changes

Add a new issue-closeout layer around existing heartbeat orchestration.

Suggested components:

1. **Post-run reconciler**
   - invoked after an issue-scoped run reaches a terminal heartbeat status
   - evaluates the linked issue after issue execution release/promotion logic has
     settled
2. **Closeout watchdog service**
   - owns watchdog record lifecycle
   - decides whether to create, advance, resolve, cancel, or exhaust a watchdog
3. **Passive closeout enqueue path**
   - reuses the existing heartbeat wake/run infrastructure
   - adds closeout-specific context and reason metadata
4. **Visibility layer**
   - writes issue comments and activity entries
   - optionally emits a Messenger-facing event in a later or minimal fallback
     path

The important sequencing rule is:

- do not evaluate for passive closeout until the current run has finished and
  issue execution promotion for deferred wakes has already been attempted

That prevents the watchdog from racing against existing `deferred_issue_execution`
promotion.

### Breaking Change

No public API, storage, or runtime breaking change is required for the first
implementation pass.

The proposal adds internal orchestration behavior and likely a new internal
watchdog table plus new activity actions.

### Design

#### 1. Trigger point

The trigger should be attached to the terminal issue-run path in
`server/src/services/heartbeat.ts`.

High-level flow:

```ts
onIssueScopedRunTerminal(run) {
  releaseIssueExecutionAndPromote(run);
  evaluateIssueCloseoutAfterRun(run);
}
```

`evaluateIssueCloseoutAfterRun(run)` should:

1. load the linked issue from `run.contextSnapshot.issueId`
2. exit if no issue exists or issue ownership moved away from the observed agent
3. exit if issue status is not `todo` or `in_progress`
4. exit if a reliable continuation exists
5. create or update an active watchdog record
6. enqueue a passive closeout attempt if the watchdog is eligible

#### 2. Reliable continuation rules

The watchdog must be suppressed when the system can already explain why the
issue is still open.

Recommended first-pass continuation checks:

- `issues.executionRunId` references a `queued` or `running` run
- a deferred issue wake exists for the same issue
- a paused deferred wake exists for the same issue and assignee
- the issue is now assigned to someone else or no longer assigned to the run's
  agent
- the issue is in an explicit governed wait state that the platform can point to
  durably

This means the watchdog is triggered by lack of continuity, not by lack of a
scheduled timer heartbeat.

#### 3. Passive closeout run contract

The passive closeout run should carry explicit context fields such as:

- `issueId`
- `closeoutMode: "passive_issue_closeout"`
- `closeoutWatchdogId`
- `closeoutAttempt`
- `closeoutMaxAttempts`
- `closeoutParentRunId`
- `closeoutTrigger: "issue_left_open_after_run"`

The run prompt should instruct the agent to do one of the following before exit:

- close the issue as `done`
- move it to `in_review`
- mark it `blocked`
- create a handoff or follow-up and reduce the current issue scope
- explicitly write durable progress and create a continuation path

The prompt should also say:

- do not repeat expensive or externally visible side effects unless continuation
  is clearly required
- closeout quality is more important than more exploration

#### 4. Accepted progress model

“Still `in_progress`” should not automatically count as failure if the passive
attempt produced real durable progress.

First-pass accepted progress should be conservative and machine-detectable.
Suggested signals:

- issue status leaves `todo` / `in_progress`
- the run writes a new issue comment with a concrete blocker, review summary, or
  explicit next step
- the run creates or updates issue-linked work products or documents
- the run creates a child or follow-up issue linked to the current issue
- the run creates a reliable continuation path that the system can point to
- the run performs a handoff or assignment change

Avoid using only freeform “I made progress” text as the success signal.

#### 5. Failure accounting

Track two failure classes:

- `hard_failure`
  - passive closeout run could not complete because of timeout, runtime failure,
    tool failure, budget hard-stop, or another invocation problem
- `no_progress`
  - passive closeout run completed but the issue is still open without accepted
    progress or a continuation signal

The watchdog should exhaust after **three consecutive failures**.

Progress should reset the streak.
Human intervention should cancel or reset the watchdog.

#### 6. Exhaustion behavior

When the watchdog exhausts:

- update the issue to `blocked`
- clear stale execution ownership fields if needed
- create an issue comment such as:
  - the system attempted passive closeout three times
  - the issue remains open without accepted progress
  - the issue was auto-blocked to prevent silent abandonment
  - recommended next action
- write a structured issue activity event
- mark the watchdog `exhausted`

Recommended structured details:

- `blockedBy: "issue_closeout_watchdog"`
- `attemptCount`
- `lastObservedRunId`
- `lastObservedIssueStatus`
- `lastOutcome`
- `recommendedNextAction`

#### 7. Notification and escalation

The first implementation should prefer existing durable surfaces over inventing a
large new notification subsystem.

Recommended escalation order:

1. issue comment and issue activity always
2. human creator or participants see the issue as updated through existing issue
   feeds
3. if no direct human participant exists, surface the exhaustion through an
   existing Messenger system surface such as failed-runs, or add a small scoped
   follow-up for issue-attention events

This keeps V1 honest without forcing a broad notification redesign inside the
same change.

#### 8. Concurrency and idempotency

The implementation must preserve current issue-execution invariants.

Rules:

- at most one active watchdog per issue
- at most one passive closeout attempt queued/running per issue at a time
- watchdog creation/evaluation should run under issue-scoped transactional
  checks or equivalent locking
- use an idempotency key such as `issue-closeout:{issueId}:{attempt}` when
  enqueuing closeout work
- assignee change, unassignment, cancellation, or issue resolution should cancel
  the active watchdog

#### 9. Budget policy

Passive closeout attempts should run with a smaller budget profile than ordinary
issue work.

Recommended defaults:

- shorter timeout
- smaller token budget
- no expansive tool loops by default
- safe read/write actions allowed: issue read, issue comment, issue status
  change, follow-up issue creation, handoff

If additional real work is needed, the passive attempt should create a clear
continuation rather than becoming a long-running substitute for the normal issue
run.

### Security

No new third-party dependency is required.

No new external network trust boundary is required.

The main safety concern is repeated side effects. The mitigation is to constrain
closeout mode, keep it low-budget, and bias it toward issue mutation and
reporting rather than arbitrary repeated execution.

## What Is Your Testing Plan (QA)?

### Goal

Prove that issue-scoped runs cannot silently strand assigned issues in `todo` or
`in_progress` without either a continuation path or a visible closeout outcome.

### Prerequisites

- seeded org with at least one agent and one assignable issue
- existing heartbeat orchestration tests available
- issue lifecycle and activity assertions available
- passive closeout enabled behind an internal feature flag if rollout is staged

### Test Scenarios / Cases

#### Service and orchestration tests

- run ends with issue already `done` -> no watchdog created
- run ends with issue `in_progress` and deferred issue wake exists -> no
  watchdog created
- run ends with issue `in_progress` and no continuation -> watchdog created and
  passive attempt enqueued
- passive attempt moves issue to `blocked` -> watchdog resolves
- passive attempt moves issue to `in_review` -> watchdog resolves
- passive attempt writes accepted progress plus new continuation -> watchdog does
  not exhaust
- passive attempt hard-fails three times -> issue auto-blocked
- passive attempt no-progress three times -> issue auto-blocked
- assignee changes while watchdog active -> watchdog cancels

#### Route and activity tests

- issue activity log shows watchdog start/attempt/exhaust events
- issue detail shows system-authored auto-block comment after exhaustion
- blocked issue retains correct organization scoping and mutation audit trail

#### End-to-end tests

- agent forgets closeout after issue run; system recovers and moves the issue to
  a truthful state
- agent repeatedly fails to close out; system auto-blocks and leaves human-
  visible evidence

### Expected Results

- no duplicate passive closeout runs are created for the same issue
- current deferred issue promotion behavior remains intact
- the final issue state is always explainable from durable system records
- exhausted issues stop retrying automatically

### Pass / Fail

- Proposal stage only.
- Implementation verification not yet run.
- Final pass/fail must be filled during implementation handoff after automated
  coverage is added and executed.

## Documentation Changes

If this proposal is accepted, the following docs should be updated during
implementation:

- `doc/SPEC-implementation.md`
  - clarify the issue closeout guarantee after issue-scoped run termination
- `server/resources/bundled-skills/rudder/SKILL.md`
  - reinforce exit expectations for active work and blocked work
- `server/resources/bundled-skills/rudder/references/api-reference.md`
  - only if any public issue/run behavior changes become externally visible
- relevant run/issue operator docs if a new visible recovery label or issue
  activity surface is added

## Open Issues

1. Should budget-paused or approval-paused work suppress the watchdog entirely,
   or should those states actively convert open issues to `blocked` in a later
   pass?
2. Should notification reuse the existing failed-runs Messenger surface for V1,
   or should Rudder add a dedicated issue-attention system thread kind?
3. What is the minimum accepted-progress allowlist that is strict enough to
   prevent fake progress but broad enough not to penalize long tasks?
4. Should human comments or board edits automatically reset watchdog attempt
   counters, or only cancel the current watchdog?
5. Should passive closeout be feature-flagged at org level for staged rollout,
   or shipped as an unconditional control-plane guarantee?
