---
title: Rust ownership of Project deletion
date: 2026-09-29
kind: implementation
status: in_progress
area: data_model
entities:
  - project_goal_mutation_state
  - organization_mutation_receipt
  - backend_authority
  - activity_log
issue:
related_plans:
  - 2026-09-21-rudder-full-rust-backend-completion-plan.md
  - 2026-09-16-rust-d1-persistence.md
supersedes: []
related_code:
  - server/src/routes/projects.ts
  - server/src/services/projects.ts
  - server/src/services/rust-foundation-bridge.ts
  - native/crates/d1-persistence/src/lib.rs
  - native/crates/server-foundation/src/lib.rs
  - packages/db/src/schema/organization_mutations.ts
commit_refs:
  - 939ea94e1bc7c59d1aabee3eb0bb4229be1f3da5
updated_at: 2026-09-29
---

# Outcome and boundary

Public Project deletion currently locks the component fence but still executes
the delete and link cascades through Node for a Rust-owned Project. Move that
specific public workflow to Rust and reject stale direct Node deletion under
Rust ownership. This is a prerequisite to default writer cutover, not a default
mode flip or a claim that all Project-Goal writers have retired.

Keep ordinary Node-owned deletion working. Preserve the current actor and
organization permissions, including supported non-CEO agents, deletion response,
foreign-key effects, and 404 behavior for unkeyed repeated deletion. Do not
disable deletion, require a new client header, or silently fall back to Node.
Organization-wide deletion and create-with-goals remain separate live writers;
they must be migrated before claiming whole-component retirement.

# Transaction and public integration

The private signed DELETE entry is `/api/orgs/{org_id}/projects/{project_id}`.
It accepts the existing actor envelope and idempotency header, plus a bounded
`{runId}` body, and returns the legacy deleted-Project response. The public
`DELETE /api/projects/:id` remains unchanged. Generate a key internally when
the caller supplied none, preserving existing clients. Reuse the existing
Project-Goal required-mode configuration; do not add a separate deletion opt-in.
An explicit required-Rust request must not delete a Node-owned row through Node.

Rust validates the live actor and organization, locks the organization and
Project component in the established order, verifies ownership/fence, and
commits the deletion, `project.deleted` audit, immutable receipt, and outbox in
one SQLx transaction. Audit failure must roll back the whole operation. Use a
new explicit `project_delete` receipt command kind and a generated additive
migration. Store `result.kind=project_deleted`, `result.project_id`, and the
legacy response in `result.response`.

The Project fence cascades away on deletion, so retry must validate the durable
receipt without depending on that missing row. Explicit-key public retries
resolve only receipt organization scope before checking a live Project, enforce
current authorization, and ask Rust to validate and replay the stored response.
They must not delete a subsequently recreated UUID or produce a second audit.
Receipt existence never grants authority or permits cross-organization result
disclosure. Unkeyed retry may retain legacy 404 behavior.

On restart, a deleted UUID may remain in the configured Project allowlist when
a valid durable `project_delete` receipt proves that terminal target. A missing
UUID without such proof still fails closed. Operators must not need to edit
configuration after every successful deletion.

# Convergence and acceptance

Reuse the clean D1 checkout on `codex/d1-default-writer-20260929`, based on the
frozen member-default source; preserve the prior branch. Core owns Rust plus
the DB schema/migration; integration owns Node route/bridge/fence changes.
Parent owns packet, reconciliation, and PR delivery. Do not alter PR #233's
frozen implementation. Reconcile with its accepted Main result before publishing
this successor as a separate candidate.

Require focused protocol/route/fence checks and a real disposable workflow:
linked/resource-bearing Project deletion, permitted actor parity, foreign-org
denial, stale Node writer rejection, audit rollback, explicit-key replay after
restart, one audit/outbox effect, and Rust outage with no Node fallback. Exercise
existing CLI/MCP delete consumers where present; do not invent new capabilities.
Serialize local embedded PostgreSQL workflows with the member-default verifier.
Then freeze source/build/data, obtain independent stage and terminal acceptance,
final review, exact-head CI, and protected-PR integration. All whole-migration
completion/release/production claims remain false.

## Active implementation coordination

- Core and schema: Planck `01a0e9e0-6443-76a0-892c-75958a2a591f`.
- Actix adapter and binary route registration: Boole
  `01a0ea02-71d7-7df3-829b-1ff7ddf9280c`; split from Core to keep store/migration
  and HTTP integration moving concurrently with disjoint file ownership.
- Public route, bridge and old-writer fence: Carson
  `01a0e9e0-656e-72b1-b5aa-8aad22300c49`.
- Real-entry regression workflow: Sagan
  `01a0e984-d6bc-7b31-be56-433668d1a1f6`.
- Independent proposal review: Newton accepted the bounded direction, requiring
  current-caller replay authorization, atomic ownership/deletion, cascade parity,
  and no delayed outbox mutation of a recreated UUID. This is not implementation
  acceptance.

The member-default verifier and author packaged checks finished and released
their owned resources. Planck now owns this migration's database and native-build
slots for serial persistence and Actix tests; parent runs the real public harness
after that release. The shared Cargo cache is available to Planck. Coordinate
native builds to avoid competing cache mutations. Do not wait for unrelated
worktrees' PostgreSQL processes; isolate fixtures and preserve those processes.
No independent D1 deletion runtime acceptance or retirement receipt exists yet.

## Author checkpoint (2026-09-29)

PR #233 is merged at `e14771c4a0ed642bafd478c18dd1278855be89c5`; PR #234
merged its delivery records at `4422039540f8926f5021466061f1bbd1b890dd01`.
This successor remains dirty on base `939ea94e1`
until the Node startup-race fix is checked and all workers stop editing. Preserve
that base and checkpoint before rebasing onto current Main.

Planck completed the SQLx transaction and migration0175, and Boole completed the
Actix adapter and route registration. Combined Rust no-run build passed; store
unit tests3, serial real-PostgreSQL deletion tests3, Actix deletion black-box1,
and strict nullable-runId parser1 passed. Foundation and migration-preflight
binaries built. DB typecheck, manifest integrity and parent DB package build
passed. These are author checks, not independent acceptance. The Node migration
Vitest case remains unrun because its global setup performs broad host cleanup;
the Rust PostgreSQL checks applied the full journal through0175.

Both normal and custom Drizzle generation hit a pre-existing historical
snapshot collision. Generation therefore used an isolated temporary baseline
with the current journal and a synthetic pre-change snapshot; only additive
0175 SQL, journal entry and snapshot were brought back. The new snapshot links
to the last tracked0147 snapshot; no previous SQL or snapshot was rewritten.

Hilbert's advisory confirmed one startup race: a terminal receipt was checked
before locking its organization, so same-org recreation could be missed. Carson
added sorted receipt-organization locks and an absence recheck under lock;
63 focused no-global-setup tests and server typecheck passed. Fix review remains
separate from these author checks.
The separate proposed objection to returning the original response for a reused
key after UUID recreation was withdrawn: this historical no-write replay is
intentional, reauthorized, and must never delete the recreated Project.

Parent public real-entry smoke passed with marker `RUST_PROJECT_DELETE_REAL_ENTRY_PASS`
and exit0 at `/tmp/rudder-project-delete-entry.eyw9XU` (SHA256
`8a18b8605531e22afa2cd68ca9a897e597fe3edf4cee620a7515968174da5597`).
It exercised legacy response parity, scoped agent denial, Issue-reference500
rollback parity, old Node writer rejection before any DELETE, same-key/conflicting
key behavior, audit rollback, same-data restart with deleted UUIDs still allowlisted,
unknown-ID rejection, recreated UUID protection, outbox behavior, and Rust outage
without fallback. The foundation hash was
`168896b549ca451c72ee24148ae3d0579fbe98f3c52e54e196e54ef9372c1783`;
migration-preflight hash was
`3875f8511366559c6019abb57388bf26359a7f1aa2e9542ce4a4391b191a4408`.

The initial smoke failed before Rust handoff because its terminated-agent fixture
omitted `x-rudder-agent-id` in local-trusted mode, where implicit board access is
intentional. The fixture now binds known tokens to the supported Agent context
header; no product auth behavior changed. The first assertion also printed a
failure while returning exit0, so the harness now exits1 after awaited cleanup.
A real missing-binary subprocess test proves nonzero failure before DB startup;
all four no-DB harness tests pass. Preserve the first log
`/tmp/rudder-project-delete-entry.fT6BQ7` (SHA256
`41cb30ab89ed266cf9b0d27d8ea56faca997e77788e05fb8d5dda67549866788`)
as failed evidence, never a passing run.

### Stage-review repair in progress

Newton rejected the initial candidate because the generic 256 KiB Actix response
cap could reject an already committed deletion, while the receipt store imposed
a 1 MiB cap on otherwise supported Project rows. The deletion-specific store,
replay and successful HTTP response paths now preserve the complete legacy row.
Other mutation/read limits remain unchanged. Serialization and receipt insertion
remain inside the transaction before commit. Planck reports four real PostgreSQL
deletion tests (including a 1.625 MiB description and receipt-storage failure
rollback), four existing replay tests and three unit tests passing. Boole is
running HTTP coverage for 320 KiB and 1152 KiB descriptions and rebuilding the
binary; these results are not yet independent acceptance.

The earlier public smoke proves small-row behavior only and counted outbox rows;
it did not prove post-restart delivery. Its affected observations are superseded
by the pending updated harness. That harness creates a Project with a 1152 KiB
description through the public API, checks complete DELETE/replay parity, and
holds another deletion event in `pending` across restart using a disposable DB
eligibility trigger. After recreating the deleted UUID, it releases eligibility,
requires actual public WebSocket delivery plus persisted `published` state, and
checks the recreated Project and command/audit counts remain unchanged.

Renewed stage review: Newton `accept` on the repaired implementation and revised
acceptance criteria; no final handoff claim. Boole's actual HTTP large-response
test and strict parser test each passed. Rebuilt foundation SHA256:
`ae9d6054b6fc1da1bbcaab3c6fe6beef7d678550a41b01f1fd675f69886b1d44`;
migration-preflight SHA256:
`d996435c7609713a07b7b1dda42b138b9b85e50248034271d242776916057a59`.

Updated public author smoke passed with exit0 and
`RUST_PROJECT_DELETE_REAL_ENTRY_PASS` at
`/tmp/rudder-project-delete-recovery.GM92Ny`. Organization:
`bfd8b548-593d-44ad-9dbe-c4ee102b9a2e`; Project:
`245e43cc-b8d0-49ae-bcfb-798c0b97ba19`. Complete large response was
1,180,164 bytes. Outbox `047c1c1c-5a66-4e66-9f24-643f06234300` survived
restart pending, then delivered `activity.logged/project.deleted` over the
public WebSocket and reached `published` with attempts1. Recreated UUID and
durable command counts remained unchanged. The isolated runtime stopped and
its disposable data was cleaned; the local DB slot is released. These are
author observations, not independent verifier evidence.

Next executable step: checkpoint and rebase onto
merged Main, then freeze and publish a coherent draft
for CI once author integration passes, then complete independent acceptance and
final review before protected-main merge.

## Following boundaries

Prefer atomic Project creation with goals as the next bounded writer slice,
including existing resources and CLI/MCP consumers. It needs an explicit cohort
selection design because the server generates Project UUIDs. Do not split Node
Project insertion from Rust goal-link writes. Organization deletion remains a
separate broad operation with branding, organization, then sorted-Project lock
order, post-commit storage cleanup, and org-scoped receipt lifetime concerns.
In particular, deleting an organization removes Project-delete receipts as well:
the existing missing-allowlist startup boundary must be documented rather than
relaxed into acceptance of arbitrary unknown IDs.

## Test-isolation incident and required constraint

Carson's earlier default-config command, run from `server/`, was
`pnpm exec vitest run src/services/rust-foundation-bridge.test.ts src/services/project-goal-mutation-fence.test.ts src/__tests__/project-routes.test.ts`.
Its retained output starts at local `05:38:24` on 2026-09-29 and reports
`Stopped 1 orphaned test PostgreSQL process(es).` and removal of four stale
SysV shared-memory segments. The setup did not log the affected PID or data
directory. Therefore ownership, actual orphan status, and absence of collateral
interruption are unproven; no guessed restart or cleanup is authorized by this
record. No data-directory removal is shown by the inspected cleanup path.

Source inspection of `scripts/vitest-postgres-global-setup.ts` shows a temporary
directory `rudder-` prefix selector, rather than proof of this task's ownership.
All subsequent focused Node tests must use `vitest.nodb.config.ts` with global
setup disabled. Carson's later 60-test run used that configuration and passed.
Real workflows retain isolated profiles/ports and explicit owned-resource
cleanup. Repairing host-wide test cleanup belongs in a separate bounded tooling
increment; it must not silently change the frozen member-default candidate.
