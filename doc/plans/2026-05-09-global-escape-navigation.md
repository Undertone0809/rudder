---
title: Global Escape Navigation Fix
date: 2026-05-09
kind: implementation
status: completed
area: ui
entities:
  - keyboard_shortcuts
  - issue_detail
issue: fb9e1229-932c-4ffd-bd52-7c61f86e9667
related_plans: []
supersedes: []
related_code:
  - ui/src/hooks/useKeyboardShortcuts.ts
  - ui/src/components/Layout.tsx
  - ui/src/pages/IssueDetail.tsx
  - tests/e2e/issue-detail-breadcrumb.spec.ts
commit_refs:
  - fix: make escape navigation fallback reliable
updated_at: 2026-05-09
---

# Global Escape Navigation Fix

## Context

Issue detail has its own Escape fallback that returns to the source breadcrumb. The global keyboard shortcut handler currently prevents the Escape event before checking whether an in-app browser history entry exists. When there is no in-app back stack, the event is consumed and the issue detail fallback never runs.

## Plan

1. Let the global Escape handler know whether navigation was actually handled.
2. Only call `preventDefault()` when the global back navigation succeeds.
3. Preserve existing layer/editable-target guards so dialogs, popovers, and editors keep Escape first.
4. Add E2E coverage for directly opened issue detail pages using the default `/issues` breadcrumb fallback.
5. Run the focused E2E spec and targeted checks before committing.

## Validation

- Passed: `RUDDER_E2E_DATABASE_URL=postgres://rudder:rudder@127.0.0.1:55487/rudder RUDDER_E2E_PORT=33287 pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-detail-breadcrumb.spec.ts --project=chromium` (2 passed)
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Failed before relevant assertions: `pnpm test:run` hit the local embedded PostgreSQL `initdb` failure already seen in this workspace; Vitest reported 1430 passed, 104 skipped, and embedded-Postgres setup failures in DB/server suites.
- Note: default embedded PostgreSQL E2E startup failed before tests during `initdb`, so the browser regression was rerun against a temporary Docker PostgreSQL instance.
