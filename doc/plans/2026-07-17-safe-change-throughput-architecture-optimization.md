---
title: Safe change throughput architecture optimization
date: 2026-07-17
kind: proposal
status: in_progress
area: developer_workflow
entities:
  - architecture_fitness
  - module_boundaries
  - messenger_chat
  - bounded_data_paths
issue:
related_plans:
  - 2026-05-19-source-file-size-boundary-refactor.md
  - 2026-06-18-architecture-fitness-and-hotspot-extraction.md
  - 2026-06-24-messenger-render-performance.md
  - 2026-07-12-behavior-preserving-architecture-performance-hardening.md
  - 2026-07-13-runtime-supervisor-resource-lifecycle.md
  - 2026-07-14-run-intelligence-summary-and-bounded-evidence.md
supersedes: []
related_code:
  - scripts/architecture-audit.mjs
  - scripts/architecture-audit.test.mjs
  - scripts/architecture-audit-baseline.json
  - scripts/architecture-boundaries.mjs
  - scripts/architecture-boundaries.json
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/organization-workspaces/OrganizationWorkspaceFilesSidebar.tsx
  - ui/src/pages/organization-workspaces/ProjectResourceDetailPanel.tsx
  - ui/src/pages/organization-workspaces/WorkspaceDocumentEditors.tsx
  - ui/src/pages/organization-workspaces/WorkspaceTabContextMenu.tsx
  - ui/src/pages/Chat.scroll-map.tsx
  - server/src/services/chats.ts
  - server/src/services/messenger.ts
  - server/src/routes/chat-background-runtime.ts
  - server/src/services/runtime-kernel/heartbeat.ts
  - desktop/src/main.ts
commit_refs:
  - 4abd738d1
  - d9091cddc
updated_at: 2026-07-18
---

# Safe Change Throughput Architecture Optimization

## Overview

Rudder will remain a modular monolith, but its internal ownership boundaries
will be aligned with the Product Logic Registry domains and the real
`Goal -> Chat or Issue -> Agent Run -> Review -> Learning` work loop.

The optimization objective is safe change throughput: reduce the expected cost
and failure probability of delivering a real product change while preserving
organization isolation, approvals, budgets, atomic checkout, activity evidence,
runtime compatibility, and the local-first Desktop experience.

Source-file size is a pressure signal, not the outcome. A successful slice must
make state ownership, dependency direction, data bounds, and verification more
explicit. Moving the same closure across several mutually dependent files does
not count as an architecture improvement.

This proposal defines the complete optimization program and starts with the
highest-change-pressure area, the Messenger/Chat collaboration slice. The first
implementation delivery is behavior-preserving: extract Messenger thread
organization and preference models from the route-level sidebar component,
cover the extracted boundary directly, and leave the rendered workflow and
public contracts unchanged.

## What Is The Problem?

The 2026-07-17 working-tree audit reports:

- 1,051 handwritten production TypeScript/TSX files scanned;
- 28 files above the existing 1,500-line ceiling;
- `OrganizationWorkspaces.tsx` at 6,781 lines;
- `MessengerContextSidebar.tsx` at 4,841 lines;
- nine additional core Chat, Messenger, Issue, and Agent files above 2,400
  lines;
- an architecture ratchet that currently reports historical regressions, so it
  is not yet an actionable required CI gate.

The current checkout also contains unrelated Browser and Chat backend work in
progress. Working-tree counts are useful for hotspot discovery, but acceptance
must be measured against a clean target commit and the task-specific diff.
Architecture work must preserve and avoid absorbing unrelated changes.

The main failure mode is ownership concentration:

- UI route components own persistence preferences, query state, workflow
  policy, sorting/grouping, drag-and-drop behavior, mutations, and rendering;
- server service factories combine data access, aggregation, policy,
  serialization, and event/activity responsibilities;
- list, summary, detail, and heavy evidence paths are not consistently separate;
- shared helpers can become convenience dependencies rather than stable domain
  contracts;
- the existing line-count gate can identify debt but does not yet prevent new
  debt reliably on a repository that already exceeds its old baseline.

The resulting cost is not merely difficult code review. Changes to the most
important product loop require understanding broad mutable state, create large
regression surfaces, make production-shaped performance difficult to reason
about, and slow focused verification.

## Optimization Objective

Optimize for all four properties together:

1. **Behavior safety:** product and operating-layer invariants remain explicit,
   tested, and traceable to Product Logic Registry contracts.
2. **Change locality:** a product change is primarily owned by one domain module;
   cross-domain effects occur through named contracts or workflow orchestrators.
3. **Bounded runtime cost:** collection and evidence reads have explicit limits,
   projections, query budgets, and resource lifetimes.
4. **Fast evidence:** each domain boundary has independently runnable tests and
   a real end-to-end workflow proof.

The north-star product metric remains completed real agent-work loops per week.
Architecture acceptance uses closer leading indicators: change locality,
regressions, query and payload bounds, resource cleanup, focused-test duration,
and end-to-end failure rate.

## What Will Be Changed?

### Phase 0: Architecture Fitness And Clean Evidence

- make architecture checks compare the proposed target against an explicit
  clean reference instead of failing forever on unrelated historical debt;
- keep the existing baseline visible and prohibit upward baseline resets that
  hide oversized-file growth;
- add owner, target, and expiry metadata for accepted temporary debt;
- record file size, churn, dependency direction, query count, payload bytes,
  latency, and RSS only where the measurement is relevant;
- make the no-new-regression check a required CI signal after it can evaluate a
  target diff deterministically.

### Phase 1: Messenger And Chat Vertical Slice

- make `MessengerContextSidebar` a route-level composer rather than the owner of
  local persistence, organization/grouping policy, row rendering, mutations,
  and drag-and-drop state;
- extract pure thread organization and preference models first, with direct
  characterization tests;
- extract coherent row/section renderers and a controller hook only after their
  inputs and state ownership are explicit;
- keep Chat, issue, approval, and system thread identity organization-scoped;
- keep summary navigation separate from detail/message/evidence loading;
- migrate backend Chat/Messenger work only after current overlapping work is
  integrated, using additive facades and bounded read contracts.

### Phase 2: Organization Workspace Vertical Slice

- separate file-tree policy, open-tab state, document editors/previews,
  project-resource adapters, skill-library adapters, and workspace mutations;
- keep `OrganizationWorkspaces.tsx` as a page composer with explicit feature
  controllers;
- preserve protected agent-managed paths, organization scope, draft recovery,
  and Desktop launch behavior through E2E coverage.

### Phase 3: Execution And Operating-Layer Ownership

- continue the RuntimeSupervisor direction so HTTP, WebSocket, schedulers,
  plugins, child processes, local PostgreSQL, and DB pools have one owner and
  deterministic cleanup;
- split runtime admission, execution, evidence persistence, recovery, and
  operator-facing run intelligence behind stable facades;
- keep Desktop and CLI as adapters over shared lifecycle contracts rather than
  alternate owners of operating-layer policy.

### Phase 4: Remaining Hotspots And Final Ratchet

- apply the proven migration method to Issue, Agent, Automation, editors, and
  knowledge portability;
- remove cross-domain cycles and direct imports of another domain's internals;
- burn down oversized files without creating generic `utils`, mega-hooks, or
  pass-through modules;
- require architecture, product-logic, focused-test, and E2E evidence for every
  completed slice.

## Target Architecture

Rudder stays in one deployable operating-layer process by default:

```text
UI route / HTTP route / CLI / Desktop adapter
                    |
                    v
        application use case or workflow
                    |
                    v
        domain policy and state transition
                    |
                    v
       query / repository / runtime adapter
```

Rules:

- UI pages compose feature controllers and coherent views.
- HTTP routes own authentication, validation, and transport mapping only.
- Application services own one named use case or cross-domain workflow.
- Domain modules expose public facades and stable DTO/schema contracts.
- Persistence and external-runtime details stay behind repositories/adapters.
- Cross-domain workflows may depend on public facades, never domain internals.
- Process isolation remains reserved for plugins, external runtimes, browser
  execution, and other boundaries with real fault or security isolation needs.
- Shared packages expose stable contracts, not convenience access to mutable
  implementation details.

## Success Criteria For Change

Program completion requires:

- zero new or growing oversized production files relative to the clean target
  reference;
- zero production files above 3,000 lines, then a staged reduction of files
  above 1,500 lines from 28 to at most 15, then at most 5; any remaining
  exception must have an owner, rationale, target, and expiry;
- zero declared cross-domain dependency cycles and zero imports that bypass a
  domain's public facade;
- at least 80% of production changes in representative feature replay cases
  remain inside the owning domain, with cross-domain changes limited to explicit
  contracts or orchestrators;
- every external list/search API has a server-enforced maximum, pagination or a
  proven bounded cardinality, and an explicit summary projection;
- production-shaped hotspot fixtures record query count, response bytes,
  latency, and RSS where applicable, with no unexplained regression above 10%;
- every extracted domain boundary has an independently runnable focused test;
- every changed user-visible workflow has E2E coverage for the real path and at
  least one production-shaped edge case;
- `pnpm product-logic:check`, `pnpm lint`, `pnpm -r typecheck`,
  `pnpm test:run`, and `pnpm build` pass before final program completion.

The first Messenger delivery is accepted when:

- thread organization and preference logic has one explicit owner outside the
  sidebar component;
- direct model tests cover organization/user isolation, malformed local
  storage, stable ordering, deduplication, attention grouping, and manual order;
- existing Messenger component/action/scroll tests pass unchanged;
- Messenger E2E proves grouping, unread attention, custom groups, and navigation
  remain unchanged;
- the main sidebar file shrinks materially and the new module remains below the
  1,500-line ceiling;
- no unrelated Browser/Chat WIP enters the task commit.

## Out Of Scope

- no rewrite to a different frontend framework, database, or transport stack;
- no microservice split without independent scaling, deployment, security, or
  fault-isolation evidence;
- no broad renaming of compatibility-preserving `paperclip*` identifiers;
- no product redesign hidden inside a behavior-preserving extraction;
- no baseline increase solely to make architecture checks green;
- no generic abstraction introduced before at least two domain-owned use cases
  prove the shared contract.

## Non-Functional Requirements

- **Compatibility:** preserve API, storage, local preference, Desktop, runtime,
  and plugin compatibility unless a later phase explicitly migrates them.
- **Security:** preserve organization boundaries and actor permissions through
  all extractions; no shared cache key may omit organization identity.
- **Performance:** every new collection path is bounded; no extraction may add
  N+1 work, eager heavy evidence, or duplicate realtime ownership.
- **Maintainability:** dependencies point inward to domain contracts; public
  facades remain narrow and named by business capability.
- **Observability:** mutations retain activity evidence and runtime lifecycle
  paths retain inspectable state transitions.
- **Local-first:** architecture changes must not make local startup, packaged
  Desktop boot, or time-to-first-success depend on distributed infrastructure.

## User Experience Walkthrough

The intended operator experience does not change during behavior-preserving
architecture slices:

1. The operator opens Messenger and sees the same organization-scoped thread
   directory, unread state, grouping, custom groups, and navigation.
2. Chat, issue, approval, and system threads continue to load summary data
   progressively and open their existing detail surfaces.
3. The operator can reorder, group, pin, hide, read, and navigate threads with
   the same persisted local and server-backed behavior.
4. Later bounded-data migrations preserve visible history and expose explicit
   loading or pagination rather than silently dropping evidence.
5. Runtime and Workspace phases preserve existing workflows while making
   failures and resource ownership more deterministic internally.

## Implementation

### Product Or Technical Architecture Changes

The first implementation creates two UI-owned boundaries:

- a Messenger preferences module for organization/user-scoped local persistence
  keys, normalization, read/write fallback behavior, and collapse/order state;
- a Messenger thread organization model for identity conversion, sorting,
  deduplication, managed/custom grouping, manual order, and attention counts.

The existing component imports these functions and types. It continues to own
React state, queries, mutations, drag-and-drop coordination, and rendering until
later slices extract those responsibilities behind explicit props/controllers.

The architecture audit follow-up will add a clean-reference comparison mode and
test it with temporary Git fixture repositories before it is wired into CI.

### Product Logic Alignment

The first delivery preserves these contracts without semantic changes:

- `MESSENGER.ATTENTION.001`;
- `MESSENGER.THREAD.PREVIEW.001`;
- `MESSENGER.CUSTOM.GROUPS.001`;
- `CHAT.LIFECYCLE.001`.

No Product Logic Registry edit is required for a pure ownership extraction.
The user has explicitly authorized later `doc/product/**` updates when an
approved implementation phase intentionally changes user- or agent-visible
behavior. Such a phase must update the owning contract and registry mapping in
the same change.

### Breaking Change

None in the first delivery. Later behavior or contract migrations must be
additive first, migrate every internal/plugin consumer, update the Product Logic
Registry, and define an explicit compatibility and rollback path.

### Design

Extraction order is dependency-driven:

1. characterize pure behavior at the current boundary;
2. move types and pure functions without semantic edits;
3. keep import direction from component to model;
4. run focused tests after each move;
5. only then extract stateful controllers or rendering components;
6. reduce the old file's baseline after the target slice is verified.

### Security

The first delivery adds no dependency, endpoint, remote call, database access,
or temporary persistent file. Organization and user identifiers remain part of
all persisted preference and ordering keys. Storage parsing remains fail-open to
safe defaults so malformed local state cannot block Messenger.

## What Is Your Testing Plan (QA)?

### Goal

Prove that each extraction changes ownership without changing behavior, and
that later bounded-data or lifecycle slices improve measured work without
weakening product invariants.

### Prerequisites

- use the current complete dependency installation;
- preserve unrelated working-tree changes;
- use a clean target snapshot or task-scoped diff for architecture acceptance;
- use an isolated organization and local dev instance for browser verification.

### Test Scenarios / Cases

- malformed, missing, and valid Messenger local preference state;
- organization and user key isolation;
- stable project, agent, kind, attention, latest, and custom grouping;
- duplicate thread summaries and manual group/entry order;
- unread attention and locally read overlays;
- custom-group move, reorder, collapse, pin, rename, and regenerate actions;
- Messenger paging and unread-scroll behavior;
- real Messenger navigation and custom-group workflow in Playwright;
- architecture audit clean-reference new-file, growth, shrink, rename/delete,
  and non-production exclusion cases;
- later list/read-model phases with maximum page size, projection, organization
  isolation, and production-shaped payload cases.

### Expected Results

- extracted pure-model tests pass without rendering React;
- existing component tests remain green without expectation rewrites that hide
  behavior changes;
- E2E behavior and screenshots match the existing Messenger contract;
- architecture checks reject new debt while allowing unrelated historical debt
  to remain visible;
- product logic and full repository validation pass before each phase handoff.

### Pass / Fail

Implementation evidence will be appended after each phase. A phase is not
complete until writer validation, an independent black-box verifier, and an
independent reviewer all pass on the same target SHA or task-scoped diff.

## Implementation Evidence: 2026-07-18

The program remains `in_progress`. This batch establishes the governance and
ownership mechanics needed for later burn-down, but it does not redefine
program completion around the Messenger first slice.

### Delivered In This Batch

- Phase 0 clean-reference governance now rejects new or growing oversized
  files while preserving historical debt as visible inventory. Every debt
  exception requires owner, rationale, target, and expiry metadata, and an
  existing path's allowance cannot increase.
- The declared-only boundary checker reports cross-domain cycles and facade
  bypasses, including static template-literal `import()` and `require()` forms.
  Unmigrated areas remain explicitly observed rather than falsely certified.
- The HTTP application now owns Chat background timers, tracked work, queue
  abort controllers, and coalesced drains. Startup rollback and normal close
  are idempotent and failure-isolated across Chat and Vite disposers.
- `OrganizationWorkspaces.tsx` moved file-tree, Sidebar, skill-dialog, and
  capability ownership into direct modules. `Layout` now imports the Sidebar
  owner directly instead of evaluating the route aggregation module.
- Chat moved its message map into a directly tested component. It caps the map
  at 64 markers, bounds Markdown preview work by visible text and source scan,
  preserves complete mention/link/code tokens, and hides the rail when content
  or preview clearance is insufficient.
- Messenger Product Logic evidence now reflects the existing Arc-style default
  directory instead of the superseded `Pinned` / `Today` / `Recent` E2E model.

### Measured Result

- `OrganizationWorkspaces.tsx`: 5,994 to 2,982 lines across the Sidebar,
  file-tree, document-editor, project-resource, and tab-menu extraction stages;
- `Chat.tsx`: 3,112 to 2,836 lines;
- `server/src/routes/chats.ts`: 2,565 to 2,558 lines relative to `origin/main`;
- new Workspace production modules: 1,090, 1,054, 168, and 156 lines;
- `Chat.scroll-map.tsx`: 325 lines before final formatting changes;
- current audit: 28 production files above 1,500 lines, with only
  `server/src/services/chats.ts` at 4,585 still above 3,000.

### Verification Evidence

- architecture governance: 18 fixture tests pass; clean-ref comparison reports
  no task regression; declared boundaries report zero cycles and zero bypasses;
- Product Logic Registry: 74 contracts valid;
- focused Chat, Workspace, Messenger, and lifecycle suites pass, including 146
  combined Chat/Workspace tests and failure-isolated Vite port reuse;
- repository lint, all workspace typechecks, and full build pass;
- single-worker full Vitest run reached 541/543 files and 4,483/4,487 tests.
  The extraction-owned static-source failure was corrected and passed on
  rerun. The sole remaining deterministic failure is the unchanged
  `agent-integration-feishu-db-dispatcher` active-generation fixture, which also
  fails alone against unchanged `origin/main` code and is not accepted as final
  program evidence;
- independent review reports no remaining actionable findings;
- isolated Playwright verification passed Messenger custom-pin cases, Workspace
  tree drag/keyboard and launcher paths, and the complete Chat scroll-map path.
  The final scroll-map run passed at 1/1 in 15.2 seconds with wide-screen
  preview/jump proof and narrow-screen visibility proof.

### Remaining Program Gates

- reduce production files above 3,000 from one to zero, then reduce files above
  1,500 to at most 15 and finally at most five;
- complete Workspace, Chat, and Messenger controller/facade ownership rather
  than stopping at the current extraction boundaries;
- expand declared boundary enforcement beyond the three initial domains;
- record representative feature replays that prove at least 80% change locality;
- bound every external list/search API and add explicit summary projections;
- add production-shaped query-count, response-byte, latency, and RSS fixtures;
- close remaining runtime lifecycle gaps and make the full repository test gate
  green on one final target SHA before changing this proposal to `completed`.

## Documentation Changes

- update this proposal with phase evidence and commit references;
- update contributor architecture guidance when clean-reference CI is enabled;
- update affected Product Logic Registry contracts only when behavior changes;
- update public documentation only when operator-facing workflows or commands
  change.

## Open Issues

- The current architecture baseline predates substantial feature growth. The
  clean-reference CI design must preserve the historical debt signal without
  making every unrelated change fail.
- Chat backend files currently overlap unrelated working-tree changes; backend
  extraction begins only after a task-scoped target can be isolated safely.
- Formal dependency-boundary tooling should be selected only after the first
  two vertical slices reveal stable public facade paths.
- Performance budgets need fresh fixed-fixture baselines before absolute p95 or
  RSS limits are frozen.
