---
title: Plan template kinds and taxonomy
date: 2026-04-17
kind: proposal
status: completed
area: planning
entities:
  - doc_plans
  - plan_templates
  - plan_taxonomy
issue:
related_plans:
  - 2026-04-17-plan-metadata-and-advisor-history-retrieval.md
  - 2026-04-17-recent-plan-metadata-backfill.md
supersedes: []
related_code:
  - doc/DEVELOPING.md
  - doc/plans/_template.md
  - doc/plans/_template-proposal.md
  - doc/plans/_template-implementation.md
  - doc/plans/_template-fix-plan.md
  - doc/plans/_taxonomy.md
  - .agents/skills/build-advisor/SKILL.md
commit_refs:
  - docs: add plan template kinds and taxonomy
updated_at: 2026-04-17
---

# Plan Template Kinds And Taxonomy

## Overview

Rudder's current plan standard solves machine retrieval, but it still treats all
plans as if they should look roughly the same. That is not enough for proposal
work, large feature definition, or high-impact fix planning. This change should
introduce kind-specific templates and a shared taxonomy for `area` and
`entities`, so contributors and advisor skills can both produce better plans and
retrieve past work without inventing metadata ad hoc.

## What Is The Problem?

Current state:

- plan metadata exists and is now mostly normalized
- the repo still has one thin generic template
- `area` / `entities` retrieval logic exists, but there is no clear source of
  truth for what values should be used

Problem:

- proposal docs do not get enough structure for decision-quality writing
- contributors do not know when to use a deep proposal template versus a lean
  implementation or fix template
- advisor retrieval is not a closed loop because it says "match area/entities"
  without first telling the agent where those values come from

Impact:

- important planning work risks being underspecified
- similar work can end up with slightly different metadata values
- advisor retrieval will drift if there is no taxonomy to normalize against

## What Will Be Changed?

- define multiple supported plan kinds with template guidance
- add a detailed proposal template based on the stronger collaboration format
- add lean templates for implementation and large-fix planning
- turn the old `_template.md` into a template guide/index instead of a single
  underspecified skeleton
- add a taxonomy reference for canonical `area` values and `entities` naming
  rules
- update contributor docs and `build-advisor` to use the taxonomy before
  retrieval

## Success Criteria For Change

- contributors can choose the right template for `proposal`,
  `implementation`, and `fix-plan` work without guessing
- proposal docs now carry problem framing, scope boundaries, NFRs, design, QA,
  and open issues by default
- `area` values come from a documented taxonomy instead of freeform invention
- advisor retrieval can explicitly say where `area` / `entities` came from

## Out Of Scope

- retrofitting every historical plan to new kind-specific section layouts
- building a fully automated taxonomy linter in this pass
- enforcing plan structure in CI

## Non-Functional Requirements

- Maintainability: templates should be easy to reuse and evolve
- Usability: authors should be able to decide on a template in under a minute
- Observability: advisors should be able to explain the retrieval source they
  used for `area` / `entities`

## Implementation

### Product Or Technical Architecture Changes

- planning standards move from a single generic template to a small template
  family
- taxonomy becomes a shared normalization layer between contributors and
  advisor-style skills

### Breaking Change

- no hard breaking change for old plans
- guidance changes to prefer more specific `kind` values and the new template
  files for future work

### Design

- keep one common metadata block for all plan kinds
- add specialized templates for:
  - proposal
  - implementation
  - fix-plan
- define `doc/plans/_taxonomy.md` as the source of truth for:
  - approved `area` values
  - entity naming rules
  - retrieval precedence
- update `build-advisor` so it checks the taxonomy before inferring plan
  retrieval metadata

## What Is Your Testing Plan (QA)?

### Goal

Verify that the new template system is understandable, internally consistent,
and sufficient for advisor retrieval.

### Test Scenarios/Cases

- review each new template for complete frontmatter and section structure
- verify the taxonomy covers the current major planning areas in recent plans
- verify updated contributor docs explain template selection and taxonomy usage
- verify `build-advisor` now references the taxonomy as part of retrieval

### Expected Results

- template files are readable and aligned with the documented `kind` values
- `area` / `entities` now have an explicit source of truth
- advisor retrieval loop is closed in documentation

## Documentation Changes

- `doc/DEVELOPING.md`
- `doc/plans/_template.md`
- new `doc/plans/_template-*.md` files
- new `doc/plans/_taxonomy.md`
- `.agents/skills/build-advisor/SKILL.md`

## Open Issues

- whether `proposal` should remain the preferred kind for all larger feature
  work, or whether some future `spec` kind is worth adding later

## Validation Results

- reviewed the new proposal / implementation / fix-plan templates for metadata
  consistency and section depth
- verified contributor guidance now points to the template guide and taxonomy
- verified `build-advisor` retrieval now reads taxonomy before matching
  `area` / `entities`
