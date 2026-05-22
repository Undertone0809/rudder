---
title: Thin CLI runtime bootstrap
date: 2026-05-09
kind: implementation
status: completed
area: deployment
entities:
  - cli_bootstrap
  - runtime_cache
issue: ZST-82
related_plans: []
supersedes: []
related_code:
  - cli/src/commands/start.ts
  - cli/src/commands/run.ts
  - cli/src/runtime/install.ts
  - cli/esbuild.config.mjs
  - scripts/generate-npm-package-json.mjs
commit_refs:
  - feat: add thin CLI runtime cache
updated_at: 2026-05-09
---

# Thin CLI Runtime Bootstrap

## Summary

Split the npm cold-start path so `@rudderhq/cli` can enter its own UI before
heavy server/runtime dependencies are installed. The CLI remains responsible for
bootstrap UX, configuration, downloads, and HTTP client commands; the server
runtime is installed into a versioned cache under the Rudder home directory.

## Problem

`npx @rudderhq/cli@<version> start` currently waits on npm to install the full
CLI dependency tree before any Rudder UI can render. Because that tree includes
server, database, embedded PostgreSQL, and local agent runtime packages, the
first-run experience looks like a hang before `rudder start` can explain what is
happening.

## Scope

- Add a versioned runtime installer/cache for the published server runtime.
- Wire `rudder start` to show progress while preparing that runtime.
- Wire `rudder run` to load the server from the cached runtime when not running
  from a monorepo checkout.
- Prune the published CLI dependency collector so heavy runtime packages are no
  longer part of the `@rudderhq/cli` production install path.
- Leave broader command delegation for developer-only heavyweight commands as a
  follow-up unless needed for the start/run path.

## Implementation Plan

1. Add runtime cache helpers that resolve `~/.rudder/runtimes/<version>`, detect
   matching installs, run `npm install --prefix`, and write metadata.
2. Add a runtime server loader that keeps the monorepo dev path fast and uses
   the cached runtime for published CLI execution.
3. Integrate the installer into `start` before Desktop installation and into
   `run` before server import.
4. Update npm build/package generation to publish only the thin bootstrap
   dependencies.
5. Add focused tests for cache hits, installer failure messaging, and package
   dependency pruning.

## Design Notes

- Runtime cache semantics are versioned by CLI target version; `latest` remains
  cacheable but is treated as a mutable tag.
- Runtime installation failures should include the npm command and cache path so
  a user can retry manually or clear the cache.
- Desktop installation keeps its own metadata and cache semantics; runtime
  metadata is separate.

## Success Criteria

- `rudder start` prints its own intro before any heavy runtime install begins.
- Published CLI dependencies do not include server, db, embedded PostgreSQL, or
  local agent runtime packages.
- `rudder run` can start from the monorepo without installing a runtime and can
  resolve a cached runtime in published mode.
- Cache hits avoid reinstalling the same runtime version.

## Validation

- `pnpm vitest run cli/src/__tests__/start.test.ts` passed.
- `pnpm --filter @rudderhq/cli typecheck` passed.
- `pnpm --filter @rudderhq/server typecheck` passed.
- `pnpm --filter @rudderhq/cli build` passed.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- Publish package generation produced five dependencies and no heavy runtime packages.
- `pnpm test:run` was attempted, but local embedded Postgres init hit macOS SysV shared-memory exhaustion (`shmget` ENOSPC); the unrelated route failure passed when rerun in isolation.

## Open Issues

- Heavy developer commands such as worktree and benchmark may need a later
  command-delegation pass if they must remain available from the published thin
  CLI.
