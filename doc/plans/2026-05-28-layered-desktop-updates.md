---
title: Layered Desktop Updates
date: 2026-05-28
kind: implementation
status: completed
area: desktop
entities:
  - desktop_updates
  - runtime_cache
  - cli_bootstrap
issue:
related_plans:
  - 2026-05-09-thin-cli-runtime-bootstrap.md
  - 2026-05-16-runtime-cache-retention.md
supersedes: []
related_code:
  - cli/src/commands/start.ts
  - cli/src/runtime/install.ts
  - desktop/src/runtime-cache.ts
  - desktop/src/main.ts
  - desktop/scripts/dist.mjs
  - scripts/collect-desktop-release-assets.mjs
  - scripts/wait-for-desktop-release-assets.mjs
  - doc/DESKTOP.md
commit_refs:
  - feat: add layered desktop shell updates
  - fix: verify desktop shell cli via script file
updated_at: 2026-05-28
---

# Layered Desktop Updates

## Summary

Split Rudder Desktop updates into a small Electron shell asset and a versioned
server runtime cache. The Desktop update path now avoids downloading the full
packaged server and embedded PostgreSQL payload on every macOS or Windows app
update when the matching runtime is already prepared by `rudder start`.

## Problem

Portable Desktop releases bundled the Electron shell, desktop CLI, server
runtime, dependencies, and embedded PostgreSQL payload into every update. That
made routine app updates much larger than the UI shell change required, and it
forced users to redownload the heavy server payload even though Rudder already
has a versioned runtime cache under `~/.rudder/runtimes`.

## Scope

- Add macOS and Windows `shell.zip` release assets alongside the existing full
  portable assets.
- Keep Linux on the existing AppImage path until there is a comparable layered
  distribution shape.
- Prune shell assets to the Electron shell and packaged desktop CLI only.
- Require an exact matching `@rudderhq/server@<version>` runtime cache before
  choosing a shell asset.
- Fall back to the full portable asset when the shell asset, checksum, runtime,
  or download path is not safe.
- Update release asset collection, checksum waiting, and Desktop docs so the
  release pipeline treats shell assets as required on supported platforms.

## Implementation

1. `desktop/scripts/dist.mjs` now creates full portable zips and shell zips for
   macOS and Windows. Shell zips retain the desktop CLI files and `commander`,
   fail if the packaged `server-package` is missing, and verify the pruned CLI
   through a temporary `.mjs` script that also works on Windows runners.
2. `cli/src/commands/start.ts` now resolves Desktop asset candidates in shell
   then full order, but enables shell candidates only after
   `ensureRuntimeInstalled()` returns the exact requested runtime package spec.
3. Full asset scoring explicitly excludes shell assets, so fallback selection
   cannot accidentally install a shell package as if it were full portable.
4. Shell candidates fail closed when their checksum is absent. Shell download
   failures fall back to the full checksummed portable candidate.
5. `desktop/src/runtime-cache.ts` resolves
   `~/.rudder/runtimes/<version>/runtime.json` and validates both runtime
   metadata and the installed `node_modules/@rudderhq/server/package.json`
   version before returning the shared server entrypoint.
6. Packaged Desktop imports the exact shared runtime first. If that import
   fails, it falls back to the bundled full server; if no bundled server exists
   because the app is a shell asset, it reports a clear recovery error.
7. Release scripts require macOS and Windows shell assets and verify that
   `SHASUMS256.txt` includes every expected app asset.

## Fallback And Safety Rules

- Shell assets are supported only for macOS and Windows.
- `latest` or any non-exact runtime selector disables shell asset selection.
- Missing shell assets, missing shell checksum entries, and shell download
  failures fall back to full portable when a full checksummed candidate exists.
- A shell app launched without a matching runtime cache is not a supported
  direct install path. Users should rerun `rudder start` so the CLI can prepare
  the runtime, or install the full portable asset.
- `RUDDER_DESKTOP_DISABLE_EXTERNAL_RUNTIME=1` disables shared-runtime loading
  for diagnostics and forces bundled-runtime behavior when a bundled server is
  present.

## Size Evidence

The validated `0.2.8-canary.3` release produced these asset sizes:

- macOS arm64: full `317.9 MB`, shell `108.8 MB`, saving about `209.1 MB`
  per shell update.
- macOS x64: full `325.8 MB`, shell `113.6 MB`, saving about `212.2 MB`
  per shell update.
- Windows x64: full `513.3 MB`, shell `134.0 MB`, saving about `379.3 MB`
  per shell update.

Local package inspection also showed the shell `server-package` reduced to a
CLI-only payload, while the full app retained the complete server package.

## Validation

- Passed: `pnpm --filter @rudderhq/cli exec vitest run src/__tests__/start.test.ts`
- Passed: `pnpm --filter @rudderhq/desktop exec vitest run src/runtime-cache.test.ts src/cli-runner.test.ts`
- Passed: `node --check desktop/scripts/dist.mjs`
- Passed: `node --check scripts/collect-desktop-release-assets.mjs`
- Passed: `node --check scripts/wait-for-desktop-release-assets.mjs`
- Passed: GitHub `release.yml` run `26523037612` on
  `6b99c7aa315289d7ac919a7e536bf3ce279879dc`
- Passed: GitHub `desktop-release.yml` run `26524607703` on the same SHA,
  including Windows x64.
- Passed: `node scripts/wait-for-desktop-release-assets.mjs --repo
  Undertone0809/rudder --tag canary/v0.2.8-canary.3 --version
  0.2.8-canary.3 --attempts 1`
- Passed: isolated local public install with
  `node scripts/smoke-public-install.mjs --package-spec
  @rudderhq/cli@0.2.8-canary.3 --repo Undertone0809/rudder --keep-temp`
  downloaded `Rudder-0.2.8-canary.3-macos-arm64-shell.zip`, wrote
  `assetKind: "shell"`, installed the matching runtime cache, and reported
  CLI version `0.2.8-canary.3`.
- Passed: launching that installed shell app reached the board UI and
  `/api/health` returned version `0.2.8-canary.3`.

## Open Issues

- Linux still uses the full AppImage path.
- Binary-delta updates remain out of scope; this is a layered asset strategy,
  not a byte-range patcher.
- A future Settings storage view can make runtime and Desktop asset cache size
  visible to users.
