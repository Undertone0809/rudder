---
name: debug-run-transcript
description: "Use when analyzing Rudder agent run transcripts, run logs, execution traces, partial run IDs, stdout/stderr, tool calls, runtime errors, failed agent execution, or questions about what happened during a run."
---

# Debug Run Transcript

## Overview

Reconstruct what happened during a Rudder agent run from the best available transcript source.

## When to Use

Use this skill when:

- the user mentions a run id, partial run id, transcript, run log, stdout/stderr, or failed agent execution
- the question is what happened during the run
- tool calls, output shape, metadata, or continuity need diagnosis

Do not use this skill when:

- prove a product fix works; debugging explains the failure, verification proves the fix
- start with raw SQL when run-intelligence or logs are available

## Core Pattern

```text
run id -> run-intelligence source -> log fallback -> DB fallback -> execution story
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Run id or prefix | Resolve the run first |
| API available | Use run-intelligence path |
| API unavailable | Use filesystem logs |
| Only targeted metadata needed | Use direct DB fallback carefully |

## Implementation

1. Identify the run and runtime context.
2. Use run-intelligence loader/API first.
3. Fall back to filesystem logs when the API is unavailable.
4. Use direct DB queries only for targeted checks.
5. Report summary, timeline, key evidence, and raw log pointers.

Reference files are part of this skill contract. Before executing high-risk actions or final judgments, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Starting with broad SQL | Use source priority first. |
| Confusing parser gaps with runtime failure | Compare raw log and parsed transcript. |
| Treating diagnosis as fix proof | Route fixes to product verification. |
| Dumping raw logs without explanation | Reconstruct the story and cite key evidence. |
