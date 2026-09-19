---
title: Migration core offline source inspection boundary
date: 2026-09-19
kind: implementation
status: completed
area: data_model
entities:
  - migration_source
  - migration_manifest
issue:
related_plans: []
supersedes: []
related_code:
  - native/crates/migration-core/src/lib.rs
  - packages/db/src/migration-manifest.ts
commit_refs: []
updated_at: 2026-09-19
---

# Boundary

`rudder-migration-core` owns the private, offline preflight for migration
source assets. It reads the explicit migrations directory and journal, parses
the current Drizzle/Paperclip-compatible shape, classifies journaled versus
allowlisted legacy SQL files, and computes the same canonical SHA-256 manifest
identity as `packages/db/src/migration-manifest.ts`.

The existing `MigrationManifest` and `PreMutationRequirements` API remains the
single Rust domain boundary. Source inspection is read-only and returns
metadata, hashes, and diagnostics; it does not become migration authority.

The source is a global release asset, so this API intentionally accepts no
organization ID and performs no organization lookup or authorization. The
path boundary is one explicit directory plus a journal below that directory;
the root itself and components below it, symlink files, non-regular SQL files,
unknown SQL files, duplicate journal tags, and malformed names fail closed.

The canonical manifest uses an explicit bytewise file-name order and hashes
the raw SQL bytes on both the Node and Rust sides. Append compatibility checks
the immutable journal prefix and the fixed legacy tail independently, including
journal metadata.

# Non-Goals

This slice does not connect to PostgreSQL, inspect migration history, execute
SQL, acquire an advisory lock, create a recovery point, register a route,
change startup behavior, retire Node migration ownership, or mint migration
authority. It also does not provide an atomic descriptor-anchored snapshot
against a hostile concurrent writer across the entire directory hierarchy;
individual files are opened no-follow and read through bounded handles, while
atomic directory enumeration and root-descriptor binding remain a separately
reviewed follow-up. Database mutation, migration authority, and startup
integration remain with the current TypeScript migration runtime and any
separately reviewed future adapter.
