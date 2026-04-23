---
title: Langfuse trace observability plan
date: 2026-04-14
kind: plan
status: completed
area: langfuse
entities:
  - langfuse_traces
  - transcript_export
  - token_usage
issue:
related_plans:
  - 2026-04-15-local-app-langfuse-settings.md
supersedes: []
related_code:
  - server/src/langfuse.ts
  - server/src/langfuse-transcript.ts
  - server/src/__tests__/langfuse.test.ts
commit_refs:
  - fix: improve langfuse trace summaries
updated_at: 2026-04-17
---

# Langfuse Trace Observability Plan

## Goal

Make Rudder's Langfuse traces readable and trustworthy for agent runs by:

- populating trace-level input/output so the trace list is not blank
- ensuring the final agent response is visible on the root trace
- correcting generation usage export so Langfuse reports input/output tokens instead of `0 -> 0`
- tightening a few metadata/status gaps that currently make traces harder to interpret

## Diagnosis

Current traces have three concrete instrumentation problems:

1. Root traces do not write trace-level IO, so Langfuse list columns remain empty even when child observations have content.
2. Generation usage is exported with `promptTokens` / `completionTokens` / `totalTokens`, which Langfuse stores as custom usage keys instead of standard `input` / `output`, causing `Input usage` and `Output usage` to show `0`.
3. Heartbeat transcript/export updates reuse a context object that still says `status=running`, so finalized traces keep stale status metadata.

## Plan

1. Add a small Langfuse helper for trace-level IO updates and use it from root observations.
2. Normalize transcript generation usage to Langfuse's standard `input` / `output` usage keys and keep cached tokens as a separate metric.
3. Return final-output summary data from transcript export so heartbeat/chat roots can set a readable final output.
4. Update heartbeat/chat instrumentation to write final root output and final status metadata.
5. Extend tests around transcript export and helper behavior.
6. Verify with targeted server tests and a live Langfuse trace fetch.

## Validation

- `pnpm --filter @rudder/server test -- --run langfuse`
- targeted trace fetch via `langfuse-cli`

## Commit

- `fix: improve langfuse trace summaries`
