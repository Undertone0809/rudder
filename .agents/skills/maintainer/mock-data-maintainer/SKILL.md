---
name: mock-data-maintainer
description: "Use when creating realistic Rudder mock, demo, seed, fixture, screenshot, test, CSV, JSON, SQL, TypeScript, or scenario data for local development, demos, screenshots, product explanations, and workflow validation."
---

# Mock Data Maintainer

## Overview

Create coherent scenario data that supports testing, demos, screenshots, and user understanding.

## When to Use

Use this skill when:

- the user asks for mock, demo, seed, fixture, synthetic, screenshot, CSV/JSON/SQL, or TypeScript data
- a workflow needs realistic records to explain or validate behavior
- landing screenshots need a demo org dataset
- tests need production-shaped edge states

Do not use this skill when:

- random fake records with no scenario spine
- real customer or private data unless explicitly approved and safe
- screenshot capture itself; coordinate with landing-proof-shots-maintainer

## Core Pattern

```text
intent -> scenario spine -> entities/states -> output format -> seed ledger -> regression checks
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Testing data | Prioritize deterministic edge states |
| Screenshot/demo data | Use landing or studio scenarios |
| User-scenario explanation | Make the workflow legible |
| Live seed | Record org, writes, cleanup, and collision handling |

## Implementation

1. Classify the intent: testing, screenshot/demo, scenario explanation, or static artifact.
2. Select only relevant references and bundled scripts.
3. Build one coherent scenario spine before generating entities.
4. Output data in the requested format with deterministic names and ids when useful.
5. Record seed ledger, usage instructions, and cleanup expectations.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `references/`, `scripts/`, `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Generating random isolated rows | Build a coherent workflow scenario. |
| Mutating a live instance without ledger | Record writes and cleanup. |
| Ignoring existing demo org collisions | Detect and handle collisions intentionally. |
| Using landing data for unrelated tests without adaptation | Select the right scenario reference. |
