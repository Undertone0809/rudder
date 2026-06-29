---
name: agent-work-reviewer-maintainer
description: "Use when reviewing Rudder agent work, Codex sessions, PRs, commits, UI, releases, regressions, proposals, or agent outcomes for product correctness, evidence quality, scope, architecture, and handoff trust."
---

# Agent Work Reviewer Maintainer

## Overview

Review completed or in-progress Rudder agent work from product, engineering, and evidence perspectives.

## When to Use

Use this skill when:

- the user asks to review a Codex session, PR, commit, diff, release, UI, proposal, or agent outcome
- the task needs first-principles product judgment rather than implementation
- the user asks whether validation, screenshots, CI, or handoff evidence is trustworthy
- a reviewer verdict is needed: accept, conditional accept, needs more evidence, or reject

Do not use this skill when:

- black-box acceptance verification as the main task; use product-acceptance-verifier-maintainer
- implementation or fixing the issue under review unless the user switches modes
- generic advice with no concrete artifact

## Core Pattern

```text
target artifact -> user intent -> product context -> proven evidence -> reviewer verdict
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Codex session review | Read local session evidence before judging |
| UI or workflow review | Run the real scenario when available |
| Release/Desktop review | Check live or packaged evidence |
| Skill/contract review | Separate author-claimed proof from reviewer-verified proof |

## Implementation

1. Identify the target and the user job the work was supposed to solve.
2. Collect the diff, session transcript, screenshots, tests, CI, logs, and handoff claims.
3. Read relevant product or engineering contracts before judging behavior.
4. Separate author-claimed proof from reviewer-verified proof.
5. Return findings first, then verdict, blockers, and smallest next action.

Reference files are part of this skill contract. Before executing high-risk actions or final judgments, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Reviewing only the diff when product behavior matters | Exercise or inspect the terminal product path. |
| Accepting author screenshots as reviewer proof | Mark them as author-claimed unless you verified them. |
| Fixing during a review-only task | Stay read-only unless the user changes the task. |
| Giving a vague PM opinion | Ground every finding in file, session, UI, test, or product-contract evidence. |
