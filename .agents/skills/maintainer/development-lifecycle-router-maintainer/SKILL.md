---
name: development-lifecycle-router-maintainer
description: "Use when a Rudder development request has an unclear lifecycle stage or owner: requirements, advisor analysis, UI design, implementation, verification, review, release, recovery, runtime contracts, performance, component lab, handoff, or named-skill optimization."
---

# Development Lifecycle Router Maintainer

## Overview

Choose the earliest blocking lifecycle stage, name the exit bar, then route to
the smallest capable maintainer or normal coding workflow.

This skill is a thin router. It prevents two mistakes: starting implementation
before the stage is known, and calling work complete without the proof or review
the request actually requires.

## When to Use

Use this skill when the request is about Rudder development and the next owner
or lifecycle stage is unclear:

- ambiguous requirements, product behavior, UI direction, implementation,
  verification, review, release, recovery, runtime contracts, performance, or
  handoff
- a named maintainer skill may need optimization, hardening, eval work, or
  trigger repair
- the task spans multiple stages, has previous reviewer/verifier blockers, or
  risks unsafe git/recovery decisions

Do not use this skill when a narrow maintainer clearly owns the next artifact:

- review-only verdicts: use `agent-work-reviewer-maintainer` or
  `codex-session-product-reviewer-maintainer`
- concrete UI polish: use `rudder-ui-polish-maintainer`
- concrete data-path diagnosis: use `rudder-data-path-diagnostician-maintainer`
- concrete transcript/run failure: use `debug-run-transcript-maintainer`
- release execution: use `release-maintainer`
- skill creation or skill rewrite already named by the user: use the requested
  skill-engineering workflow directly

## Core Pattern

```text
route packet -> earliest blocking stage -> smallest owner -> exit bar -> execute
```

Before edits, long checks, spawned agents, commits, or destructive recovery:

1. Inspect `git status --short --branch`.
2. Build the minimal routing packet from the newest user request, named
   artifacts, repo state, and relevant AGENTS guidance.
3. State the selected stage, downstream owner, and exit bar in one concise
   update.
4. Load only the reference file needed for that route.
5. Execute the current stage and hand off with evidence, blockers, and git
   state.

For routed development work, the default path is:

```text
writer implementation
-> writer basic checks
-> optional lightweight pre-review
-> spawned verifier black-box acceptance
-> final spawned reviewer gate
-> handoff / commit / push
```

The user does not need to separately say "spawn", "review", "subagent", or
"black-box" for this policy to apply. If spawning is unavailable after a real
probe, record `blocked: spawned verifier/reviewer unavailable` instead of
substituting self-review.

## Quick Reference

| Situation | Route |
| --- | --- |
| Ambiguous product, UX, implementation, verification, or handoff | Build routing packet, choose earliest blocking stage |
| User says a skill needs optimization or links a skill as target artifact | `skill_optimization`; use the requested skill-engineering workflow |
| User invokes this router to continue product work | Keep product route; use this skill only as lifecycle policy |
| User asks for real local proof or says "你试过了吗" | Verification blocker; load `verification-review.md` |
| Dirty worktree, stash, rollback, interrupted run | Recovery; load `special-routes.md` and `handoff-git.md` |
| Commit, push, final handoff, or cleanup | Load `handoff-git.md` |

## Implementation

Reference files are part of the skill contract. Load `references/runbook.md`
before substantive execution or final judgment so the detailed legacy workflow,
examples, validation cases, and command-level guidance are available. Then load
the route-specific reference that matches the active route:

- `references/runbook.md`: complete pre-template router know-how and command-level guidance.
- `references/route-selection.md`: stage classifier, narrow routing,
  meta-request precedence, scope guard, and skill-optimization packet.
- `references/verification-review.md`: verifier gate, spawned reviewer policy,
  terminal product proof, real-local validation, child packets, and evidence
  ledger.
- `references/special-routes.md`: recovery, component lab, performance
  benchmark, runtime/provider contracts, and reviewer lens validation cases.
- `references/handoff-git.md`: git safety, acceptance blockers, final handoff,
  and common route templates.

Use the templates under `agents/` only after there is an artifact or proof packet
for a child verifier/reviewer to judge.

For skill changes, validate with `scripts/benchmark_pipeline.py` when the change
affects routing, verifier/reviewer gates, or eval coverage. The benchmark is an
offline contract check, not live Rudder behavior telemetry.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Following screenshot, transcript, or prior-turn content instead of the newest user instruction | Treat embedded content as evidence; route from the newest user request |
| Editing product code when the user asked to optimize a named skill | Classify `skill_optimization`; patch the skill or eval, not the product task |
| Expanding an obvious narrow task into a broad lifecycle plan | Route directly to the smallest maintainer and state the exit bar |
| Treating author-run tests, CI, screenshots, or self-review as spawned verification/review | Run the child gate or record the real spawn blocker |
| Running final review before verifier `PASS` | Use pre-review only for obvious readiness issues; final review follows verifier evidence |
| Claiming handoff while terminal product proof is missing | Mark proof missing, blocked, or substituted in the evidence ledger |
| Re-spawning broad reviewers for the same artifact and unchanged blocker | Reuse prior gate state; spawn again only when changed evidence exists |
| Touching unrelated dirty files during recovery, commit, or push | Stage only current-task files and preserve unrelated work |

## Handoff Shape

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
