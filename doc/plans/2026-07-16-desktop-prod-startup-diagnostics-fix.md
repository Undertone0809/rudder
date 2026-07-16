---
title: Desktop Prod Startup and Diagnostics Fix
date: 2026-07-16
kind: fix-plan
status: completed
area: desktop
entities:
  - desktop_startup
  - startup_recovery
  - support_diagnostics
  - runtime_cache
issue:
related_plans:
  - 2026-07-15-desktop-startup-loading-recovery.md
  - 2026-05-09-thin-cli-runtime-bootstrap.md
supersedes: []
related_code:
  - cli/src/commands/start.ts
  - cli/src/runtime/install.ts
  - desktop/src/boot-screen.ts
  - desktop/src/desktop-startup-failure.ts
  - desktop/src/desktop-support-mail.ts
  - desktop/src/main.ts
  - desktop/scripts/smoke.mjs
commit_refs: []
updated_at: 2026-07-16
---

# Desktop Prod Startup and Diagnostics Fix

## Problem

After an in-app update to `0.4.6-canary.11`, packaged Desktop installs a shell
asset whose version-specific runtime cache has no PostgreSQL 18.4 payload. The
shell eligibility check ignores that missing payload. Desktop then falls back
to the npm embedded PostgreSQL binary, whose `liblz4` dependency is rejected by
macOS system policy, so the prod API never starts.

The recovery surface also fails the operator in two ways:

- the visible and copied diagnostic contains only generic stage metadata, not a
  bounded explanation of the classified failure;
- `URLSearchParams` serializes mailto spaces as `+`, which Apple Mail displays
  literally instead of decoding as spaces.

This is a restoration of `CONTROL.DESKTOP.STARTUP.RECOVERY.001`, not a product
logic change. The contract already requires a plain-language failure summary,
shared bounded diagnostics, and an encoded editable support draft.

## Scope

1. Reuse the prepared shared PostgreSQL 18.4 payload under
   `~/.rudder/runtime-payloads/` when staging a version-specific CLI runtime
   cache, while preserving an explicit `RUDDER_POSTGRES_BIN_DIR` override.
2. Require an exact runtime and a usable PostgreSQL payload before selecting a
   Desktop shell asset.
3. Include the existing allowlisted failure summary in the technical detail,
   copied diagnostic, and support draft without exposing raw exception text.
4. Encode mailto subject and body with percent encoding so mail clients receive
   spaces and line breaks instead of literal plus signs.
5. Add focused unit coverage and a real packaged Desktop regression path for
   payload staging, failure rendering, diagnostic copying, support mail, and
   prod API readiness.

## Non-Goals

- Editing `doc/product/**`.
- Exposing raw logs, exception stacks, credentials, config contents, database
  files, or private workspace data in the renderer or support draft.
- Sending email or submitting an issue automatically.
- Redesigning the recovery surface beyond making its error information useful.

## Acceptance Criteria

- A shell asset is not selected when the matching runtime cache lacks a usable
  PostgreSQL 18.4 payload.
- Runtime installation can stage the existing shared payload into the exact
  version cache without requiring the caller to pre-populate an environment
  variable.
- Packaged Desktop starts the real `default` prod instance with the official
  PostgreSQL payload and `GET /api/health` reports no pending migrations.
- The failure page visibly shows the classified summary and exposes the same
  summary in technical details and copied diagnostics.
- Apple Mail receives a readable subject and multiline body with no literal
  separator `+` characters introduced by URL encoding.
- Focused tests, repository typecheck/test/build gates, `pnpm desktop:verify`,
  and a rendered Desktop black-box check pass before handoff.

## Verification

- Focused regression tests: 5 files, 95 tests passed.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm product-logic:check`, and
  `pnpm build` passed.
- Desktop packaging completed and verified the PostgreSQL 18.4 payload.
- Packaged startup-recovery and upgrade smoke scenarios passed. The unrelated
  clean smoke scenario reached a working board and failed later in the old
  baseline reload-navigation wait.
- The installed `0.4.6-canary.11` runtime reused the shared PostgreSQL 18.4
  payload. The real `default` prod instance reported healthy, used that exact
  binary path, applied its pending migration, and then reported `upToDate`.
- Independent reviewer and black-box verifier both passed the final change.
- Full `pnpm test:run` on the old branch baseline reported 4,221 passed, 2
  skipped, and 15 unrelated failures in existing automation, migration 0102,
  Feishu, board-mutation, and heartbeat-concurrency expectations.
