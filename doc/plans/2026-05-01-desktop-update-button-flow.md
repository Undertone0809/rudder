---
title: Desktop Update Button Flow
date: 2026-05-01
kind: implementation
status: completed
area: desktop
entities:
  - desktop_release
  - cli_start
issue:
related_plans:
  - 2026-04-27-unified-npx-portable-desktop-install.md
  - 2026-04-29-cli-start-install-progress.md
  - 2026-04-24-release-desktop-npm-distribution.md
supersedes: []
related_code:
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - desktop/src/update-check.ts
  - ui/src/pages/InstanceAboutSettings.tsx
  - ui/src/lib/desktop-shell.ts
  - doc/DESKTOP.md
commit_refs: []
updated_at: 2026-05-01
---

# Desktop Update Button Flow

## Goal

Replace the current "Open Release" update affordance with an "Update" action
that starts the existing Rudder-managed portable Desktop replacement flow.

## Decisions

- Keep GitHub Releases as the release source of truth.
- Reuse the bundled CLI `start` installer instead of duplicating download,
  checksum, replacement, and launcher logic in Electron.
- Treat in-app update as packaged-Desktop-only. Browser and development shell
  update checks remain comparison-only.
- Block the update when active agent runs are present, matching the existing
  update-quit safety rule.
- Spawn the bundled CLI as a detached updater so the current Electron process
  can quit when the installer requests replacement.
- Keep "open release page" only as a fallback for unavailable installer paths,
  not as the primary update CTA.

## Implementation Notes

- Add a Desktop IPC method for installing the discovered update version.
- Add a startup dialog primary button labelled `Update`.
- Add About page copy and button state for update installation.
- Document that this is still full portable replacement, not binary-delta
  incremental update.

## Validation

- Passed: `pnpm --filter @rudderhq/desktop typecheck`
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm vitest run desktop/src/update-check.test.ts ui/src/pages/InstanceAboutSettings.test.tsx`
- Passed: `pnpm --filter @rudderhq/desktop build`
