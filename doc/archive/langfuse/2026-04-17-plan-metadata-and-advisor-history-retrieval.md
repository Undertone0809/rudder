---
title: Plan metadata and advisor history retrieval
date: 2026-04-17
kind: plan
status: completed
area: planning
entities:
  - doc_plans
  - build_advisor
  - contributor_workflow
issue:
related_plans:
  - 2026-04-12-langfuse-agent-run-gap-diagnosis.md
supersedes: []
related_code:
  - AGENTS.md
  - doc/DEVELOPING.md
  - doc/plans/_template.md
  - .agents/skills/build-advisor/SKILL.md
commit_refs:
  - docs: standardize plan metadata and advisor retrieval
updated_at: 2026-04-17
---

# Plan Metadata And Advisor History Retrieval

## Summary

`doc/plans` currently stores useful contributor history, but the files are not
structured enough for reliable retrieval. Header fields vary by document, plan
types are mixed together, and status labels drift across near-duplicate values.

This pass should make plan docs easier for both humans and advisor skills to
query without turning the plan system into a heavyweight knowledge base.

## Decisions

- Standardize new plan records on YAML frontmatter.
- Keep the required metadata small:
  - `title`
  - `date`
  - `kind`
  - `status`
  - `area`
  - `entities`
- Support focused optional lineage and traceability fields:
  - `issue`
  - `related_plans`
  - `supersedes`
  - `related_code`
  - `commit_refs`
  - `updated_at`
- Constrain `kind` and `status` to a fixed vocabulary so advisor retrieval can
  use them predictably.
- Do not require a bulk backfill of historical plans in this pass. New plans
  should follow the standard immediately, and older plans can be normalized only
  when they are active context for a current task.
- Update `build-advisor` so it checks relevant plan history before issuing
  recommendations.

## Implementation Notes

- Add plan metadata guidance and a reusable template to contributor docs.
- Update repo-level contributor instructions so plan docs are expected to carry
  structured metadata, not just date-stamped filenames.
- Extend `build-advisor`'s "Search Before Advising" step with a clear retrieval
  order:
  1. match likely `area` and `entities`
  2. follow `related_plans` and `supersedes`
  3. inspect linked issues, code paths, and commit references
  4. fall back to slug/title keyword search for older unstructured plans

## Validation

- inspect the rendered markdown for the new template and examples
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## Validation Results

- rendered markdown for the new template and standards plan inspected locally
- `pnpm -r typecheck` passed
- `pnpm test:run` failed in existing route tests whose mocked
  `../services/index.js` export set does not include `organizationSkillService`
- `pnpm build` failed in the existing desktop packaging build with
  `TS2688: Cannot find type definition file for 'node'`
