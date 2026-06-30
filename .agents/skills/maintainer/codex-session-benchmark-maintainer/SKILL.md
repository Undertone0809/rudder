---
name: codex-session-benchmark-maintainer
description: "Use when benchmarking local Codex sessions against recent history: target session comparisons, recent 30/50/100 session cohorts, efficiency, follow-up rate, interruption, rework, problem-resolution proxies, workflow quality, or skill/workflow improvement signals."
---

# Codex Session Benchmark Maintainer

## Overview

Compare a target Codex session or session class against a clean local cohort using explicit proxy metrics and caveats.

## When to Use

Use this skill when:

- the user gives a Codex session id and asks how it compares
- the user asks for recent 30/50/100 session benchmark or efficiency analysis
- the desired output is proxy metrics, failure classes, and workflow improvement recommendations
- session quality must be compared against local history rather than judged in isolation

Do not use this skill when:

- review-only product verdicts; use codex-session-product-reviewer-maintainer
- cohort-only skill hygiene when the deliverable is which skill to optimize
- raw conversation search with no benchmark question

## Core Pattern

```text
target -> clean cohort -> proxy metrics -> baseline comparison -> workflow recommendation
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Target session supplied | Resolve logs and session metadata first |
| Recent cohort requested | Deduplicate roots and exclude current/spawned noise |
| Outcome metric requested | Label proxy metrics and caveats |
| Skill recommendation requested | Map repeated failures to existing owners before proposing new skills |

## Implementation

1. Resolve the target session and local rollout path.
2. Build a clean comparable cohort from local SQLite/session evidence.
3. Extract proxy metrics such as turns, follow-ups, interruptions, spawned children, commits, and validation evidence.
4. Classify outcome and failure modes with caveats.
5. Recommend the smallest workflow or skill improvement supported by the cohort.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Treating proxy metrics as true satisfaction | Name the caveat and avoid overclaiming. |
| Letting spawned children pollute the cohort | Collapse to root sessions first. |
| Benchmarking without a target or cohort boundary | Ask or infer the smallest defensible cohort. |
| Inventing a new skill from one cluster | Compare against existing maintainers first. |
