---
title: Run Diagnostics Ledger
date: 2026-06-01
kind: proposal
status: implemented
area: agent_runtimes
entities:
  - run_diagnostics
  - heartbeat_runs
  - run_intelligence
  - maintainer_skills
issue:
related_plans:
  - 2026-04-12-langfuse-derived-observability-phase1.md
  - 2026-04-14-create-agent-benchmark-v1.md
  - 2026-04-27-agent-self-iteration-feedback-system.md
supersedes: []
related_code:
  - packages/db/src/schema/heartbeat_runs.ts
  - packages/db/src/schema/heartbeat_run_events.ts
  - packages/run-intelligence-core/src/diagnosis.ts
  - server/src/services/run-intelligence.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/instance-settings.ts
  - ui/src/pages/InstanceGeneralSettings.tsx
  - .agents/skills/maintainer
commit_refs: []
updated_at: 2026-06-01
---

# Run Diagnostics Ledger

## Overview

Add a local-first run diagnostics ledger so Rudder can turn completed agent run
evidence into a durable system-improvement backlog.

The first version focuses on deterministic, post-run detection of high-signal
errors inside heartbeat run logs and transcripts. It should catch cases where a
run is marked `succeeded` but the transcript still contains local tool, CLI,
adapter, dependency, permission, or runtime errors. Those findings should be
stored in a structured ledger that an operator can inspect and that a
repo-local maintainer skill can process on a schedule.

This is a narrow execution-intelligence slice of the broader self-iteration
feedback system. It does not automatically rewrite skills, create issues, or
change agent behavior. It creates the missing evidence queue that makes those
later actions reviewable.

## What Is The Problem?

Rudder already stores heartbeat runs, run events, run logs, and enough metadata
for `run-intelligence` to reconstruct an observed run. The gap is that this
evidence is still mostly passive. Operators can inspect an individual transcript,
but recurring tool-call and runtime errors are not promoted into a durable,
queryable backlog.

This is especially painful for local agent-team operation because many useful
signals are not top-level run failures:

- a tool call fails but the agent works around it and the run succeeds
- a CLI invocation misses a required option and appears only as transcript text
- a workspace or dependency warning repeats across many runs
- an adapter emits structured stderr but the run still returns useful output
- the same skill instruction defect appears in multiple agents' work

Without a ledger, a maintainer skill has to rescan raw transcripts every time,
deduplicate manually, and has no stable state for resolved or ignored findings.
The result is anecdotal improvement instead of a governed improvement loop.

## What Will Be Changed?

1. Add an instance General > Developer toggle named `Analyze completed agent runs`
   or equivalent copy.
2. Extend instance general settings with a persisted boolean that controls
   post-run diagnostics.
3. Add a `run_diagnostic_findings` table for org-scoped, run-linked findings.
4. Add deterministic run diagnostics logic that converts observed run detail
   into findings.
5. Trigger diagnostics after a heartbeat run reaches a terminal state and the
   run log has been finalized.
6. Add API endpoints for listing, summarizing, recomputing, and updating
   diagnostic findings.
7. Add the first operator-facing control through the Developer settings area.
   Dedicated findings lists and run-detail summaries are deferred until the
   ledger proves useful.
8. Add a repo-local `run-diagnostics-maintainer` skill that consumes open
   findings and writes resolution state after it processes them.

## Success Criteria For Change

- A succeeded heartbeat run containing a tool or CLI error creates an open
  diagnostic finding.
- A failed or timed-out heartbeat run creates a top-level failure finding.
- Repeated findings with the same fingerprint are aggregated instead of creating
  noisy duplicates.
- Disabling the General > Developer toggle stops new automatic diagnostics
  without deleting historical findings.
- Each finding can be traced back to org, agent, run, optional issue, summary,
  evidence, and redacted excerpt.
- A maintainer skill can list open findings and update their status.
- API access remains organization-scoped and board-only for mutation.

## Out Of Scope

- Automatic code repair or skill rewriting.
- Automatic issue creation for every diagnostic finding.
- LLM-based deep retrospective generation.
- Replacing Langfuse traces or external observability.
- Cross-instance or cloud synchronization of diagnostics.
- Full UI analytics dashboards for trend charts.

## Non-Functional Requirements

- **Performance:** post-run diagnostics must not block marking the run terminal
  or releasing issue execution. Failures in diagnostics should be logged and
  isolated.
- **Security:** stored evidence must use the same redaction posture as run logs
  and must not expose cross-organization data.
- **Maintainability:** deterministic findings should live in
  `@rudderhq/run-intelligence-core` so CLI/server/tests can share the taxonomy.
- **Observability:** diagnostics failures should emit server logs and may emit a
  low-noise activity event, but they must not change the heartbeat run status.
- **Usability:** the first UI should be compact and developer-scoped, because
  this is an operator-maintainer control, not a normal end-user setting.

## User Experience Walkthrough

1. The operator opens Settings > General and scrolls to Developer.
2. The operator enables `Analyze completed agent runs`.
3. Rudder continues to run agents normally.
4. When a heartbeat run finishes, Rudder analyzes the finalized run evidence.
5. If findings exist, they are available through the diagnostics API for a
   maintainer workflow. A later UI can show a run-detail summary or recent open
   findings after the ledger shape stabilizes.
6. A scheduled `run-diagnostics-maintainer` skill reads open findings, groups
   them by fingerprint and root cause, then decides whether to patch a skill,
   adapter, config, or docs.
7. After processing, the skill marks findings as `resolved`, `ignored`, or
   `needs_human`, with a short resolution note.

## Implementation

### Product Or Technical Architecture Changes

Introduce `run_diagnostic_findings` as the durable ledger between raw run
evidence and improvement work.

The table should include:

- `org_id`, `run_id`, `agent_id`, optional `issue_id`
- `kind`, `severity`, `status`
- `fingerprint` for aggregation
- `summary`, `details_json`, `evidence_json`, optional `raw_excerpt`
- `source`, `first_seen_at`, `last_seen_at`, `occurrence_count`
- `resolved_at`, `resolution_note`

The instance setting should live under the existing `instance_settings.general`
JSON so it appears next to the current Developer toggles.

### Breaking Change

No breaking product, API, runtime, or storage behavior is intended. The database
migration only adds a table and a general-settings field with a default of
`false`.

### Design

Post-run execution flow:

```text
heartbeat run terminal
run log finalized
run status persisted
diagnostics setting checked
observed run detail loaded from run-intelligence service
diagnostic findings generated
findings upserted by org + fingerprint + status bucket
optional activity/log event emitted
```

Initial deterministic detection should cover:

- terminal run failure
- timeout
- stderr lines with known permission, auth, dependency, network, or CLI usage
  signatures
- transcript tool result entries that look like errors
- missing required CLI option messages such as
  `required option '--comment <text>' not specified`
- high tool volume and very high token input warnings already modeled in
  `run-intelligence`

The analyzer should preserve enough evidence to review the finding without
copying the whole transcript into the table.

### Security

The implementation adds HTTP endpoints and stores redacted excerpts from run
evidence. Endpoints must enforce organization access. Mutation should require
board access. No remote API calls or external dependencies are required for the
first version.

## What Is Your Testing Plan (QA)?

### Goal

Prove that Rudder can persist, show, and let a maintainer process diagnostics
without changing the normal heartbeat run lifecycle.

### Prerequisites

- Embedded PostgreSQL test database.
- A seeded organization, agent, and heartbeat run with finalized log evidence.
- Instance General setting enabled for automatic diagnostics cases.

### Test Scenarios / Cases

- General settings schema defaults diagnostics analysis to disabled.
- General settings API persists the diagnostics toggle.
- Analyzer emits a `cli_usage_error` finding for a missing required option.
- Analyzer emits a finding for failed or timed-out runs.
- Analyzer can detect tool-result error entries in a succeeded run.
- Service upserts repeat fingerprints and increments occurrence count.
- List API returns only findings for the requested organization.
- Patch API updates status and resolution note.
- Automatic post-run hook is skipped when the setting is disabled.
- Settings UI renders the Developer toggle and persists changes.
- E2E covers enabling the Developer toggle and seeing the persisted state.

### Expected Results

- Findings are created only when diagnostics are enabled or when manually
  recomputed.
- Repeated fingerprints aggregate.
- Historical findings remain visible after the toggle is disabled.
- Failed diagnostics analysis never changes run status.

### Pass / Fail

Passed:

- Focused shared validator coverage for the default-off setting.
- Focused run-intelligence analyzer coverage for failed runs, timed-out runs,
  tool-result errors, and CLI usage signatures.
- Focused server route coverage for listing, organization scoping, status
  updates, and manual recompute access checks.
- Focused settings UI coverage for rendering the Developer toggle.
- Focused Settings E2E coverage for enabling the Developer diagnostics setting
  and reading back the persisted value.
- `pnpm -r typecheck`
- `pnpm build`

Not passed in this worktree:

- `pnpm test:run` currently fails in unrelated dirty-worktree areas involving
  markdown-render snapshot expectations, existing home-path layout assertions,
  checkout wakeup expectations, desktop quit timing, and embedded Postgres test
  initialization. The focused diagnostics tests passed.

Review gate:

- Spawned reviewer probe succeeded, but both spawned reviewers failed with a
  usage-limit error before producing verdicts. Do not treat this as completed
  spawned-review evidence.

## Documentation Changes

- This plan records the product and engineering contract.
- The new maintainer skill should describe its API consumption and resolution
  workflow.
- If public docs later describe self-improving teams, they should refer to this
  as a developer/maintainer diagnostic loop, not automatic self-repair.

## Open Issues

- Whether to expose a dedicated diagnostics page after the initial Developer
  settings surface proves useful.
- Whether run detail should include a compact diagnostics summary in the next
  UI slice.
- Whether to add a manual `Convert to issue` action in a later phase.
- Whether to use organization intelligence profiles for optional LLM
  retrospectives after deterministic findings are stable.
