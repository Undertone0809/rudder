---
title: Thread pressure performance coverage
date: 2026-07-20
kind: implementation
status: completed
area: benchmarks
entities:
  - control_plane_performance
  - messenger_chat
  - issue_comments
  - agent_runs
issue:
related_plans:
  - 2026-06-24-messenger-render-performance.md
  - 2026-07-12-behavior-preserving-architecture-performance-hardening.md
supersedes: []
related_code:
  - scripts/perf/control-plane-baseline.ts
  - scripts/perf/control-plane-baseline.test.ts
  - scripts/perf/run-isolated-control-plane.ts
  - tests/e2e/thread-pressure.spec.ts
  - server/src/services/chats.ts
  - server/src/services/issues.comments-attachments.ts
  - server/src/services/activity.ts
  - server/src/__tests__/activity-service.test.ts
  - ui/src/components/CommentThread.tsx
  - ui/src/components/CommentThread.test.tsx
  - ui/src/components/transcript/useLiveRunTranscripts.ts
  - ui/src/components/transcript/useLiveRunTranscripts.test.tsx
  - scripts/vitest.config.ts
  - package.json
commit_refs: []
updated_at: 2026-07-20
---

# Thread Pressure Performance Coverage

## Summary

Extend the control-plane benchmark from broad, shallow row counts to
production-shaped single-entity pressure. The first delivery slice adds a
deterministic `thread-heavy` workload containing one very long Chat and one
Issue with many comments and linked agent runs, measures the real service/query
paths that load those entities, and fails on correctness or organization-scope
violations.

The evidence exposed a request-fanout bottleneck in the Issue timeline, so this
slice also defers terminal run-log hydration until expansion while preserving
active streaming and persisted result access. It does not change Chat, Issue,
or run product semantics.

## Problem

The existing `smoke`, `medium`, and `cost-heavy` benchmark scales distribute a
small number of messages and comments across many entities. They do not cover
the pressure visible in real usage:

- a single Chat whose history contains thousands of messages;
- a single Issue with thousands of comments and many linked agent runs;
- equal timestamps, varied payload sizes, and terminal plus active run states;
- neighboring organization data that must never leak into measured results;
- warm-up, tail latency, deterministic workload identity, and executable
  correctness gates.

As a result, the current benchmark can remain green while a detail screen does
unbounded work or fans out requests in proportion to hidden history.

## Review Convergence

Three reviewers independently assessed database/API behavior, UI/browser work,
and product correctness. A second round cross-examined the other reviews. The
shared conclusion was:

1. keep the current broad/shallow cases as regression context;
2. add a named single-entity whale workload before changing architecture;
3. separate hard correctness and bounded-work gates from machine-calibrated
   absolute latency budgets;
4. preserve ordering, deep-link, unread, run evidence, and organization-scope
   contracts;
5. defer Chat cursor semantics, a unified Issue timeline API, virtualization,
   and schema migrations until measurements prove which boundary dominates.

## Scope

In scope:

- deterministic workload configuration and manifest identity;
- one 5,000-message Chat;
- one Issue with 2,000 comments and 1,000 linked runs, including terminal and
  active states;
- a neighboring organization with colliding-looking content;
- fixed timestamp ties and varied short, long, markdown, and transcript-like
  payloads;
- warm-up iterations, p50/p95/max summaries, row/byte evidence, and process
  memory deltas;
- direct measurements of Chat history, Issue comments, and linked run loading;
- gates for exact cardinality, uniqueness, ordering, linkage, and zero
  cross-organization leakage;
- focused automated tests for workload shape, percentile calculation, and gate
  failures;
- parent-organization consistency filters for Chat messages and Issue comments;
- lazy terminal run-log hydration, active-run streaming, and collapse/re-expand
  evidence retention;
- a real local benchmark run and browser verification using the seeded IDs.

Out of scope for this slice:

- changing default API pagination or response shapes;
- changing visible timeline order, deep-link, unread, or transcript evidence
  behavior;
- replacing the Issue timeline with a unified cursor API;
- Chat turn-aware cursor design or history virtualization;
- database schema migrations;
- edits to the guarded `doc/product/**` registry.

## Affected Product Contracts

The implementation must preserve:

- `CHAT.LIFECYCLE.001`;
- `ISSUE.COMMENTS.001`;
- `ISSUE.SURFACE.001`;
- `RUN.RESULT.001`;
- `MESSENGER.ATTENTION.001`.

## Implementation Plan

1. Extract testable scale, summary, and gate helpers from the performance
   script while preserving existing scale names and CLI compatibility.
2. Add the `thread-heavy` scale and seed hotspot rows in bounded chunks.
3. Link all hotspot runs to the hotspot Issue and mix terminal, queued, and
   running states deterministically.
4. Seed an isolation sentinel in a second organization.
5. Add warm-up execution and measure Chat history, Issue comments, and linked
   runs in addition to the existing control-plane paths.
6. Emit a workload manifest, p95, bytes, memory evidence, and named gate
   results; exit non-zero when a hard gate fails.
7. Run focused tests, the real PostgreSQL benchmark, and black-box browser
   checks. Use the evidence to select the next product optimization slice.
8. Remove eager terminal-run log fanout, keep active runs live, and prove real
   persisted evidence remains inspectable after collapse/re-expand.

## Design Notes

- Absolute p95 and RSS budgets are intentionally not hard-coded before a
  reference-runner baseline exists. Correctness and data-scope gates are hard
  failures immediately; latency evidence is calibrated and reported.
- IDs may be unique per invocation so `--keep-data` remains useful, but the
  workload shape, timestamps, payload distribution, and manifest hash are
  deterministic.
- Equal timestamp ordering must include a stable ID tiebreaker in the measured
  assertion.
- The benchmark must seed in chunks so increasing the whale size does not make
  fixture construction itself require one giant in-memory array.
- Isolation sentinels deliberately pair a neighboring organization ID with the
  primary hot parent ID; ordinary neighbor-owned parents cannot detect a
  missing child organization predicate.
- Linked-run coverage uses both supported relationships: 750 context-linked
  runs and 250 activity-only runs.

## Success Criteria

- `thread-heavy` creates exactly one 5,000-message Chat and one Issue with
  exactly 2,000 comments and 1,000 linked runs.
- Reported results include warm-ups, p50, p95, max, response row counts,
  approximate serialized bytes, and heap/RSS deltas.
- The run exits non-zero for count, duplicate, ordering, linkage, or
  organization-isolation violations.
- Existing benchmark scale names and default behavior remain available.
- Focused automated tests, repository checks, and a real isolated-database
  benchmark pass.

## Implementation Evidence

- Workload manifest `f29167a6fef53dea`, version 2, includes the timestamp,
  payload, transcript, turn-variant, state, and linkage recipe.
- Isolated PostgreSQL: 3 warm-ups and 20 measured iterations.
- Chat history: 5,000 rows / 8,264,791 bytes; p50 82.53 ms; p95 172.13 ms.
- Issue comments: 2,000 rows / 3,005,817 bytes; p50 16.50 ms; p95 102.99 ms.
- Linked runs: 1,000 rows / 502,826 bytes; p50 6.43 ms; p95 15.64 ms.
- Expected-ID, count, duplicate, stable-order, dual-linkage,
  cross-organization, and Messenger summary isolation gates passed.
- Chromium: 2,000 Chat messages, 500 comments, 250 terminal runs, and 2 active
  runs. Initial terminal log requests were zero; active persisted evidence and
  an appended chunk rendered; one terminal transcript rendered after first and
  second expansion without hydrating other terminal runs.
- The first benchmark iteration exposed 370 tied-timestamp run-order failures;
  the service now orders by creation time and run ID descending.

## Validation

- TDD witnesses failed before the helper module, stable run ordering, lazy
  terminal hydration, and collapse/re-expand fixes were implemented.
- Focused helper, service, CommentThread, and transcript-hook tests passed: 52
  tests across the affected suites.
- `pnpm perf:thread-pressure` passed against an isolated embedded PostgreSQL
  instance with all four correctness/isolation gate groups green.
- `RUDDER_E2E_RUN_ID=perf-thread-pressure-evidence-v2 pnpm test:e2e --
  thread-pressure.spec.ts` passed in Chromium (1 test, 46.0 seconds) and wrote
  the Chat and Issue evidence screenshots under `/tmp`.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm product-logic:check`, and an offline
  `pnpm build` passed. The product logic check covered 75 contracts.
- The clean single-worker full suite completed 552 test files: 549 passed and
  3 unrelated files failed (4,614 tests passed, 2 skipped, 6 failed). The two
  migration-journal expectations omit existing migration `0107`; the remaining
  failures are in unchanged onboarding and notification-settings tests. All
  affected and newly added suites passed.
- Three independent reviewers completed two adversarial rounds across DB/API,
  UI/browser, and product-contract perspectives; black-box browser verification
  exercised active streaming, zero initial terminal-log fanout, and repeated
  terminal transcript expansion.

## Open Issues

- Calibrate fixed-runner p95 and RSS budgets after the first reference
  benchmark result is recorded.
- If Chat loading dominates, design a turn-aware keyset/around API before
  changing the default response.
- If Issue loading dominates, design a unified timeline cursor before
  independently truncating comments, activities, and runs.
- Add a fixed reference runner before turning the captured latency and RSS
  evidence into absolute regression budgets.
