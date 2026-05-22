---
title: New issue modal redirect
date: 2026-05-07
kind: implementation
status: completed
area: ui
entities:
  - issue_board
  - issue_detail
issue: ZST-54
related_plans:
  - 2026-05-02-linear-source-issue-board.md
  - 2026-04-30-issue-sidebar-recent-views.md
supersedes: []
related_code:
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/NewIssueDialog.test.tsx
  - ui/src/motion.css
  - tests/e2e/new-issue-project-context.spec.ts
commit_refs:
  - fix: redirect new issue creation to detail
updated_at: 2026-05-07
---

# New Issue Modal Redirect

## Goal

When an operator creates an issue from the new issue modal, Rudder should close
the creation flow and automatically navigate to the new issue detail route with
a small motion transition so the newly created work is immediately actionable.

## Implementation Steps

1. Locate the existing new issue modal submit path and issue-detail route helper.
2. Update successful creation to navigate to the created issue detail page.
3. Add a lightweight animation for the modal close / redirect handoff that stays
   consistent with existing UI motion patterns.
4. Add or update E2E coverage for creating an issue from the modal and landing
   on its detail page.
5. Validate with targeted E2E and the standard UI checks that are practical in
   this heartbeat.

## Acceptance Criteria

- Successful new issue creation redirects to the created issue detail route.
- The handoff includes visible motion rather than an abrupt route jump.
- Existing create-issue error handling remains visible and unchanged.
- Automated E2E coverage proves the redirect path.


## Validation

- `pnpm exec vitest run ui/src/components/NewIssueDialog.test.tsx ui/src/lib/new-issue-dialog.test.ts`
- `pnpm --filter @rudderhq/ui typecheck`
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/new-issue-project-context.spec.ts --grep "redirects to the created issue detail"`
- Temporary screenshot verification: `/tmp/rudder-new-issue-redirect-detail.png`

Full repo checks were attempted but are currently blocked by unrelated existing failures in server chat routes, DB/CLI timeout suites, and build-time `server/src/routes/chats.ts` type errors.
