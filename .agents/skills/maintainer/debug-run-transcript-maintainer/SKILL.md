---
name: debug-run-transcript-maintainer
description: "Use when analyzing one Rudder agent run or recent run batches: run IDs, partial IDs, transcripts, run logs, execution traces, runtime failures, finalizer failures, stdout/stderr, run quality, or recent org run behavior."
---

# Debug Run Transcript Maintainer

## Overview

Diagnose one run or a recent run batch by reconstructing execution from run-intelligence, logs, and targeted DB evidence.

## When to Use

Use this skill when:

- the user asks why an agent run failed
- the user names a run id, run prefix, org, runtime, or timeframe
- recent run quality or batch behavior needs analysis
- tool success and Rudder final status disagree

Do not use this skill when:

- claim a product fix is proven from transcript diagnosis alone
- skip run-intelligence and jump to raw DB guesses

## Core Pattern

```text
identify run/batch -> source priority -> failure classification -> evidence -> next route
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Single run | Resolve and reconstruct transcript |
| Recent batch | Build bounded cohort and classify failures |
| Finalizer failure suspected | Separate tool result from stream/persistence/UI status |
| Fix required | Hand back to lifecycle verification path |

## Implementation

1. Identify run, org, runtime, or batch window.
2. Use run-intelligence loader/API first, filesystem logs second, direct DB last.
3. Classify root cause: model/runtime, tool call, parser, event stream, persistence, UI status, or continuity.
4. Separate diagnosis evidence from fix proof.
5. Report what happened, key evidence, and next route.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Treating run debug as implementation | Debug first, then route fixes separately. |
| Using DB rows as full transcript truth | Prefer run-intelligence/log source. |
| Merging finalizer and tool failures | Diagnose them separately. |
| Over-scanning recent runs | Bound the cohort and state filters. |
