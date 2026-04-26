---
title: Issue Draft Recovery
date: 2026-04-26
kind: implementation
status: completed
area: ui
entities:
  - issue_drafts
  - issue_sidebar
issue:
related_plans:
  - 2026-03-26-rudder-chat-mvp.md
  - 2026-04-10-messenger-unification.md
  - 2026-04-12-rud-98-add-sub-issue.md
supersedes: []
related_code:
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/ThreeColumnContextSidebar.tsx
  - ui/src/lib/new-issue-dialog.ts
commit_refs:
  - b0df7a7
updated_at: 2026-04-26
---

# Issue Draft Recovery

## Problem

The new issue draft behaves like a recoverable work object, but is stored as a
hidden browser-local value. Users can accidentally leave the dialog and then have
no visible place to find the draft. Contextual "new issue" entry points can also
make recovery feel inconsistent because the draft is only restored inside the
dialog lifecycle.

## Diagnosis

- Primary layer: information architecture.
- Secondary layer: interaction correctness.
- The draft needs a visible home in the issue surface, not only implicit recovery
  through reopening the composer.

## Evaluation Criteria

- A saved issue draft is visible from the Issues sidebar.
- Clicking the visible draft affordance opens the issue dialog with the saved
  title, description, project, assignee, labels, status, and priority.
- Draft persistence is shared through a small helper rather than private dialog
  functions.
- Draft recovery works when only description or properties were edited, not only
  when the title exists.
- Creating or discarding the issue clears the visible draft affordance.

## Implementation Plan

1. Move issue draft storage helpers into `ui/src/lib/new-issue-dialog.ts` and
   expose a compact draft summary reader plus a storage event helper.
2. Update `NewIssueDialog` to use the shared helpers and save any meaningful
   draft, not only title-bearing drafts.
3. Add a `Draft Issue` entry to the Issues context sidebar when a draft exists.
   Clicking it opens the New Issue dialog directly.
4. Add focused tests for draft persistence and the sidebar recovery entry.
5. Run targeted UI tests and typecheck for affected packages.

## Validation

- `pnpm test:run ui/src/lib/new-issue-dialog.test.ts ui/src/components/NewIssueDialog.test.tsx ui/src/components/ThreeColumnContextSidebar.test.tsx`
- `pnpm --filter @rudderhq/ui typecheck`
- `pnpm -r typecheck`
- `pnpm build`

The targeted Playwright draft recovery spec was added in
`tests/e2e/new-issue-project-context.spec.ts`, but local Playwright/browser MCP
runs hung before any test request reached the server in this workspace session.
The full `pnpm test:run` suite also failed in pre-existing unrelated areas:
`cli/src/__tests__/company-import-export-e2e.test.ts` and two server embedded
PostgreSQL initialization suites.
