---
title: Knowledge Base Control Plane Proposal
date: 2026-05-17
kind: proposal
status: proposed
area: data_model
entities:
  - knowledge_base
  - memory_provider
  - knowledge_provenance
issue: ZST-196
related_plans:
  - 2026-03-17-memory-service-surface-api.md
  - 2026-04-30-agent-memory-instructions.md
supersedes: []
related_code:
  - packages/db/src/schema
  - server/src/services/heartbeat.ts
  - ui/src/pages
commit_refs: []
updated_at: 2026-05-17
---

# Knowledge Base Control Plane Proposal

## Overview

Add a manual-first, provenance-first Knowledge Base control-plane surface for
Rudder organizations.

This proposal does not turn Rudder into a general wiki or a monolithic memory
engine. It defines the product and system boundary for organization-approved
knowledge: reusable decisions, facts, procedures, preferences, reference
summaries, and open questions that can be traced back to Rudder work objects and
selectively injected into future agent runs.

The first iteration should make knowledge explicit, reviewable, and
explainable. More automatic capture, provider-backed memory, and richer
maintenance workflows can follow after the control-plane contract is stable.

## What Is The Problem?

Rudder's long-term product direction names organization knowledge as a core
control-plane capability, but `SPEC-implementation.md` keeps a full Knowledge
Base subsystem out of V1 scope. At the same time, the product already has
adjacent surfaces that create and consume reusable knowledge:

- issues, comments, documents, approvals, runs, and activity logs
- organization resources and project attachments
- generated artifacts, plans, and skills in managed workspaces
- agent instruction and tacit memory files
- a proposed memory-provider adapter layer

Without a narrower Knowledge Base proposal, the term can collapse several
different concerns into one overloaded system:

- Resources answer where source material lives.
- Workspaces answer where files, artifacts, plans, skills, and runtime context
  live.
- Memory providers answer how content is stored, indexed, recalled, or
  maintained.
- Knowledge Base should answer which reusable conclusions the organization has
  accepted and can safely reuse.

If these boundaries stay implicit, future implementation work will repeatedly
debate whether "knowledge" means a resource catalog, a workspace file tree, an
agent memory vendor, a wiki, or a run-context injection mechanism.

## What Will Be Changed?

Introduce a Knowledge Base product layer with four explicit boundaries:

- `Resources`: source material and locators, such as repositories, files,
  URLs, connector objects, and external documents.
- `Workspaces`: managed places where files and execution surfaces live,
  including organization workspace roots, agent homes, artifacts, plans, skills,
  and execution workspaces.
- `Memory providers`: storage, indexing, retrieval, correction, and profile
  systems. Providers may be local, hosted, or plugin-supplied.
- `Knowledge Base`: organization-approved, reusable knowledge entries with
  scope, status, provenance, and audit history.

The MVP should add these product capabilities:

- Save selected issue, comment, document, run, resource, or manual-note content
  into a draft knowledge entry.
- Preserve source references for every entry.
- Let the board review, edit, activate, archive, or update entries.
- Recall only active, scope-matching entries for agent runs.
- Record which entries were injected into each run context snapshot.
- Let agents propose knowledge additions or updates without silently changing
  active knowledge.

## Success Criteria For Change

- A board user can save useful content from a Rudder work object into a draft
  knowledge entry.
- Every active entry has at least one visible source reference or an explicit
  manual-note source.
- Agent runs only receive active entries that match the run scope and recall
  query.
- Run context snapshots record the injected knowledge entry IDs and source
  references.
- Archiving an entry prevents future injection without deleting historical
  provenance.
- Agents can suggest new or updated knowledge, but active knowledge remains
  board-governed in the first version.

## Out Of Scope

- A general-purpose wiki.
- Replacing Resources or Workspaces.
- Full automatic capture of every run, transcript, and comment.
- Requiring a vector database as a prerequisite for the MVP.
- Letting a provider own Rudder organization, project, issue, permission, or
  provenance semantics.
- Rich project, agent, or user-level permission granularity beyond the current
  organization-scoped V1 model.

## Non-Functional Requirements

- Maintainability: keep the core data model small and do not bind Rudder to one
  memory-provider ontology.
- Usability: show why a knowledge entry exists, where it came from, and whether
  it is active.
- Observability: log knowledge write, search, injection, update, and archive
  operations.
- Security: keep all entries organization-scoped and enforce existing actor
  boundaries for board and agent access.
- Performance: start with bounded top-N recall so agent context does not become
  noisy or expensive.

## User Experience Walkthrough

1. A board user or agent finds a reusable conclusion in an issue, comment,
   document, resource summary, or run output.
2. The user clicks `Save to Knowledge`, or the agent proposes the same action.
3. Rudder creates a draft knowledge entry with title, body, kind, tags, and
   source references prefilled.
4. The board edits the draft and marks it active.
5. Later, an agent run starts with issue, project, goal, label, and resource
   context.
6. Rudder recalls a small number of active matching entries and injects them
   with source references.
7. The run context snapshot records which entries were used.
8. If an agent detects stale or conflicting knowledge, it proposes an update or
   archive action for board review.

## Implementation

### Product Or Technical Architecture Changes

Add a Knowledge Base layer above Resources, Workspaces, and Memory providers.

The first implementation can be Postgres-backed and provider-independent. A
later phase can bind entries or recall to the memory-provider contract from
`2026-03-17-memory-service-surface-api.md`.

Recommended phases:

1. Phase 0: accept this proposal and align terminology.
2. Phase 1: implement a Postgres-backed Knowledge Base MVP with manual save,
   review, archive, list/search, and run-context injection.
3. Phase 2: add memory-provider bindings so local or plugin providers can power
   recall while Rudder still owns provenance and governance.
4. Phase 3: add automatic capture, duplicate/conflict detection, stale-review
   queues, and scoped recall refinements.

### Breaking Change

No breaking product, API, runtime, or storage changes are required for the
proposal. The implementation phases would add new tables, API routes, and UI
surfaces.

### Design

Minimum objects:

- `knowledge_entries`
  - `orgId`
  - `title`
  - `body` or `summary`
  - `kind`: `decision | fact | procedure | preference | reference_summary |
    open_question`
  - `status`: `draft | active | archived`
  - `scope`: org-level first; project, agent, and issue scope can come later
  - `tags`
  - `confidence` and `reviewedAt` as optional metadata
  - creator and updater attribution
- `knowledge_sources`
  - source kind: `issue_comment | issue_document | issue | run | resource |
    external_document | manual_note`
  - source ID or locator
  - captured excerpt or summary hash for explainable provenance
- `knowledge_operations`
  - write, search, inject, archive, update, and suggestion logs
  - actor, source, run, and usage fields where applicable
- `memory_bindings`
  - reused or aligned with the memory-service provider binding plan in later
    phases

MVP recall should avoid complex retrieval requirements:

- derive a bounded query from issue title, description, goal, project, labels,
  and attached resources
- filter to active entries in the organization
- use keyword or FTS ranking first
- inject a small top-N result set
- include source references in both prompt context and the stored context
  snapshot

### Security

The implementation will add new organization-scoped API endpoints. They should
follow existing board and agent actor rules:

- board users can create, edit, activate, archive, and inspect entries
- agents can read recall results during authorized runs
- agents can propose draft entries or updates if that workflow is enabled
- provider adapters must not bypass Rudder organization or provenance checks

## What Is Your Testing Plan (QA)?

### Goal

Prove that Knowledge Base entries are governed, traceable, organization-scoped,
and injected into agent runs only when active and relevant.

### Prerequisites

- A local Rudder organization with at least one issue, comment, document, and
  agent run.
- Optional seeded resources for source-reference coverage.

### Test Scenarios / Cases

- Create a draft entry from an issue comment and verify source attribution.
- Activate the draft and verify it appears in Knowledge list/search.
- Start an issue-backed run and verify matching active entries appear in the
  run context snapshot.
- Archive the entry and verify future runs do not inject it.
- Attempt cross-organization access and verify it is rejected.
- Let an agent propose an update and verify active content does not change until
  board confirmation.

### Expected Results

- Provenance is visible for every entry.
- Active entries can be recalled and injected.
- Draft and archived entries are not injected.
- Context snapshots explain which knowledge was used.
- Unauthorized cross-organization reads or writes fail.

### Pass / Fail

Not run. This is a proposal document; validation belongs to the implementation
issue for Phase 1.

## Documentation Changes

If implemented, update:

- `doc/SPEC-implementation.md` when Knowledge Base moves into the scoped
  release contract.
- `doc/PRODUCT.md` to clarify the difference between Resources, Workspaces,
  Memory providers, and Knowledge Base.
- Public docs once the board-facing Knowledge UI is available.

## Open Issues

- Should Phase 1 use Postgres as the product source of truth, or should it use
  markdown-first local files? Recommendation: Postgres first, with export to
  markdown later, so the UI, provenance, and context snapshots have a stable
  product contract.
- Does Phase 1 need project scope? Recommendation: start organization-scoped
  with source references and add project scope once recall quality demands it.
- Can agents create drafts directly, or only propose them through approvals?
  Recommendation: agents can create draft suggestions; activating knowledge
  requires board confirmation in the first version.
