---
name: stop-rudder-dev-maintainer
description: "Use when the user explicitly asks to stop, restart, kill, or clean Rudder repo-local pnpm dev processes or local dev runtime residue, including “把 pnpm dev 停了”, “重启 dev”, or “清掉 dev 残留”."
---

# Stop Rudder Dev Maintainer

## Overview

Stop Rudder repo-local development runtimes safely without broad machine process cleanup.

## When to Use

Use this skill when:

- the user specifically asks to stop or restart pnpm dev
- repo-local dev processes or ports need cleanup
- the user asks for a safe preflight stop before another task

Do not use this skill when:

- production/local-prod data, packaged Desktop, organizations, backups, migrations, or API maintenance unless stopping dev is explicitly requested
- pkill broad process names by default
- stop packaged Desktop or embedded prod Postgres unless explicitly asked

## Core Pattern

```text
applicability check -> bundled stop script -> verify process/port state -> report
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Stop dev | Run bundled script first |
| Restart dev | Stop, verify, then start only if requested |
| Unrelated task mentions this skill | Treat as optional preflight only |
| Packaged Desktop running | Leave it alone unless explicitly in scope |

## Implementation

1. Classify whether the current task is truly repo-local dev runtime cleanup.
2. Use the bundled stop script before ad-hoc process commands.
3. Verify whether Rudder dev processes or ports remain.
4. Report what was stopped, what was not running, and any residual blocker.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `scripts/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Broad pkill across the machine | Target only Rudder repo dev processes. |
| Spending time on process lists for unrelated tasks | Run at most the requested preflight. |
| Stopping packaged Desktop by accident | Keep packaged/local-prod out of scope. |
| Restarting when user only asked to stop | Do exactly the requested runtime action. |
