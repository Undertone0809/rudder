---
name: development-lifecycle-router-maintainer
description: >
  Route Rudder development work across the full lifecycle: intake, requirement
  framing, product/advisor analysis, UI design, implementation, testing,
  evidence collection, review gates, rework, commit, push, and handoff. Use
  when the user gives an ambiguous or end-to-end development request, asks which
  workflow or skill should handle a task, wants to enter at any lifecycle stage,
  wants reviewer subagents after each stage, or expects review by default before
  handoff. Prefer spawned reviewers for review gates. Prefer narrower
  maintainer skills directly when the user clearly asks for a release, UI
  polish, run transcript debug, local preview, data diagnosis, PR preview, or
  review-only task.
---

# Development Lifecycle Router Maintainer

This skill is the routing layer for Rudder development work. It decides which
stage the user is entering, selects the right downstream skill or normal coding
workflow, defines the stage exit criteria, and adds review gates when needed.
By default, every routed development stage should end with a review gate before
handoff or before moving to the next consequential stage.

It should stay thin. Do not copy the full logic of advisor, reviewer, UI,
release, debug, or preview skills into this file. Route to those skills and
follow their contracts.

## When To Use

Use this skill when the user asks for any of:

- an end-to-end development workflow from requirement to implementation,
  testing, review, and handoff
- a general "which skill/workflow should handle this?" decision
- lifecycle routing when the user may enter from requirements, UI design,
  implementation, testing, CI, release, debug, or review
- stage-by-stage reviewer gates, reviewer subagents, or "review after every
  phase"
- repair of a previous agent run where the failure was weak routing, skipped
  review, wrong stage, or premature implementation
- continuation after `turn_aborted`, rollback, stash/worktree confusion, or a
  long `/goal` run where the agent must recover the real current state before
  resuming
- creating or improving a reusable workflow for development tasks

Do not use this skill as a substitute for a clearly matched narrow skill. If
the user asks only to release, debug a run, review a Codex session, preview a
PR, seed mock data, polish a screenshot, or stop dev processes, use the
specialized skill directly.

## Core Rule

Route first, then execute.

Before editing files, running long validation, spawning reviewers, or committing,
state the lifecycle stage and the acceptance bar for leaving that stage. The
router fails when it silently jumps from a user complaint to implementation, or
when it claims review happened without real reviewer evidence.

Default to review. Prefer real spawned reviewers when the current user request
and runtime policy allow subagents. Use a serial fallback when subagents are
unavailable, not authorized by the active tool policy, the user explicitly asks
for a lightweight single-agent pass, or the task is a truly mechanical no-code
operation.

## Stage Classifier

Classify the prompt into one primary stage:

- `intake`: user intent, target artifact, and mode are unclear.
- `requirements`: user wants problem framing, scenarios, acceptance criteria,
  or "do you understand?"
- `advisor`: the current build, UI, workflow, trace, or proposal feels wrong and
  needs first-principles diagnosis.
- `ui_design`: user asks for interface direction, wireframe, visual hierarchy,
  or screenshot-based product/design judgment before code.
- `implementation`: user approved a direction or directly asks to fix/build.
- `verification`: user asks whether tests, CI, E2E, screenshot, Desktop smoke,
  or release checks prove the work.
- `review`: user asks for review, PM judgment, first-principles critique, or a
  Codex/session/PR/commit verdict.
- `debug`: user asks why a run, UI path, data path, CI job, Desktop app, or
  local process failed.
- `release`: user asks for canary/stable release, npm, Desktop assets, tags, or
  GitHub Release state.
- `handoff`: work is implemented and needs final summary, validation, commit,
  push, residual risk, or PR.

If multiple stages are present, choose the earliest blocking stage. Example:
"fix this and review it" starts at `implementation`, then must pass
`verification` and `review` before handoff.

## Routing Matrix

Use the smallest matching workflow:

- Vague dissatisfaction, weak result, unclear product/design critique:
  `build-advisor`.
- High-stakes proposal or implementation that must pass reviewer rounds:
  `advisor-review-loop-maintainer`.
- Review-only of a session, PR, commit, proposal, UI state, release, or agent
  outcome: `agent-work-reviewer-maintainer` or
  `codex-session-product-reviewer-maintainer` for local Codex session ids.
- Codex session benchmarking against recent local session history, efficiency,
  follow-up rate, token/cost hints, or problem-resolution proxy metrics:
  `codex-session-benchmark-maintainer`.
- Screenshot-driven visible UI polish or small UI interaction fix:
  `rudder-ui-polish-maintainer`.
- Wrong, missing, stale, or sparse data on a Rudder surface:
  `rudder-data-path-diagnostician-maintainer`.
- Rudder agent run failure, transcript, logs, stdout/stderr, or run id:
  `debug-run-transcript`.
- Local Rudder Desktop dev startup, Electron shell, embedded Postgres,
  prod-local instance confusion, or update/install failure before release:
  `rudder-desktop-dev-recovery-maintainer`.
- Release, canary/stable publish, npm dist-tag, Desktop release asset, or
  release workflow failure: `release-maintainer`.
- Local branch preview for user testing: `rudder-worktree-preview-maintainer`.
- GitHub PR local checkout/preview/review: `pr-local-preview-maintainer`.
- Mock/demo/seed data or landing screenshots: `mock-data-maintainer`, then
  `landing-proof-shots-maintainer` when screenshots are the deliverable.
- Stop, restart, or clean repo-local dev runtime:
  `stop-rudder-dev-maintainer`.
- New or updated skill artifact: use `skill-creator` guidance plus this router
  for lifecycle gates.

If the route is obvious, do not run an advisor loop just because this router is
active. State the route briefly and execute the specialized workflow.

## Default Workflow

### 1. Build a routing packet

Collect only the evidence needed to choose the route:

- user request and any corrections in this thread
- current `git status --short --branch`
- named files, screenshots, session ids, run ids, PRs, commits, or plans
- relevant repo docs based on `AGENTS.md`
- nearby skill contracts when choosing between skills

Ignore injected environment text and broad repo scanning unless it affects the
route. If the user gave a Codex session id, extract the real user prompts and
agent actions before judging the workflow.

### 2. Declare route and stage exits

Before implementation, say:

- lifecycle stage now
- downstream skill or normal coding workflow selected
- acceptance bar for the current stage
- review gate plan, with `spawned reviewers` as the preferred mode

Keep this concise. For a small bug, one sentence is enough.

### 3. Execute the current stage

Follow the downstream skill or normal repo workflow. Each stage must produce a
concrete artifact:

- requirements: scenario map, non-goals, acceptance criteria
- advisor: diagnosis, options, recommendation, decision boundary
- UI design: wireframe, screenshot criteria, or approved direction
- implementation: scoped diff, tests, docs or contract updates as needed
- verification: passing checks, screenshots, logs, or explicit blockers
- review: verdict, blocking gaps, smallest fixes, residual risk
- release: locked source ref, live publish/asset/dist-tag evidence
- handoff: files, validation, commit/push state, unverified items

Do not move to the next stage when the current stage has a blocker that changes
the route.

### 3.1 Recover continuation state before resuming work

When the thread resumes after `turn_aborted`, rollback, compaction, a long
`/goal` run, unexpected stash creation, or work that spans multiple Codex
sessions, rebuild state before editing or handing off:

- Read the newest user request and compare it with the original task. Do not
  continue an older ghost task if the user redirected the work.
- Check `git status --short --branch`, recent commits, stashes, and touched
  files relevant to the task. Treat unrelated dirty files as user work unless
  evidence shows they belong to this task.
- Inspect prior session evidence when the user names sessions or says "刚才",
  "之前", "正在处理", or "别把功能弄没了".
- Reconstruct the current phase, files changed, validation already run,
  blockers, and next safe command before continuing.
- Before final handoff, verify that the final answer, commit, and push state
  correspond to the latest user request, not a stale pre-interruption stage.

If a stash exists, classify it before applying or dropping it: source session,
files included, overlap with current task, and whether applying it would
overwrite unrelated work. Do not drop or pop a stash just to clean up state.

### 4. Run default review gates

Use review gates by default for every routed stage that produces an artifact,
decision, diff, validation bundle, or handoff. This includes narrow bug fixes:
implement first, collect verification evidence, then review the actual diff and
evidence before final handoff.

Escalate the review depth when:

- the user explicitly asks for reviewer agents, two rounds, or "not done until
  review passes"
- the work is a workflow/skill/proposal that will shape future agent behavior
- the change is broad, user-visible, release-related, Desktop/package-related,
  or cross-contract
- a prior run failed because it skipped review or used the wrong stage

Skip or defer the review gate only when:

- the user explicitly says not to review
- the current task is review-only and the review itself is the artifact
- the work is a truly mechanical no-code operation such as a quick status check
- the stage has no artifact yet; create the artifact first, then review it

Prefer spawned reviewers. When subagents are available and authorized by the
current user request and active tool policy, spawn reviewers after the stage
artifact exists. Record execution mode as `spawned reviewers`.

If subagents are unavailable or not authorized, run a labeled serial two-role
fallback. Record execution mode as `serial two-role fallback`, say independence
confidence is lower, and do not imply independent review happened.

Reviewer A owns scenario correctness:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review the stage artifact as the scenario and demand reviewer. Focus on user
job, actors, lifecycle states, non-goals, requirement classes, edge cases, and
whether this stage solves the right problem. Give accept / conditional accept /
reject, blockers, and smallest changes needed.
```

Reviewer B owns delivery trust:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review the stage artifact as the implementation, validation, and handoff
reviewer. Focus on object model, scope discipline, org scoping, contracts,
tests, visual/Desktop/release evidence when relevant, git safety, and handoff
quality. Give accept / conditional accept / reject, blockers, and smallest
changes needed.
```

If either reviewer rejects or names a blocker, rework before final handoff or
report the blocker as requiring user judgment.

### 5. Keep git safe in shared worktrees

Always inspect branch and dirty state before edits and before commit.

- Stage only files from the current task.
- For large refactors or `/goal` runs, split commits by coherent phase when
  the phase can stand on its own: facade/boundary setup, internal extraction,
  consumer rewiring, compatibility fix, test hardening, or docs update.
- When the user says "分批 commit" or "不要一个很大的 commit", make a phase
  checklist before the first commit and preserve a resumable checkpoint after
  each phase: current phase, files touched, validation state, known blockers,
  and next command or edit target.
- Do not batch unrelated route, UI, runtime, migration, and docs cleanup into a
  single commit just because they were discovered during one long run.
- Do not amend unless HEAD is confirmed to be your own just-created commit and
  no parallel commits have appeared.
- Prefer a normal follow-up commit over history rewrite in a shared workspace.
- Do not push when the branch is behind, non-fast-forward, or includes unrelated
  local commits that the user did not ask to publish.
- If push is blocked, still make the scoped local commit when repo rules require
  a commit, and explain the branch state.

### 6. Final handoff

Final output should include:

- route taken and stages completed
- downstream skills used or deliberately skipped
- review execution mode, if any
- files or artifacts changed
- validation passed and not run
- commit and push status
- remaining blockers or human decisions

## Acceptance Bar

Do not hand off as complete when any of these are true:

- the route was never stated and the agent silently jumped stages
- a narrow specialized skill was bypassed for a heavyweight advisor loop
- reviewer gates were requested but no real review artifact was produced
- "review" only means the author reread their own diff without findings
- user-visible UI lacks rendered or screenshot evidence when required
- feature/workflow changes skip required E2E coverage without explicit approval
- Desktop/release/package work lacks the repo-required packaged or live checks
- git history includes unrelated files or an unsafe amend in a shared worktree
- final answer hides failed checks, skipped evidence, or push blockers

## Common Routes

### Small UI bug with review requested

Route: `implementation -> verification -> review -> handoff`.

Use the UI or Desktop-specific workflow needed for the bug. Review after the
diff and tests exist. Do not run a full advisor loop unless the bug reveals an
unclear product decision.

### Small UI bug without explicit review request

Route: `implementation -> verification -> review -> handoff`.

Default review still applies. Keep the review lightweight when the bug is
narrow, but produce a real verdict and blocker assessment before handoff.

### Proposal-only request

Route: `requirements -> advisor -> review -> handoff`.

Do not implement. Produce the decision artifact, run reviewer gates if asked,
and stop with verdicts, blockers, and next decision.

### Codex session audit

Route: `review`.

Use `codex-session-product-reviewer-maintainer`, extract real user requests and
agent actions from local session logs, then give a verdict. Do not edit files
unless the user later switches to rework.

### Failed run or transcript problem

Route: `debug -> review or implementation`.

Use `debug-run-transcript` first to reconstruct what happened. Only switch to
implementation after the root cause and target fix are clear.

### Release request

Route: `release`.

Use `release-maintainer` directly. Live remote state is the source of truth.

## Output Template

```markdown
Route: ...
Stage exits:
- ...

Used:
- ...

Review:
- Mode: spawned reviewers / serial two-role fallback / not required
- Verdict: ...

Validation:
- Passed: ...
- Not run / not proven: ...

Git:
- Commit: ...
- Push: ...

Residual risk:
- ...
```
