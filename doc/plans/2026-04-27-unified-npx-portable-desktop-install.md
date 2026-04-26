---
title: Unified npx portable desktop install
date: 2026-04-27
kind: implementation
status: completed
area: deployment
entities:
  - release_automation
  - desktop_release
  - cli_start
issue:
related_plans:
  - 2026-04-24-release-desktop-npm-distribution.md
  - 2026-03-26-rudder-desktop-v1.md
  - 2026-03-31-desktop-resident-shell.md
supersedes: []
related_code:
  - cli/src/commands/start.ts
  - desktop/src/main.ts
  - desktop/scripts/dist.mjs
  - .github/workflows/desktop-release.yml
commit_refs: []
updated_at: 2026-04-27
---

# Unified npx Portable Desktop Install

## Goal

Use `npx @rudderhq/cli@latest start` as the single public install entrypoint
while avoiding unsigned installer friction and the Windows NSIS close-failure
path. The CLI remains globally installable through npm, but Desktop becomes a
per-user portable install managed by the CLI.

## Decisions

- Keep npm as the CLI/runtime distribution surface.
- Keep Desktop binaries on GitHub Releases.
- Publish portable Desktop assets by default:
  - macOS `.zip` containing `Rudder.app`
  - Windows `.zip` containing the unpacked Electron app
  - Linux `.AppImage`
- Require `SHASUMS256.txt` verification before installing Desktop assets.
- Install Desktop per user only.
- Use stop-and-replace for upgrades; block if the running Desktop reports
  active agent runs.
- If graceful close fails and no active-run block is reported, force terminate
  Rudder and replace the portable install.

## Implementation Notes

- Update `rudder start` to download, verify, install, and launch portable
  Desktop assets instead of opening platform installers.
- Add a Desktop update-quit second-instance protocol for graceful replacement.
- Update Desktop release automation to upload portable assets.
- Update docs to call the current Desktop channel an unsigned portable alpha
  until Apple/Windows code signing is available.

## Validation

- Passed: `pnpm vitest run cli/src/__tests__/start.test.ts`
- Passed: `pnpm --filter @rudderhq/cli typecheck`
- Passed: `pnpm --filter @rudderhq/desktop typecheck`
- Passed: workflow YAML parse check
- Passed: `pnpm rudder start --dry-run --no-version-check --no-open --desktop-install-dir /tmp/rudder-portable-dry-run`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Passed: `pnpm desktop:verify`
- Passed: `node scripts/collect-desktop-release-assets.mjs --version 0.1.0 --platform macos --arch arm64 --out /tmp/rudder-desktop-assets-check`
- Failed, unrelated to this plan: `pnpm test:run`
  - Embedded PostgreSQL suites hit local shared-memory exhaustion.
  - Existing non-install-route assertions failed in instance settings,
    heartbeat retry, and company import/export round-trip tests.
