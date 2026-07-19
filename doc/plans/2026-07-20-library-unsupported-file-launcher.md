---
title: Library unsupported-file launcher
date: 2026-07-20
kind: implementation
status: planned
area: ui
entities:
  - library_workspace
  - desktop_file_launcher
related_plans:
  - 2026-04-30-workspace-root-launcher.md
  - 2026-05-19-library-project-context-workspace-proposal.md
  - 2026-07-15-isolated-library-website-preview.md
supersedes: []
related_code:
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/components/workspaces/WorkspaceLaunchControls.tsx
  - ui/src/lib/workspace-preferences.ts
  - ui/src/lib/desktop-shell.ts
  - desktop/src/ide-opener.ts
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - tests/e2e/organization-workspaces-launcher.spec.ts
commit_refs: []
updated_at: 2026-07-20
---

# Library Unsupported-File Launcher

## Decision

Full Library will replace its terminal cannot-render message with a centered,
compact split launcher only when the selected file is a valid existing file and
no built-in preview or editor can present it. Eligibility is capability-based;
it is not a binary-file, MIME-family, or extension denylist. Existing
preview-only formats remain in their previews, and editable formats remain in
their editors.

In Rudder Desktop, the primary split action starts as `Default app`. A
different compatible target becomes the restored primary action only after that
target opens successfully and while it remains available. The menu can offer
the default app and detected IDEs as file targets, plus compatible folder and
terminal targets for the file's containing directory.

## Routing And Degradation

- Default-app and IDE actions reuse the validated Desktop file-open bridge.
- Folder and terminal actions reuse the validated containing-directory bridge;
  folder targets reveal the selected file and terminal targets open its parent
  directory as cwd.
- Failed launches surface an error and do not replace the last successful
  target.
- Browser/server surfaces keep an honest cannot-render state and do not render
  controls that claim to open local applications or directories.

## Verification

- Unit coverage proves the launcher appears only after preview and edit
  capabilities are exhausted, keeps preview-only and editable formats on their
  existing paths, and selects/restores targets only after successful launches.
- Component coverage proves the centered compact split control, target menu,
  loading/disabled behavior, and visible launch failures.
- Desktop bridge coverage proves file targets and containing-directory targets
  retain canonical path validation and reject missing files, unsafe roots, and
  escaping symlinks.
- E2E coverage exercises an unsupported valid Library file through default app,
  IDE, folder, and terminal routes, includes restored-target behavior, and
  verifies Web degradation plus representative preview-only/editable files.
- Run `pnpm product-logic:check`, the relevant UI/Desktop tests and E2E suite,
  the packaged Desktop verification path, and rendered Desktop/Web inspection
  before handoff.
