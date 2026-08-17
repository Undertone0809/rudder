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
  - doc/plans/_taxonomy.md
commit_refs: []
updated_at: YYYY-MM-DD
---

# Plan Template Guide

Use this file to choose the right template, not as the default body for every
plan.

All new plan docs should use the shared YAML frontmatter schema in this file
and choose `area` and `entities` from `doc/plans/_taxonomy.md`.

## Shared Frontmatter

```yaml
---
title: Short plan title
date: YYYY-MM-DD
kind: implementation
status: planned
area: workspace
entities:
  - agent_workspace
issue:
related_plans: []
supersedes: []
related_code: []
commit_refs: []
updated_at: YYYY-MM-DD
---
```

Required fields:

- `title`: concise human-readable title
- `date`: creation date in `YYYY-MM-DD`
- `kind`: one of `proposal`, `implementation`, `fix-plan`, `advisory`,
  `postmortem`, or `design-note`
- `status`: one of `draft`, `proposed`, `planned`, `in_progress`, `completed`,
  `superseded`, or `abandoned`
- `area`: primary area from `doc/plans/_taxonomy.md`
- `entities`: 1-4 stable retrieval nouns from the taxonomy or nearby plans

Optional traceability fields are `issue`, `related_plans`, `supersedes`,
`related_code`, `commit_refs`, and `updated_at`. Use `supersedes` only when the
new plan intentionally replaces an older direction. Update `commit_refs` when
the plan produces repository changes.

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

## Authoring Rules

- Pick the most specific supported `kind`.
- Reuse existing `area` and `entities` vocabulary when it still fits.
- Mint a new entity only when needed, keep it snake_case, and reuse it later.
- Do not add free-form tag lists or bulk-normalize historical plans.

## Retrieval Reminder

Advisor-style workflows should not guess metadata from scratch.
Use this order:

1. read `doc/plans/_taxonomy.md`
2. map the task to an existing `area`
3. reuse matching `entities` from recent plans when possible
4. only then follow `related_plans`, `supersedes`, commits, and issues
