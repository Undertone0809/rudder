---
title: Issue activity behavior optimization
date: 2026-05-08
kind: fix-plan
status: completed
area: ui
entities:
  - issue_detail
  - issue_activity
  - live_notifications
issue: ZST-72
related_plans:
  - 2026-05-08-issue-detail-activity-stream.md
supersedes: []
related_code:
  - ui/src/pages/IssueDetail.tsx
  - ui/src/context/LiveUpdatesProvider.tsx
  - server/src/services/activity.ts
  - server/src/services/messenger.ts
commit_refs:
  - fix: improve issue activity signal
updated_at: 2026-05-08
---

# Issue Activity Behavior Optimization

## Summary

Improve issue activity signal by adding assignee/reviewer names to assignment
events and suppressing low-signal description/document-update activity from user
notifications and issue activity presentation.

## Implementation Plan

1. Render issue assignment and reviewer changes with from/to labels.
2. Hide description-only issue updates and document-updated rows from issue activity feeds.
3. Suppress description-only issue update toasts and inbox notifications.
4. Add focused unit coverage for activity wording and suppression.
5. Run targeted checks, then broader validation as time allows.

## Success Criteria

- Assignment activity identifies the new assignee and reviewer changes include previous and next reviewer when available.
- Description-only issue updates do not surface as activity rows or live toasts.
- Issue document update events remain in the audit log but do not surface in issue activity rows.
- Existing higher-signal events such as status, priority, title, comments, and document creation/deletion still surface.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/pages/IssueDetail.test.tsx src/context/LiveUpdatesProvider.test.ts`
- Passed: `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-activity-chat-links.spec.ts --list`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Failed before tests/browser: `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts` because embedded PostgreSQL exited during `initdb` bootstrap.
- Failed before browser: `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-activity-chat-links.spec.ts` because embedded PostgreSQL exited during server startup.
- Failed environment-wide DB setup: `pnpm test:run` had 267 passing files, then 19 DB-backed files failed during embedded PostgreSQL init with `Postgres init script exited with code 1`.
