---
name: rudder-desktop-dev-recovery-maintainer
description: "Use when Rudder local Desktop development, Electron shell, embedded Postgres, ~/.rudder instance state, dev startup, update/install smoke, packaged boot, or release-blocking local Desktop validation fails or needs recovery."
---

# Rudder Desktop Dev Recovery Maintainer

## Overview

Recover local Rudder Desktop development and validation paths before release or handoff work continues.

## When to Use

Use this skill when:

- pnpm dev starts API but Desktop/Electron fails
- embedded Postgres or ~/.rudder instance state is confusing
- Desktop update/install/local packaged smoke fails
- release work is blocked by local Desktop validation
- dirty WIP compile failures block Desktop startup

Do not use this skill when:

- npm/GitHub release publishing; use release-maintainer after local Desktop state is clear
- generic UI bugs in the browser app
- destructive profile cleanup without state evidence

## Core Pattern

```text
failure mode -> Desktop docs/contracts -> active runtime -> narrow repair -> dev/packaged validation -> handoff/escalation
```

## Quick Reference

| Situation | Action |
| --- | --- |
| API works, Desktop fails | Separate API, UI, Electron, and profile layers |
| Embedded DB confusion | Inspect active instance and paths |
| Release blocked | Fix local Desktop first, then route release |
| Packaged path touched | Run packaged verification |

## Implementation

1. Classify the failure mode and current command path.
2. Read Desktop and development docs relevant to the failure.
3. Verify active runtime, ports, profile, database, and logs before repair.
4. Repair narrowly without overwriting unrelated dirty work.
5. Validate dev shell or packaged path as required.
6. Hand off blocker, commands, logs, and escalation route.

Reference files are part of this skill contract. Before executing high-risk actions or final judgments, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Treating browser API health as Desktop proof | Validate Electron or packaged path when relevant. |
| Deleting ~/.rudder before diagnosis | Inspect instance state first. |
| Mixing release work into recovery | Escalate to release-maintainer after recovery. |
| Claiming done without packaged smoke for packaging changes | Run desktop verification or report blocker. |
