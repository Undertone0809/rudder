# Run Detail Events In Tabs

Status: In Progress
Date: 2026-04-12
Owners: UI

## Summary

- Bring `heartbeat_run_events` into the main run-detail inspection surface instead of leaving them in a detached block below the transcript card.
- Show events inside the Transcript timeline so operator-visible system/failure markers are part of the same execution narrative.
- Keep event visibility available in the Invocation tab so adapter payload inspection and run-event inspection live in one place.

## Problem

- The run detail page currently splits one execution story across two surfaces:
  - transcript/invocation inside the primary card
  - raw run events in a separate `Events` block below
- This breaks progressive disclosure and makes run review slower because operators have to reconcile the transcript with a second event list.
- The transcript renderer already has an event language, but `heartbeat_run_events` are not being fed into it.

## Goals

1. Treat run events as part of the execution narrative, not detached debug residue.
2. Preserve the existing transcript renderer and tab structure with minimal churn.
3. Avoid duplicating the same information in multiple detached sections.

## Implementation

1. Add a small mapping layer in run detail that converts `HeartbeatRunEvent[]` into `TranscriptEntry[]`.
2. Merge mapped event entries with parsed log transcript entries, sorted by timestamp and de-duped conservatively by semantic content.
3. Remove the standalone bottom `Events` block.
4. Render the same event list inside the Invocation tab as a compact auxiliary section beneath adapter invoke payload details.
5. Add focused UI tests for:
   - event normalization into transcript-visible entries
   - invocation-tab event rendering

## Verification

- Run focused Vitest coverage for transcript rendering and agent detail behavior.
- If feasible, run one broader UI test slice covering the edited page module.
