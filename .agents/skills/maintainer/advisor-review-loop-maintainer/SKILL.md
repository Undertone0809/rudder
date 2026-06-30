---
name: advisor-review-loop-maintainer
description: "Use when Rudder development work needs first-principles advisor analysis plus independent reviewer rounds: proposals, UI/product decisions, architecture, release readiness, workflow changes, agent outcomes, explicit acceptance gates, repeated review, or “没有通过 review 返工”."
---

# Advisor Review Loop Maintainer

## Overview

Run a decision-grade advisor-to-reviewer loop for Rudder work that should not be accepted after one author pass. It does not replace implementation, black-box product verification, or release execution skills.

## When to Use

Use this skill when:

- the user asks for Build Advisor plus reviewer agents
- the work needs first-principles scenario, requirement, or corner-case analysis before acceptance
- the user asks for repeated review rounds, acceptance gates, or rework until review passes
- a proposal, skill, workflow, UI, architecture, release, or agent outcome needs independent pressure before handoff

Do not use this skill when:

- narrow bug fixes where implementation is already clear
- simple command execution
- ordinary code review without advisor analysis
- release execution without an advisor/reviewer loop

## Core Pattern

```text
evidence packet -> advisor artifact -> reviewer lens gate -> rework list -> targeted next review -> final handoff
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Fuzzy high-stakes request | Build advisor packet first |
| Needs independent pressure | Spawn reviewers after the advisor artifact exists |
| Consequential work | Use functional trust, adversarial, and heuristic/product-systems lenses |
| Reviewer finds blockers | Convert to rework list and rerun review |
| User asked only for advice | Use build-advisor instead |

## Implementation

1. Build a compact evidence packet from user request, repo state, relevant docs, and named artifacts.
2. Run the advisor pass to produce scenarios, requirements, options, risks, and recommended path.
3. Spawn independent reviewers only after there is an artifact to judge.
4. Merge reviewer findings into concrete rework items, revise, and run the requested next round.
5. Hand off with advisor conclusion, reviewer verdicts, unresolved risks, and next decision.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Skipping the advisor artifact and spawning reviewers immediately | Produce the scenario/requirement artifact first. |
| Treating reviewer comments as optional decoration | Convert blockers into rework before handoff. |
| Using this for a small obvious fix | Route to the narrow maintainer or normal implementation workflow. |
| Accepting one author pass when the user asked for repeated rounds | Run the requested review loop or report why it is blocked. |
