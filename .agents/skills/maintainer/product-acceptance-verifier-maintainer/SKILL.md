---
name: product-acceptance-verifier-maintainer
description: "Use when implemented Rudder feature, UI, workflow, Desktop, CLI, runtime, release, or regression work needs black-box acceptance verification against user requirements and the running product surface."
---

# Product Acceptance Verifier Maintainer

## Overview

Verify delivered Rudder work from the requirement side without editing code or fixing failures.

## When to Use

Use this skill when:

- writer/reviewer work already exists and needs black-box acceptance
- the user asks whether the running product actually meets the requested outcome
- feature, UI, Desktop, CLI, runtime, release, or regression behavior must be exercised
- acceptance depends on real surface behavior, API/DB readback, or disposable product data

Do not use this skill when:

- edit files, stage, commit, push, or fix the bug during verification
- perform general code review unless needed to find the acceptance surface
- replace real requested proof with author claims

## Core Pattern

```text
acceptance target -> run product path -> regression check -> mutation ledger -> PASS/FAIL/QUESTION
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Sort/order requirement | Use data where competing orders differ |
| UI fidelity | Open the route and inspect rendered behavior |
| Runtime/CLI | Exercise actor-run-chain and read back state |
| Failure found | Report FAIL and stop |

## Implementation

1. State actor, trigger, expected effect, and terminal surface.
2. Run the product path through Browser, Computer Use, CLI, API, logs, or DB readback as appropriate.
3. Check nearest regression path.
4. Record mutation ledger for disposable data.
5. Return PASS, FAIL, or QUESTION with observed evidence.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Fixing during verification | Stop and report failure. |
| Accepting reviewer approval as product proof | Run the acceptance path. |
| Using mock data when real-local proof was requested | Mark substituted or blocked. |
| Skipping mutation ledger | Record created records and cleanup. |
