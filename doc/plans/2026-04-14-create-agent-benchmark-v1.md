---
title: Create-agent benchmark loop v1
date: 2026-04-14
kind: plan
status: planned
area: benchmarks
entities:
  - create_agent_benchmark
  - run_intelligence
  - langfuse_scores
issue:
related_plans:
  - 2026-04-14-langfuse-trace-observability.md
supersedes: []
related_code:
  - packages/run-intelligence-core/src/create-agent-benchmark.ts
  - packages/run-intelligence-core/src/create-agent-benchmark.test.ts
commit_refs:
  - Pending
updated_at: 2026-04-17
---

# Create-Agent Benchmark Loop v1

## Goal

Turn `create-agent` from an ad hoc manual debugging flow into a repeatable benchmark loop that:

- runs real create-agent requests as issue-backed executions
- computes create-agent-specific deterministic scores
- syncs benchmark metadata and scores into Langfuse
- optionally runs a quality judge and annotation-queue routing
- emits local reports for comparison across repeated runs

## Scope

Phase 1 is intentionally vertical and local-only:

- implement `create-agent` benchmark cases as repo-tracked JSON files
- add a CLI runner under `rudder benchmark create-agent ...`
- reuse existing issue creation, assignment wakeup, issue run, and run-intelligence APIs
- add benchmark trace tags/metadata to issue-backed Langfuse traces
- add deterministic create-agent eval logic in `@rudder/run-intelligence-core`
- support optional judge + annotation queue sync when external credentials exist

Out of scope:

- generic benchmark platform abstraction
- nightly or CI scheduling
- public HTTP API additions

## Design

### Benchmark case format

Store benchmark assets under `benchmark/create-agent/`:

- `cases/*.json` for individual cases
- `sets/*.json` for named groups such as `smoke`

Each case contains:

- `id`
- `prompt`
- `expectedPath`
- `expectedAgentShape`
- `fixtures`
- `judgeFocus`

### Execution flow

1. CLI loads a case and snapshots the current org state for agents and approvals.
2. CLI creates an issue assigned to the benchmark agent. The issue description embeds hidden benchmark metadata.
3. Existing issue assignment wakeup triggers a normal `issue_run`.
4. CLI polls the issue until `executionRunId` appears, then polls run-intelligence until the run is terminal.
5. CLI diffs org state before/after and combines the diff with run detail to compute deterministic create-agent scores.
6. CLI syncs scores, metadata, and optional review artifacts into Langfuse.
7. CLI writes a local result JSON and a markdown summary report under `.artifacts/`.

### Observability contract

Issue descriptions for benchmark-generated tasks carry a hidden metadata block. Server-side issue-run observability extracts that metadata and adds:

- tags:
  - `workflow:create-agent`
  - `benchmark:true`
  - `benchmark-case:<caseId>`
- metadata:
  - `benchmarkCaseId`
  - `expectedPath`
  - `requestedRole`
  - `requestedRuntimeType`
  - `evaluationVersion`
  - `judgeVersion`

### Judge and review

- Deterministic correctness always runs.
- Judge is optional and only executes when judge model credentials exist.
- Judge prompt should be fetched from Langfuse Prompt Management when configured; otherwise fall back to a local built-in prompt.
- Annotation queue routing is optional and only executes when Langfuse annotation queue configuration exists.

## Validation

- `pnpm --filter @rudder/run-intelligence-core test`
- `pnpm --filter @rudder/cli typecheck`
- `pnpm --filter @rudder/run-intelligence-core typecheck`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `pnpm --filter @rudder/cli dev benchmark create-agent --help`

## Commit

- Planned message: `feat: add create-agent benchmark loop`
