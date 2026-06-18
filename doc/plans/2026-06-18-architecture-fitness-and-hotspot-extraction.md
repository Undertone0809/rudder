---
title: Architecture fitness and hotspot extraction
date: 2026-06-18
kind: proposal
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
  - package.json
  - ui/src/pages/AgentDetail.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - server/src/services/messenger.ts
commit_refs:
  - chore: add architecture audit baseline
updated_at: 2026-06-18
---

# Architecture Fitness And Hotspot Extraction

## Overview

This proposal turns the current "clean up the code mountain" request into a
repeatable engineering loop instead of a broad rewrite. The first slice adds a
read-only architecture audit that records where Rudder is drifting back into
oversized, multi-responsibility source files. Later slices can use that baseline
to extract one high-risk hotspot at a time with tests and reviewer evidence.

The goal is healthier maintenance and better runtime discipline for the Rudder
work loop: operators and agents should be able to trust issue, run, chat,
review, and cost surfaces without every change passing through giant page or
service files.

## What Is The Problem?

Rudder already has a completed source-size refactor plan that set a 1500-line
ceiling for handwritten production TypeScript and TSX files. The current tree
has regressed past that boundary in several important surfaces, including
`AgentDetail`, `OrganizationWorkspaces`, Messenger context, issue detail, chat
messages, Messenger service logic, and automation service logic.

The proven problem is not "bad code" in the abstract. It is that future changes
are likely to accumulate inside already-large files where rendering, policy,
data shaping, persistence, and orchestration can blur together. That raises the
cost of safe changes and makes performance work harder to reason about.

## What Will Be Changed?

Phase 1A changes only developer workflow:

- add a warning-only architecture audit script
- add a root package script so the audit can be rerun consistently
- record the initial baseline in this plan
- keep the audit read-only and out of CI-failing paths for now

Later phases are intentionally separate:

- Phase 1B: choose one hotspot, likely the `AgentDetail` run-review surface, add
  characterization tests, and extract a behavior-preserving module boundary
- Phase 2: ratchet the audit so new or expanded oversized files are blocked,
  while existing debt remains tracked through explicit allowlist entries

## Success Criteria For Change

- `pnpm architecture:audit` runs from the repo root and exits 0 by default.
- The audit reports handwritten production `.ts` and `.tsx` files over 1500
  lines while excluding tests, specs, generated/build output, dependency
  folders, and plugin examples.
- The audit prints a non-blocking advisory section for manual triage candidates
  that look list-like but do not show obvious limit, cursor, offset, pagination,
  bounded, or take markers.
- The plan records a fresh baseline from the same script.
- The change does not alter product behavior, API contracts, schema, UI, or
  runtime execution.

## Out Of Scope

- No UI or API behavior changes in Phase 1A.
- No immediate rewrite of `AgentDetail`, Messenger, automations, or workspace
  pages.
- No CI-failing architecture gate until a first extraction has proven the rule
  is useful and low-noise.
- No new performance claims beyond the existing performance-control-plane plan.

## Non-Functional Requirements

- Maintainability: make architectural drift observable before starting large
  extractions.
- Performance: keep data-volume concerns visible, but leave measured runtime
  optimization to the existing performance plan.
- Observability: print enough baseline data for humans and reviewer agents to
  challenge scope, exemptions, and next-slice priority.
- Compatibility: the first slice is read-only and behavior-preserving.

## User Experience Walkthrough

The primary user is a Rudder contributor or agent preparing a change.

1. The contributor runs `pnpm architecture:audit`.
2. The script prints oversized production source files in descending line-count
   order.
3. The script prints advisory list-like files that may deserve manual triage
   before any bounded data-path claim is made.
4. The contributor uses the output to decide whether the next implementation
   should extract a small module boundary or avoid adding to a hotspot.
5. Reviewers use this plan and the audit output to judge whether a later
   refactor slice is scoped and evidence-backed.

## Implementation

### Product Or Technical Architecture Changes

Phase 1A adds a repository-local developer workflow script only. It does not
change the Rudder product architecture.

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

The audit script should use the filesystem directly, not shell pipelines, so it
is portable across local machines and CI runners. It should support:

- `--root <path>` for fixture tests and future worktree runs
- `--max-lines <number>` for tests and threshold experiments
- `--json` for future machine consumption

Default behavior remains warning-only with exit code 0.

### Security

No new dependencies, HTTP endpoints, remote API calls, or persistent local temp
files are introduced.

## What Is Your Testing Plan (QA)?

### Goal

Prove the audit scope and warning-only behavior before relying on its baseline.

### Prerequisites

No database, browser, Desktop shell, or dev server is required.

### Test Scenarios / Cases

- A fixture production TSX file above the threshold is reported.
- Test, spec, generated/build, dependency, and plugin example files are
  excluded.
- The command exits 0 even when findings exist.
- `pnpm architecture:audit` runs against the real repo and prints the baseline.

### Expected Results

The fixture test should fail before the audit script exists, then pass after
implementation. The real repo audit should report current hotspots without
mutating files.

### Pass / Fail

Phase 1A verification:

- Pass: `node --test scripts/architecture-audit.test.mjs`
- Pass: `pnpm architecture:audit`

Clean target baseline from `node scripts/architecture-audit.mjs --root
<git-archive-of-HEAD>` at HEAD `460e1dc5`:

- scanned production source files: 956
- oversized threshold: 1500 lines
- oversized production files: 20
- advisory list-like manual triage candidates: 22

This is the canonical Phase 1A baseline because this commit does not include
the unrelated dirty working-tree edits currently present in the local checkout.
Line counts can drift while those edits are present; rerun
`pnpm architecture:audit` and treat the script output as the source of truth
before using the numbers for a ratchet or extraction slice.

Current oversized production files:

- `ui/src/pages/OrganizationWorkspaces.tsx`: 6008 lines
- `ui/src/pages/AgentDetail.tsx`: 5800 lines
- `ui/src/components/MessengerContextSidebar.tsx`: 3429 lines
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
- `ui/src/components/MilkdownMarkdownEditor.tsx`: 1741 lines
- `ui/src/pages/Costs.tsx`: 1697 lines
- `server/src/services/runtime-kernel/heartbeat.ts`: 1687 lines
- `desktop/src/main.ts`: 1562 lines
- `server/src/services/issues.ts`: 1530 lines
- `server/src/services/knowledge-portability/organization-skills.ts`: 1510
  lines

## Documentation Changes

This plan is the documentation artifact for Phase 1A. No public `docs/` update
is needed because the change is contributor workflow only.

## Open Issues

- The allowlist owner and expiry format should be decided before any CI-failing
  ratchet is added.
- Advisory list-like endpoint detection is intentionally heuristic and should
  stay non-blocking until noise is reviewed.
- Runtime latency and production-shaped performance evidence remain tracked in
  `2026-05-25-performance-control-plane-optimization.md`.
