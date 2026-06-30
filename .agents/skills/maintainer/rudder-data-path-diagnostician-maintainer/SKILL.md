---
name: rudder-data-path-diagnostician-maintainer
description: "Use when Rudder pages or product surfaces show missing, stale, sparse, empty, slow, or wrong data, including Calendar, runs, issues, dashboard counts, chat output, prod/local org data, API/UI/DB mismatches, or “这个数据从哪来”."
---

# Rudder Data Path Diagnostician Maintainer

## Overview

Trace Rudder surface data from UI query through API, service aggregation, database rows, derived sources, org scope, and runtime instance.

## When to Use

Use this skill when:

- a Rudder screen has missing, stale, sparse, empty, or wrong data
- the user asks where a value comes from
- UI, API, service, DB, org scope, or runtime source might disagree
- the task is evidence-backed lineage or root cause before fixing/seed changes

Do not use this skill when:

- pure visual polish where data is correct
- broad performance tuning; use performance maintainer
- guess from screenshot without tracing the chain

## Core Pattern

```text
symptom -> environment/org -> UI query -> API/service -> source rows -> root cause -> fix or explanation
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Missing page data | Confirm environment and org first |
| Wrong count | Trace API aggregation and filters |
| Explainer mode | Read source/code path before DB if enough |
| Fix requested | Keep org scope and product contracts aligned |

## Implementation

1. Confirm target environment, org, route, and symptom.
2. Identify UI query/client state and API route.
3. Inspect service aggregation and filters.
4. Read source rows safely when needed.
5. Classify root cause and recommend or implement the narrow fix.
6. Hand off lineage, evidence, and verification status.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Assuming empty UI means empty DB | Trace filters and org/runtime first. |
| Jumping to seed data | Diagnose source chain before seeding. |
| Ignoring derived data generation | Check derivation jobs/services. |
| Fixing without org scoping checks | Preserve organization boundaries. |
