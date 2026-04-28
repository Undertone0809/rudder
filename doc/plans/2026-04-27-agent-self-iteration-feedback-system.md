---
title: Agent Self-Iteration Feedback System
date: 2026-04-27
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - agent_iteration
  - run_feedback
  - improvement_proposals
  - eval_gates
issue:
related_plans:
  - 2026-04-05-run-detail-transcript-v2.md
  - 2026-04-07-rudder-benchmark-v0.1.md
  - 2026-04-12-langfuse-derived-observability-phase1.md
  - 2026-04-14-langfuse-trace-observability.md
  - 2026-04-16-agent-private-skill-creation.md
  - 2026-04-22-agent-dashboard-skills-analytics.md
supersedes: []
related_code:
  - packages/db/src/migrations
  - packages/db/src/schema
  - packages/shared
  - server/src/services
  - server/src/routes
  - ui/src
  - benchmark
commit_refs: []
updated_at: 2026-04-27
---

# Agent Self-Iteration Feedback System

## Overview

Add a self-iteration feedback system to Rudder so every agent run can become structured learning input for future work.

The system should turn real execution into a controlled improvement loop:

```text
heartbeat run -> outcome feedback -> retrospective -> improvement proposal -> eval gate -> approval -> canary/promotion -> rollback if needed
```

This proposal does not make agents silently rewrite themselves. It makes improvement visible, reviewable, testable, and reversible inside Rudder's existing control plane.

The first version should focus on Rudder-owned execution signals: heartbeat runs, issues, issue comments, approvals, cost/budget events, work products, run events, benchmark results, and board feedback. Later versions can import richer traces from Langfuse or external agent runtimes.

## What Is The Problem?

Rudder already has strong primitives for agent work: organizations, goals, issues, assignments, heartbeats, approvals, budgets, activity logs, skills, and execution workspaces. These primitives make work legible, but they do not yet close the learning loop.

Today, when an agent succeeds or fails, the result is mostly operational history. Operators can inspect the run, but Rudder does not systematically answer:

- Did the run actually achieve the issue goal?
- Was the output accepted, edited, rejected, blocked, or unsafe?
- What failure mode occurred?
- Is this a one-off failure or a recurring pattern?
- Should the fix be a prompt change, a skill change, a workflow change, a memory entry, a tool-policy change, or a new eval?
- Did the proposed fix improve real outcomes without increasing cost or risk?

Without this layer, agent improvement remains manual, anecdotal, and hard to audit. With it, Rudder can become the control plane for self-improving agent teams.

## What Will Be Changed?

### 1. Add structured run feedback

Introduce a first-class feedback record for every heartbeat run.

Feedback can come from:

- system-derived signals: run status, exit code, timeout, budget stop, tool error, test result, missing closeout, unsafe action block
- board/operator input: accept, reject, edit, rate, label failure, leave note
- agent self-report: summary and suspected failure mode, never accepted as final truth without system or human evidence
- eval runs: deterministic test/build/lint/browser/e2e result or benchmark result

Initial outcome vocabulary:

```text
accepted
accepted_with_edits
rejected
blocked
failed
test_failed
tool_failed
budget_paused
timeout
unsafe_action_blocked
closeout_missing
needs_human_review
unknown
```

Initial failure-mode vocabulary:

```text
requirements_unclear
context_missing
wrong_context
memory_missing
memory_stale
skill_missing
skill_misapplied
workflow_gap
tool_permission_denied
tool_error
execution_environment_error
test_failure
budget_limit
approval_rejected
unsafe_action_blocked
model_reasoning_error
closeout_gap
unknown
```

### 2. Add automatic run retrospectives

When a run finishes with a negative or ambiguous outcome, Rudder should generate a concise retrospective.

A retrospective should include:

- what the agent was trying to do
- what actually happened
- observed evidence from run events, issue state, approvals, work products, costs, and evals
- likely failure modes
- what could prevent recurrence
- whether a proposal should be created

The retrospective is not raw chain-of-thought. It is an operator-facing, evidence-backed summary.

### 3. Add improvement proposals

An improvement proposal is a reviewable change request generated from one or more feedback records or retrospectives.

Proposal target types:

```text
agent_config
agent_prompt_context
skill
workflow
tool_policy
memory_entry
eval_suite
documentation
benchmark_case
```

Proposal statuses:

```text
draft
pending_eval
failed_eval
pending_approval
approved
rejected
canary
promoted
rolled_back
archived
```

Proposal risk levels:

```text
low       memory note, docs clarification, eval case addition
medium    prompt/context patch, skill markdown patch, workflow checklist change
high      executable skill change, tool-policy change, runtime config change, budget change, MCP/server integration
critical  secret access, network scope expansion, cross-org behavior, autonomous promotion policy
```

Agents may create draft proposals, but they cannot self-approve or silently promote production behavior.

### 4. Add eval gates for proposed improvements

Before an improvement proposal can be promoted, it should pass an eval gate appropriate to the target.

Examples:

- prompt/context patch: replay recent failed runs where safe, run benchmark cases, compare baseline vs candidate
- skill patch: run skill-specific smoke/eval cases, check referenced docs, validate file inventory
- workflow patch: run deterministic workflow tests and issue lifecycle tests
- tool-policy change: require high-risk approval and verify least-privilege scope
- memory entry: validate source/evidence, scope, expiry, and conflict with existing memories
- benchmark/eval patch: verify it fails before the fix when relevant and passes after the fix when relevant

Rudder-owned benchmark cases should remain the canonical internal eval path. Langfuse traces can remain a derived observability plane rather than the source of truth for governance.

### 5. Add canary and rollback semantics

Approved improvements should not always become global immediately.

Promotion scopes:

```text
single_agent
single_agent_role
single_issue_label
single_project
single_organization
global_builtin
```

A candidate can run in canary mode for the next N matching runs or for a fixed time window. Rudder should compare against the prior stable version on:

- accepted outcome rate
- rejected outcome rate
- blocked/stuck rate
- cost per accepted run
- average duration
- tool error rate
- approval rejection rate
- test/eval pass rate
- rollback/regression rate

If metrics regress beyond configured thresholds, Rudder should recommend or perform a guarded rollback depending on risk policy.

## Success Criteria For Change

The first shippable version succeeds when:

1. At least 90% of completed heartbeat runs receive a structured outcome label, either system-derived or operator-provided.
2. Failed, blocked, rejected, timeout, unsafe, and test-failed runs automatically receive a retrospective draft.
3. Operators can create an improvement proposal from a run or retrospective in under 30 seconds.
4. Every proposal records source run IDs, target type, risk level, diff/patch, eval status, approval status, and rollback plan.
5. Medium/high/critical proposals cannot be promoted without approval.
6. Proposal application writes activity log entries and preserves organization boundaries.
7. Rudder can show an Iteration Board with recent failures, recurring failure modes, open proposals, eval results, and promoted improvements.
8. At least one internal Rudder engineering workflow is dogfooded end-to-end: failed run -> retrospective -> skill/prompt/workflow proposal -> eval -> approval -> canary/promotion.

## Out Of Scope

The first version should not include:

- model weight training or reinforcement learning
- automatic production self-modification without approval
- marketplace distribution of learned improvements
- cross-organization aggregation of private run data
- fully general benchmark orchestration across all external agent products
- automatic MCP/tool installation or secret-scope expansion
- replacing Langfuse, benchmark cases, or the run detail transcript surface

## Non-Functional Requirements

### Security

- All records must be organization-scoped.
- Agents may propose changes but cannot approve their own proposals.
- High-risk and critical changes must route through approvals.
- Tool-policy, executable skill, MCP/server, budget, network, and secret-access changes must be treated as governed actions.
- Feedback and retrospectives must not store raw hidden reasoning.
- Memory writes must carry source evidence, scope, confidence, and expiry/validation metadata.
- Activity logs must be written for mutating actions.

### Maintainability

- Reuse existing heartbeat runs, run events, approvals, activity logs, skills, config revisions, benchmark, and work-product structures where possible.
- Keep the first database addition small and composable.
- Avoid creating a second execution-log system parallel to heartbeat run events.
- Keep provider-specific trace parsing behind adapters or derived observability helpers.

### Observability

- Every retrospective and proposal should link back to source runs, source issue, feedback records, and related eval runs.
- Metrics should be derived from structured outcome records rather than scraped text.
- Langfuse links may be attached as evidence refs, but Rudder remains the governance source of truth.

### Usability

- Default UI should be board-level and concise.
- Raw traces/logs should remain available through progressive disclosure.
- The operator should see a practical recommendation, not just a diagnostic dump.

## User Experience Walkthrough

### Scenario 1: Operator reviews a failed run

1. An engineer agent finishes a heartbeat run with status `failed`.
2. Rudder derives initial feedback: `outcome=test_failed`, `failure_mode=workflow_gap`.
3. The run detail page shows a Feedback card above the transcript.
4. The operator sees a retrospective summary:
   - attempted task
   - failing command
   - changed files/work products
   - suspected root cause
   - suggested next improvement
5. The operator adjusts the failure mode if needed and clicks `Create proposal`.
6. Rudder opens a proposal draft targeting a skill or workflow checklist.

### Scenario 2: Agent proposes a reusable improvement

1. An agent notices repeated failures where it forgets to run a repo-specific verification command.
2. The agent creates a draft proposal targeting `skill` or `agent_prompt_context`.
3. Rudder links the proposal to the source runs and marks it `pending_eval`.
4. The eval gate runs the relevant smoke/benchmark cases.
5. If eval passes, proposal status becomes `pending_approval`.
6. Board approves the proposal.
7. Rudder promotes it to canary for the same agent role and issue label.
8. If canary metrics improve, the operator promotes it to stable.

### Scenario 3: Risky self-modification is blocked

1. An agent proposes enabling a new external MCP server or widening shell/network access.
2. Rudder classifies the proposal as `high` or `critical` risk.
3. The proposal cannot be applied automatically.
4. The approval page shows the exact tool-policy diff, source evidence, expected benefit, and rollback path.
5. Board rejects, edits, or approves.
6. The decision is logged in activity history.

## Implementation

### Product Or Technical Architecture Changes

Introduce five cooperating services:

1. `RunFeedbackService`
   - derives initial run feedback from heartbeat runs, run events, issues, approvals, cost/budget data, work products, and eval results
   - accepts operator and agent feedback submissions
   - maintains outcome/failure-mode labels

2. `RunRetrospectiveService`
   - creates evidence-backed retrospectives for negative or ambiguous outcomes
   - summarizes what happened without storing hidden chain-of-thought
   - recommends whether an improvement proposal should be created

3. `ImprovementProposalService`
   - creates and updates proposals
   - validates target type, risk level, source evidence, and patch/diff shape
   - links proposals to approvals and eval runs

4. `EvalGateService`
   - maps proposal target type to required eval checks
   - runs or references Rudder benchmark cases and deterministic checks
   - records baseline/candidate comparison where available

5. `PromotionService`
   - applies approved low/medium-risk changes to a canary scope
   - records promotion and rollback state
   - emits activity log entries

### Data Model

Use `org_id` in new tables. If the current implementation still carries `company_id` compatibility paths, the migration can name the column to match the current schema convention and expose org naming through shared types.

#### `agent_run_feedback`

```sql
CREATE TABLE agent_run_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  issue_id uuid,
  agent_id uuid NOT NULL,
  source text NOT NULL, -- system | operator | agent | eval
  outcome text NOT NULL,
  failure_modes jsonb DEFAULT '[]'::jsonb NOT NULL,
  rating integer,
  note text,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_by_user_id text,
  created_by_agent_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX agent_run_feedback_org_run_idx ON agent_run_feedback (org_id, run_id);
CREATE INDEX agent_run_feedback_org_agent_created_idx ON agent_run_feedback (org_id, agent_id, created_at);
CREATE INDEX agent_run_feedback_org_outcome_idx ON agent_run_feedback (org_id, outcome);
```

#### `agent_run_retrospectives`

```sql
CREATE TABLE agent_run_retrospectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  issue_id uuid,
  agent_id uuid NOT NULL,
  status text DEFAULT 'draft' NOT NULL, -- draft | accepted | dismissed | superseded
  summary text NOT NULL,
  root_causes jsonb DEFAULT '[]'::jsonb NOT NULL,
  lessons jsonb DEFAULT '[]'::jsonb NOT NULL,
  recommended_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
  evidence_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_by text DEFAULT 'system' NOT NULL, -- system | agent | operator
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX agent_run_retrospectives_org_run_idx ON agent_run_retrospectives (org_id, run_id);
CREATE INDEX agent_run_retrospectives_org_agent_created_idx ON agent_run_retrospectives (org_id, agent_id, created_at);
```

#### `improvement_proposals`

```sql
CREATE TABLE improvement_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  target_type text NOT NULL,
  target_id text,
  proposal_kind text NOT NULL,
  risk_level text DEFAULT 'medium' NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  source_run_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
  source_retrospective_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
  patch jsonb DEFAULT '{}'::jsonb NOT NULL,
  expected_impact jsonb DEFAULT '{}'::jsonb NOT NULL,
  eval_status text DEFAULT 'not_run' NOT NULL,
  latest_eval_run_id uuid,
  approval_id uuid,
  promotion_scope jsonb DEFAULT '{}'::jsonb NOT NULL,
  rollback_plan text,
  created_by_user_id text,
  created_by_agent_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX improvement_proposals_org_status_idx ON improvement_proposals (org_id, status);
CREATE INDEX improvement_proposals_org_target_idx ON improvement_proposals (org_id, target_type, target_id);
CREATE INDEX improvement_proposals_org_created_idx ON improvement_proposals (org_id, created_at);
```

#### `proposal_eval_runs`

```sql
CREATE TABLE proposal_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  baseline_ref text,
  candidate_ref text,
  status text DEFAULT 'queued' NOT NULL,
  result text, -- passed | failed | inconclusive
  score jsonb DEFAULT '{}'::jsonb NOT NULL,
  checks jsonb DEFAULT '[]'::jsonb NOT NULL,
  log_ref text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX proposal_eval_runs_org_proposal_idx ON proposal_eval_runs (org_id, proposal_id);
CREATE INDEX proposal_eval_runs_org_created_idx ON proposal_eval_runs (org_id, created_at);
```

### API Surface

All endpoints must enforce organization access, actor permissions, and activity logging for mutations.

```text
GET    /api/orgs/:orgId/iteration/overview
GET    /api/orgs/:orgId/runs/:runId/feedback
POST   /api/orgs/:orgId/runs/:runId/feedback
POST   /api/orgs/:orgId/runs/:runId/retrospectives
GET    /api/orgs/:orgId/runs/:runId/retrospectives
GET    /api/orgs/:orgId/improvement-proposals
POST   /api/orgs/:orgId/improvement-proposals
GET    /api/orgs/:orgId/improvement-proposals/:proposalId
PATCH  /api/orgs/:orgId/improvement-proposals/:proposalId
POST   /api/orgs/:orgId/improvement-proposals/:proposalId/run-eval
POST   /api/orgs/:orgId/improvement-proposals/:proposalId/request-approval
POST   /api/orgs/:orgId/improvement-proposals/:proposalId/promote-canary
POST   /api/orgs/:orgId/improvement-proposals/:proposalId/promote-stable
POST   /api/orgs/:orgId/improvement-proposals/:proposalId/rollback
```

### UI Surfaces

#### Run detail page

Add a Feedback card above or beside the run transcript:

- outcome label
- failure modes
- rating or accept/reject action
- derived evidence
- retrospective status
- `Create proposal` action

#### Issue page

Add a compact Learning section:

- latest run outcomes
- accepted/rejected history
- retrospectives tied to this issue
- proposals created from this issue

#### Agent detail page

Add an Iteration tab:

- recent outcomes
- recurring failure modes
- cost per accepted run
- proposal list
- canary vs stable summary
- skills or prompt/context changes affecting this agent

#### Board-level Iteration page

Add a board-level overview:

- open improvement proposals
- failed/blocked run clusters
- top failure modes by agent/role/project
- eval gates waiting
- canaries in progress
- recent promotions and rollbacks

#### Approval page

Improvement proposal approvals should show:

- diff/patch
- target type and risk level
- source runs and retrospectives
- eval results
- promotion scope
- rollback plan
- security warnings

### Applying Proposals

Initial apply behavior should be conservative:

- `memory_entry`: create a scoped memory/resource draft with source evidence and expiry metadata
- `agent_prompt_context`: create an `agent_config_revisions` candidate, not a direct overwrite
- `skill`: create a new skill version or draft skill patch; do not mutate stable skill content directly
- `workflow`: create a workflow draft or checklist patch
- `tool_policy`: require approval and produce a policy diff only
- `eval_suite` / `benchmark_case`: create or update eval case files through a normal reviewed work path

### Feature Flag

Add a feature flag or instance setting:

```text
agentIterationFeedback.enabled
```

Default can be enabled in development and hidden/disabled in production-like modes until the first full E2E coverage lands.

## Breaking Change

No breaking API or runtime behavior should be required for the first version.

The system adds new records and optional UI surfaces. Existing heartbeat runs, issues, approvals, activity logs, skills, and benchmarks remain compatible.

## Security

This feature directly affects agent behavior and must preserve Rudder's control-plane invariants.

Rules:

1. Agent-created proposals are drafts by default.
2. Agents cannot approve, promote, or rollback proposals that affect their own permissions, runtime config, budget, or tool access.
3. Medium/high/critical proposals require approval before promotion.
4. Tool-policy, executable skill, MCP/server, network, secret, and budget changes must be high or critical risk.
5. Retrospectives must cite evidence from visible events, logs, comments, approvals, work products, and evals.
6. Do not store hidden chain-of-thought. Store operator-facing summaries and evidence references.
7. All mutation endpoints must write activity logs.
8. Every query and mutation must enforce organization scope.
9. Rollback must be available for every promoted proposal that changes agent behavior.

## What Is Your Testing Plan (QA)?

### Goal

Prove that Rudder can capture structured feedback, derive retrospectives, create proposals, enforce approval/eval gates, and promote or rollback changes without violating organization boundaries or control-plane invariants.

### Prerequisites

- A seeded organization with CEO and engineer agents
- At least one issue-backed heartbeat run
- At least one failing run fixture
- At least one deterministic benchmark/eval fixture
- Feature flag enabled

### Test Scenarios / Cases

1. System-derived feedback
   - Given a failed heartbeat run with error and issue context
   - When the run finishes
   - Then Rudder creates `agent_run_feedback` with the expected outcome and failure mode

2. Operator feedback override
   - Given a system-derived outcome
   - When the operator changes the outcome and adds a note
   - Then Rudder stores the operator feedback and activity log without deleting system evidence

3. Retrospective generation
   - Given a failed or rejected run
   - When retrospective generation runs
   - Then the retrospective contains summary, root causes, lessons, recommended actions, and evidence refs

4. Proposal creation from retrospective
   - Given a retrospective
   - When operator clicks `Create proposal`
   - Then Rudder creates a draft proposal linked to the source run and retrospective

5. Eval gate enforcement
   - Given a medium-risk proposal
   - When promotion is attempted before eval/approval
   - Then Rudder blocks promotion and returns a clear error

6. Approval enforcement
   - Given a high-risk tool-policy proposal
   - When an agent attempts to self-approve
   - Then Rudder rejects the action

7. Canary promotion
   - Given an approved proposal with passing eval
   - When promoted to canary
   - Then promotion scope is recorded and activity log is written

8. Rollback
   - Given a canary or promoted proposal
   - When rollback is requested
   - Then Rudder restores the prior stable reference and records rollback activity

9. Organization boundary
   - Given two organizations
   - When an actor from org A accesses feedback/proposals from org B
   - Then Rudder returns 403/404 according to existing route convention

10. UI flow
   - Run detail page shows feedback and retrospective controls
   - Agent detail page shows iteration metrics
   - Board-level Iteration page shows proposals and failure modes

### Expected Results

- Feedback records are created and searchable by run, issue, agent, outcome, and organization.
- Retrospectives are evidence-backed and do not expose hidden reasoning.
- Proposal state transitions are valid and auditable.
- Medium/high/critical changes cannot bypass eval/approval gates.
- Canary and rollback write activity log entries.
- E2E tests cover the operator path from failed run to proposal creation.

### Pass / Fail

To be filled during implementation verification.

## Documentation Changes

Update:

- `doc/PRODUCT.md`: add self-iteration feedback as part of the control-plane learning loop
- `doc/SPEC-implementation.md`: define V1 behavior for run feedback, retrospectives, proposals, eval gates, approvals, and rollback
- `doc/spec/agent-runs.md`: document run completion hook and feedback derivation
- `doc/TASKS.md`: describe issue-level feedback and learning linkage if issue UI changes
- `doc/DESIGN.md`: add guidance for Iteration Board, feedback card, and proposal review UI
- `doc/plans/_taxonomy.md`: optionally add `agent_iteration` as an entity example if this becomes repeated work
- bundled skill docs if a Rudder self-iteration skill is introduced

## Rollout Plan

### Phase 1: Feedback capture and labels

- Add DB tables for run feedback and retrospectives.
- Add shared validators/types.
- Add server service and routes.
- Derive basic feedback on run completion.
- Add run-detail Feedback card.
- Add activity logging for manual feedback.

### Phase 2: Retrospectives

- Generate retrospective drafts for negative/ambiguous outcomes.
- Add issue and run links.
- Add operator accept/dismiss actions.
- Add tests for evidence refs and no hidden-reasoning leakage.

### Phase 3: Improvement proposals

- Add proposal table, service, routes, and UI list/detail.
- Support proposal creation from run/retrospective.
- Support risk classification and approval linkage.

### Phase 4: Eval gates

- Connect proposals to Rudder benchmark/eval cases.
- Add proposal eval runs.
- Block promotion without required eval and approval.

### Phase 5: Canary and rollback

- Add canary promotion scopes.
- Compare candidate vs stable metrics.
- Add rollback path and activity logs.
- Expose board-level Iteration page.

## Open Issues

1. Should proposal records be generic, or should each target type eventually get a dedicated version table?
2. Should `agent_config_revisions` become the canonical AgentVersion model, or should Rudder introduce a new `agent_versions` table?
3. How should skill versioning work with the current `company_skills` and `agent_enabled_skills` tables?
4. Should memory writes be stored as organization resources, a dedicated memory table, or provider-specific memory patches?
5. What is the minimum useful eval gate for non-code work?
6. Should canary comparison be fully automatic in V1, or should it start as operator-visible metrics only?
7. What proposal types may be agent-created in production mode by default?
8. Should feedback labels be editable after promotion decisions have used them?
9. How should external runtime traces be normalized into evidence refs without making Rudder dependent on one observability provider?

## Recommended First Dogfood

Use Rudder's own engineering workflow as the first dogfood path:

1. Pick a small failing issue-backed run.
2. Label the outcome and failure mode.
3. Generate retrospective.
4. Create a proposal to patch a Rudder skill, AGENTS guidance, or workflow checklist.
5. Run repo validation or benchmark case.
6. Request board approval.
7. Promote to canary for one agent or one issue label.
8. Compare the next few runs against baseline.
9. Roll back if regressions appear.

This keeps the first iteration grounded in real agent-work loops and avoids making self-iteration a purely synthetic demo.
