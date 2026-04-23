---
title: Org resource catalog and agent run context
date: 2026-04-17
kind: proposal
status: proposed
area: workspace
entities:
  - org_resources
  - project_resource_attachment
  - agent_run_context
issue:
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-16-org-workspace-scope.md
  - 2026-04-17-org-resources-onboarding-and-ready-state.md
supersedes: []
related_code:
  - server/src/services/agent-run-context.ts
  - server/src/org-resources.ts
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/components/ProjectProperties.tsx
commit_refs:
  - docs: add org resource catalog proposal
updated_at: 2026-04-17
---

# Org Resource Catalog And Agent Run Context

## Summary

Rudder's current `resources.md` model is strong for agent prompt quality but weak for operator authoring:

- agents can consume one concise markdown file with paths, links, and notes
- operators must hand-author the canonical shared context in markdown
- the current product still carries legacy `project workspace` language that no longer matches the desired mental model

This proposal replaces manual markdown as the canonical source of truth with an org-owned structured resource catalog. Projects attach resources from that catalog or create new ones inline. Agent runs consume a compiled resource context built from structured resources plus optional freeform notes. The agent's canonical cwd remains stable; resources describe what matters, not where the runtime must anchor the process.

## Problem

The product currently mixes four different concerns:

1. shared references for agents
2. repo or folder bindings for work
3. project-specific guidance about which shared references matter
4. runtime-only execution details such as isolated worktrees or adapter-managed sandboxes

This creates two failures:

- operator failure: users must understand and author `resources.md` directly
- modeling failure: `workspace` still carries too much meaning across org files, repo roots, project defaults, and execution behavior

The result is a backwards product boundary:

- the agent-friendly representation is canonical
- the operator-friendly representation is missing

## Goals

1. Make `resource` the operator-facing object for paths, files, folders, URLs, and connector-backed references.
2. Keep resources organization-owned so multiple projects can reuse the same underlying repo, doc set, or external system.
3. Let projects create or attach resources without taking ownership of them.
4. Let projects explain why a resource matters through attachment-level notes.
5. Preserve a high-quality agent run context without requiring users to hand-edit markdown.
6. Keep the agent's canonical cwd stable and treat runtime workspace realization as an internal execution concern.
7. Remove `project workspace` from user-facing product language and creation flows.

## Non-Goals

- turning every resource into a software-specific codebase abstraction
- requiring every project to have a single privileged "primary codebase"
- exposing runtime worktree or sandbox realization as a core product object
- removing all filesystem-native notes surfaces on day one
- solving every connector schema up front

## Product Principles

### 1. Resource is the product object

`Resource` is the reusable organization object. It can represent:

- a local file
- a local directory
- a URL
- a connector-backed external reference such as a Linear project or Feishu doc

Software repos are not a separate first-class product noun in this model. They are resources with a filesystem or URL locator plus optional descriptive metadata.

### 2. Project attaches resources; it does not own them

Projects should not own durable resource roots. A project only declares:

- which org resources are relevant
- what role each resource plays for this project
- any project-specific note that tells agents how to use that resource

### 3. Agent cwd stays stable

The agent home or canonical runtime cwd remains the stable process starting point. Resource attachment tells the agent what to inspect or operate on. If the runtime later realizes a worktree, remote sandbox, or delegated coding tool flow, that is an internal execution detail rather than a core operator-facing object.

### 4. Markdown remains a delivery format, not the canonical store

Markdown is still useful for agent consumption. It should become a compiled prompt artifact assembled from structured resources and optional freeform notes rather than a hand-authored canonical database.

## Proposed Object Model

## 1. Organization Resource

The org owns a catalog of reusable resources.

Suggested minimum fields:

- `id`
- `orgId`
- `name`
- `kind`: `file | directory | url | connector_object`
- `locator`
- `description`
- `metadata`
- `createdAt`
- `updatedAt`

Notes:

- `locator` is the concrete address:
  - local filesystem path
  - URL
  - provider-specific reference payload
- `description` is operator-authored prose for agent understanding
- `metadata` can hold resource-kind-specific details such as repo ref, provider label, workspace-relative hints, or validation state

## 2. Project Resource Attachment

Projects reference org resources through attachments.

Suggested minimum fields:

- `id`
- `projectId`
- `resourceId`
- `role`: `working_set | reference | tracking | deliverable | background`
- `note`
- `sortOrder`
- `createdAt`
- `updatedAt`

Why this layer matters:

- the same resource can mean different things to different projects
- the attachment note is where project-specific guidance belongs
- this removes pressure to overload the org resource description with project-local instructions

## 3. Freeform Notes

Keep one optional freeform org notes surface for information that does not belong in structured resource rows yet.

Near-term recommendation:

- keep `resources.md`, but redefine it as optional org notes
- it is no longer the canonical place to declare every resource
- it remains useful for rich prose, conventions, and operator-written caveats

## Interaction Model

## 1. Organization: Resources

Introduce an org-level `Resources` surface as the primary operator entry point.

Recommended structure:

- `Catalog`
  - structured resources list
  - create/edit/delete resource
  - validate path or URL where possible
- `Notes`
  - current `resources.md` editor, reframed as optional freeform notes
- `Files`
  - existing org workspace browser for direct file inspection where needed

This keeps the current filesystem view but stops making it the only setup surface.

## 2. Create Project

Project creation should support both:

- `Create resource`
- `Attach existing org resource`

Recommended flow:

1. enter project name and description
2. optionally attach one or more existing org resources
3. optionally create a new resource inline and attach it immediately
4. for each attached resource, optionally write a short project-specific note

This preserves speed while avoiding duplicate resource ownership.

## 3. Project Detail

Replace `project workspace` language with `Resources`.

Show:

- attached resources
- role badge
- project-specific note
- quick action to attach more from org
- quick action to create new org resource and attach it

Do not show `project workspace` as a first-class product concept on this surface.

## Agent Run Context

## 1. Source Inputs

At run time, build context from:

- org resource catalog
- project resource attachments
- optional issue-level context if that surface is added later
- optional freeform org notes from `resources.md`
- runtime-internal cwd/workspace details that adapters still need

## 2. Compiled Outputs

Produce two projections from the same source data:

### A. Structured runtime object

Expose structured resource data to runtimes and tools, for example:

- `rudderResources`
- `rudderProjectResources`
- `rudderOrgNotes`

This supports future adapter logic, tool routing, and delegated coding workflows without forcing string parsing of markdown.

### B. Agent-readable prompt block

Compile a concise markdown section for the run prompt.

Recommended order:

1. `Project Resources`
2. `Project Resource Notes`
3. `Organization Notes`
4. runtime hints only when they help explain where files should be edited

Example:

```md
## Project Resources

- [working_set] Rudder repo
  - Kind: directory
  - Locator: `~/projects/rudder`
  - Description: Main Rudder repository with server, ui, packages, and desktop.

- [tracking] Linear workspace
  - Kind: connector_object
  - Locator: `linear://team/RUD`
  - Description: Team backlog and acceptance notes.

## Project Resource Notes

- Rudder repo:
  This project mostly touches `ui/src` and `server/src/chat`. Avoid desktop unless the issue explicitly requires it.

## Organization Notes

- Local app URL: `http://localhost:3100`
- Use `pnpm dev` for the default dev stack.
```

## 3. Runtime Boundary

The prompt should not teach the agent that its cwd equals the resource locator.

The runtime may still include hidden or adapter-facing execution fields such as:

- canonical agent home
- currently realized edit path or delegated runtime target
- derived worktree path
- adapter-managed sandbox identifiers

But these are execution details, not the core product abstraction presented to operators.

## Treatment Of `resources.md`

## Decision

Keep `resources.md`, but demote it from canonical resource database to optional freeform org notes.

## Why

- it preserves today's agent-friendly markdown path
- it avoids forcing a risky one-shot migration away from an existing surface
- it removes the operator-hostile requirement that every path, URL, and resource declaration be hand-authored in markdown

## Run-Time Composition Rule

Agent runs should no longer depend on `resources.md` alone.

Instead:

- structured resources become the primary prompt input
- `resources.md` is appended as optional org notes when marked ready

This preserves current quality while moving the source of truth into structured product state.

## Migration Strategy

### Phase 1

- add org resource catalog and project attachments
- keep `resources.md` as optional notes
- compile run context from structured resources plus `resources.md`
- stop exposing `project workspace` in create/edit flows

### Phase 2

- reduce prompt reliance on raw `resources.md`
- add richer validation and previews for resource kinds
- support connector-backed locator payloads

### Phase 3

- consider whether `resources.md` should remain a user-edited notes file or become a generated export with a reserved manual-notes block

This third step should stay open until the structured model proves sufficient.

## Success Criteria

- operators can configure shared repos, folders, files, and URLs without hand-writing markdown
- projects can reuse the same org resource without duplicating ownership
- project-specific resource guidance is captured at the attachment layer
- agent runs receive better structured context than the current markdown-only path
- `project workspace` disappears from user-facing creation and detail flows
- the agent's canonical cwd model remains stable and does not depend on the product surface teaching workspace realization

## Open Questions

1. Should issue-level resource attachments exist in V1, or should issue context stay comment- and description-driven at first?
2. How much connector schema should be typed in the first pass versus stored as provider payload in `metadata`?
3. Should project attachments allow one optional "focus" flag for ranking prompt order, without creating a privileged resource class?
4. Should `resources.md` remain a manually editable notes surface indefinitely, or later become an export/preview derived from structured data plus a small manual section?
