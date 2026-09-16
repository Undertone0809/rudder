# R6Z-120: private D1 transaction persistence

Status: implementation candidate, not accepted or activated

Issue: R6Z-120

## Authority and acceptance boundary

Migration 0163 creates empty organization mutation state and original receipt
ledgers. It does not backfill rows, change Node callers, activate a Rust writer,
change migration-runner ownership, or open a public route. Missing state and the
Node default are both fail-closed conditions for a future private SQLx adapter.
There is deliberately no ownership-acquisition endpoint in this slice.

The organization row and state row must be locked in that order. One SQLx
transaction must own the business change, monotonically increasing organization
version, activity, and original receipt. The organization-wide idempotency key is
shared by branding and project-goal commands. A conflicting fingerprint never
replaces an existing receipt. Replay must return the original resulting version,
fence, activity ID, and result, not the current aggregate state. An unknown future
receipt format is storage-compatible but must fail closed in an older adapter.
No production dual-write mode is permitted.

Commands are not credentials. A future adapter must require a separate trusted,
non-deserializable actor binding supplied after existing authorization. Agent
identity, organization, and CEO role must also be checked against actual database
rows. Every entity, logo asset, activity, and key lookup is organization-scoped.

## Schema and backward compatibility

`organization_mutation_state` contains a signed BIGINT mutation version and fence,
with a Node owner by default. Owner changes require a strictly greater fence.
Neither version nor fence may decrease. Live state cannot be deleted and recreated
to reset the fence. Versions must be checked at the Rust u64 / PostgreSQL BIGINT
boundary before any business change.

`organization_mutation_receipts` binds an organization-scoped key to command kind,
SHA-256 fingerprint, format version, applied/noop classification, original version
and fence, original JSON result, and the activity ID. The JSON envelope must match
the organization, version, and fence columns. Updates and live-organization deletes
are rejected by database triggers. This is not a table of current business state.
Rejected commands do not create success receipts: conflict is derived from the
immutable first receipt and its fingerprint, without overwriting evidence.

A composite activity foreign key enforces that a receipt and its activity belong
to the same organization. It is NO ACTION, DEFERRABLE INITIALLY DEFERRED: existing
Node organization deletion removes activity first and organization last in one
transaction. That ordering must still commit, with organization deletion cascading
through the new state and receipt tables. Deleting referenced activity by itself
must fail at commit. The additional activity unique index is additive.

No existing SQL file or existing journal entry is rewritten. The current Node
migration runner, advisory lock, recovery point and migration-journal transaction
remain authoritative. Re-running the actual upgrade is tested. The new ledger is
not a substitute for the current migration journal or release compatibility matrix.

## Generation evidence and limits

`pnpm db:generate` first compiles the schema but encounters the pre-existing shared
parent collision between published `0140_snapshot.json` and `0143_snapshot.json`.
Changing either historical snapshot is not an acceptable workaround. Drizzle Kit
0.31.10 generated the two new table definitions from the compiled new schema into
an isolated output directory. Only that new SQL, the additive activity index,
explicit deferred constraint and guard triggers were placed in migration 0163.
The existing journal receives one appended entry. No partial standalone snapshot
was inserted into the historical snapshot chain. Future general schema generation
still needs a separately reviewed resolution of that historical metadata collision.

## Rollback and recovery

Before a non-empty production upgrade, retain the existing full recovery point
including the migration journal. This change neither disables that gate nor adds
a second runner. Before writer activation, reverting application code leaves the
empty additive schema compatible with old Node writes and deletion. Do not execute
a destructive down migration or erase applied migration history.

After any future writer activation, an application-code rollback alone is not an
ownership protocol. Quiesce all writers, verify a recovery point and in-flight
transactions, then use a separately reviewed fenced transition before allowing
Node to write again. No claim of mixed-version concurrent writer safety is made.
The database guards constrain cooperating adapters; they do not retrofit all old
Node write paths to obey a new version or fence. Activation remains a serial gate.

## Required evidence

The acceptance packet was fixed before editing: full historical schema upgrade,
old Node update/deletion compatibility, default owner, idempotency isolation,
immutable receipts, monotonic fences, BIGINT boundaries, and rollback when an
activity reference is invalid. All nine schema regressions first failed against
the old schema and pass after 0163 on disposable PostgreSQL using the actual Node
migration runner. These tests are in the normal database Vitest collection.

The next library slice must add real PostgreSQL success, original replay after
restart and later changes, conflicts, stale versions/fences, cross-organization
entities, concurrent commands, audit failure rollback and cancellation coverage.
For project-goal links it must receive an explicit legacy primary goal and bind it
into the fingerprint, rather than inventing an ordering for remaining links.

Full applicable Node and native baselines, exact-source hosted CI, independent
reviewer accept, independent verifier PASS, and final review on the same SHA remain
required before acceptance. A focused green schema suite is not adapter acceptance,
public cutover, or completion of D1. Task-plan progress remains 10/18 (55.56%), not
a percentage of production backend authority migrated.
