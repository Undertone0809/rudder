---
name: rudder-performance-architecture-maintainer
description: "Use when Rudder needs performance or architecture optimization: slow pages, skeleton loops, query cache misses, refetch storms, large-org over-fetching, payload budgets, expensive API/DB paths, hot files, boundaries, measurement, or ZStudio-scale proof."
---

# Rudder Performance Architecture Maintainer

## Overview

Find and fix Rudder performance or architecture bottlenecks with measurements, scoped changes, and regression evidence.

## When to Use

Use this skill when:

- the user asks why a page/API is slow or refetching
- large org or ZStudio-scale data exposes over-fetching or payload issues
- query keys, staleTime, invalidation, cache, or render cost may be wrong
- architecture boundaries, hot files, or duplicated data paths need cleanup
- the task asks to capture performance know-how

Do not use this skill when:

- pure visual polish
- missing-data diagnosis with no performance question
- release operations
- Desktop startup recovery

## Core Pattern

```text
context -> baseline measurement -> path trace -> smallest fix -> regression coverage -> remeasure -> know-how
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Broad optimization | Load checklist and recent-thread signals |
| Known slow path | Measure before changing |
| Large-org proof | Calibrate dataset and runtime |
| Architecture fix | Keep product contracts stable |

## Implementation

1. Load relevant optimization references for non-trivial work.
2. Record workload, dataset, route/API, and baseline measurement.
3. Trace UI, API, service, DB, cache, and rendering path end to end.
4. Choose the smallest correct fix with rollback boundary.
5. Add focused regression coverage and re-measure.
6. Record reusable know-how when requested.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `references/`, `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Optimizing without a baseline | Measure first. |
| Tuning the UI while API is the bottleneck | Trace end to end. |
| Using toy data for scale claims | Use calibrated dev pressure data or label limitation. |
| Refactoring broad hot files without a slice | Choose one measurable fix. |
