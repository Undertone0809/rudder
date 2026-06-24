---
title: Agent run scene runtime contract
date: 2026-06-24
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - agent_runs
  - runtime_scene
  - wakeup_requests
  - issue_comments
issue:
related_plans:
  - 2026-06-10-unified-agent-run-architecture.md
  - 2026-06-20-agent-run-unification-completion.md
  - 2026-06-21-agent-run-facade-cleanup.md
  - 2026-06-21-product-logic-registry.md
supersedes: []
related_code:
  - packages/shared/src/agent-run.ts
  - packages/agent-runtime-utils/src/server-utils.instructions.ts
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/routes/issues.comments-attachments.ts
  - server/src/routes/issues.mutations.ts
  - server/src/services/issue-review-wakeup.ts
  - doc/product/domains/execution/agent-runs.md
  - doc/product/domains/execution/heartbeats.md
  - doc/product/domains/agents/instruction-loading.md
commit_refs: []
updated_at: 2026-06-24
---

# Agent Run Scene Runtime Contract

## Decision

Rudder should treat **Agent Run** as the umbrella execution model and should
use five product scenes:

- `heartbeat`: timer or operator-triggered heartbeat/self-check work.
- `issue`: assignment, checkout, issue follow-up, issue comment, mention, and
  reopen work.
- `review`: reviewer-requested work and reviewer follow-up when an in-review
  issue lacks a recorded review decision.
- `chat`: chat conversation agent turns.
- `automation`: automation-triggered runtime work.

`manual` is a trigger detail, not an Agent Run scene. A user clicking
`Run heartbeat` creates a heartbeat scene run with a manual trigger. It must
load heartbeat instructions.

`RUDDER_AGENT_HEARTBEAT_INSTRUCTION` must load only for `scene=heartbeat`.
Issue, review, chat, and automation runs must not receive generic heartbeat
pipeline instructions.

## Scope

This implementation will:

1. Add a shared runtime-scene derivation contract that maps run source/context
   to the five scenes.
2. Expand runtime scene context beyond the current `chat | heartbeat` split.
3. Use the derived scene during runtime prompt assembly so only heartbeat runs
   load heartbeat instructions.
4. Remove ordinary assignee wakeups for issue comments. Comments wake agents
   only when the comment explicitly mentions them.
5. Preserve comment-reopen behavior by appending an assignee mention to the
   persisted comment when reopening would need assignee attention and the
   assignee was not already mentioned.
6. Rename product-language references from review governance to review
   follow-up: if a reviewer-requested run finishes without a review result and
   the issue remains `in_review`, Rudder may enqueue review follow-up.
7. Synchronize `doc/product/**` with Agent Run scenes, trigger/source
   semantics, and instruction-loading contents.

This implementation will not rename the physical `heartbeat_runs` table. The
table remains the compatibility persistence table while Agent Run is the product
facade.

## Acceptance Criteria

- Assignment and issue-comment/mention/reopen runs derive `scene=issue`.
- Reviewer-requested and reviewer follow-up runs derive `scene=review`.
- Timer and manual `Run heartbeat` runs derive `scene=heartbeat`.
- Chat and automation runs derive `scene=chat` and `scene=automation`.
- Only `scene=heartbeat` loads `# Rudder Heartbeat Instruction`.
- Ordinary issue comments no longer wake the assignee unless the assignee is
  mentioned.
- Reopen-by-comment persists an assignee mention when the author did not mention
  the assignee, and the wake reason remains `issue_reopened_via_comment`.
- Product contracts list each scene, trigger family, flow, and
  agent-visible instruction content.

## Verification Plan

- Add failing tests before implementation for runtime scene derivation and
  heartbeat instruction exclusion.
- Add route tests for issue comments:
  - ordinary comment with assignee but no mentions does not enqueue an assignee
    wake.
  - mention comment wakes mentioned agents.
  - reopen comment appends an assignee mention if needed and enqueues reopen
    wake.
- Run targeted tests for shared runtime utilities, agent runtime adapters, issue
  lifecycle/comment routes, and product logic.
- Run the route-required verifier gate after writer checks.
- Run spawned reviewer gates after verifier `PASS`.

## Review And Handoff Gates

The lifecycle route for this plan is:

```text
implementation -> writer checks -> verifier acceptance -> spawned review -> commit/push
```

Reviewer lenses:

- Functional trust: scene derivation, instruction-loading tests, comment wake
  behavior, doc/product sync.
- Adversarial: source/trigger/scene confusion, hidden prompt regressions,
  legacy `heartbeat_runs` compatibility, comment notification surprises.
- Heuristic/product-systems: whether the five-scene taxonomy stays teachable
  and whether review follow-up is named without redundant governance language.
