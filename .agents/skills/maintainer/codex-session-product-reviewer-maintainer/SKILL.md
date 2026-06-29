---
name: codex-session-product-reviewer-maintainer
description: "Use when reviewing a local Codex session, task, thread, or commit as a product manager or first-principles reviewer for product correctness, scope, behavior, validation, and whether the task solved the right user problem."
---

# Codex Session Product Reviewer Maintainer

## Overview

Review a Codex session from the product-manager side: did it solve the right problem with credible behavior and proof?

## When to Use

Use this skill when:

- the user gives a Codex session id and asks for PM or first-principles review
- the user wants to judge whether another agent solved the right product problem
- a proposal or implementation needs accept/conditional/reject product critique
- the task asks for review, not implementation

Do not use this skill when:

- fixing code during a review-only request
- benchmarking a session against a large cohort; use codex-session-benchmark-maintainer
- black-box product acceptance as the main task

## Core Pattern

```text
session evidence -> intended user job -> product frame -> validation check -> verdict
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Session id supplied | Read local transcript and related repo artifacts |
| PM review requested | Start from user job and product object model |
| Validation disputed | Separate what was run from what was assumed |
| Implementation follow-up requested | Hand off after verdict or switch modes explicitly |

## Implementation

1. Resolve the session and extract actual user requests, agent actions, files, commits, and validation.
2. Read relevant product docs or code paths for the task.
3. Apply the review frame: user job, object model, scope, behavior, validation, handoff.
4. Return verdict early with findings and smallest next fix or decision.

Reference files are part of this skill contract. Before executing high-risk actions or final judgments, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Reviewing from the assistant summary instead of transcript evidence | Read the local session/log artifacts. |
| Treating tests as product correctness when the scenario was wrong | Judge against the user job. |
| Mixing review with implementation | Stay read-only unless redirected. |
| Ignoring missing validation | Make missing proof a blocker or residual risk. |
