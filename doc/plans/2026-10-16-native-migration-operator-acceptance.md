---
title: Native migration operator acceptance
date: 2026-10-16
kind: implementation
status: in_progress
area: api
entities: [backend_authority, rust_migration, runtime_lifecycle]
issue:
related_plans: [2026-10-16-rudder-rust-backend-retirement.md]
supersedes: []
related_code: [native/crates/migration-service, native/crates/migration-history-postgres]
commit_refs: []
updated_at: 2026-10-16
---

# Native migration operator acceptance

This packet covers the explicit `migration-apply` executable and its writer.
Node remains the default startup owner. Historical journal repair, database
process lifecycle and packaged default cutover are separate incomplete slices.

## Candidate and prior rejection

Base `ae74493a38f9688980d9ff46d49fff1a32896eab`, branch
`codex/rust-backend-completion-20261016`. The first stage review rejected backup
self-attestation: the wrapper's journal marker could pass an empty successful
dump. The repaired candidate removes that marker and requires actual plain
PostgreSQL dump structure, including journal definition/data and completion.
The raw operator database URL is also removed from the dump child's environment.
Re-review must accept this repaired candidate before independent acceptance.

The verifier must record dependency-closure/source hash, manifest fingerprint,
immutable copied binary hash, PostgreSQL/client versions, process/listener and
disposable database identities. Recapture identities before the terminal verdict.

## Public operator criteria

Use the actual stdin/stdout protocol, not only library calls:

- Bootstrap the shipped historical migration source into a disposable empty
  database and verify journal/schema consistency, including the known 0055
  SELECT 1 and 0128 index reconciliation cases.
- Upgrade a source copied into a disposable fixture with a new append-only
  migration and production-shaped preserved rows. Restore its real recovery
  dump into a separate empty database; verify pre-upgrade data, schema and
  journal. Repeating an already-current operation must not apply twice.
- A selected dump executable that exits zero with empty output, a truncated
  dump or an unrelated-table dump must fail before changing schema or history.
  Backup process failure, source fingerprint mismatch and ambiguous nonempty
  legacy history also fail without mutation.
- Hold the existing Node-compatible database advisory lock and observe the
  operator wait. Cancel a waiting/in-progress operator, release the fixture
  lock, and verify a fresh invocation succeeds without leaked lock ownership.
- A migration whose later statement fails rolls back its earlier statements and
  journal insert together. Preserve earlier committed migrations and backup.
- The dump child receives required libpq connection settings but not the raw
  RUDDER_MIGRATION_APPLY_DATABASE_URL; credentials appear in neither argv nor
  diagnostic output. Existing recovery files are not overwritten.

## Boundaries

Detailed evidence and all temporary databases stay outside the repository.
Only explicit disposable databases may be created, restored or dropped.
Author library tests support lock/race coverage; they do not replace independent
operator workflow observation. Return PASS, FAIL or QUESTION. No UI, deployed
service, default startup or cross-platform package acceptance is implied.
