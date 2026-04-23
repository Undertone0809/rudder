---
title: Recent plan metadata backfill
date: 2026-04-17
kind: plan
status: completed
area: planning
entities:
  - doc_plans
  - plan_metadata
  - metadata_backfill
issue:
related_plans:
  - 2026-04-17-plan-metadata-and-advisor-history-retrieval.md
supersedes: []
related_code:
  - doc/plans
  - doc/DEVELOPING.md
commit_refs:
  - docs: backfill metadata for recent plans
updated_at: 2026-04-17
---

# Recent Plan Metadata Backfill

## Summary

Backfill the standard YAML frontmatter onto the 15 most recent product and
implementation plan documents in `doc/plans/`, excluding the metadata-standard
plan itself.

## Decisions

- Limit this pass to the most recent 15 dated plan records.
- Infer `status` conservatively: only mark a plan `completed` when the document
  itself records implementation outcome, validation results, or an explicit
  completed/implemented status.
- Keep lineage focused and sparse so the metadata remains useful instead of
  noisy.

## Implementation Notes

- Add frontmatter to the selected plans and remove duplicated top-of-file
  `Date:` / `Status:` lines where they exist.
- Preserve the existing body content and narrative structure.
- Review the batch for vocabulary consistency against `doc/DEVELOPING.md`.

## Validation

- inspect the edited frontmatter for the 15 selected plans
- `git diff -- doc/plans`

## Validation Results

- verified frontmatter presence for the selected 15 plan files
- verified referenced `related_code` paths exist locally
- reviewed the doc-only diff for representative files after the batch update
