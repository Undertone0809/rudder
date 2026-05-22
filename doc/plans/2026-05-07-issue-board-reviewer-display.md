---
title: Issue Board Reviewer Display
date: 2026-05-07
kind: implementation
status: completed
area: ui
entities:
  - issue_board
  - display_properties
issue: 81faa4d0-6b22-46a0-9324-f2b79df02def
related_plans: []
supersedes: []
related_code:
  - ui/src/components/IssuesList.tsx
  - ui/src/components/KanbanBoard.tsx
  - tests/e2e/issue-board-display-properties.spec.ts
commit_refs: []
updated_at: 2026-05-07
---

# Issue Board Reviewer Display

## Scope

Add reviewer as a board card display property and keep it enabled in the default board metadata set.

## Implementation

- Add `reviewer` to the board display property option list.
- Include `reviewer` in the default board display properties.
- Render reviewer agent/user identity on board cards when the property is enabled and a reviewer exists.
- Keep saved display-property preferences authoritative for existing local views.

## Validation

- `pnpm exec vitest run ui/src/components/IssuesList.test.tsx ui/src/components/KanbanBoard.test.tsx`
- `pnpm --filter @rudderhq/ui typecheck`
- `pnpm test:e2e -- issue-board-display-properties.spec.ts`
