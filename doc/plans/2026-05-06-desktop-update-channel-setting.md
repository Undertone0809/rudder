---
title: Desktop Update Channel Setting
date: 2026-05-06
kind: implementation
status: completed
area: desktop
entities:
  - desktop_release
  - desktop_settings
issue:
related_plans:
  - 2026-05-01-desktop-update-button-flow.md
  - 2026-04-27-unified-npx-portable-desktop-install.md
  - 2026-04-24-release-desktop-npm-distribution.md
supersedes: []
related_code:
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - desktop/src/update-check.ts
  - ui/src/pages/InstanceGeneralSettings.tsx
  - ui/src/pages/InstanceAboutSettings.tsx
  - ui/src/lib/desktop-shell.ts
  - doc/DESKTOP.md
commit_refs:
  - feat: add desktop update channel setting
updated_at: 2026-05-06
---

# Desktop Update Channel Setting

## Summary

Add a local Desktop update-channel preference so operators can opt into canary
Desktop updates from Settings. Stable remains the default channel, while canary
is only used after the operator explicitly enables it on this machine.

## Problem

Desktop update checks currently infer the release channel from the running
version. That prevents a stable Desktop build from discovering canary builds
through the in-app update flow, and it makes the update policy implicit instead
of operator-controlled.

## Scope

- In scope: local Desktop preference storage, Desktop IPC, startup/manual/About
  update checks, Settings UI, About copy, docs, and targeted tests.
- Out of scope: changing release publishing, npm dist-tags, Desktop asset
  naming, binary-delta updates, or organization-wide policy settings.

## Implementation Plan

1. Change update checking so the caller can provide a `stable` or `canary`
   channel, defaulting to `stable`.
2. Persist the selected update channel in the Electron user-data directory and
   expose `getUpdateChannel` / `setUpdateChannel` through preload.
3. Make startup checks, menu checks, and About checks use the stored channel.
4. Add a Settings > General update-channel row with stable default and canary
   opt-in copy.
5. Update About inline/toast copy so the checked channel is visible.
6. Update docs and targeted tests for stable default, canary opt-in, and UI
   rendering.

## Design Notes

The preference is local to the Desktop shell, not the Rudder instance. The
setting controls which portable app gets installed on this machine, so it should
not change behavior for other operators sharing the same server instance.

Stable and canary checks continue to use GitHub Releases as the release source
of truth. Beta prereleases remain ignored.

## Success Criteria

- Missing preference means update checks use stable.
- Enabling canary makes manual, About, and startup checks compare against the
  latest canary release.
- Settings exposes the preference without adding a new top-level settings page.
- About shows which channel was checked before offering an install action.

## Validation

- Passed: `pnpm --filter @rudderhq/desktop typecheck`
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm vitest run desktop/src/update-check.test.ts desktop/src/update-channel-preference.test.ts ui/src/pages/InstanceGeneralSettings.test.tsx ui/src/pages/InstanceAboutSettings.test.tsx`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm test:run`
- Passed: `pnpm build`
- Passed: `pnpm --filter @rudderhq/desktop smoke`
- Passed after cleaning generated packaging dirs and restoring workspace
  dependencies: `pnpm desktop:dist`
- Passed: `node desktop/scripts/smoke.mjs --mode=packaged`
- Attempted browser screenshot verification with Desktop shell injection, but
  local browser automation timed out before producing an image. Desktop smoke
  did verify the Settings overlay and General/About routes in both dev and
  packaged shells.

## Open Issues

None.
