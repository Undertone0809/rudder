---
title: Runtime Cache Retention
date: 2026-05-16
kind: implementation
status: completed
area: deployment
entities:
  - runtime_cache
  - cli_bootstrap
issue:
related_plans:
  - 2026-05-09-thin-cli-runtime-bootstrap.md
  - 2026-05-08-desktop-update-progress.md
supersedes: []
related_code:
  - cli/src/runtime/install.ts
  - cli/src/__tests__/start.test.ts
  - doc/DESKTOP.md
commit_refs:
  - feat: prune old runtime cache entries
updated_at: 2026-05-16
---

# Runtime Cache Retention

## Summary

Add a bounded retention policy for the published server runtime cache under
`~/.rudder/runtimes`. Versioned runtime installs remain the source of fast,
isolated starts, but old versions should not accumulate indefinitely after
Desktop or CLI updates.

## Problem

The thin CLI bootstrap installs `@rudderhq/server@<version>` into
`~/.rudder/runtimes/<version>` and reuses that directory on later starts. The
cache key is intentionally immutable for exact versions, but the current
implementation never prunes old entries. Canary users can accumulate many
hundreds of megabytes per update, and the cache becomes user-visible storage
debt.

## Scope

- In scope: automatic best-effort pruning after runtime install/cache-hit,
  metadata touch timestamps, protection for current/previous/active runtime
  versions, size and age based cleanup, and focused tests.
- Out of scope: Desktop portable asset cache retention, binary-delta updates,
  full Settings storage management UI, and destructive cleanup of instance data.

## Implementation Plan

1. Extend runtime install metadata with a non-breaking `lastUsedAt` timestamp.
2. Add runtime cache scanning that reads valid runtime metadata and computes
   cache entry size and recency.
3. Add a retention planner that protects the requested version, healthy active
   runtime descriptor versions, latest stable, latest canary, and at least one
   previous runtime entry.
4. Prune entries that exceed age, count, or total-size policy without blocking
   startup when cleanup fails.
5. Add tests for protected current/previous versions, canary pruning, active
   descriptor protection, and size-limit cleanup.
6. Document the runtime cache retention behavior in Desktop/CLI docs.

## Design Notes

- Pruning is best effort. Runtime installation and startup should not fail
  because an old cache directory could not be removed.
- The retention policy is intentionally conservative: keep enough local history
  for rollback and weak-network recovery, but do not keep every canary.
- Active runtime protection is based on instance runtime descriptors under
  `~/.rudder/instances/*/runtime/server.json`.
- `latest` is a mutable package selector and should not receive stronger
  protection than exact versions unless it is the requested or active version.

## Success Criteria

- Reusing or installing a runtime can trigger old-cache pruning automatically.
- Current and active runtime versions are never selected for deletion.
- The latest stable, latest canary, and one previous runtime remain available
  when present.
- Canary-heavy caches shrink without manual Finder cleanup.
- Cleanup failures are reported as warnings only.

## Validation

- Passed: `pnpm vitest run cli/src/__tests__/start.test.ts`
- Passed: `pnpm --filter @rudderhq/cli typecheck`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Attempted: `pnpm test:run`
  - Failed in embedded PostgreSQL initialization across DB-backed suites with
    `Postgres init script exited with code 1. Please check the logs for extra info.`
  - The focused runtime-cache CLI tests passed in the same full test run before
    the unrelated DB-backed suite failures were reported.

## Open Issues

- A future Settings storage panel can surface cache size and expose a manual
  cleanup button, but the automatic policy is now in place.
