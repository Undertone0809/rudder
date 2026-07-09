---
title: Sync Product Logic Into Official Docs
date: 2026-07-09
kind: implementation
status: in_progress
area: developer_workflow
entities:
  - official_docs
  - product_logic_registry
  - mintlify_docs
issue:
related_plans:
  - 2026-06-21-product-logic-registry.md
supersedes: []
related_code:
  - doc/product/GOAL.md
  - doc/product/PRODUCT.md
  - doc/product/README.md
  - doc/product/registry.yml
  - docs/docs.json
commit_refs: []
updated_at: 2026-07-09
---

# Sync Product Logic Into Official Docs

## Overview

The official Mintlify docs should reflect Rudder's current product model, not a
thin subset of it. The guarded Product Logic Registry in `doc/product/` already
records the current behavior contracts for organizations, issues, agents, runs,
work routing, workspaces, automations, collaboration, control-plane surfaces,
review, learning, and plugins. This plan turns the public parts of that truth
into user-facing documentation under `docs/`.

This is a docs synchronization, not a product-logic change. `doc/product/`
remains the internal source of product truth. `docs/` should explain that truth
in a way users can read, navigate, and act on.

## What Is The Problem?

Current official docs cover the core Rudder story, first organization flow,
issues, agents, runtimes, Chat, Messenger, Calendar, Workspaces, Skills, and
Feishu. They do not yet expose several current product areas that are already
covered by `doc/product/`:

- automations and automation output routing
- review, feedback, and learning promotion
- approvals, budgets, activity, dashboard, run intelligence, and inbox
- plugins and plugin management
- organization settings, onboarding, export, and import
- runtime platform permissions and adapter readiness
- Library files, workspace backups, and workspace boundaries as operational
  behavior, not only a concept

The result is drift between the internal Product Logic Registry and the public
documentation. A user can read the docs and still miss important parts of the
current product.

## What Will Be Changed?

Update the official docs information architecture and content:

- Add public concept pages for automations, review and learning, control-plane
  operations, and plugins.
- Do not add `concepts/documents-work-products.mdx`; documents and work products
  should be covered through Workspaces, Library, issue close-out, and review
  docs instead.
- Add how-to guides for creating automations, reviewing agent work, managing
  Workspaces and Library files, exporting or importing organizations, and
  managing plugins.
- Add reference pages for issue statuses, runtime types, workspace boundaries,
  automation output routing, and runtime permissions.
- Refresh existing overview, Workspaces, agents, issue lifecycle, and navigation
  pages where needed so new pages connect cleanly to the current docs.
- Keep English and Simplified Chinese docs structurally aligned when adding new
  navigation entries and pages.
- Use the `humanizer` and `humanizer-zh` writing rules during final review:
  avoid promotional filler, formulaic "AI" phrasing, overused bold labels,
  forced rule-of-three patterns, curly quotes, and em/en dashes in authored
  prose.

## Success Criteria For Change

- Every `doc/product/` domain has a corresponding public docs entry point, or is
  intentionally folded into a related public page.
- The public docs do not expose internal contract IDs, registry traceability,
  code paths, test paths, or guarded edit-policy mechanics.
- `docs/docs.json` includes valid English and Chinese navigation entries for the
  new pages.
- No standalone `docs/concepts/documents-work-products.mdx` page is created.
- The docs validate with `pnpm docs:validate`.
- The final staged diff only contains the docs sync and this plan, not unrelated
  dirty worktree changes.

## Out Of Scope

- Changing `doc/product/**` contracts.
- Changing product behavior, server routes, UI behavior, or tests.
- Adding new screenshots or visual assets unless an existing page already needs
  a stable existing screenshot reference.
- Publishing the docs site to production.
- Rewriting release notes.

## Non-Functional Requirements

- Maintainability: keep pages short enough to be edited independently, and link
  related pages instead of duplicating long explanations.
- Usability: write for operators and contributors using Rudder, not for internal
  registry maintainers.
- Searchability: titles and descriptions should use concrete product nouns such
  as automations, reviews, budgets, plugins, workspaces, runtime permissions,
  and organization import/export.
- Localization: Chinese pages should be natural Chinese docs, not literal
  sentence-by-sentence English mirrors.

## User Experience Walkthrough

After this change:

1. A new user lands on the docs homepage and sees Rudder as a control plane for
   goals, issues, runs, reviews, budgets, workspaces, automations, plugins, and
   learning.
2. They open Core Concepts and can find each current product domain in the
   public model.
3. They use how-to guides to create an automation, review agent work, manage
   workspaces, export/import an organization, or manage plugins.
4. They use reference pages to check behavior boundaries such as issue statuses,
   runtime types, workspace placement, automation output routing, and platform
   permissions.
5. Chinese readers can follow the same navigation structure under `/zh`.

## Implementation

### Product Or Technical Architecture Changes

No product architecture changes are needed. This is a Mintlify docs content and
navigation update.

### Breaking Change

None. The change only adds and updates documentation.

### Design

Use `doc/product/` as the source material and rewrite it for public docs:

- Domain README files provide the public concept map.
- Workflow files provide user journeys.
- `surface-domain-map.md` checks whether important surfaces have a public docs
  entry point.
- `registry.yml` checks coverage, but contract IDs stay internal.

Page additions:

- `docs/concepts/automations.mdx`
- `docs/concepts/reviews-feedback-learning.mdx`
- `docs/concepts/control-plane.mdx`
- `docs/concepts/plugins.mdx`
- `docs/how-to/create-automation.mdx`
- `docs/how-to/review-agent-work.mdx`
- `docs/how-to/manage-workspaces-and-library.mdx`
- `docs/how-to/export-import-organization.mdx`
- `docs/how-to/manage-plugins.mdx`
- `docs/reference/issue-statuses.mdx`
- `docs/reference/runtime-types.mdx`
- `docs/reference/workspace-boundaries.mdx`
- `docs/reference/automation-output-routing.mdx`
- `docs/reference/permissions-and-platforms.mdx`

Chinese counterparts should be added under `docs/zh/` for the same pages.

Navigation:

- Add the new English concept/how-to/reference pages to `docs/docs.json`.
- Add matching Chinese navigation groups and pages.
- Keep the Project group unchanged unless validation requires another entry.

### Security

No new endpoints, dependencies, remote APIs, or local files are introduced.
The docs should avoid publishing internal code paths, test paths, credentials,
or machine-local paths.

## What Is Your Testing Plan (QA)?

### Goal

Prove the docs tree is structurally valid and the requested scope is respected.

### Prerequisites

- Run from the repository root.
- Existing package dependencies are installed.

### Test Scenarios / Cases

- Validate Mintlify docs with `pnpm docs:validate`.
- Search for the forbidden standalone page path:
  `docs/concepts/documents-work-products.mdx`.
- Inspect `git diff --name-only` to confirm only `doc/plans/**`, `docs/**`,
  and necessary docs metadata are changed by this work.
- Search authored docs for em/en dashes in new prose.

### Expected Results

- `pnpm docs:validate` passes.
- No `docs/concepts/documents-work-products.mdx` file exists.
- No unrelated dirty files are staged.
- New English and Chinese docs are reachable from `docs/docs.json`.

### Pass / Fail

To be filled after implementation.

## Documentation Changes

This plan directly changes official docs under `docs/`. It does not change
`doc/product/**`.

## Open Issues

- If docs validation reveals Mintlify limitations around a new `reference`
  navigation group, keep the pages but adjust the navigation structure to the
  smallest valid Mintlify shape.
- If the final change is too large for one review, commit English and Chinese
  docs in separate commits while keeping the same branch and scope.
