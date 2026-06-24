---
name: development-lifecycle-router-maintainer
description: "Route ambiguous or multi-stage Rudder development work across requirements, advisor/product analysis, UI design, implementation, verification, review, release, recovery, and handoff. Use when the request needs stage selection, cross-stage sequencing, reviewer gates, interrupted-run or dirty-worktree recovery, component-lab/performance/runtime-contract routing, or a decision about whether a named maintainer skill should be optimized. Keep thin: if a narrow maintainer clearly owns the task, state that route and follow it."
---

# Development Lifecycle Router Maintainer

This skill is a routing layer, not a second copy of every downstream workflow.
Use it to choose the current lifecycle stage, name the exit bar, and hand off to
the smallest capable maintainer skill or normal coding workflow.

The reason this skill exists is to prevent two expensive mistakes:

- jumping from a complaint into implementation before the correct stage is known
- calling a stage complete without the product proof or reviewer evidence that
  the user's request actually requires

Keep this file thin. Load the reference files below only when the current route
needs them.

## Reference Map

- `references/route-selection.md`: stage classifier, narrow-skill routing,
  meta-request precedence, and skill-optimization boundaries.
- `references/verification-review.md`: verifier gates, terminal product proof,
  spawned reviewer policy, reviewer lenses, and evidence ledger.
- `references/special-routes.md`: recovery, component lab, performance
  benchmark, runtime/provider contracts, and hard real-local validation.
- `references/handoff-git.md`: git safety, final handoff shape, acceptance
  blockers, and common route templates.

## Fast Start

Before editing files, running long checks, spawning reviewers, or committing:

1. Inspect `git status --short --branch`.
2. Classify the current stage.
3. State the selected route and downstream owner in one concise update.
4. Name the artifact or proof required to leave the current stage.
5. Decide which references are needed for this route and read only those.

For obvious narrow requests, do not expand a lifecycle plan. Say the route,
load the narrow skill, and execute it.

## Non-Use Gate

Use the narrow maintainer directly when all of these are true:

- the prompt names a concrete surface, run, PR, release, screenshot, data path,
  or local runtime problem
- the next useful artifact is obvious for that surface
- the task does not need cross-stage sequencing, reviewer orchestration, or
  destructive recovery judgment before the narrow work can begin

Keep ownership in this router only when it adds value by choosing a stage,
resolving ambiguity, sequencing multiple stages, or protecting a high-risk
handoff.

## Core Rule

Route first, then execute.

State the lifecycle stage and acceptance bar before implementation. The normal
implementation sandwich is:

```text
writer implementation
-> writer basic checks
-> optional lightweight pre-review
-> verifier black-box acceptance
-> final spawned reviewer gate
-> handoff / commit / push
```

Pre-review is only for catching obvious diff, startup, safety, scope, or test
readiness problems before verifier time is spent. It is not the final reviewer
gate. Final review follows verifier `PASS` so reviewers can inspect the diff,
tests, handoff, and verifier evidence together.

Separate verification from review:

- verification asks whether the product path meets the requirement from the
  user's side
- review asks whether the diff, architecture, scope, tests, proof, and handoff
  are trustworthy

## Stage Classifier

Choose one primary stage. If multiple stages are present, choose the earliest
blocking stage.

- `intake`: user intent, target artifact, or mode is unclear
- `requirements`: problem framing, scenarios, acceptance criteria, or "do you
  understand?"
- `advisor`: first-principles diagnosis of a build, UI, workflow, trace, or
  proposal that feels wrong
- `ui_design`: interface direction, wireframe, visual hierarchy, or
  screenshot-based design judgment before code
- `implementation`: approved direction or direct fix/build request
- `verification`: tests, CI, E2E, screenshots, Desktop smoke, actor-run-chain,
  release checks, or black-box acceptance proof
- `review`: review, PM judgment, first-principles critique, or
  Codex/session/PR/commit verdict
- `debug`: failed run, UI path, data path, CI job, Desktop app, or local process
- `release`: canary/stable release, npm, Desktop assets, tags, or GitHub
  Release state
- `handoff`: final summary, validation, commit, push, residual risk, or PR
- `recovery`: dirty worktree, stash, interrupted run, rollback, delete/restore,
  or suspected old Codex work
- `component_lab`: UI Lab, component inventory, fixtures, or design-system
  coverage
- `performance_benchmark`: benchmark or optimize before the exact bottleneck is
  known
- `runtime_contract`: provider/runtime/tool-call/transcript/parser/CLI or
  agent-visible contract parity
- `skill_optimization`: optimize, harden, refactor, validate, benchmark,
  package, or improve a named skill or workflow skill

For full routing detail, read `references/route-selection.md`.

## Narrow Routes

Prefer the smallest matching owner:

- screenshot-driven UI polish: `rudder-ui-polish-maintainer`
- missing, stale, suspicious, or slow page data:
  `rudder-data-path-diagnostician-maintainer`
- run transcript, stdout/stderr, recent run batch, or run-quality issue:
  `debug-run-transcript-maintainer`
- Desktop startup, packaged app, Electron shell, update, profile, local
  instance recovery: `rudder-desktop-dev-recovery-maintainer`
- release, npm, GitHub Release, Desktop assets, tags, dist-tags, install smoke:
  `release-maintainer`
- review-only session/PR/commit/proposal/UI/release outcome:
  `agent-work-reviewer-maintainer` or
  `codex-session-product-reviewer-maintainer`
- local branch preview: `rudder-worktree-preview-maintainer`
- GitHub PR checkout/preview/review: `pr-local-preview-maintainer`
- mock/demo/seed data: `mock-data-maintainer`
- landing screenshots: `landing-proof-shots-maintainer`
- stop/restart/clean local dev runtime: `stop-rudder-dev-maintainer`
- new reusable workflow skill: `skill-creator`
- existing skill optimization: `skill-optimizer`

If this router itself is the target artifact for optimization, route to
`skill-optimizer` or the user-requested skill-engineering workflow. Do not run
this router's normal product lifecycle except for git safety around the patch.

## Skill Optimization Boundary

The newest user instruction is the routing source of truth.

If the user says a skill "needs optimization", "should be hardened", "always
does the wrong thing", "I have to ask this every time", or asks to use
`skill-optimizer`/`skill-creator` on a named skill, classify the turn as
`skill_optimization`.

Treat screenshots, prior requirements, session ids, quoted logs, and prior
assistant recommendations as evidence for the skill failure. They are not the
active product task unless the newest user instruction says to continue that
product task.

For this route:

- name the target skill and path
- extract the failed decision point
- choose the smallest durable owner: target skill body, frontmatter
  description, eval case, memory update, or no-op
- add or update a validation case when the behavior should change next time

## Verification And Review Defaults

For user-visible, agent-visible, Desktop, release, runtime, CLI, workflow, or
control-plane changes, identify the terminal product surface before calling
verification complete. Use `product-acceptance-verifier-maintainer` for a
distinct black-box acceptance pass when the product path is cheap enough to
exercise.

Spawned reviewer gates are the default for routed stage artifacts when the user
explicitly invokes this router or asks for routed review. If spawning is
available and authorized, final reviewers should cover these lenses:

- functional trust
- adversarial
- heuristic/product-systems

Do not replace spawned reviewer verdicts with self-review or serial personas. If
the active runtime cannot spawn reviewers after a real availability probe,
record `blocked: spawned reviewers unavailable` with the probe evidence instead
of claiming review passed.

For the full verifier/reviewer contract, read
`references/verification-review.md`.

## Execution Outline

1. Build a compact routing packet:
   - latest user request and corrections
   - `git status --short --branch`
   - named files, screenshots, sessions, runs, PRs, commits, or plans
   - relevant `AGENTS.md` route docs and nearby skill contracts
   - changed-file ownership if cleanup or recovery is involved
2. Declare route and stage exits.
3. Execute the current stage using the narrow owner or normal repo workflow.
4. Run the required verification and review gates for that route.
5. Hand off with evidence, blockers, git state, and commit/push status.

## Minimal Handoff Shape

```markdown
Route: ...
Stage exits: ...
Used: ...
Review: spawned reviewers / blocked / not applicable
Validation: passed / not run / not proven
Evidence: required / scenario / proven / missing or substituted
Git: commit / push
Residual risk: ...
```
