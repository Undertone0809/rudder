---
title: Windows Smart App Control browser-app fallback
date: 2026-09-03
kind: implementation
status: completed
area: deployment
entities:
  - cli_start
  - desktop_release
  - server_lifecycle
issue:
related_plans:
  - 2026-04-27-unified-npx-portable-desktop-install.md
supersedes: []
related_code:
  - cli/src/commands/start.ts
  - cli/src/commands/browser-app.ts
  - cli/src/program.ts
updated_at: 2026-09-03
---

# Windows Smart App Control browser-app fallback

## Problem

The Windows Desktop release is intentionally unsigned. Smart App Control can
therefore block a newly downloaded Rudder executable whenever Microsoft's cloud
reputation does not recognize that exact binary. Reinstalling the same portable
asset, changing launchers, or running as administrator does not make an
unsigned executable satisfy the policy.

## Goal

Keep `npx @rudderhq/cli@latest start` usable on Windows machines where Smart App
Control is enforcing signed-or-reputable code, without requiring the operator
to disable a device security control and without claiming that an unsigned
Electron executable is trusted.

## Decisions

- Add `--desktop-mode <auto|native|browser>` to `rudder start`.
- In `auto`, select browser-app compatibility mode only when Windows reports
  Smart App Control enforcement. Other platforms and Windows machines without
  enforcement retain the native Desktop path.
- `native` explicitly retains the existing portable Electron installation.
- `browser` explicitly selects the compatibility path.
- Browser-app mode installs the matching persistent CLI and server runtime,
  starts the existing `prod_local/default` instance in a detached hidden Node
  process, and opens the board in Microsoft Edge's signed `--app` window.
- Create a per-user Start Menu shortcut that repeats that launch without
  relying on the unsigned `Rudder.exe`.
- Keep an existing native Desktop installation in place. Do not delete user
  files or prevent an operator from returning to native mode later.
- Report the compatibility boundary honestly: Electron-only bridges are not
  available in a normal browser window.
- Treat this as an un-packaged, loopback-only `local_trusted` client. It does
  not present the packaged Canary/Stable Desktop Account Gate and must never be
  represented as a packaged Desktop session or exposed beyond loopback.

## Safety and fallback

- Read Smart App Control state; do not modify Windows security settings or
  policies.
- Prefer Microsoft Edge from the standard per-machine or per-user locations.
  If Edge is unavailable, open the local URL in the default browser.
- Keep the server bound to `127.0.0.1` in `local_trusted` mode and reuse the
  existing Rudder home, instance, and database paths.
- Never execute `Rudder.exe` merely to probe whether policy will block it.

## Product-contract delta proposal

No guarded `doc/product/**` files are edited in this change. A later explicitly
authorized registry update should extend `DESKTOP.SHELL.IDENTITY.001` (or add a
dedicated install/admission contract) with the Windows compatibility decision:
when native Desktop execution is unavailable because an unsigned release does
not satisfy Smart App Control, the public installer may offer the same local
workspace through a signed system-browser app window while clearly withholding
Desktop-only capabilities.

The same authorized delta must update `CLIENT.AUTH.RELEASE.ISOLATION.001` to
state that this browser-app path is intentionally outside the packaged
Canary/Stable client boundary: it is an un-packaged, loopback-only
`local_trusted` client, does not present the packaged Desktop Account Gate, must
not accept non-loopback exposure, and must not enable fixture or bypass identity
inside a packaged client. `PRIVACY.LOCAL.DATA.BOUNDARY.001` remains unchanged:
the fallback keeps workspace content and runtime credentials local.

## Acceptance

1. Unit tests cover Smart App Control parsing, mode selection, Edge resolution,
   shortcut construction, detached launch arguments, and native-mode override.
2. A Windows integration test uses an isolated Rudder home, starts browser-app
   mode without opening a real browser, verifies the installed runtime identity
   and health (including the existing explicit `latest` fallback for an
   unpublished candidate), and verifies a controlled restart attaches to the
   same instance.
3. Existing CLI start, Desktop packaged smoke, typecheck, test, lint, build, and
   product-logic checks are run, with candidate failures distinguished from
   pre-existing Windows or local-toolchain constraints.
4. Independent reviewer and black-box verifier verdicts apply to the same final
   candidate before commit and push.
