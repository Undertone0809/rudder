---
title: Run Intelligence Summary And Bounded Evidence
date: 2026-07-14
kind: implementation
status: completed
area: api
entities:
  - agent_runs
  - run_intelligence
  - run_transcript
issue:
related_plans:
  - 2026-06-10-unified-agent-run-architecture.md
  - 2026-06-21-agent-run-facade-cleanup.md
  - 2026-04-05-run-detail-transcript-v2.md
supersedes: []
related_code:
  - server/src/routes/run-intelligence.ts
  - server/src/services/run-intelligence.ts
  - cli/src/commands/client/runs.ts
  - packages/run-intelligence-core/src/loaders/rudder.ts
  - packages/db/src/schema/heartbeat_runs.ts
commit_refs: []
updated_at: 2026-07-14
---

# Run Intelligence Summary And Bounded Evidence

## Context

Run Intelligence is a diagnostic API and CLI surface for selecting an agent run,
understanding its outcome, and drilling into raw evidence. Its list endpoint
currently reuses the full run export shape. At production-shaped volume this
causes list requests to fetch and serialize large `resultJson`,
`contextSnapshot`, excerpt, session, process, and configuration fields that the
human list output does not use.

The current transcript cursor limits returned rows only. The server still loads
all events and the complete log before constructing and slicing the transcript.
Run Intelligence also duplicates unbounded events and log readers even though
the canonical Agent Runs routes already support bounded reads.

The affected Product Logic Registry contracts are:

- `CONTROL.RUN.INTELLIGENCE.001`: summarized run intelligence with traceable raw
  evidence.
- `RUN.RESULT.001`: durable result, transcript, usage, session, and log evidence.
- `RUN.AGENT.UNIFICATION.001`: one Agent Run identity across work surfaces.

This implementation restores the existing summary-first contract. It does not
semantically edit `doc/product/**`; any registry clarification requires separate
explicit authorization.

## Goals

1. Make list cost independent of large per-run result and context payloads.
2. Preserve existing full JSON consumers through an explicit compatibility path.
3. Add stable keyset pagination and server-side filters for summary reads.
4. Reuse canonical bounded Agent Runs event and log plumbing.
5. Ensure compact/full transcript responses do not accidentally include an
   unbounded duplicate transcript payload.
6. Prove behavior with production-shaped heavy rows, organization boundaries,
   stable pagination, CLI parity, and a real black-box workflow.

## Non-Goals

- A new top-level Run Intelligence UI or navigation item.
- Renaming Heartbeats to Runs.
- Replacing the persisted raw run evidence model.
- A full normalized transcript storage migration in this delivery. True
  storage-level transcript pagination requires a later persisted transcript
  index; this delivery must describe that residual boundary honestly.

## API Contract

### Summary page

Add an explicit summary projection to the organization run list. It returns a
page envelope with an allowlisted `RunSummary` type and a stable cursor composed
of `(createdAt, id)`.

Summary rows include run identity, status, invocation, timing, agent/runtime,
target/issue reference, clipped outcome/error summary, normalized usage/cost,
skill evidence, and log availability metadata. They exclude full result/context
JSON, excerpts, sessions, process metadata, raw log references, and config
fingerprints.

The official CLI and run-intelligence-core list consumers opt into summary by
default. Existing no-projection API behavior remains available during the
compatibility window, and the CLI exposes an explicit full option for callers
that still need raw rows.

### Evidence reads

- Events accept `afterSeq` and `limit` and use the same authorization and
  redaction service as `/agent-runs/:runId/events`.
- Logs accept `offset` and `limitBytes` and return the canonical ranged-read
  envelope with `endOffset`, `nextOffset`, and `eof`.
- Transcript full output returns only the requested page entries; it must not
  append the complete transcript as a second payload.

## Data And Query Design

- Persist `result_summary_json` beside the complete result so list reads never
  need to hydrate the historical payload, and add `(org_id, created_at, id)`
  for the summary keyset query.
- Use keyset pagination, never OFFSET.
- Select heavy JSON columns only for single-run detail.
- Do not load agent config revisions for summary pages.
- Clip human outcome/error summaries to a fixed maximum.
- Keep skill evidence semantics (`used` versus `loaded`) unchanged.

## Delivery Slices

1. Define shared summary/page types, cursor codec, summary query, and route.
2. Add schema indexes and migrations required by the query.
3. Migrate CLI and run-intelligence-core list/by-skill/prefix lookup consumers.
4. Share bounded event/log service helpers with Agent Runs routes.
5. Remove the unbounded duplicate transcript payload and document remaining
   storage-level pagination limitations.
6. Add unit, route, CLI, migration, and E2E coverage.

## Verification

- A 50-row summary response with heavy source rows stays below 150 KB.
- Summary serialization does not include `resultJson`, `contextSnapshot`, raw
  excerpts, session IDs, process fields, or config fingerprints.
- The legacy/full projection remains compatible.
- Identical `createdAt` values paginate without gaps or duplicates.
- Organization access and short run ID behavior remain enforced.
- Events and logs enforce bounds, cursors/offsets, EOF, and redaction.
- CLI workflow passes: list, errors, around-error transcript, paged log, get.
- Run `pnpm product-logic:check`, lint, recursive typecheck, tests, build, and the
  relevant E2E suite before hand-off.

## Verification Results

- The 50-row heavy-source summary response is below the 150 KB gate and omits
  full result, context, excerpt, session, process, and configuration fields.
- Keyset pagination, legacy full projection, bounded events and logs, event
  redaction, UTF-8 log boundaries, CLI compatibility, and the real embedded
  PostgreSQL plus Express workflow pass focused coverage.
- A synthetic production-count migration benchmark backfilled 4,518 historical
  runs, each with a 4,518-line / 280 KB stdout payload, in 24.47 seconds on the
  local embedded PostgreSQL runtime (185 runs/second; 4,518/4,518 summarized).
  This is an explicit one-time first-upgrade cost, not a steady-state request
  cost.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm product-logic:check`, `pnpm build`,
  the focused server/CLI/core tests, and the Run Intelligence E2E pass.
- The full Vitest run reached 3,991 passed, 2 skipped, and 5 failed. The failures
  were existing shared-database/mock concurrency instability; the affected Run
  Intelligence E2E and heartbeat suites passed in isolated reruns.
- The existing transcript-detail Playwright suite is blocked primarily by the
  known `organization_issue_prefix_aliases` organization-creation 409 collision;
  the fresh server did apply this delivery's migration and boot successfully.
- The production-shaped p95 and process-RSS gates remain unverified because the
  available prod-local build is stale and the shared dev instance cannot be
  safely reseeded through its existing migration collision. They must be
  remeasured by the daily performance check after this branch is packaged or on
  an isolated fresh dev instance; this delivery does not claim those gates pass.

## Performance Gates

- 50 summary rows: <= 150 KB response payload.
- Production-shaped local p95: <= 300 ms (follow-up runtime verification).
- Summary-list RSS is bounded and does not scale with full result/log size
  (follow-up runtime verification).
- No query performs deep OFFSET pagination.

The transcript and errors endpoints still load and parse one selected run's
complete log before slicing the requested page. Eliminating that residual
single-run RSS/latency boundary requires normalized persisted transcript data
and is intentionally deferred rather than coupled to the summary-list fix.

## Rollback

The summary projection is additive. Consumers can be moved back to the existing
full list path without a data migration. New indexes can remain safely in place
if consumer migration is rolled back.
