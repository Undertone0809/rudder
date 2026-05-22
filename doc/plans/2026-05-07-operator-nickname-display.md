---
title: Operator Nickname Display
date: 2026-05-07
kind: implementation
status: completed
area: ui
entities:
  - operator_profile
  - operator_identity
issue: c7d03120-62b7-48f7-8b27-3220450b5812
related_plans:
  - 2026-05-05-operator-profile-context-import.md
supersedes: []
related_code:
  - ui/src/lib/operator-display.ts
  - ui/src/hooks/useOperatorDisplayName.ts
  - ui/src/lib/activity-actors.ts
  - ui/src/components/ActivityRow.tsx
  - ui/src/components/CommentThread.tsx
  - ui/src/pages/Activity.tsx
  - ui/src/pages/Dashboard.tsx
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/ApprovalDetailDialog.tsx
  - ui/src/context/LiveUpdatesProvider.tsx
  - tests/e2e/profile-context-import.spec.ts
commit_refs:
  - fix: use operator nickname in current-user labels
updated_at: 2026-05-07
---

# Operator Nickname Display

## Summary

Use the operator profile nickname as the user-facing name wherever the UI labels
the current human as `YOU`. If no nickname is configured, keep the existing
`YOU` fallback so current empty-profile behavior remains unchanged.

## Problem

The profile settings page lets users configure a nickname, but conversation and
activity surfaces still render the current user as `YOU`. That makes the saved
profile feel disconnected from the rest of the product.

## Scope

- Replace current-user `YOU` labels with the configured nickname when present.
- Keep `YOU` as the fallback when the nickname is blank or unavailable.
- Reuse the existing profile settings API/cache instead of introducing new
  identity storage.
- Do not rename agents, other users, API actors, or persisted activity records.

## Implementation Plan

1. Trace UI surfaces that hard-code or translate the current user as `YOU`.
2. Identify the existing profile settings query and cache behavior.
3. Add a small shared UI helper or hook for the operator display label.
4. Replace relevant render paths without changing persisted event data.
5. Add focused component/unit coverage for nickname and fallback behavior.
6. Run targeted tests and broader checks as practical.

## Design Notes

- This is a presentation-layer identity change: stored activity should remain
  stable and actor typing should not be migrated.
- Whitespace-only nicknames should behave like no nickname.
- Surfaces without profile data during initial load should continue to render
  the old fallback until the query resolves.

## Success Criteria

- A configured nickname appears instead of `YOU` in all current-user labels.
- Blank nickname preserves the existing `YOU` label.
- Existing profile settings save behavior is unchanged.
- Tests cover at least one nickname and one fallback rendering path.

## Validation

- `pnpm test:run ui/src/components/ActivityRow.test.tsx ui/src/components/CommentThread.test.tsx` passed.
- `pnpm test:run ui/src/context/LiveUpdatesProvider.test.ts` passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm test:e2e tests/e2e/profile-context-import.spec.ts` passed with coverage for the saved nickname appearing in activity labels.
- `pnpm -r typecheck` passed.
- `pnpm test:run` passed: 278 files, 1420 tests passed, 1 skipped.
- `pnpm build` passed.

## Open Issues

- None.
