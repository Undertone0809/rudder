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
updated_at: 2026-10-23
---

# Native migration operator acceptance

This packet covers the explicit `migration-apply` executable, the public
`pnpm db:migrate` command, and the candidate's Rust migration writer. The current
candidate also connects the server startup adapter to the Rust operator and
managed embedded PostgreSQL owner. Node still coordinates startup; default
server, packaged cutover, general restore, and remaining lifecycle authority
need separate evidence before they can be reported as retired.

The R28 runtime checkpoint is `b93dbe3efb8affa5f56494358fdf4fa20fc69251`
(tree `1471124015edcaff4e0eed86df4c863001645836`), integrated with main
`e6eb1d033aa3a7ffa6a4c889c47a7e5d1353d4f6`. Independent acceptance passed
all 27 migration cases and the separate S01 entry-point check, five checkout
cases with 31 assertions, and eight startup groups across nine server
invocations. All five native executables were rebuilt from this checkpoint
and physically frozen together with the built server package. Earlier
candidate observations are historical and do not substitute for these runs.

The seven name-only cases require an explicit reconciliation: the fresh raw
run retains N01 FAIL and N02–N07 PASS. N01's only failing predicate compared
column arrays without sorting after the supported alias rename. Independent
offline acceptance of the exact captured snapshots passed the corrected
comparator, all other N01 guards, and adversarial schema/data mutations. It
also verified that only the two intended journal rows were replaced and the
other 184 rows stayed identical. The original raw FAIL remains unchanged;
the supplemental PASS is recorded separately, not rewritten into the raw run.

The full default `pnpm desktop:verify` passed on that same checkpoint in
791.889 seconds, including development-shell checks, installer construction,
packaged account/upgrade recovery, and packaged App Builder. Owned fixture
process and PostgreSQL PID-file checks were clean afterward. This proves the
local macOS arm64 packaged path; cross-platform CI, final review and protected
PR delivery remain separate gates. It does not establish complete Node
retirement or production deployment.

The candidate-bound receipts are under
`/private/tmp/rudder-rust-migration-authority-20261022/`: MAIN in
`independent-r28-execution/main-r28b/`, name-only raw/cleanup receipts in
`independent-r28-execution/nameonly-r28/`, the N01 supplement in
`n01-comparator-r28b/pav-r28d/`, checkout in
`integrated-checkout-preparation-r28/execution-r28/`, startup in
`server-startup-observer-r28/execution-r28/`, and the full desktop result and
cleanup in `baseline-r9/integrated-desktop-verify-r28/`.

## Snapshot comparison regression

Use the canonical offline entry point for N01 catalog/data comparison:

```sh
python3 scripts/acceptance/compare_snapshots.py --before N01-before.stdout --after N01-after.stdout
python3 -m unittest discover -s scripts/acceptance -p 'test_compare_snapshots.py' -v
```

The helper accepts only the supported `issues` JSONB-column alias, sorts the
complete column lists after normalization, and compares every other captured
field exactly. It rejects missing captures and duplicate column identities.
The observer must separately verify journal identities, ordering, timestamps
and repair rows because the helper excludes the journal from its comparison.
Never use a comparator PASS as a complete migration verdict. Future acceptance
observers must invoke this tracked helper rather than keep a private copy of
the old ordering-sensitive predicate. The Rust real-entry CI workflow runs
its regression cases, including schema, constraint, index and data mutations.

## Candidate and prior rejection

The original candidate used base `ae74493a38f9688980d9ff46d49fff1a32896eab`, branch
`codex/rust-backend-completion-20261016`. The first stage review rejected backup
self-attestation: the wrapper's journal marker could pass an empty successful
dump. The repaired candidate removes that marker and requires actual plain
PostgreSQL dump structure, including journal definition/data and completion.
The raw operator database URL is also removed from the dump child's environment.
Re-review must accept this repaired candidate before independent acceptance.

The current integration branch is `codex/rust-migration-integrated-20261022`.
Record its exact final source and artifact identities in the delivery receipt;
the original base and earlier failures above remain historical evidence.

The verifier must record dependency-closure/source hash, manifest fingerprint,
immutable copied binary hash, PostgreSQL/client versions, process/listener and
disposable database identities. Recapture identities before the terminal verdict.

## Public operator criteria

Use the actual public CLI and stdin/stdout protocol, not only library calls:

- Repeat the eight public `pnpm db:migrate` criteria on the final operator:
  missing native executable fails without Node SQL fallback; an empty database
  bootstraps without a dump executable; complete history is unique and stable;
  repeated current invocations are no-ops; and the managed Rust PostgreSQL owner
  can restart, preserve data, and stop without leaving its listener running.
- Upgrade the recognized historical 0102 fixture through the missing 0102/0103
  entries. Preserve its existing data and historical hash. Reject an unknown
  history identity without changing schema, journal, or data.
- Reconcile missing 0021/0031 history only after exact source-bound catalog
  verification. Exercise the supported 0021 legacy-column alias and prove the
  alias and journal change are atomic. A wrong column type, incomplete 0031
  table/constraint/index, or conflicting identity must fail closed. After one
  or multiple repair waves append old entries to the journal, a later ordinary
  manifest migration must remain upgradeable. Limit ordering exceptions to
  exact approved recovery identities; preserve rejection of ordinary
  history reversals, unknown entries, duplicates, and hash/name conflicts.
  Exercise both hash-backed and name-only history tables. When a hash column
  exists, a missing or wrong hash must never fall back to a matching name;
  only a history table without that column may identify rows by exact filename.
- For a missing 0103 row, distinguish absent DDL from already-present or
  partial DDL. Verify successful application when absent, and either a supported
  catalog repair or a transactionally unchanged refusal for the other states.

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
operator workflow observation. Return PASS, FAIL or QUESTION. Reuse unchanged
scoped evidence explicitly; do not convert a historical receipt into a fresh
runtime run. Full repository checks, default startup, and `pnpm desktop:verify`
remain separate gates. No UI, deployment, full lifecycle retirement, or complete
no-Node backend acceptance is implied by this operator packet.
