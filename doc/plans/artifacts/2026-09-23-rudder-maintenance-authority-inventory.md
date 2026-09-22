# Rudder Maintenance Authority Inventory

Status: Phase 0 semantic inventory, source-only evidence

Date: 2026-09-23

## Candidate and scope

- Source commit: `e80deae94a441cc8cfa0411cf37a0a5949614285`
- Source tree: `e453569dd7d89dd800662c13550ece19ad0759ec`
- Worktree: `/Users/zeeland/.codex/worktrees/rudder-branding-outbox-recovery-20260922/rudder-oss`
- Scope: first-party maintenance, update, installation, runtime-selection, scheduling, migration, backup, and recovery entrypoints under `cli/`, `scripts/`, and `desktop/`, plus the matching native crates and binaries.
- Excluded: unrelated product routes and server domains, broad Rust crate enumeration, and any claim that a crate build or staged binary has retired a Node caller.

The source references below are from the exact e80 source. Existing dirty ledger, packet, refresh, and verifier artifacts are not evidence for this inventory and were not changed.

## Authority test and classifications

An operation is counted as state-owning when its production caller chooses the policy, writes durable state or database state, owns an external-process lifecycle, or performs recovery after an interrupted operation. A helper is not an owner merely because it performs one bounded filesystem or database operation.

- **N: Node/Electron authority.** The TypeScript/Node caller still owns policy, durable state, lifecycle, fallback, or the database write.
- **M: Mixed helper boundary.** Rust performs a bounded accepted operation, while Node still owns orchestration, durable product state, and fallback policy.
- **B: Bootstrap/staging only.** The operation creates a short-lived build or package staging result; it does not own installed product state.
- **U: Unresolved caller.** A native core or binary exists, but no first-party production caller in this scope was established. This is not evidence of retirement.

## Inventory

### 1. CLI start, runtime cache, and installed surfaces

**Entrypoint -> caller.** `cli/src/index.ts:6-11` runs `runCli`; `cli/src/program.ts:30,355-379` registers `startCommand` and maps ordinary failures to exit `1`. The command is `cli/src/commands/start.ts:1568-1717`.

**State mutations.** `startCommand` selects the requested runtime and Desktop mode, then calls `ensureRuntimeInstalled` (`start.ts:1653-1717`). The runtime installer acquires lifecycle and per-cache locks and writes the versioned runtime cache and metadata (`cli/src/runtime/install.ts:373-425,428-455,520-619`). The same command installs the persistent global CLI with `npm install --global` (`start.ts:1719-1746`), and can download, verify, replace, install, and create launchers for the Desktop app (`start.ts:1828-1855,2009-2105`). These are durable installed-runtime and installed-application mutations, not harmless bootstrap.

**Rust equivalent and current default.** `cli/src/runtime/native-payload.ts:152-190,245-313` delegates only PostgreSQL archive verification, extraction, version probing, and publication. The matching Rust boundary is `native/bins/rudder-native/src/main.rs:25-36,471-573` over `native/crates/runtime-payload-core/src/lib.rs:1-7`. `packages/shared/src/native-mode.ts:56-89` defaults `RUDDER_NATIVE_MODE` to `auto`; auto allows only fallback-safe failures, `required` fails closed, and `node` disables the capability. The native helper does not install the npm runtime cache, persistent CLI, Desktop application, or launchers.

**Failure/exit behavior.** `runCli` returns `0` on success and `1` for a non-Commander exception (`cli/src/program.ts:355-379`), then `cli/src/index.ts:6-11` calls `process.exit`. A runtime installation error is therefore a failed CLI command unless the Desktop best-effort path converts it into a full Desktop-asset fallback (`start.ts:1700-1715`). Classification: **M**, with the overall authority still **N**.

### 2. Explicit database backup and retention

**Entrypoint -> caller.** `scripts/backup-db.sh:1-17` is a `set -euo pipefail` wrapper that executes `pnpm rudder db:backup`; `cli/src/commands/db-backup.ts:49-101` resolves the connection, backup directory, retention, and calls `runDatabaseBackup`.

**State mutations.** `packages/db/src/backup-lib.ts:102-118,261-315,641-661` creates a SQL backup through a temporary file and atomic rename, optionally includes the migration journal, then deletes old matching backups. This is durable database recovery state and retention policy, not a Rust archive helper call.

**Rust equivalent and current default.** No matching Rust database-backup writer, restore path, or retention owner was found in the scoped callers. `rudder-native` workspace/archive capabilities are not a substitute for this PostgreSQL database dump. Current authority is Node.

**Failure/exit behavior.** The CLI wrapper maps thrown backup errors to exit `1` through `runCli`; the shell wrapper propagates the child status. Classification: **N**.

### 3. Server startup migration writer and Rust preflight

**Entrypoint -> caller.** Server startup imports the preflight adapter (`server/src/index.ts:89-97`) but still calls `ensureMigrations` for external PostgreSQL (`server/src/index.ts:681-695`) and embedded PostgreSQL (`server/src/index.ts:867-884`). The Node migration path creates a recovery point, acquires the migration path, applies pending SQL, and checks post-migration invariants (`server/src/index.ts:449-515`). The actual writer remains `packages/db/src/client.ts:1300-1315`, including the advisory-lock wrapper.

**Rust equivalent and current default.** `server/src/services/migration-preflight.ts:160-223` can invoke the native `migration-preflight` binary before Node inspection. `native/crates/migration-service/src/lib.rs:1-6,68-110` explicitly defines this operation as read-only: it does not acquire the writer lock, execute migration SQL, repair the journal, or change startup authority. `native/crates/migration-service/src/bin/migration-preflight.rs:90-107` exits `0` for a successful report and `2` for a protocol/database error. In auto mode, an unavailable preflight logs a warning and continues with Node migration authority (`migration-preflight.ts:204-221`); required mode refuses to inspect or mutate after preflight failure. Current migration authority is therefore **N**, with a **M** read-only preflight.

**Failure/exit behavior.** A direct server startup failure exits `1` (`server/src/index.ts:1578-1585`); normal signal shutdown exits `0` (`server/src/index.ts:1531-1541`). A preflight binary error is `2`, but in default auto mode the adapter can continue to the Node writer. This is a deliberate fallback boundary, not migration retirement.

### 4. One-shot database maintenance scripts

**Product analytics migrations.** `scripts/product-analytics-migrate.mjs:54-89` creates the analytics schema and migration table, executes each SQL file in a transaction, records the tag, and grants role privileges. Its direct entrypoint reports success implicitly and sets `process.exitCode=1` on failure (`:91-97`). No Rust equivalent or production Rust caller was established. Classification: **N**.

**Inline environment-secret migration.** `scripts/migrate-inline-env-secrets.ts:30-39,41-110` reads agent rows and, with `--apply`, creates or rotates secrets and updates `agentRuntimeConfig`; dry-run and apply complete with exit `0`, while missing `DATABASE_URL` exits `1` (`:113-123`). No Rust equivalent or caller was established. Classification: **N**.

These scripts are state writers even though they are short-lived processes. They must not be grouped with packaging/bootstrap merely because they exit after one run.

### 5. Persistent scheduler and business maintenance

**Server backup scheduler.** `server/src/index.ts:1252-1291` installs a durable process interval, prevents overlapping backups, and invokes the Node backup service with connection, directory, retention, and size policy. A tick logs errors and keeps the server alive; there is no per-tick Rust exit status. No Rust scheduler or database-backup authority was found. Classification: **N**.

**Desktop product analytics scheduler.** `desktop/src/product-analytics-main-scheduler.ts:37-123,155-193` reads local telemetry state, persists consent state, registers organization installation/consent remotely, and starts the uploader. `desktop/src/product-analytics-scheduler.ts:10-53` owns the repeating timer and in-flight suppression. Setup failures warn and return; upload failures are contained in the scheduler rather than represented as a separate process exit. No matching Rust business scheduler was found. Classification: **N**.

### 6. Installed runtime selection and PostgreSQL recovery

**Entrypoint -> caller.** Packaged Desktop startup calls `startManagedLocalServer` after stopping any prior local server and acquiring the packaged PostgreSQL lifecycle lock (`desktop/src/main.ts:2243-2267`). Runtime selection reads and validates the shared versioned cache (`desktop/src/runtime-cache.ts:63-104`). PostgreSQL selection/reconciliation updates managed environment variables (`desktop/src/postgres-runtime.ts:174-242`), lifecycle locking reclaims stale owners (`:409-450`), and finalization removes incomplete or unprotected runtime payloads only after a live descriptor check (`:484-560,719-737`).

**Rust equivalent and current default.** The inspected Rust `runtime-core` and `runtime-attempt-core` crates are pure state machines with no process, network, database, clock, or filesystem side effects (`native/crates/runtime-core/src/lib.rs:1-5`; `native/crates/runtime-attempt-core/src/lib.rs:1-5`). No first-party CLI/Desktop caller carrying their transitions into this runtime selection or cleanup path was established. Current authority is Electron/Node. Classification: **N**, with the pure crates **U** for this surface.

**Failure/exit behavior.** The runtime APIs throw on invalid/incomplete state and lock timeout; they do not expose a stable numeric command status at this library boundary. Desktop startup owns the resulting boot/recovery behavior. This is an unresolved handoff contract, not evidence that a Rust runtime selector exists.

### 7. Desktop automatic-update product state and policy

**Entrypoint -> caller.** `desktop/src/desktop-auto-update-state.ts:128-215,222-283` reads/writes the durable JSON state, generation, policy sequence, and lock. Candidate staging, claiming, status transitions, and recovery flags are Node state transitions (`:381-490`). `desktop/src/desktop-update-flow.ts:146-180` gates automatic updates to packaged macOS `prod_local/default` with an attested helper and signed policy; `:382-489` builds the identity/checkpoint/admission request, claims the candidate, writes the request, and restores the claim on handoff failure.

**Rust equivalent and current default.** Node/Electron owns update policy, candidate discovery, durable state, admission/drain, and fallback. The Rust `update-helper-core` is a real destructive-boundary equivalent: it acquires an ownership fence and dispatches apply/recover/status (`native/crates/update-helper-core/src/lib.rs:188-197`), persists journal/checkpoint/exchange stages and rollback state (`:345-498`), and validates/replays recovery (`:816-930`). It does not own the Desktop policy/state file or candidate decision. Current product authority is **N** with a bounded Rust helper (**M**).

**Failure/exit behavior.** The detached helper is launched by Node (`desktop/src/desktop-update-helper.ts:346-389`). Its binary reports success with `0`, rollback with `3`, recovery required with `4`, and invalid/operational errors with `2` (`native/bins/rudder-update-helper/src/main.rs:37-77`). Node parses the result during recovery (`desktop/src/desktop-update-helper.ts:391-434`) and keeps the candidate/state policy in TypeScript. Automatic update is deferred when the helper or signed policy capability is unavailable (`desktop-update-flow.ts:166-180,402-405`).

### 8. Packaging and installation bootstrap boundary

`desktop/scripts/stage-native.mjs:37-81` builds and copies `rudder-process-host`, `rudder-native`, `rudder-update-helper`, `migration-preflight`, and `rudder-server-foundation` into package staging. `desktop/scripts/stage-server.mjs:314-352,391-434` prepares a PostgreSQL payload, performs a production server deploy, rewrites manifests, and verifies the staged server entrypoint. These scripts can remove and recreate staging directories, but only as ephemeral packaging output; they do not select the installed runtime, own database migrations, or recover a product update. Their script-level failure is exit `1` and success is exit `0`. Classification: **B**.

The presence of `native/bins/rudder-server-foundation` in the staging list is not evidence that it owns the CLI/Desktop maintenance paths. Its product HTTP/persistence surface is outside this bounded inventory; no authority claim is made here about unrelated server routes.

## Unresolved authority rows

1. **Migration apply/recovery writer.** Rust preflight has a clean caller and protocol, but no Rust-owned SQL apply, recovery-point, journal-repair, post-invariant, or crash-recovery runner is present. Node remains the writer and can fall back in auto mode.
2. **Database backup/restore and retention.** The CLI, server scheduler, and migration recovery point all rely on Node `runDatabaseBackup`; there is no scoped Rust database-backup equivalent or Rust scheduler.
3. **CLI installed-runtime authority.** Rust payload handling does not cover npm runtime cache metadata, persistent CLI installation, Desktop asset replacement, launcher creation, or the full-asset fallback policy.
4. **Desktop runtime lifecycle.** Runtime-cache selection, PostgreSQL payload selection, lifecycle locks, descriptor checks, cleanup, and managed environment mutation have no established Rust caller.
5. **Desktop update state/policy.** The Rust helper can exchange and recover generations, but candidate policy, admission, durable state transitions, and helper replacement safety remain Node/Electron-owned.
6. **One-shot analytics and secret migrations.** Both scripts mutate database/business state and have no matching Rust production entrypoint.
7. **Pure runtime crates.** `runtime-core` and `runtime-attempt-core` provide deterministic transitions, but no first-party maintenance/update/recovery adapter was established in this scope. Their existence cannot be used to mark a Node owner retired.

## First-principles boundary

The current system has Rust capabilities at selected edges, not a Rust maintenance authority. The owner is the component that decides whether an operation is admitted, writes the durable record or database state, selects the active installed generation, and recovers after interruption. On e80 those responsibilities remain in Node/Electron for every unresolved row above. A native call, a staged native binary, an `effectiveEngine: rust` payload result, or a pure Rust state machine is evidence only for the bounded operation it actually controls.

## Next migratable unit and safe local acceptance

The next concrete unit should be a **Rust migration apply-and-recover runner** extending the existing `migration-service` preflight boundary. Keep the first unit limited to the canonical Drizzle migration manifest/journal and SQL apply path. Product analytics migrations, inline secret conversion, backup scheduling, and Desktop runtime/update state remain separate units.

The unit is not implemented by this artifact. Before retiring the Node writer, the Rust runner must own the writer lock, manifest/history agreement, a restorable pre-migration recovery point, ordered SQL application, journal update, post-migration invariants, and crash recovery. Passing a Node backup path into a Rust apply command without an explicit Rust-owned recovery contract would remain mixed authority.

Safe disposable-local acceptance:

1. Reuse the fixture and disposable PostgreSQL pattern already present in `scripts/verify-migration-preflight.ts:126-196,528-590`: temporary migration directory, temporary PostgreSQL data directory, random loopback port, non-persistent instance, and cleanup in `finally`.
2. Seed a pending canonical migration and invoke the proposed runner with native mode required. Assert the exact manifest fingerprint, advisory writer-lock ownership, recovery-point creation, applied journal entry, and post-migration invariants by database readback.
3. Run a concurrent second invocation and assert it cannot mutate while the first writer owns the lock. Exercise manifest mismatch, missing recovery point, invalid journal, and stale-owner cases; each must fail closed with a structured non-zero result and no partial journal advancement.
4. Inject termination at the recovery boundary and after SQL/journal transitions. Restart the runner against the same disposable database and assert deterministic recovery, no duplicate application, correct journal identity, and a final up-to-date state.
5. Prove the required-mode path does not call Node `applyPendingMigrations`; retain the current Node fallback only as an explicitly separate compatibility mode until the Rust acceptance is independently verified. Remove the temporary database, data directory, lock, and logs after every case.

## Evidence limits

- This is a source inventory, not a migration implementation, semantic audit of unrelated server routes, release qualification, or production verification.
- No existing Rust crate, staged binary, or local test result is treated as proof of authority retirement.
- No product tests or full-repository tests were run for this documentation-only artifact.

## Integrated Main note

This artifact intentionally retains the e80 scope and identity above. The integrated candidate is now `ceb08be24dcbf71ae110e55b9907deca54d91a0f` on top of `origin/main=38acc6fbe5c21c38c05a74cea19fbfe5123ea4cf`. The Main delta from `5ef9b5475787dd662b2c8ec04b64158387d9dcb7` is the single `feat(db): add native session lineage and common Run foundation (#223)` commit, affecting `desktop/`, `native/`, `packages/`, and `scripts/`. It is relevant outside the server authority inventory because it changes migration/runtime baseline inputs, but it does not establish Rust ownership for the maintenance rows above. Current integrated counts and receipt status are recorded separately in `2026-09-21-rudder-full-rust-backend-completion-current-source-refresh.yml`; no new maintenance semantic scan or runtime receipt is claimed here.
