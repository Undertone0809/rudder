---
title: Shared PostgreSQL Runtime Payload
date: 2026-07-24
kind: implementation
status: implemented
area: desktop
entities:
  - runtime_cache
  - postgres_runtime
  - desktop_updates
issue:
related_plans:
  - 2026-05-16-runtime-cache-retention.md
  - 2026-05-28-layered-desktop-updates.md
  - 2026-07-16-desktop-update-last-known-good-recovery.md
supersedes: []
related_code:
  - cli/src/runtime/install.ts
  - desktop/src/postgres-runtime.ts
  - server/src/local-runtime.ts
commit_refs: []
updated_at: 2026-07-24
---

# Shared PostgreSQL Runtime Payload

## Goal

Keep one managed PostgreSQL payload per PostgreSQL version, platform, and
architecture under `~/.rudder/runtime-payloads/`. Rudder release runtimes must
reuse that payload instead of copying PostgreSQL binaries into every
`~/.rudder/runtimes/<version>` entry.

## Implementation

- Make the shared PostgreSQL 18.4 payload authoritative while preserving an
  explicit operator-provided `RUDDER_POSTGRES_BIN_DIR`.
- Provision the managed payload automatically on macOS and Windows. Linux keeps
  system or explicit PostgreSQL precedence and retains its embedded fallback
  unless a verified shared payload already exists.
- Prepare or migrate the shared payload atomically, validate its binaries and
  initdb templates, and expose its bin directory through runtime installation
  results.
- Replace legacy version-local payload directories with links to the shared
  payload after no live runtime references their physical files.
- Record optional PostgreSQL runtime metadata in runtime and live-server
  descriptors so old descriptors remain readable and cleanup is conservative.
- Remove only the managed runtime's embedded PostgreSQL platform package after
  the shared payload is proven usable; preserve unrelated optional packages.
- Prune incomplete runtime cache entries and obsolete PostgreSQL payloads
  without touching instance database data.

## Verification

- Unit and integration coverage for shared reuse, migration, explicit override,
  compatibility links, descriptor compatibility, cleanup, and concurrency.
- Packaged Desktop handoff and cold-start smoke with database identity and data
  preserved.
- Full lint, typecheck, test, build, Desktop verification, and release smoke
  before hand-off.

The focused runtime suites, full workspace typecheck/build, packaged Desktop
handoff, and a fresh packaged cold start all pass. The repository-wide lint and
test commands still report unrelated failures in files unchanged from base
`main`; the release browser smoke also requires its separately bootstrapped
Docker target at port 3232 and does not start that target itself.

## Release Gate

Implementation stops at review-ready. A new canary or stable publication
requires separate target-specific confirmation.
