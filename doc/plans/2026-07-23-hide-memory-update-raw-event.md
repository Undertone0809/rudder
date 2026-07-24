---
title: Hide Memory Update Raw Event Details
date: 2026-07-23
kind: implementation
status: completed
area: ui
entities:
  - run_transcript
  - agent_memory
issue: R6Z-13
related_plans:
  - 2026-04-05-run-detail-transcript-v2.md
  - 2026-07-11-chat-transcript-local-file-preview.md
supersedes: []
related_code:
  - ui/src/components/transcript/RunTranscriptView.blocks.tsx
  - ui/src/components/transcript/RunTranscriptView.test.tsx
  - tests/e2e/run-transcript-detail.spec.ts
commit_refs: []
updated_at: 2026-07-23
---

# Hide Memory Update Raw Event Details

## Summary

Remove the duplicated `Raw event` section from expanded memory-update rows while
keeping the operator-readable summary, scope tags, paths, failure details, and
disclosure behavior unchanged. The structured `rawText` evidence remains in the
transcript model for audit and diagnostics.

## Problem

Memory-update rows currently show each affected path twice: once in `Paths` and
again inside the protocol-level `Raw event` text. The duplicate detail adds
noise and exposes an internal event prefix without improving reviewability.

## Scope

In scope:

- remove the `Raw event` heading and payload from successful and failed
  memory-update disclosures;
- retain summaries, tags, paths, failure reasons, keyboard interaction, and
  accessibility attributes;
- keep parsing and storing `rawText`;
- add unit and E2E regression coverage for the readable projection;
- verify the dark Run Detail or Messenger rendering in a real browser.

Out of scope:

- changing the transcript data model or event parser;
- removing raw details from ordinary file-change rows;
- editing the guarded Product Logic Registry.

## Implementation Plan

1. Remove only the memory-update raw-event JSX from
   `TranscriptMemoryUpdateRow`.
2. Update normalization and rendering assertions to prove structured raw
   evidence remains available but is not projected into successful or failed
   memory-update rows.
3. Update the Run Detail E2E scenario to assert one visible copy per memory
   path and no `Raw event` label after expansion.
4. Run focused tests, repository quality checks, and dark-theme browser
   verification.

## Design Notes

This is an allowed regression-restore for `RUN.RESULT.001`: the default
transcript projection stays operator-readable while raw diagnostic evidence
remains attached to the structured transcript. The ordinary file-change
disclosure continues to expose its existing raw event detail.

## Success Criteria

- Successful memory updates expand to `Paths` without `Raw event`.
- Failed memory updates remain expanded with `Failure`, the reason, and `Paths`,
  without the raw protocol prefix.
- Each memory path appears once in the expanded UI.
- `rawText` remains present in normalized transcript blocks.
- Ordinary file-change raw details remain expandable.

## Validation

- Focused Vitest: 83/83 transcript tests passed.
- Focused Playwright: the fixture transcript and real Run Detail memory-update
  scenarios passed in dark mode.
- Typecheck passed across all workspace packages.
- Production build passed.
- Product Logic Registry check passed with 77 valid contracts.
- Dark-theme browser and Playwright screenshots confirmed successful and
  failed memory rows retain `Paths` and failure details without `Raw event`.
- Repository lint remains blocked by an unrelated import-order finding in
  `ui/src/components/side-panel/SubagentPanelView.test.tsx`.
- The full Vitest run completed with 5,181 passed, 70 failed, and 2 skipped;
  failures were outside this change and dominated by inherited Rudder
  environment paths, active Desktop/runtime state, dependency resolution, and
  concurrent timeout pressure. The changed transcript suite passed 83/83
  within that run.

## Open Issues

None.
