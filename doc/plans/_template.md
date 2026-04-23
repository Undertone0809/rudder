---
title: Plan template guide
date: YYYY-MM-DD
kind: design-note
status: draft
area: planning
entities:
  - doc_plans
issue:
related_plans: []
supersedes: []
related_code:
  - doc/DEVELOPING.md
  - doc/plans/_taxonomy.md
commit_refs: []
updated_at: YYYY-MM-DD
---

# Plan Template Guide

Use this file to choose the right template, not as the default body for every
plan.

All new plan docs should keep the shared YAML frontmatter schema defined in
`doc/DEVELOPING.md`.

## Choose A Template

- `doc/plans/_template-proposal.md`
  Use for new features, bigger product changes, open-ended design/architecture
  work, or anything that needs decision-quality writing before implementation.
- `doc/plans/_template-implementation.md`
  Use for scoped approved work where the direction is already decided and the
  main task is sequencing implementation safely.
- `doc/plans/_template-fix-plan.md`
  Use for larger bug, regression, or reliability fixes where diagnosis,
  constraints, and verification matter more than product walkthrough depth.

## Shared Metadata Rules

- pick the most specific `kind` that matches the document:
  - `proposal`
  - `implementation`
  - `fix-plan`
  - `advisory`
  - `postmortem`
  - `design-note`
- keep `status` within the fixed vocabulary:
  - `draft`
  - `proposed`
  - `planned`
  - `in_progress`
  - `completed`
  - `superseded`
  - `abandoned`
- choose `area` from `doc/plans/_taxonomy.md`
- reuse existing `entities` from recent plans when possible
- if a new `entity` is needed, mint a stable snake_case noun and reuse it later

## Retrieval Reminder

Advisor-style workflows should not guess metadata from scratch.
Use this order:

1. read `doc/plans/_taxonomy.md`
2. map the task to an existing `area`
3. reuse matching `entities` from recent plans when possible
4. only then follow `related_plans`, `supersedes`, commits, and issues
