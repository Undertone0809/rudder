---
title: Workspace Backup File Selection Acceptance
date: 2026-10-16
kind: implementation
status: in_progress
area: ui
entities:
  - workspace_backup
issue:
related_plans: []
supersedes: []
related_code:
  - ui/src/components/WorkspaceBackupFilesSidebar.tsx
  - ui/src/pages/OrganizationWorkspaceBackups.tsx
  - tests/e2e/workspace-backups.spec.ts
commit_refs: []
updated_at: 2026-10-16
---

# Workspace Backup File Selection Acceptance

## Behavior under test

Selecting a file in the workspace-backup sidebar must preserve the selected
backup ID and file path together in the URL. This prevents the page's default
backup reconciliation from clearing a file selection when the sidebar has a
stale search-parameter snapshot.

## Acceptance checks

1. A component regression renders a backup and file entry while its search
   parameters omit the backup, selects that file, and verifies the navigation
   includes both `backup` and `file` while preserving unrelated parameters.
2. The real Playwright workflow creates an organization and backup, returns to
   the backup browser after visiting Library, selects `plans/roadmap.md`, and
   verifies the URL retains both IDs and the preview displays the snapshotted
   `# Roadmap` content.
3. The Playwright run uses an isolated embedded PostgreSQL instance under a
   dedicated temporary Rudder home. It does not connect to or delete existing
   user data. A successful-state screenshot is written outside the repository.

The author-run checks establish the implementation workflow only. Independent
stage review and any separately requested acceptance verdict remain distinct
gates.

## Author verification

- `pnpm exec vitest run ui/src/components/WorkspaceBackupFilesSidebar.test.tsx`:
  passed (1 test).
- `pnpm --filter @rudderhq/ui typecheck`: passed.
- `pnpm lint:changed`: passed.
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts
  tests/e2e/workspace-backups.spec.ts --project=chromium --workers=1`: passed
  (2 tests) against the fresh embedded database at
  `/private/tmp/rudder-workspace-backup-selection-e2e-20261016`, app port
  `33731`, database port `55531`. The test server stopped during teardown.
- Successful preview screenshot:
  `/private/tmp/rudder-workspace-backup-selection-evidence-20261016/workspace-backup-preview.png`
  (SHA-256 `62f4866fda24afbe241c61953d9fe614c08031fd2b853ea6f3ee416afb188dfd`).
