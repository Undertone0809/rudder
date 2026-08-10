---
title: Database Migration Compatibility
domain: execution
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - DATABASE.MIGRATION.COMPATIBILITY.001
related_code:
  - packages/db/src/client.ts
  - packages/db/src/migration-manifest.ts
  - server/src/index.ts
  - scripts/release-compatibility-matrix.mjs
  - scripts/release-compatibility-runtime.ts
  - .github/workflows/release.yml
related_tests:
  - packages/db/src/client.test.ts
  - packages/db/src/migration-manifest.test.ts
  - scripts/release-compatibility-matrix.test.mjs
  - scripts/release-workflow-contract.test.mjs
  - server/src/__tests__/migration-startup-contract.test.ts
  - desktop/scripts/smoke.mjs
related_plans: []
edit_policy: user_confirmed_only
---

# Database Migration Compatibility

## DATABASE.MIGRATION.COMPATIBILITY.001

## Contract Summary

Rudder's managed server-startup upgrade path changes an existing PostgreSQL
database only through an immutable, verified migration history. A candidate
release must preserve every published migration and declare a compatibility
matrix containing strictly older, production-shaped database fixtures. Before
that path changes a non-empty database, Rudder creates a recoverable
pre-migration backup, serializes the complete startup migration flow, applies
legacy normalization transactionally, and checks post-migration invariants
before the server is allowed to continue.

Unknown migration journal identifiers, changed historical SQL, missing recovery
points, failed normalization, failed migrations, or failed invariants stop the
upgrade. The release workflow runs the historical upgrade and packaged smoke
gates before any npm, tag, or GitHub Release mutation.

## Intent / User Job

An operator should be able to install a newer Rudder version over an existing
instance without losing organizations, tasks, chats, runs, accounts,
permissions, relationships, or other persisted work. When the managed startup
upgrade cannot be proven safe, Rudder must retain any recovery point already
created for that attempted mutation, leave an unchanged database available when
no mutation was planned, and refuse to start against an unverified schema
instead of silently repairing or partially continuing.

## Why / Design Reasoning

Database migrations are durable changes to user-owned work, not an ordinary
startup detail. A green page or a current migration count does not prove that
historical SQL, journal order, relationships, or permissions survived. The
contract therefore uses immutable migration fingerprints, explicit old-version
fixtures, a recovery point before any mutation, and invariant checks after the
whole chain.

The migration lock is database-scoped so concurrent server starts converge on
one migration attempt. Legacy column normalization is one transaction so a
later rename failure cannot leave a mixed schema. Automatic recovery is
bounded to creating a restorable pre-change copy; restoring or switching to a
previous application release remains an operator or deployment concern. The
low-level database migration helper does not choose a backup directory; callers
outside managed server startup own that recovery decision.

## Actors / Objects / State

- **Operator**: installs, starts, or upgrades Rudder against an existing local
  or externally managed PostgreSQL database.
- **Candidate release**: the versioned Rudder source, migration journal, SQL
  files, and immutable manifest fingerprint being evaluated.
- **Compatibility fixture**: a database reconstructed from the immutable
  migration assets of a published older release, then populated with
  production-shaped organizations, work, runs, accounts, and permissions.
- **Migration journal**: the database record of applied migration identifiers,
  hashes, and ordering metadata.
- **Recovery point**: a restorable backup captured before a non-empty schema or
  migration-history mutation.
- **Post-migration report**: manifest, journal, core-table, foreign-key, and
  index invariant results.

## Entry Points / Inputs

- Managed server startup and restart against a configured PostgreSQL database.
- CLI or database package migration entry points, whose caller owns any
  pre-migration backup outside the managed startup path.
- A canary or stable release candidate entering the release workflow.
- The candidate version, migration journal, migration SQL files, database
  connection, backup directory, and declared compatibility fixtures.

## Product Logic Flow

1. The release preflight builds a manifest fingerprint from the migration
   journal and every migration SQL file. Published entries and SQL files are
   immutable; corrections are appended as new migrations.
2. The compatibility matrix requires each fixture version to be strictly older
   than the candidate and verifies the fixture prefix and fingerprints. The
   historical runtime upgrades each fixture with shaped data, checks
   relationships and permissions, restarts, and verifies persistence.
3. Before managed startup migration work, Rudder acquires the database
   advisory lock, reads legacy-column drift and migration state, and captures a
   recovery point for a non-empty database whenever normalization,
   reconciliation, or pending migrations may mutate it.
4. Legacy column normalization runs in one transaction. The server then
   reconciles only explicitly known historical journal identities and applies
   pending migrations in journal order. Unknown identifiers fail closed.
5. Rudder checks the final migration state and post-migration invariants even
   when the journal was already current. A failed check prevents normal
   managed server startup. If a recovery point was created before mutation,
   it remains available for operator recovery; otherwise the unchanged
   database remains available and no new recovery point is implied.
6. The canary and stable publication jobs depend on the cross-platform
   migration/recovery/packaged gate. npm publication, Git tags, GitHub Release
   creation, and later Desktop publication occur only after that gate passes.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Current and valid | Journal matches the manifest and invariants pass | Continue startup | Treat the migration count alone as proof | `validatePostMigrationInvariants` |
| Pending managed upgrade | Candidate has newer migrations and a non-empty database | Capture recovery point, apply in order, then verify | Mutate without a restorable pre-change copy | `server/src/index.ts`, DB tests |
| Legacy column drift | Known old column exists without its current name | Rename all required columns in one transaction | Leave a partially normalized schema | `normalizeLegacyColumnNames`, rollback test |
| Unknown journal entry | Hash or identifier is not an explicit known historical identity | Fail closed with `migration_journal_invalid` | Accept arbitrary `legacy-*` prefixes | Client invariant test |
| Recovery failure | Backup cannot be created or configured | Refuse schema mutation and preserve the old schema | Normalize or migrate after backup failure | Recovery runtime evidence |
| Migration or invariant failure | SQL, reconciliation, journal, foreign-key, or index check fails | Refuse normal startup; retain any existing recovery point or leave an unchanged database available | Start on a partially upgraded database | Historical matrix and startup checks |
| Release gate failure | Any fixture, recovery, or packaged platform gate fails | Block public publication | Publish npm, tags, or Release first | Release workflow contract |

## Actor-Visible Input

The operator supplies the target Rudder version and starts the server or
Desktop application. During a safe upgrade there is no separate migration
command or SQL step, although interactive startup may request confirmation
before applying pending migrations. When an upgrade is refused, the operator
receives a startup failure that points to the migration or recovery reason and
any available recovery point rather than an apparently healthy but untrusted
workspace.

## Operator-Visible Output

- A successfully upgraded instance opens with its existing work intact.
- A refused upgrade reports the blocking reason through the startup/release
  diagnostic surface; an existing recovery point remains available when one
  was created, while an unchanged database remains available when no mutation
  was attempted.
- Release operators see a failed prepublish gate instead of a public package or
  tag that has not passed the compatibility matrix.

## Persisted Evidence

- Immutable candidate and fixture migration manifest fingerprints.
- Migration journal identifiers, hashes, ordering, and entry count.
- Pre-migration recovery backup for a non-empty database.
- Runtime/release invariant report covering core tables, organizations, foreign
  keys, indexes, and migration journal validity. This report is evidence for
  the run; it is not a durable application record.
- Historical fixture sentinels, row counts, relationships, permissions, and
  restart readbacks from the compatibility runtime.

## Canonical Scenarios

1. **Upgrade from a supported older release**:
   - Trigger: Start the candidate against a `v0.7.1`, `v0.7.0`, or `v0.6.5`
     shaped database.
   - Expected state/action: The candidate creates a recovery point, applies
     the immutable migration prefix plus new migrations, and verifies the
     result.
   - Visible output: Existing organizations, work, relationships, permissions,
     and restart-persisted data remain available.
   - Evidence: Historical compatibility runtime and post-migration report.
2. **Upgrade with a broken recovery path**:
   - Trigger: The configured recovery backup fails before normalization.
   - Expected state/action: Startup refuses to mutate the schema.
   - Visible output: A migration recovery failure is reported; the old schema
     remains available.
   - Evidence: Backup-failure runtime proof and unchanged schema readback.
3. **Corrupted current journal**:
   - Trigger: An otherwise current database contains an unknown journal hash.
   - Expected state/action: Invariant validation fails closed.
   - Visible output: Rudder refuses normal startup instead of treating the
     database as current.
   - Evidence: `migration_journal_invalid` regression test.
4. **Concurrent startup**:
   - Trigger: Two Rudder processes start against the same pending database.
   - Expected state/action: The advisory lock serializes one complete migration
     chain and the other observes the verified result.
   - Visible output: Both processes either converge on the valid schema or
     surface the same refusal; no mixed journal is exposed.
   - Evidence: Advisory-lock test and verifier runtime packet.

## Invariants / Non-Goals

- Published migration journal entries and SQL files are never edited in place.
- A candidate has one immutable schema identity and every declared fixture is
  strictly older than that candidate.
- The managed server-startup path never mutates a non-empty database without a
  recovery point when migration work can change schema or migration history.
- Only explicit known historical journal identities are accepted.
- Legacy normalization is atomic, migration attempts are advisory-lock
  serialized, and post-migration invariants are always checked.
- Public release mutation is downstream of the compatibility and packaged
  upgrade gate.
- This contract does not promise automatic rollback or application-version
  switching, zero-downtime migrations, support for arbitrary unlisted release
  versions, or proof that every future migration is safe without a new fixture
  and gate run. Direct low-level migration callers are responsible for taking
  their own backup before mutating a non-empty database.

## Drift Boundaries

Update this contract when the supported-version policy, migration journal or
manifest identity rules, managed-startup recovery-point requirement, startup
refusal behavior, invariant set, compatibility fixture matrix, or release
publication ordering changes.

Changing SQL implementation details without changing those safety guarantees
does not require a semantic contract change, but it must retain the listed
tests and release gates.

## Traceability

Related plans:

- None. The current contract records the implemented migration-safety behavior;
  future rollback or zero-downtime design belongs in a dated `doc/plans/` file.

Related code:

- `packages/db/src/client.ts`
- `packages/db/src/migration-manifest.ts`
- `server/src/index.ts`
- `scripts/release-compatibility-matrix.mjs`
- `scripts/release-compatibility-runtime.ts`
- `.github/workflows/release.yml`

Related tests:

- `packages/db/src/client.test.ts`
- `packages/db/src/migration-manifest.test.ts`
- `scripts/release-compatibility-matrix.test.mjs`
- `scripts/release-workflow-contract.test.mjs`
- `server/src/__tests__/migration-startup-contract.test.ts`
- `desktop/scripts/smoke.mjs`

Known gaps:

- The local packaged proof is macOS arm64; Linux and Windows packaged paths
  remain CI responsibilities for the same candidate.
