---
title: Docs work product layer
date: 2026-05-18
kind: proposal
status: superseded
area: workspace
entities:
  - docs_work_product
  - workspace_browser
  - org_resources
  - issue_documents
issue:
related_plans:
  - 2026-05-19-library-project-context-workspace-proposal.md
  - 2026-04-17-org-resource-catalog-and-agent-run-context.md
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-20-remove-legacy-project-managed-workspace-paths.md
supersedes: []
related_code:
  - ui/src/components/PrimaryRail.tsx
  - ui/src/components/ThreeColumnContextSidebar.tsx
  - ui/src/pages/OrganizationResources.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/components/IssueDocumentsSection.tsx
  - server/src/services/organization-workspace-browser.ts
  - server/src/services/agent-run-context.ts
commit_refs: []
updated_at: 2026-05-19
---

# Docs Work Product Layer

## Overview

Rudder should introduce `Docs` as the user-facing work product layer for
agent-produced documents, reports, datasets, and HTML deliverables, while
keeping `Workspaces` as the agent-native filesystem layer.

The product should support two first-class perspectives:

1. Users need a reviewable, searchable, status-aware view of what agents
   produced and what needs human action.
2. Agents need a stable filesystem workspace with Markdown, CSV, HTML, JSON,
   skill files, memory files, and other AI-native formats that can be listed,
   grepped, edited, and reused across runs.

The same underlying file or document can serve both perspectives. It should be
projected as an `Artifact` or `Doc` for the user, and as a `File` for the
agent.

## What Is The Problem?

Rudder already has most of the raw ingredients:

- an org-owned workspace root under `workspaces/`
- a workspace browser and editor
- organization resources and project resource attachments
- issue documents backed by Markdown-first editing
- agent run context that can inject workspace and resource guidance

The gap is product framing.

The current `Workspaces` surface is useful, but it exposes the filesystem as
the primary user model. That is right for agents and advanced operators, but it
is the wrong default for a human user trying to answer:

- What did the agent produce?
- Which outputs need review?
- Which issue, project, run, or agent owns this output?
- Is this document accepted, stale, superseded, or ready to reuse?
- How do I ask an agent to continue from this output?

At the same time, flattening everything into a human-facing document library
would damage the agent experience. Agents work well with simple files,
directories, stable paths, and AI-native formats. The product should not hide
that layer from the runtime.

External product research reinforces this split. Moxt's strongest product
idea is not a decorative document library; it is an AI-native workspace where
agents work in Markdown, CSV, HTML, skills, memory, and files. Rudder should
adopt that principle, but express it through Rudder's control-plane model:
issues, projects, runs, reviews, approvals, and durable work loops.

## What Will Be Changed?

1. Add `Docs` as a primary user-facing product surface.
2. Keep `Workspaces` as the advanced filesystem and agent-native surface.
3. Introduce a `Doc` / `Artifact` projection over workspace files and issue
   documents.
4. Treat Markdown, CSV, HTML, JSON, and skill files as first-class AI-native
   output formats.
5. Connect docs to Rudder work objects:
   - issue
   - project
   - agent
   - run
   - organization
6. Make review state explicit for docs that need human action.
7. Keep `Resources` as the input/reference catalog, not the output library.
8. Keep workspace paths available as advanced metadata and agent context, not
   as the primary human navigation model.

## Success Criteria For Change

- A user can open `Docs` from the primary rail and understand recent agent
  outputs without reading a directory tree.
- A user can see which docs are linked to an issue, project, run, or agent.
- A user can identify docs that need review, are accepted, or have been
  superseded.
- An agent can still read and write the underlying files through stable
  workspace paths.
- A generated Markdown report, CSV dataset, or HTML visualization can appear
  in `Docs` while remaining a normal file in `Workspaces`.
- `Resources`, `Docs`, and `Workspaces` have distinct product meanings:
  inputs, work products, and filesystem/runtime substrate.

## Out Of Scope

- Building a generic file manager.
- Replacing issue documents in this proposal.
- Replacing organization resources.
- Creating a full Google Docs or Notion-style collaborative editor.
- Automatically importing every file in the workspace as a visible doc.
- Automatically enabling arbitrary workspace skills for agents.
- Solving cloud object storage or remote sandbox persistence in this pass.

## Non-Functional Requirements

### Maintainability

The first implementation should reuse existing workspace file and issue
document contracts where possible. Avoid a large storage migration until the
product shape is validated.

### Usability

The user-facing `Docs` surface should be organized around work ownership,
status, recency, and review needs. Filesystem path should be visible, but not
the first hierarchy.

### Security

Workspace files can contain secrets, credentials, local paths, or prompt
injection attempts. The `Docs` projection should not blindly expose every file.
The first pass should rely on explicit save/link/publish actions or safe
allowlisted folders such as `plans/`, `reports/`, `docs/`, and issue-linked
documents.

### Observability

Doc creation, update, review, archive, and supersede events should be
traceable to the run, agent, or user action that caused them.

## User Experience Walkthrough

### 1. User Reviews Agent Output

1. An agent completes an issue and writes `reports/market-research.md` plus
   `reports/market-sizing.csv` into the org workspace.
2. The run records those files as produced artifacts.
3. The user opens `Docs` from the primary rail.
4. The recent output list shows:
   - title
   - format
   - linked issue
   - producing agent
   - source run
   - review status
   - last updated time
5. The user previews the Markdown report in a readable document view.
6. The user can approve, request revision, attach it to an issue comment, or
   ask an agent to continue from it.
7. The advanced menu still offers `Reveal in Workspaces` and `Open in IDE`.

### 2. Agent Uses Native Workspace

1. The agent receives a run context with relevant resources and docs.
2. The context includes stable workspace paths and concise Markdown summaries.
3. The agent can inspect files with normal filesystem operations.
4. The agent writes Markdown, CSV, JSON, or HTML outputs back into the
   workspace.
5. Rudder records the output path and projects it into `Docs` only when it is
   linked, generated under an output folder, or explicitly saved as a doc.

### 3. User Adds Input Context

1. The user adds a repo, PDF-derived Markdown file, URL, or folder in
   `Resources`.
2. A project attaches that resource with a role and project-specific note.
3. Agent runs consume the resource as input context.
4. Agent outputs go to `Docs`, not back into `Resources`, unless the user
   intentionally promotes a finished doc into reusable reference material.

## Implementation

### Product Or Technical Architecture Changes

Add a work product projection that can point at multiple backing sources:

```ts
type WorkProductSource =
  | { kind: "workspace_file"; orgId: string; path: string }
  | { kind: "issue_document"; issueId: string; documentKey: string }
  | { kind: "external_url"; url: string };

type WorkProductFormat =
  | "markdown"
  | "csv"
  | "html"
  | "json"
  | "image"
  | "text"
  | "other";

type WorkProductReviewState =
  | "draft"
  | "needs_review"
  | "accepted"
  | "revision_requested"
  | "superseded"
  | "archived";
```

Minimum persisted fields, if a new table is added:

- `id`
- `orgId`
- `title`
- `description`
- `format`
- `sourceKind`
- `sourceLocator`
- `issueId`
- `projectId`
- `agentId`
- `runId`
- `reviewState`
- `createdByType`
- `createdById`
- `createdAt`
- `updatedAt`

The first pass may avoid a new table by deriving a read model from issue
documents, known workspace output folders, and run file-operation metadata.
However, explicit review state will likely need persistence once the UI allows
approval or supersede actions.

### Breaking Change

No breaking API or storage change should be required in the first pass.

Navigation changes should preserve `/workspaces` as an existing route. If a new
`/docs` route is introduced, `/workspaces` remains available under the org
sidebar and as an advanced action from doc details.

### Design

#### Primary Rail

Add `Docs` to the primary rail only after the surface is more than a raw file
browser. The rail entry should represent user-facing work products, not the
workspace filesystem.

Recommended initial rail order:

1. Messenger
2. Dashboard
3. Issue
4. Docs
5. Agents
6. Organization
7. Auto
8. Calendar

#### Docs Main Surface

Recommended sections:

- `Needs review`
- `Recent outputs`
- `By project`
- `By issue`
- `Formats`

Each row/card should show:

- title
- format icon
- linked issue/project/run
- source agent
- review state
- updated time
- advanced path disclosure

#### Docs Detail

The detail view should prioritize readable preview and review actions:

- Markdown renders as a document with outline.
- CSV renders as a compact table with download/raw actions.
- HTML renders in a constrained preview with explicit open/raw controls.
- JSON/text renders as code.
- Images render as previews.

Actions:

- approve
- request revision
- archive
- mark superseded
- attach to issue
- ask agent to continue
- reveal in workspace
- open in IDE

#### Workspaces

Keep the current file tree/editor surface, but position it as:

- advanced filesystem view
- agent workspace inspection
- skill/memory/raw file editing
- IDE handoff
- workspace backups and recovery

Do not put the raw `Workspaces` page in the primary rail as the default user
entry point.

#### Resources

Keep `Resources` as input and reference context:

- repos
- folders
- files
- URLs
- connector objects
- optional freeform notes

Do not overload `Resources` with agent-generated outputs. A finished output can
be promoted into a resource only when it becomes reusable input for future
work.

### Security

The implementation should treat workspace files as untrusted until explicitly
projected into `Docs`.

Rules:

- Never auto-publish hidden config, env files, credentials, or dotfiles.
- Do not auto-enable skills found in workspace directories.
- For HTML previews, use sandboxing and avoid privileged script execution.
- Show local filesystem paths only to board operators with full-control
  context.
- Keep provenance visible so a user can tell whether a doc was user-authored,
  agent-generated, imported, or derived from an external file.

## What Is Your Testing Plan (QA)?

### Goal

Prove that users can review docs as work products while agents retain
filesystem-native access to the same underlying material.

### Prerequisites

- Seeded organization with at least one project, issue, agent, and run.
- Workspace files in Markdown, CSV, HTML, JSON, and image formats.
- At least one issue document.
- At least one generated output linked to a run.

### Test Scenarios / Cases

1. `Docs` appears in primary rail and opens the work product surface.
2. A Markdown workspace output appears in `Recent outputs`.
3. A CSV output renders as a table preview and retains raw/download access.
4. An HTML output renders in a safe preview container.
5. A doc linked to an issue shows the issue identifier and navigates back to
   the issue.
6. A user marks a doc as accepted and the state persists after reload.
7. A user requests revision and can start a follow-up agent action from the
   doc.
8. A hidden or unsafe workspace file does not appear automatically in `Docs`.
9. `Reveal in Workspaces` opens the same underlying path in the workspace
   browser.
10. Existing `/workspaces` route and workspace editor behavior still work.

### Expected Results

- Human users see ownership, status, and preview-first docs.
- Agent-facing files remain addressable by path.
- Review state does not mutate the underlying file content unexpectedly.
- Unsafe files stay hidden unless explicitly linked by an authorized action.

### Pass / Fail

To be completed during implementation.

## Documentation Changes

- Update `doc/PRODUCT.md` to distinguish:
  - `Resources` as input context
  - `Docs` as work products
  - `Workspaces` as filesystem/runtime substrate
- Update `doc/DESIGN.md` with navigation ownership guidance for `Docs` versus
  `Workspaces`.
- Update public docs under `docs/` once the surface ships.
- Update bundled skill guidance so agents write durable shared outputs into
  expected workspace folders with metadata or issue/run links when available.

## Open Issues

1. Should the first implementation add a persisted `work_products` table, or
   derive the read model first and add persistence only for review state?
2. What folders should be allowlisted as auto-discoverable doc outputs?
3. Should issue documents automatically appear in org-level `Docs`, or only
   when marked shared/exported?
4. Should `Docs` be the public label, or should the UI use `Outputs` while the
   internal model uses `work_products`?
5. How should imported Word/PDF/Notion files be converted into AI-native
   Markdown in Rudder's local-first environment?
6. Should HTML outputs be first-class in V1, or should the first pass support
   Markdown and CSV only?
