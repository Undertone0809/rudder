---
title: Private D1 persistence schema boundary
date: 2026-09-16
kind: implementation
status: in_progress
area: data_model
entities:
  - organization_mutation_state
  - organization_mutation_receipt
  - migration_journal
  - activity_log
issue: R6Z-120
related_plans:
  - 2026-08-20-rust-migration-baseline-freeze.md
  - 2026-09-19-rust-migration-inspection.md
supersedes: []
related_code:
  - packages/db/src/schema/organization_mutations.ts
  - packages/db/src/migrations/0163_organization_mutations.sql
  - native/crates/organization-mutation-core/src/lib.rs
  - native/crates/project-goal-link-core/src/lib.rs
commit_refs:
  - 770a2eac6
  - 719b8b681
  - e829b9d2d
updated_at: 2026-09-20
---

# R6Z-120: private D1 persistence boundary

This slice is intentionally schema-only. Migration 0163 creates empty private
organization mutation state and immutable receipt tables. It does not backfill
rows, acquire ownership, activate a Rust writer, change the Node migration
runner or advisory lock, add a route/listener, or modify any Node caller.
Missing state and the default `node` owner therefore remain fail-closed.

## Schema contract

`organization_mutation_state` stores organization-scoped signed PostgreSQL
`BIGINT` version and fence values. Versions and fences cannot decrease, owner
changes require a strictly greater fence, and a live organization's state row
cannot be deleted to reset authority. The default owner is `node`; a Rust owner
requires a positive fence.

`organization_mutation_receipts` is keyed by `(org_id, idempotency_key)` and
stores the first command fingerprint, format, outcome, version, fence,
activity identity, and original JSON result. Database checks bind the result
envelope to its organization/version/fence. Updates and deletes for a live
organization are rejected, so a conflicting key cannot overwrite its original
receipt.

The additive `(org_id, id)` activity uniqueness permits a composite receipt
foreign key. That foreign key is `NO ACTION DEFERRABLE INITIALLY DEFERRED` so
the existing Node organization deletion order remains activity first and
organization last. Deleting a referenced activity alone still fails at commit;
organization deletion cascades the private rows only after the old activity
delete has satisfied the deferred reference.

## Current-main audit boundary

The closed PR #172 adapter commits (`770a2eac6`, `719b8b681`, `e829b9d2d`) are
reference material, not a cherry-pick source. Current main's
`project-goal-link-core` now requires an HMAC-verified `ActorBinding`, an
opaque `ValidatedLinkContext`, and a command whose fields are not public; it
also includes `Cancel`. The old `links.rs` therefore cannot be copied into a
safe adapter without either failing to compile or weakening the authorization
boundary.

The Rust SQLx adapter is deferred until the core package exposes an explicit
trusted integration hook that can be consumed without forging actors or
duplicating private command fields. This migration intentionally leaves no
half-compatible adapter, fake constructor, public route, or writer activation.
The next bounded slice must first define and review that hook, then add the
adapter and real PostgreSQL tests for success, original replay, conflict,
stale version/fence, cross-organization targets, rollback, and overflow.

## Recovery and authority

The existing Node migration runner, recovery point, journal validation, and
advisory lock remain authoritative. Migration 0163 is append-only and does not
rewrite earlier SQL, snapshots, or journal entries. The migration regression
upgrades a real schema through entry 162, applies 0163 through the normal Node
runner twice, preserves an existing organization write, and exercises guards,
foreign-key scope, deletion order, signed bounds, immutability, and rollback.
