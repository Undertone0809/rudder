---
title: Issue Draft Autosave Separation
date: 2026-04-26
kind: implementation
status: completed
area: ui
entities:
  - issue_drafts
  - issue_autosave
  - issue_sidebar
issue:
related_plans:
  - 2026-04-26-issue-draft-recovery.md
supersedes:
  - 2026-04-26-issue-draft-recovery.md
related_code:
  - ui/src/lib/new-issue-dialog.ts
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/ThreeColumnContextSidebar.tsx
commit_refs:
  - f751aea
  - 2c4b095
updated_at: 2026-04-26
---

# Issue Draft Autosave Separation

## Problem

The previous draft recovery implementation conflated New Issue autosave with an
explicit Draft Issue. Typing in the New Issue modal immediately surfaced a
sidebar Draft Issue entry even though the user had not chosen to save a draft.
The footer action also used `Discard Draft`, which made the destructive/cache
behavior unclear.

## Diagnosis

- Primary layer: interaction design.
- Secondary layer: information architecture.
- Autosave is a hidden data-loss-prevention mechanism; a Draft Issue is an
  explicit user-created work object. Treating one as the other creates false
  state and makes the sidebar untrustworthy.

## Evaluation Criteria

- Typing in New Issue creates/restores autosave but does not change the sidebar
  Draft Issues count.
- Closing and reopening New Issue restores autosave.
- Clicking `Save Draft` in New Issue creates a new saved draft, clears autosave,
  resets/closes the modal, and shows a toast telling the user where to find it.
- Users can save multiple draft issues; the sidebar count increments.
- Clicking the sidebar Draft Issues entry opens a single saved draft directly.
- When multiple saved drafts exist, clicking the sidebar Draft Issues entry opens
  an animated picker menu and the user chooses which draft to reopen.
- Clicking a saved draft entry's visible delete button asks for confirmation
  before deleting that saved draft.
- Creating an issue clears the active autosave and any opened saved draft.

## Implementation Plan

1. Split storage helpers into `issue-autosave` and multi-entry `issue-drafts`.
2. Update `NewIssueDialog` to autosave silently, save explicit drafts via the
   footer action, restore selected saved drafts, and clear state correctly on
   create.
3. Update the Issues sidebar to show `Draft Issues` only when explicit saved
   drafts exist, including count and latest title.
4. Add the draft sidebar picker behavior: one draft opens directly, multiple
   drafts open a dropdown menu, and a visible delete button asks for
   confirmation before deleting a saved draft.
5. Update focused unit/component tests and the existing E2E spec fixture to use
   the explicit draft collection and cover the multi-draft picker.
6. Run targeted UI tests, typecheck, and build before committing.

## Validation

- `pnpm test:run ui/src/lib/new-issue-dialog.test.ts ui/src/components/NewIssueDialog.test.tsx ui/src/components/ThreeColumnContextSidebar.test.tsx`
- `pnpm -r typecheck`
- `pnpm build`
- `pnpm test:e2e tests/e2e/new-issue-project-context.spec.ts` was attempted,
  but Playwright marked pre-existing tests as failed at 1ms and then hung during
  worker shutdown; the run was stopped after confirming it did not reach the
  new picker assertions.
- `pnpm test:run` was run and still fails in unrelated existing areas:
  - server embedded PostgreSQL suites hit shared-memory/init failures.
  - `cli/src/__tests__/company-import-export-e2e.test.ts` still reports duplicated catalog skills in the round-trip export.
  - `ui/src/components/PrimaryRail.test.tsx` expects active index `4` for issue routes but receives `2`.
