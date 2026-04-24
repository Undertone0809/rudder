---
title: Release Desktop And npm Distribution
date: 2026-04-24
kind: implementation
status: completed
area: deployment
entities:
  - release_automation
  - npm_publishing
  - desktop_release
issue:
related_plans:
  - 2026-03-17-release-automation-and-versioning.md
  - 2026-03-26-rudder-desktop-v1.md
  - 2026-03-27-rudder-single-package-cli.md
  - 2026-03-31-semver-reset-and-release-alignment.md
supersedes: []
related_code:
  - .github/workflows/release.yml
  - .github/workflows/desktop-release.yml
  - cli/src/program.ts
  - cli/src/commands/start.ts
  - scripts/release.sh
  - scripts/create-github-release.sh
  - desktop/scripts/dist.mjs
commit_refs:
  - feat: add desktop npm release distribution
  - feat: use start as desktop distribution entrypoint
updated_at: 2026-04-24
---

# Release Desktop And npm Distribution

## Goal

Ship Rudder through two coordinated public distribution surfaces:

- npm publishes `@rudder/cli` plus the public runtime/workspace packages.
- GitHub Releases publish the desktop installers for macOS, Windows, and Linux.

The public first-run command should be:

```bash
npx @rudder/cli@latest start
```

By default, `start` checks for newer CLI releases, prepares the matching
persistent CLI, and starts the matching desktop path for the current platform.

## Decisions

- Keep desktop binaries on GitHub Releases, not npm.
- Keep npm focused on the CLI and public runtime packages.
- Make `rudder start` the operator-friendly launch command.
- `npx @rudder/cli@latest start` prepares both the desktop app and the same
  CLI version globally unless explicitly skipped.
- `start` checks npm for a newer `@rudder/cli` stable release and prints a
  non-blocking update reminder when one exists.
- Use the currently running CLI package version to select the desktop release
  tag. For example, `@rudder/cli@0.1.0` installs desktop release `v0.1.0`.
- Keep `@canary` usable by resolving the latest canary tag from GitHub when the
  running CLI version is a canary prerelease.
- Restore CI release workflows because the docs and scripts currently describe
  workflows that are missing from the checkout.

## Implementation Plan

1. Add a top-level `start` CLI command.
   - Check npm for a newer stable CLI version and print an update reminder.
   - Install the persistent CLI via the existing npm global install helper.
   - Detect the current OS and CPU architecture.
   - Resolve the matching GitHub Release asset for the desktop installer.
   - Download the asset into a temp directory.
   - Verify checksum when the release includes `SHASUMS256.txt`.
   - Open the installer or print the exact path and next command when opening is
     unavailable.

2. Restore npm release automation.
   - Add `.github/workflows/release.yml`.
   - Run canary publish on `main` pushes.
   - Run stable publish from manual `workflow_dispatch`.
   - Keep trusted publishing compatible by granting `id-token: write`.
   - Push release tags and create/update GitHub Releases for stable releases.

3. Add desktop release automation.
   - Add `.github/workflows/desktop-release.yml`.
   - Build desktop artifacts on macOS, Windows, and Linux runners.
   - Package macOS DMG, Windows NSIS EXE, and Linux AppImage.
   - Generate a `SHASUMS256.txt`.
   - Attach all desktop artifacts and checksums to the stable GitHub Release.

4. Update release docs.
   - Document `npx @rudder/cli@latest start`.
   - Document npm trusted publishing setup for `release.yml`.
   - Document GitHub Release desktop artifacts and the desktop workflow.
   - Clarify alpha signing/notarization limitations if signing is not yet
     configured.

5. Add focused tests.
   - Unit-test platform asset selection and release-tag resolution.
   - Unit-test the start command helpers without downloading real assets.
   - Run targeted CLI tests plus typecheck/build as far as practical.

## Risks

| Risk | Mitigation |
| --- | --- |
| Desktop asset names drift from CLI resolver | Define one naming convention in docs and tests. |
| Stable npm publishes but desktop workflow fails | Keep GitHub Release update idempotent; rerun desktop workflow for the same tag. |
| Unsigned desktop artifacts trigger OS warnings | Label early releases as alpha and keep signing/notarization as a follow-up. |
| Canary desktop start ambiguity | Resolve latest `desktop/v*` or stable `v*` canary-compatible tag through GitHub API only when canary CLI is used. |
| Existing dirty worktree files | Commit only files touched for this release work. |

## Validation

- `pnpm --filter @rudder/cli typecheck`
- targeted CLI Vitest tests for start helpers
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

If full repository validation fails for unrelated pre-existing reasons, record
the failure in this plan before hand-off.

## Implementation Notes

- Added `rudder start` as the default public launch command.
- Added a non-blocking npm latest check for update reminders.
- Added stable GitHub Release desktop asset resolution and checksum validation
  in the CLI desktop starter.
- Restored `.github/workflows/release.yml` for npm canary/stable publishing.
- Added `.github/workflows/desktop-release.yml` for macOS, Windows, and Linux
  desktop artifacts plus `SHASUMS256.txt`.
- Switched release publish payloads to exact internal dependency pins for
  stable and canary publishes.
- Kept desktop binaries on GitHub Releases; npm remains the CLI/runtime package
  distribution surface.

## Validation Results

- Passed: `pnpm vitest run cli/src/__tests__/start.test.ts`
- Passed: `pnpm --filter @rudder/cli typecheck`
- Passed: `pnpm rudder start --dry-run --no-open --no-version-check`
- Passed: `node scripts/collect-desktop-release-assets.mjs --version 0.1.0 --platform macos --arch arm64 --out /tmp/rudder-desktop-assets-check`
- Passed: `node scripts/release-package-map.mjs list`
- Passed: workflow YAML parse check with Ruby `YAML.load_file`
- Passed: `pnpm --filter @rudder/cli build`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Passed: `pnpm desktop:verify`
- Partial: `pnpm test:run`
  - Full run failed once on `server/src/__tests__/chat-routes.test.ts` with a
    5000ms timeout in `traces manual chat-to-issue conversion as a chat action`.
  - Passed on targeted rerun:
    `pnpm vitest run server/src/__tests__/chat-routes.test.ts -t "traces manual chat-to-issue conversion as a chat action"`.
