---
title: Agent scenario trigger gate for lifecycle routing
date: 2026-06-14
kind: proposal
status: proposed
area: skills
entities:
  - development_lifecycle_router
  - agent_scenario_triggers
  - runtime_contracts
issue:
related_plans:
  - 2026-06-03-heartbeat-instructions-scene-gate.md
  - 2026-05-04-agent-operating-contract-runtime.md
  - 2026-04-14-codex-managed-skill-materialization.md
supersedes: []
related_code:
  - .agents/skills/maintainer/development-lifecycle-router-maintainer/SKILL.md
  - .agents/skills/maintainer/development-lifecycle-router-maintainer/evals/evals.json
  - server/resources/bundled-skills/rudder/SKILL.md
commit_refs: []
updated_at: 2026-06-14
---

# Agent Scenario Trigger Gate For Lifecycle Routing

## Overview

Optimize `development-lifecycle-router-maintainer` so it recognizes Rudder
Agent scenario triggers before falling into artifact-first lifecycle routing.
The change should be a thin route-selection guard, not a new agent operating
manual.

The router already requires terminal product proof later in the workflow:
actor, trigger, system effect, and terminal surface. The missing behavior is
using a compact version of that question at intake, especially when the user
describes agent-visible failures with language such as heartbeat wake, reviewer
wakeup, approval follow-up, passive follow-up, chat agent response, CLI skill
management, or runtime/provider parity.

## What Is The Problem?

Current state:

- The router is strong on lifecycle stages, spawned reviewer policy, terminal
  product proof, runtime/provider matrices, and dirty-worktree recovery.
- It does not clearly put Rudder Agent scenario triggers ahead of generic
  artifact routing.
- Agent-scenario semantics exist in the bundled `rudder` skill, but that skill
  tells a runtime agent how to operate inside Rudder. It is not the route
  selector for contributor maintenance work.

Problem:

- A maintainer prompt about an agent-visible scenario can be misread as UI
  polish, generic transcript debug, generic skill optimization, or normal issue
  implementation because the visible artifact is more obvious than the actor
  and trigger.
- The router's terminal proof guidance appears too late to prevent the initial
  route mistake.

Impact:

- Agent-visible workflow bugs can receive the wrong first owner.
- Verification can stop at the derivative surface, such as renderer tests,
  screenshots, or transcript inspection, instead of proving the actor-run-chain
  that the next Rudder actor depends on.
- Adding a broad trigger taxonomy to the router would create a second copy of
  the bundled `rudder` operating manual and increase drift.

## What Will Be Changed?

1. Add a short `Agent Scenario Trigger Gate` after `Meta-Request Precedence`
   and before `Stage Classifier`.
2. Tighten `Non-Use Gate` so a visible artifact is not treated as an obvious
   narrow route when the disputed effect is agent-visible wake, run, review,
   approval, close-out, chat-agent, runtime, or skill-management state. Explicit
   user-named specialized routes and plain UI/release/docs/review-only requests
   still stay narrow.
3. Define the gate as four intake questions:
   - actor
   - observable trigger
   - system effect under dispute
   - terminal consumer or surface
4. Add a compact mapping table for agent-visible scenarios:
   - heartbeat/timer/manual wake
   - reviewer wake or `issue_review_requested`
   - approval follow-up
   - passive issue follow-up or close-out governance
   - chat agent reply or chat-native automation
   - agent skill/organization skill work
   - runtime/provider/tool-call/skill-usage contract
5. Add eval cases that use real Rudder scenario language and prevent the gate
   from becoming a broad duplicate operating manual.

## Ownership Boundaries

- `development-lifecycle-router-maintainer` owns route selection and evidence
  bars for development work about those scenarios.
- `server/resources/bundled-skills/rudder/SKILL.md` owns what a runtime agent
  does inside an actual heartbeat, review wake, approval follow-up, passive
  follow-up, or organization-skill workflow.
- `debug-run-transcript-maintainer` owns concrete run/log/transcript
  reconstruction when a run id or failed run is the primary artifact.
- `agent-work-reviewer-maintainer` owns review-only verdicts.
- `skill-optimizer` owns explicit requests to optimize an existing skill,
  including this router.

## Review Blocker Ledger

| Round 1 / 2 blocker | Resolution in this plan |
| --- | --- |
| Router bloat or duplicate bundled `rudder` procedure | The gate only records actor, trigger, effect, and terminal consumer. It forbids CLI commands, env vars, checkout steps, and heartbeat procedures. |
| Broken meta-request precedence | Explicit skill optimization still wins before the scenario gate, even when evidence includes UI, docs, or runtime content. |
| Artifact-first misrouting | Agent-scenario trigger words make the narrow artifact route not obvious until the scenario tuple is filled. |
| Eval gaps | This proposal requires concrete eval additions for mention wake, reviewer/passive close-out, org-skill versus repo-skill intent, and negative ordinary-route preservation. |
| Smallest durable owner | No new skill is created. Router owns route selection; bundled `rudder` owns runtime-agent procedure. |

## Success Criteria For Change

- Given agent-scenario trigger words, the router first names actor, trigger,
  system effect, and terminal surface.
- It routes to the smallest owner instead of the most visible artifact.
- It requires actor-run-chain, structured review decision, approval-linked
  readback, issue close-out readback, chat terminal surface, or provider matrix
  proof when those are the terminal product surfaces.
- It does not duplicate heartbeat checkout, CLI command, issue comment, review
  decision, or organization-skill procedures from the bundled `rudder` skill.
- It adds eval coverage for both positive scenario routing and negative
  meta-request/narrow-route precedence.

## Out Of Scope

- Rewriting the bundled `rudder` skill.
- Creating a new maintainer skill.
- Changing runtime code, CLI commands, database schema, or UI behavior.
- Replacing the existing stage classifier or routing matrix.
- Weakening spawned reviewer requirements.

## Non-Functional Requirements

- Maintainability: keep the new section compact, ideally 20-35 lines, and avoid
  embedding detailed procedures that belong to the bundled `rudder` skill.
- Testability: every new routing rule should have an eval case or be covered by
  an adjacent existing eval.
- Safety: preserve meta-request precedence so screenshots, prior session
  content, or named adjacent skills do not override an explicit skill
  optimization request.

## User Experience Walkthrough

1. The user says a real agent did not wake from an operator `@agent` comment.
2. Because wake behavior is disputed, the visible mention artifact is not yet a
   clear UI-polish route.
3. The router identifies actor=`board/operator and target agent`,
   trigger=`comment wake/mention`, effect=`wakeup routing`, terminal
   surface=`run/comment/readback`.
4. The router routes to debug or runtime-contract work, not cosmetic mention UI
   polish, unless the evidence proves the bug is only rendering.
5. Verification must follow the actor path: create or inspect the comment,
   read wake/run state, and inspect the terminal surface where the board or
   agent consumes the result.

For a negative case:

1. The user explicitly says this router skill needs optimization and includes a
   screenshot about some UI or docs task.
2. `Meta-Request Precedence` still wins.
3. The router classifies the turn as `skill_optimization`, uses
   `skill-optimizer`, and treats screenshot content as evidence instead of a
   current UI/docs route.

## Implementation

### Product Or Technical Architecture Changes

No product architecture changes. This is a repo-local maintainer skill and eval
optimization.

### Breaking Change

No breaking product, API, runtime, or storage change.

### Design

Insert this shape after `Meta-Request Precedence`:

```md
### Agent Scenario Trigger Gate

After Meta-Request Precedence, but before generic stage classification,
identify whether the request is about an agent-visible Rudder scenario. If yes,
record actor, trigger, system effect, and terminal consumer. Use this tuple as a
tie-breaker before declaring visible artifacts or narrow routes obvious. Do not
copy the bundled `rudder` skill's operating procedure.

| Observable trigger or actor | Primary route bias | Evidence required | Do not do |
| --- | --- | --- | --- |
| operator `@agent`, wake comment, timer/manual wake | `debug` for concrete run evidence, `runtime_contract` for routing/provider parity | wake/comment/run readback plus terminal surface | stop at mention rendering or composer UI proof |
| reviewer wake, approval follow-up, passive close-out | review/close-out governance or implementation only after obligation is clear | structured review decision, approval-linked issue readback, or close-out state | treat as fresh assignment or generic transcript debug |
| chat agent reply or chat-native automation | chat/runtime contract unless the user says it is only composer UI | persisted message/run/effect and consumer surface | assume heartbeat-only behavior |
| organization skill or agent-private skill work | bundled `rudder` procedure, product bug, or `skill-optimizer` based on user intent | enabled/created/readback state or skill patch evidence | copy org-skill CLI procedure into this router |
| provider/tool-call/skill-usage parity | `runtime_contract` | provider matrix and persisted Rudder evidence | accept Codex-only proof for provider parity |
```

The table should be concise and should reference route categories, not command
procedures.

### Security

No new dependencies, endpoints, remote APIs, or temporary file surfaces.

## What Is Your Testing Plan (QA)?

### Goal

Prove the router uses agent-scenario triggers as route-selection evidence while
preserving thin-router boundaries and meta-request precedence.

### Prerequisites

- Current `development-lifecycle-router-maintainer` skill and eval suite.
- Spawned reviewer evidence for the proposal and final diff.

### Test Scenarios / Cases

1. Operator mention wake does not trigger an agent.
   - Expected: route to debug/runtime-contract and require wake/run/readback
     evidence, not only mention rendering.
2. Concrete run id is the primary artifact.
   - Expected: route to `debug-run-transcript-maintainer` first; use the
     scenario tuple to set the later proof bar, not to bypass run diagnosis.
3. Reviewer, approval, or passive close-out behavior is wrong.
   - Expected: classify by review/approval/close-out obligation and require
     structured decision or linked-state readback, not fresh assignment.
4. Agent-private or organization skill work is requested.
   - Expected: distinguish runtime-agent skill operation, product bug in skill
     management, and repo skill optimization.
5. Explicit router optimization request with embedded UI/docs/agent evidence.
   - Expected: meta-request precedence still routes to skill optimization.
6. Ordinary UI, release, docs, or review-only work mentions an agent only as
   background.
   - Expected: preserve the narrow owner unless wake/run/review/approval/
     close-out/chat-agent/runtime state is the disputed effect.

### Expected Results

- New eval cases fail the previous skill in spirit because the route decision
  is underspecified.
- New eval cases pass with the added gate because they require actor/trigger
  intake and smallest-owner routing.

### Pass / Fail

- Passed: `node -e "JSON.parse(...evals.json...)"` confirmed eval JSON parses.
- Passed: duplicate-id check over `evals.json` reported 36 unique cases.
- Passed: targeted content inspection found the new gate in the router skill,
  the plan blocker ledger, and eval ids 30-36.
- Attempted: `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`; all were
  blocked in this worktree because workspace dependencies are not installed
  (`tsc` / `vitest` not found, with pnpm warning that `node_modules` is
  missing).
- Review: two proposal review rounds and one final diff review gate were run
  with spawned reviewers.

## Documentation Changes

- Add this plan document.
- Update the router skill only.
- Update router evals only.

## Open Issues

- The current task does not include running a full skill eval harness unless one
  is already available and cheap to run. Static JSON validation and targeted
  content inspection may be the practical verification.
- This proposal intentionally avoids changing the bundled `rudder` skill, but a
  later pass may still choose to rewrite that skill as an agent best-practice
  operating skill.
