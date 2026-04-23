---
title: Issue passive follow-up governance
date: 2026-04-20
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - issue_closure_governance
  - passive_issue_followup
  - heartbeat_runs
issue:
related_plans:
  - 2026-02-20-issue-run-orchestration-plan.md
  - 2026-04-07-agent-prompt-context-injection.md
  - 2026-04-08-paused-wakeup-replay-and-comment-context.md
supersedes: []
related_code:
  - server/src/services/runtime-kernel/heartbeat.ts
  - server/src/services/issues.ts
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/src/onboarding-assets/default/HEARTBEAT.md
  - server/src/onboarding-assets/ceo/HEARTBEAT.md
  - ui/src/pages/IssueDetail.tsx
commit_refs:
  - docs: propose issue passive follow-up governance
updated_at: 2026-04-23
---

# Issue Passive Follow-Up Governance

## Overview

Add a platform-owned issue closure governance layer so issue-backed agent runs
do not silently end in an unfinished and uncommunicated state.

The proposal does not turn every non-terminal issue into an automatic retry.
Instead, it introduces an explicit same-agent follow-up path that only activates
when a run ends without a sufficient closure signal and no normal timer
heartbeat is already responsible for continuity.

This keeps Rudder aligned with its existing principles:

- agents should be accountable for the full work loop, not only the first chunk
- recovery must stay explicit and auditable
- issue execution concurrency must remain centralized in orchestration

Inference:

- `issue_closure_governance` and `passive_issue_followup` are new stable entity
  names minted for this proposal because no existing taxonomy entry cleanly
  covered this reliability gap

## Recommended First-Cut Decisions

This proposal should stop being treated as an open-ended direction only.
The first implementation pass should make these default decisions explicit:

- trigger on `missing_closure`, not on "issue is still open" alone
- treat `issue done`, `issue block` with explanation, post-checkout progress
  comment, and explicit handoff comment as closure-sufficient signals
- suppress passive follow-up when timer heartbeat is effectively expected to
  continue the issue soon enough in normal cadence
- keep passive follow-up same-agent only and bounded
- after max attempts, emit an operator-visible review signal instead of
  mutating the issue to `blocked`
- distinguish passive follow-up from runtime recovery in storage, prompts, UI,
  and activity history

These defaults are opinionated on purpose.
Without them, the feature risks collapsing into a vague "retry if issue open"
mechanism that would overfire and muddy task semantics.

## What Is The Problem?

Current behavior mixes two different concepts:

- an issue still being open because the work legitimately spans multiple runs
- an issue being left hanging because the agent exited without proper closure

Rudder already instructs agents to communicate before exit:

- the bundled `rudder` skill requires `issue comment`, `issue done`, or
  `issue block`
- onboarding heartbeat checklists tell agents to comment on `in_progress` work
  before exit

But this is only a prompt-level expectation.
The platform does not currently enforce an issue-level post-run closure check.

That creates a reliability gap:

- assignment wake starts one issue-backed run
- the run does useful work, but forgets to update the issue
- if the agent has no timer heartbeat configured, there may be no later wake to
  repair the missing close-out
- the board sees a `todo` or `in_progress` issue with incomplete audit trail and
  no guaranteed continuation

The system already has strong orchestration primitives:

- issue execution lock on `issues.executionRunId`
- deferred issue wakeups
- explicit retry / recovery runs for runtime failures

So the missing piece is not another general scheduler.
It is a governance rule for deciding when a completed run failed to close the
issue loop well enough.

## What This Is Not

This proposal is not:

- a generic auto-retry policy for all unfinished work
- a substitute for timer heartbeat scheduling
- a silent reassignment system
- a rule that "open issue means broken run"
- a reason to auto-mark an issue `blocked`

`blocked` is a workflow statement about the work itself.
`missing_closure` is a governance statement about the run's failure to leave a
clear close-out trail.
Those should remain separate concepts.

## What Will Be Changed?

- Define a new post-run evaluation concept: `closure signal`
- Define a failure category: `missing_closure`
- Add a same-agent queued wake reason: `issue_passive_followup`
- Trigger that follow-up only when all of the following are true:
  - the run is issue-backed
  - the run ended in a terminal state that is not already handled by explicit
    recovery policy
  - the issue remains in a non-terminal workflow state
  - the run did not emit a sufficient closure signal
  - the agent does not already have an enabled timer heartbeat that is expected
    to continue the issue normally
- Reuse the existing issue execution lock and deferred wakeup promotion flow so
  passive follow-up never creates concurrent execution on the same issue
- Make the follow-up visible in run history, activity, and wake reason metadata
- Add stop conditions so the mechanism cannot loop forever
- Emit a review-needed attention signal after the bounded follow-up budget is
  exhausted without closure

## Success Criteria For Change

- Issue-backed runs no longer disappear without either:
  - a closure signal, or
  - a visible passive follow-up queued by the platform
- Passive follow-up stays same-agent only; no silent reassignment is introduced
- Operators can distinguish:
  - normal multi-run work
  - explicit failure recovery
  - closure-gap follow-up
- No issue ever gains more than one active execution owner because of this
  feature
- Repeated no-op passive follow-ups stop after a bounded number of attempts and
  surface an operator-visible escalation state
- Issue workflow semantics remain clean:
  `blocked` still means real blocker, not "automation gave up chasing close-out"

## Out Of Scope

- silent business-logic retries for every failed run
- automatic reassignment to a different agent
- changing the issue workflow model itself
- redesigning timer heartbeat configuration UI
- solving general long-running planning cadence for idle agents
- replacing prompt guidance in the bundled `rudder` skill

## Non-Functional Requirements

- maintainability:
  - the mechanism must reuse current heartbeat orchestration instead of adding a
    second scheduler path
  - closure evaluation should be deterministic and testable from stored run and
    issue state
- observability:
  - passive follow-up must have explicit run reason, activity entries, and UI
    labeling distinct from recovery retry
  - terminal stop conditions must be visible, not swallowed
- usability:
  - operators should understand why a follow-up was queued
  - issue detail should show whether the platform believes the issue is still
    waiting for close-out rather than generic "another heartbeat happened"
- performance:
  - post-run evaluation should use already-known run + issue metadata and avoid
    expensive full transcript analysis in the critical path
- safety:
  - bounded retries, cooldown, and same-agent-only rules must prevent runaway
    token burn or hidden self-healing behavior

## User Experience Walkthrough

### Case A: Legitimate completion

1. An issue assignment wakes the agent.
2. The agent checks out the issue, does the work, and calls `issue done` with a
   closing comment.
3. The run ends.
4. Post-run closure evaluation sees a valid closure signal and does nothing.

### Case B: Legitimate ongoing work

1. The agent works on an issue and leaves a progress comment that clearly says
   more work remains.
2. The issue stays `in_progress`.
3. The run ends.
4. Closure evaluation sees a valid `progress_update` closure signal and does not
   create passive follow-up.
5. If timer heartbeat exists, normal cadence continues. If not, the board still
   has a coherent audit trail.

### Case C: Missing close-out on non-timer agent

1. The agent does work on an assigned issue.
2. The run exits without `issue done`, `issue block`, `issue comment`, or other
   accepted closure signal.
3. The issue remains `todo` or `in_progress`.
4. The agent has no enabled timer heartbeat.
5. Rudder records `missing_closure` and queues a same-agent
   `issue_passive_followup` wake after cooldown.
6. The next run starts with explicit prompt framing: this is a follow-up to
   close or clarify the still-open issue, not a fresh assignment.

### Case D: Follow-up still fails to close

1. One passive follow-up run also exits without closure.
2. Rudder increments passive follow-up attempt count.
3. If attempts remain, Rudder queues another same-agent follow-up with a longer
   cooldown.
4. If max attempts are exhausted, Rudder stops auto-follow-up and emits a
   visible board attention signal such as `issue_closure_needs_operator_review`.

## Implementation

### Product Or Technical Architecture Changes

Introduce a post-run issue closure evaluation pass inside heartbeat finalization.

This pass sits conceptually beside:

- process-loss recovery
- issue execution lock release and deferred wake promotion

But it is not the same as either.

Recommended ordering on terminal run completion:

1. finalize run status and persist terminal metadata
2. determine whether explicit recovery policy applies first
3. evaluate issue closure state for issue-backed runs
4. if `missing_closure` and passive follow-up is allowed, enqueue follow-up
5. release issue execution lock or transfer it according to the queued outcome
6. continue existing queued-run startup flow

Reasoning:

- explicit failure recovery remains the higher-priority semantic because it
  preserves "continue the interrupted run" semantics
- closure governance applies after the run is known to be terminal and after
  true runtime failure handling is decided

### First-Phase Product Defaults

The first implementation should lock in these behavior defaults instead of
leaving them as open design questions:

1. Trigger passive follow-up only on `missing_closure`.
2. Treat new run-authored progress comments as closure-sufficient for ongoing
   work.
3. Treat timer heartbeat as the preferred continuity path when it is both
   enabled and expected to run within a bounded near-term window.
4. Allow at most 2 passive follow-up runs after the original run in the first
   version.
5. After that limit, stop auto-follow-up and emit
   `issue_closure_needs_operator_review`.
6. Do not auto-set issue status to `blocked` as a stop condition.

### Breaking Change

No external API break is required.

Potential additive contract changes:

- new wake reason values
- new activity log event kinds or details
- new UI labels for passive follow-up vs recovery retry
- optional additive metadata on `heartbeat_runs.contextSnapshot`

### Design

#### 1. Closure signal model

Do not infer closure from issue state alone.

Accepted initial closure signals:

- `issue_done`
  - the run moved the issue to `done`
- `issue_blocked`
  - the run moved the issue to `blocked` with blocker explanation
- `progress_update`
  - the run added an issue comment after checkout and before exit
  - the comment must be attributable to this run and newer than the run's
    checkout / prior closure state
- `explicit_handoff`
  - the run reassigned or escalated with an explanatory comment

Recommended first-cut evaluation rule:

- accept the newest issue comment authored by this run as `progress_update`
- do not accept older comments that merely existed in context before the run
- do not require semantic NLP classification in the critical path; comment
  presence, authorship, and freshness are sufficient for V1

Not accepted as closure by itself:

- run succeeded
- run produced local side effects only
- issue still `todo` or `in_progress` with no new comment

This is intentionally conservative.
The system should reward explicit close-out, not infer it from indirect traces.

Implication:

- `todo` or `in_progress` is a necessary condition for passive follow-up
  consideration
- it is not a sufficient condition by itself

#### 2. Trigger conditions

Queue passive follow-up only if all are true:

- run has an `issueId`
- run is terminal
- run is not already a recovery run that has handed off to explicit recovery
- issue status is one of `todo` or `in_progress`
- no accepted closure signal was recorded for this run
- agent heartbeat policy is disabled for timer continuation, or timer policy is
  configured inactive for this agent in practice
- passive follow-up attempts for this issue/agent pair are below max

Do not queue passive follow-up when:

- issue is `done`, `cancelled`, or `blocked`
- issue is `in_review` in a workflow where current product semantics already
  treat that state as a legitimate handoff boundary
- issue was reassigned during the run
- another active queued/running issue execution owner already exists
- the run ended through existing explicit recovery logic

Recommended default for V1:

- do not include `in_review` in the initial passive-follow-up trigger set
- revisit only if real traces show same-agent review-closeout gaps that matter

#### 3. Data model shape

Prefer additive metadata before new tables.

Candidate storage:

- `heartbeat_runs.contextSnapshot.passiveFollowup`
  - `originRunId`
  - `attempt`
  - `reason: "missing_closure"`
- `agent_wakeup_requests.reason = "issue_passive_followup"`
- optional issue-level bookkeeping for operator visibility, for example:
  - `lastClosureGapAt`
  - `passiveFollowupCount`
  - `closureNeedsReviewAt`
  - `closureNeedsReviewReason`

Recommended first phase:

- store follow-up lineage on wakeup request + run context
- avoid issue schema expansion unless UI/operator workflow genuinely needs a
  first-class issue-level flag
- if operator filtering proves too weak without issue-level state, add explicit
  review-needed fields on `issues` rather than overloading workflow status

#### 4. Prompt framing

Passive follow-up prompt must not read like a fresh assignment.

It should say:

- the previous run ended without sufficient issue close-out
- inspect the current issue state and any side effects first
- either:
  - add a progress comment
  - mark the issue done
  - block it with reason
  - or hand it off explicitly

This is closer to recovery prompt design than to assignment prompt design, but
the semantic reason is governance gap, not runtime failure.

#### 5. Cooldown and stop policy

Required guardrails:

- initial cooldown before first passive follow-up
- bounded max attempts per issue/agent
- optional exponential or stepped backoff
- operator-visible terminal escalation after max attempts

Suggested starting policy:

- cooldown: 2 to 5 minutes
- max attempts: 2 passive follow-ups after the original run
- after max attempts, stop auto-follow-up and emit operator-visible review need

Recommended default stop semantics:

- emit `issue_closure_needs_operator_review`
- create visible board attention in the same operator-facing surfaces that
  already surface follow-up-worthy run states
- keep the issue in its current workflow state unless the agent explicitly
  changes it
- never convert review-needed into synthetic `blocked`

#### 6. Relationship to existing orchestration

Passive follow-up must reuse current issue execution lock rules.

That means:

- do not create a special bypass path
- queue through the same wakeup coordinator
- allow standard deferral if some other issue owner is active
- keep same-agent ownership default

This proposal is governance on top of orchestration, not a replacement for
orchestration.

#### 7. Relationship to timer heartbeats

The user's requested policy is directionally correct:

- only trigger passive follow-up when active timer continuity is absent

But the actual condition should be more precise than "no heartbeat configured."

Use an effective continuation check:

- if timer heartbeat is enabled, the agent is eligible to run, and the next
  normal heartbeat is expected within a bounded near-term window, do not queue
  passive follow-up immediately
- if timer heartbeat is disabled, paused, or otherwise not expected to continue
  the issue in normal cadence, passive follow-up may queue

This prevents double-driving the same issue through both normal cadence and
passive governance.

Recommended first-cut heuristic:

- define "bounded near-term window" as the smaller of:
  - 2x the configured timer interval
  - 15 minutes
- if no credible next timer wake can be expected inside that window, treat
  timer continuity as absent for passive-follow-up purposes

#### 8. Operator surface

Issue detail and run detail should expose:

- that a passive follow-up was queued
- why it was queued
- which run triggered it
- current attempt count
- whether passive follow-up stopped and now needs board review

This should not be hidden in transcript-only debugging.

### Security

No new external dependency is required.
No new remote integration is required.

If additive HTTP endpoints are introduced later for UI controls such as
"retry passive follow-up now" or "dismiss closure alert", they must respect the
existing organization and actor scoping rules.

## What Is Your Testing Plan (QA)?

### Goal

Prove that issue-backed runs cannot silently disappear without either explicit
closure or an auditable passive follow-up path.

### Prerequisites

- org with at least one issue-assignable agent
- one agent with timer heartbeat disabled
- one agent with timer heartbeat enabled
- issue-backed wakeup coverage already working in test fixtures

### Test Scenarios / Cases

1. Run marks issue done
   - expect no passive follow-up
2. Run blocks issue with comment
   - expect no passive follow-up
3. Run leaves progress comment and exits with issue still `in_progress`
   - expect no passive follow-up
4. Run exits with issue still `todo` or `in_progress` and no comment
   - timer disabled:
     expect `issue_passive_followup`
5. Same as case 4 but timer enabled and active
   - expect no passive follow-up
6. Run exits with issue still `in_progress` but with a fresh run-authored
   comment
   - expect no passive follow-up
7. Passive follow-up run closes issue
   - expect attempts reset / no further follow-up
8. Passive follow-up run again exits without closure
   - expect bounded retry with incremented attempt metadata
9. Max attempts exceeded
   - expect no more auto-follow-up, explicit operator review state, and no
     workflow auto-transition to `blocked`
10. Existing process-loss recovery case
   - expect recovery semantics still win; passive follow-up does not duplicate
     it
11. Existing issue execution lock case
    - expect passive follow-up respects lock and never creates concurrent active
      execution
12. Timer configured but next wake falls outside the bounded near-term window
    - expect passive follow-up may still queue

### Expected Results

- closure-signal runs behave unchanged
- missing-closure runs become auditable follow-up work instead of silent drops
- timer agents do not get duplicate continuity work from two systems
- operator can identify passive follow-up lineage in issue/run detail

### Pass / Fail

- not run yet

## Documentation Changes

- `doc/SPEC-implementation.md`
  - clarify whether issue closure governance is in V1 scope or post-V1 follow-up
- `doc/spec/agent-runs.md`
  - add passive follow-up as a wake reason and orchestration rule
- `doc/developing/RUN-RECOVERY.md`
  - explicitly distinguish recovery from passive issue follow-up
- `server/resources/bundled-skills/rudder/SKILL.md`
  - keep prompt guidance aligned with the new closure contract
- heartbeat onboarding docs
  - explain that missing close-out can trigger same-agent follow-up

## Resolved Defaults For This Proposal Revision

This revision intentionally resolves several previously-open design questions:

- `in_review` is excluded from the first trigger set by default
- a fresh run-authored issue comment is sufficient as `progress_update`
- timer heartbeat suppresses passive follow-up only when near-term continuity is
  actually credible
- first-phase stop behavior is operator review, not workflow mutation

The remaining work is implementation validation, not basic semantic framing.

## Open Issues

- Do we need issue-level persistent flags for board filtering, or can run +
  activity lineage carry the first version?
- Should operators be allowed to disable passive follow-up per agent or per
  issue, or is global policy enough for the first cut?
- Is `issue_closure_needs_operator_review` best surfaced only in run / issue
  detail first, or does it need a dedicated inbox / Messenger attention card in
  the first version?
