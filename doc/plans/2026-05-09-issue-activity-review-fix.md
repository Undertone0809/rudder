---
title: Issue activity review fix
date: 2026-05-09
kind: fix-plan
status: completed
area: ui
entities:
  - issue_activity
  - e2e_tests
  - messenger
issue: ZST-72
related_plans: []
supersedes: []
related_code:
  - tests/e2e/issue-activity-chat-links.spec.ts
  - server/src/__tests__/messenger-service.test.ts
  - ui/src/pages/IssueDetail.tsx
  - ui/src/context/LiveUpdatesProvider.tsx
commit_refs:
  - fix: improve issue activity signal
updated_at: 2026-05-09
---

# Issue Activity Review Fix

## Goal

Resolve the review feedback for ZST-72 by making the added browser regression test executable, rerunning the focused E2E spec against a working database, and making the Messenger suppression regression runnable against external PostgreSQL when embedded Postgres is unstable locally.

## Steps

1. Inspect the failing E2E setup and current API response shape.
2. Patch the test setup to read the created agent response correctly.
3. Run the focused issue activity E2E spec with an external PostgreSQL URL.
4. Allow the Messenger service regression to use an external PostgreSQL URL.
5. Commit only the ZST-72 follow-up files and report validation evidence.

## Validation

- Passed: `RUDDER_E2E_DATABASE_URL=postgres://rudder:rudder@127.0.0.1:55472/rudder RUDDER_E2E_PORT=33272 pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-activity-chat-links.spec.ts --project=chromium` (2 passed)
- Passed: `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL=postgres://rudder:rudder@127.0.0.1:55472/rudder_messenger pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose` (18 passed)
