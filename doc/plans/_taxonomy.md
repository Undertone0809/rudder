---
title: Plan taxonomy
date: 2026-04-17
kind: design-note
status: completed
area: planning
entities:
  - doc_plans
  - plan_taxonomy
issue:
related_plans:
  - 2026-04-17-plan-metadata-and-advisor-history-retrieval.md
  - 2026-04-17-plan-template-kinds-and-taxonomy.md
supersedes: []
related_code:
  - doc/DEVELOPING.md
  - .agents/skills/build-advisor/SKILL.md
commit_refs: []
updated_at: 2026-04-17
---

# Plan Taxonomy

This file closes the retrieval loop for `area` and `entities`.
Contributors and advisor-style skills should use it before inventing plan
metadata.

## Area Vocabulary

Pick one primary `area` per plan.
Prefer an existing value from this list:

- `planning`
- `workspace`
- `chat`
- `skills`
- `langfuse`
- `benchmarks`
- `agent_runtimes`
- `developer_workflow`
- `desktop`
- `ui`
- `api`
- `data_model`
- `deployment`
- `security`

If none fit cleanly, choose the nearest existing area and keep the sharper
distinction in `entities`.
Only mint a new `area` when repeated work clearly does not fit the current list.

## Entity Rules

`entities` are stable retrieval nouns, not freeform tags.

Rules:

- use `snake_case`
- prefer domain nouns over verbs
- prefer the same entity across related plans
- use 1-4 entities per plan
- do not stuff synonyms into the list

Good examples:

- `agent_workspace`
- `organization_skills`
- `messenger_chat`
- `langfuse_traces`
- `create_agent_benchmark`
- `managed_codex_home`

Weak examples:

- `workspace-stuff`
- `chat fix`
- `bug`
- `various_refactors`

## How To Choose `area` And `entities`

Use this order:

1. read this taxonomy
2. inspect the nearest recent plans in `doc/plans/`
3. reuse existing `area` values from this file
4. reuse existing `entities` from nearby plans when they still fit
5. if needed, mint one new stable `entity` and keep it consistent in later work

## Advisor Retrieval Loop

Advisor skills should retrieve plan context in this order:

1. read `doc/plans/_taxonomy.md`
2. map the current task to a likely `area`
3. reuse matching `entities` from recent plans where possible
4. query plans by `area` / `entities`
5. follow `related_plans` and `supersedes`
6. inspect linked commits, issues, and code paths
7. fall back to title/slug search only when metadata is missing
