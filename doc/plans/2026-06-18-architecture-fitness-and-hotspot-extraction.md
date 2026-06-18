---
title: Architecture fitness and hotspot extraction
date: 2026-06-18
kind: implementation
status: in_progress
area: developer_workflow
entities:
  - architecture_fitness
  - source_file_size
  - module_boundaries
related_plans:
  - 2026-05-19-source-file-size-boundary-refactor.md
  - 2026-05-25-performance-control-plane-optimization.md
supersedes: []
related_code:
  - scripts/architecture-audit.mjs
  - scripts/architecture-audit.test.mjs
  - scripts/architecture-audit-baseline.json
  - package.json
  - ui/src/pages/AgentDetail.tsx
  - ui/src/pages/AgentDetail.runs.tsx
  - ui/src/pages/AgentDetail.helpers.tsx
commit_refs:
  - chore: add architecture audit baseline
  - refactor: extract agent run detail surface
updated_at: 2026-06-18
---

# Architecture Fitness And Hotspot Extraction

## Overview

This plan turns the current "clean up the code mountain" request into a
repeatable engineering loop instead of a broad rewrite. The first completed
slice adds a repository architecture audit, extracts a large `AgentDetail`
module boundary without intended behavior changes, and adds a ratchet command
so new or expanded oversized source files can be blocked deliberately.

The goal is healthier maintenance and better runtime discipline for the Rudder
work loop: operators and agents should be able to trust issue, run, chat,
review, and cost surfaces without every change passing through giant page or
service files.

## What Is The Problem?

Rudder already had a completed source-size refactor plan that set a 1500-line
ceiling for handwritten production TypeScript and TSX files. The tree had
regressed past that boundary in several important surfaces, including
`AgentDetail`, `OrganizationWorkspaces`, Messenger context, issue detail, chat
messages, Messenger service logic, and automation service logic.

The proven problem is not "bad code" in the abstract. It is that future changes
are likely to accumulate inside already-large files where rendering, policy,
data shaping, persistence, and orchestration can blur together. That raises the
cost of safe changes and makes performance work harder to reason about.

## What Changed

Phase 1A added developer workflow visibility:

- added `scripts/architecture-audit.mjs`
- added `pnpm architecture:audit`
- added fixture coverage for source scanning, exclusions, advisory output, and
  warning-only default behavior
- recorded the clean baseline in this plan

Phase 1B extracted a behavior-preserving `AgentDetail` boundary:

- reused the existing `ui/src/pages/AgentDetail.runs.tsx` module for runs list,
  run detail, run summary, logs, and cost rendering
- reused the existing `ui/src/pages/AgentDetail.helpers.tsx` module for shared
  formatting, badge, label, duration, and summary helpers
- removed duplicate local run/detail/log/helper implementations from
  `ui/src/pages/AgentDetail.tsx`
- reduced `AgentDetail.tsx` from 5800 audit lines to 3389 audit lines in the
  clean target snapshot

Phase 2 added an explicit ratchet:

- added `scripts/architecture-audit-baseline.json`
- added `pnpm architecture:audit:check`
- added `--baseline <path>` and `--fail-on-regression`
- made the audit fail only when a currently oversized production file is new or
  grows past its baseline
- kept the regular `pnpm architecture:audit` advisory-only for exploration

## Success Criteria For Change

- `pnpm architecture:audit` runs from the repo root and exits 0 by default.
- The audit reports handwritten production `.ts` and `.tsx` files over 1500
  lines while excluding tests, specs, generated/build output, dependency
  folders, and plugin examples.
- The audit prints a non-blocking advisory section for manual triage candidates
  that look list-like but do not show obvious limit, cursor, offset, pagination,
  bounded, or take markers.
- `pnpm architecture:audit:check` can compare the current tree against an
  explicit baseline and fail only on new or growing oversized files.
- `AgentDetail.tsx` no longer owns duplicated run-list, run-detail, log, cost,
  and helper implementations that already belong to sibling modules.
- The change does not alter product behavior, API contracts, schema, or runtime
  execution.

## Out Of Scope

- No UI behavior redesign in this slice.
- No immediate rewrite of Messenger, automations, cost pages, or workspace
  pages.
- No CI wiring yet; the ratchet command is available for local and CI adoption
  after reviewer sign-off.
- No new performance claims beyond the existing performance-control-plane plan.

## Non-Functional Requirements

- Maintainability: make architectural drift observable and stop it from growing.
- Performance: keep data-volume concerns visible, but leave measured runtime
  optimization to the existing performance plan.
- Observability: print enough baseline data for humans and reviewer agents to
  challenge scope, exemptions, and next-slice priority.
- Compatibility: the first extraction is behavior-preserving and reuses existing
  sibling modules.

## User Experience Walkthrough

The primary user is a Rudder contributor or agent preparing a change.

1. The contributor runs `pnpm architecture:audit`.
2. The script prints oversized production source files in descending line-count
   order.
3. The script prints advisory list-like files that may deserve manual triage
   before any bounded data-path claim is made.
4. Before landing a change, the contributor runs
   `pnpm architecture:audit:check`.
5. The check fails if the change adds a new oversized production file or grows
   an existing oversized file past the checked-in baseline.
6. Reviewers use this plan and the audit output to judge whether later refactor
   slices are scoped and evidence-backed.

## Implementation

### Product Or Technical Architecture Changes

The audit script is repository-local developer workflow only. It uses Node
filesystem APIs directly and supports:

- `--root <path>` for fixture tests and clean target snapshots
- `--max-lines <number>` for tests and threshold experiments
- `--json` for future machine consumption
- `--baseline <path>` for ratchet comparison
- `--fail-on-regression` for blocking new or growing oversized files

The `AgentDetail` extraction keeps the existing page as the route-level
composer and delegates run-specific UI and shared helpers to sibling modules.
The intended architecture contract for later extraction work is:

- route files handle HTTP/auth, validation, and request-response mapping
- service files own persistence, organization scoping, activity logging, and
  domain policy
- complex SQL can move into named query helpers
- UI pages compose routes, data hooks, and sections instead of owning all
  rendering and workflow logic
- components should render coherent objects or interactions
- shared packages expose stable contracts, not convenience leaks
- list, summary, and detail paths should stay separate where data volume matters

### Breaking Change

None.

### Design

Default audit behavior remains warning-only with exit code 0. Ratchet behavior
is opt-in through `--fail-on-regression` and the root
`architecture:audit:check` script.

The checked-in baseline is a ceiling for known debt, not a promise that every
oversized file is acceptable forever. The next cleanup slices should reduce one
entry at a time, then lower that file's baseline.

### Security

No new dependencies, HTTP endpoints, remote API calls, or persistent local temp
files are introduced.

## What Is Your Testing Plan (QA)?

### Goal

Prove the audit scope, warning-only default, ratchet behavior, and
behavior-preserving `AgentDetail` extraction.

### Prerequisites

No database, browser, Desktop shell, or dev server is required. This slice does
not change a user-visible workflow, so existing focused UI tests and typecheck
are the primary proof.

### Test Scenarios / Cases

- A fixture production TSX file above the threshold is reported.
- Test, spec, generated/build, dependency, and plugin example files are
  excluded.
- The command exits 0 even when findings exist.
- The ratchet fails on a new oversized file.
- The ratchet fails when an existing oversized file grows past baseline.
- The ratchet passes when oversized files stay at or below baseline.
- `AgentDetail` run summary and run cost tests pass against the extracted
  module boundary.

### Expected Results

Fixture tests should fail before the audit implementation and pass after it.
The clean target snapshot should pass the ratchet. A dirty local checkout may
fail the ratchet when unrelated WIP grows already-oversized files; that is
expected and should be handled by checking the staged/target diff rather than
reverting unrelated work.

### Pass / Fail

Verification for this slice:

- Pass: `node --test scripts/architecture-audit.test.mjs`
- Pass: `pnpm --filter @rudderhq/ui exec vitest run
  src/pages/AgentDetail.runs.test.ts src/pages/AgentDetail.run-costs.test.ts
  --reporter=verbose`
- Pass: `pnpm --filter @rudderhq/ui typecheck`
- Pass: `pnpm lint:changed`
- Pass: clean target snapshot architecture check using `git archive HEAD` plus
  this slice's changed files overlaid, then
  `node scripts/architecture-audit.mjs --root <target> --baseline
  <target>/scripts/architecture-audit-baseline.json --fail-on-regression`
- Pass: substituted browser smoke against an isolated local dev instance on
  port 3492 using the current working tree's complete dependency install.
  Temporary data: org `Architecture Smoke Org`, agent
  `Architecture Smoke Agent`. Final URL:
  `/ARC/agents/architecture-smoke-agent/runs`. The page title was
  `Runs · Architecture Smoke Agent · Agents · Rudder`, the page rendered the
  Runs tab and `No runs yet.`, and no console or page errors were reported.

Clean target snapshot after Phase 1B/2:

- scanned production source files: 956
- oversized threshold: 1500 lines
- oversized production files: 20
- baseline regressions: none

Current oversized production files in the clean target snapshot:

- `ui/src/pages/OrganizationWorkspaces.tsx`: 6008 lines
- `ui/src/components/MessengerContextSidebar.tsx`: 3547 lines
- `ui/src/pages/AgentDetail.tsx`: 3389 lines
- `ui/src/pages/IssueDetail.tsx`: 2629 lines
- `ui/src/pages/Chat.messages.tsx`: 2561 lines
- `server/src/services/messenger.ts`: 2505 lines
- `ui/src/components/MarkdownEditor.tsx`: 2412 lines
- `server/src/services/automations.ts`: 2214 lines
- `ui/src/pages/UiLab.tsx`: 2123 lines
- `server/src/services/chats.ts`: 1908 lines
- `ui/src/components/ThreeColumnContextSidebar.tsx`: 1891 lines
- `cli/src/commands/start.ts`: 1848 lines
- `ui/src/components/NewIssueDialog.tsx`: 1832 lines
- `server/src/routes/chats.ts`: 1792 lines
- `ui/src/components/MilkdownMarkdownEditor.tsx`: 1782 lines
- `server/src/services/runtime-kernel/heartbeat.ts`: 1687 lines
- `ui/src/pages/Costs.tsx`: 1669 lines
- `desktop/src/main.ts`: 1562 lines
- `server/src/services/issues.ts`: 1530 lines
- `server/src/services/knowledge-portability/organization-skills.ts`: 1510
  lines

The local checkout currently contains unrelated dirty WIP in several of those
files. Directly running the ratchet on the full working tree can fail because
of those unrelated edits; the clean target snapshot is the evidence for this
slice.

## Documentation Changes

This plan is the documentation artifact. No public `docs/` update is needed
because the change is contributor workflow and internal architecture hygiene.

## Open Issues

- CI should decide when to call `pnpm architecture:audit:check`; the command is
  ready, but this slice does not wire it into a required CI job.
- Baseline entries could grow owner and expiry metadata before CI enforcement.
- Advisory list-like endpoint detection is intentionally heuristic and should
  stay non-blocking until noise is reviewed.
- Runtime latency and production-shaped performance evidence remain tracked in
  `2026-05-25-performance-control-plane-optimization.md`.
