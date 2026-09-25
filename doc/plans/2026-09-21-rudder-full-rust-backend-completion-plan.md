---
title: Rudder full Rust backend and Agent tooling completion
date: 2026-09-21
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - rust_product_runtime
  - backend_authority
  - agent_tooling
  - migration_cutover
issue:
related_plans:
  - 2026-08-12-rust-native-foundations-pilot.md
  - 2026-08-20-rust-migration-baseline-freeze.md
  - 2026-08-20-rust-route-transaction-writer-inventory.yml
  - 2026-08-20-rust-cli-mcp-contract-inventory.yml
  - 2026-08-20-rust-electron-release-inventory.yml
  - 2026-08-28-rust-migration-g0-current-source-delta.yml
  - 2026-09-16-rust-d1-persistence.md
  - 2026-09-19-rust-migration-inspection.md
supersedes: []
related_code:
  - native/Cargo.toml
  - native/bins/rudder-server-foundation/src/main.rs
  - native/crates/d1-persistence/src/lib.rs
  - native/crates/organization-mutation-core/src/lib.rs
  - native/crates/project-goal-link-core/src/lib.rs
  - server/src/index.ts
  - server/src/routes
  - packages/db/src
  - cli/src
  - packages/agent-runtime-utils/src
  - desktop
commit_refs:
  - fc73374bb15933ef5bad7f3056336c87e455cee0
  - 17c9613e3df39e2c67c07d455206312b7ac33a75
  - b4793a868847a1f12bf1b9fb70bfc88ed00a5c9d
updated_at: 2026-09-23
---

# Purpose and terminal outcome

## Active checkout (2026-09-23)

This plan is now persisted in the migration checkout
`/Users/zeeland/.codex/worktrees/7b2a/rudder-oss` on branch
`codex/rudder-full-rust-backend-completion-20260923`. Its active candidate is
the `c54001819ca38079b627994557db0a18ed278fc0` source plus the explicitly
tracked dirty slice recorded in the companion ledger and status files. The
latest observed `origin/main` is `cf131c6de87ac7d29ad4acbda3da6729dc2c52a4`;
the current candidate has not been rebased or declared integrated. The imported
Main-e739 and Main38 sections below are historical evidence until their source,
runtime, and data identities are re-bound to this checkout.

The first active slice remains narrow: connect the existing Rust foundation and
organization branding/Project-Goal contracts through real API, CLI, and MCP
entries while preserving Node authority for un-migrated domains; keep the
Desktop update/recovery receipt contract fail-closed; and record Main drift
before freezing any acceptance candidate. The three terminal claims remain
false until the full Phase 0-7 gates pass.

The current exact acceptance candidate is packet v22 in the isolated worktree
`/private/tmp/rudder-rust-mainline-probe-20260923`: source
`cf131c6de87ac7d29ad4acbda3da6729dc2c52a4`, tree
`15c813eb7aff94e87f406e552b8d406e4512a5cd`, and NUL-safe source fingerprint
`ffe4c7093515753d914553547b3a343a70e714ed894c62e2b4d63e199ae2f161`. This
candidate includes the v25 branding and Project-Goal real-entry reruns plus
public audit-failure rollback and interrupted outbox-claim restart/retry
evidence. It is still awaiting exact-candidate stage review, independent
verifier PASS, and final review; it is not merged, released, or production
verified.

## Current Main and relocated-package checkpoint (2026-09-23)

The current source is `007b8d0ecc02e95586b8e17d75dcf19c98dd99b3`, rebased
onto Main `e73976f0fa0662b1605838e92232b2b27cdc0faa` in the independent
`rudder-main-e739-reconcile-20260923` worktree. This retains Main's Chinese
release notes and update-flow acceptance additions. Backend, native, database,
and CLI source remain equivalent to the preceding accepted workflow candidate.

Relocated packaged acceptance exposed a missing `identity-core` dependency
masked by ancestor-checkout resolution. The repair stages its compiled payload
and rejects package resolution outside the installed app. Independent stage
review and the diagnostic account gate passed. A further updater `dual_failure`
remains under investigation; direct retained target and rollback probes passed,
which alone does not prove automatic recovery. The current full build,
typecheck, lint, package validation, and 64 affected tests passed. The follow-up
working-tree patch has 14 native helper tests and 68 focused Desktop update
tests passing, with a persisted probation process/group fence. Fresh packaged
acceptance is still required; v19 package receipts are explicitly invalidated
and the follow-up patch is not frozen.
See `artifacts/2026-09-23-rudder-relocated-desktop-identity-repair.md`.

Organization settings/Chat intent and standalone analytics implementation
continue in separate lanes. No wide organization ownership activation, Node
Identity retirement, release-readiness, or production completion is claimed.

## Historical Main38 lineage checkpoint (2026-09-23)

The isolated integration branch now contains Main `38acc6fbe5c21c38c05a74cea19fbfe5123ea4cf`
and the installed Desktop member-directory default increment. Main migrations
0164–0167 retain their identities; the seven unreleased mutation migrations are
appended as 0168–0174. Checkpoint `ceb08be24dcbf71ae110e55b9907deca54d91a0f`
freezes source and a test-only Desktop stderr observation repair for independent
review; it is not an accepted or published candidate. Product artifact bytes
remain equivalent to the d328 build. Both populated upgrade paths pass locally.

The regenerated manifest has 175 journal entries and 177 SQL files. The release
matrix (18 tests) and Node/Rust manifest differential pass, as do the author-run
branding and Project–Goal HTTP/CLI/MCP probes. Prior e80 acceptance remains
historical: independent real-entry and installed workflows need fresh evidence.
The initial baseline stopped on Codex authentication termination timing assertions;
both passed an idle rerun without code or threshold changes. Remaining server
tests, UI/CLI/Desktop/scripts tests, full build and packaging pass. The complete
installed default-member author probe passes; independent acceptance and standard
Desktop smoke completion remain pending. This is split baseline evidence, not a
single clean aggregate invocation. Continue from the current status file; all three terminal goal
claims remain false. No production database or traffic has been changed.

Development Desktop scenarios now pass, as do packaged Computer Use and App
Builder checks. Standard packaged account-gate acceptance remains unresolved:
its copied identity application timed out during Electron launch, and the later
packaged scenarios were not reached. Diagnosis continues without weakening the
criterion or changing the frozen product candidate. The independent verifier
is exercising the integrated public workflows separately.

Organization-name implementation has started concurrently from `ceb08be24` in
`codex/rudder-branding-name-authority-20260923`, using a separate worktree and
build outputs. Its transaction boundary must include both supported Chat
approval paths, their proposal and system-message effects, audit, and replayable
recovery. Failing an existing approval or organization import is an incomplete
capability, not successful writer retirement. The current source boundary is
recorded in `artifacts/2026-09-23-rudder-full-branding-next-slice-boundaries.md`.

This is the implementation plan for completing the first-party Rudder backend
and Agent tooling migration to Rust. The target is a Rust-owned product runtime,
not a Node orchestration layer with Rust helpers:

- Actix Web owns the public HTTP and WebSocket server.
- SQLx owns PostgreSQL queries, transaction-connected mutations, and migrations.
- Rust owns first-party business services, auth/session authority, schedulers,
  workers, Agent Runs, Chat and Side Chat, Automations, Rudder-owned provider
  adapters, normal backend helpers, the first-party CLI, and first-party MCP.
- Rust also owns first-party identity, analytics collection, managed MCP,
  embedded PostgreSQL lifecycle, and state-owning update/recovery tools.
- React, frontend tooling, Electron shell, bounded installer entrypoints, and
  user-selected external provider CLI/MCP/Local App/Plugin processes remain in
  scope only as explicit exceptions below.

The final completion claim requires evidence after the old first-party Node
backend assets are removed. A passing Rust crate test, a loopback Actix process,
one merged PR, or a private SQLx integration test is not completion evidence.

## Authority and compatibility rules

The following rules apply to every slice and are part of the acceptance
contract, not optional migration hygiene:

1. One transaction-connected mutation has one persisted owner runtime, ownership
   epoch, and fencing token. Drizzle and SQLx never concurrently write the same
   component.
2. There is no production dual write, stale Node writer, silent Node fallback,
   Node subprocess wrapper around the old implementation, or business logic in
   Electron/bootstrap.
3. Before associating a transaction with a fence, every legacy writer touching
   that component is inventoried and either fenced or retired. A Rust fence row
   alone does not make an unfenced Node writer safe.
4. A transitional Node authority may be reached only through a private,
   authenticated bridge with a request-bound actor envelope. It has no public
   listener and is deleted when the last route in its authority unit moves.
5. Existing behavior and Product Logic remain unchanged. In particular, Chat
   must not be forced to depend on Issues, and Side Chat must retain temporary,
   expiry, promotion-to-permanent, history, stream/cancel/reconnect, and
   supported session-continuity behavior.
6. External identity providers and user-selected external runtimes remain
   external. Rust becomes Rudder's authority only after the credential,
   audience, organization, revocation, and recovery gates pass.

## Stage-review reconciliation (2026-09-21)

The first independent stage review returned `needs more evidence`. Its findings
are binding Phase 0 inputs, not optional follow-up work:

- Advancing `organization_mutation_state` does not fence an old Drizzle writer
  unless every branding, organization-settings, Project, and Project-Goal
  writer checks the same owner/fence inside its own transaction. D1 remains
  inactive until those writers are fenced, drained, or removed from the
  default path.
- The existing Project update contract replaces the complete goal set in one
  request. The Rust public contract must provide the same atomic replacement
  semantics; a sequence of single-link attach/detach calls is not equivalent.
  `cancel` remains an internal recovery operation unless an existing public
  behavior and Product Logic review authorize exposing it.
- A public D1 write needs a signed, request-bound actor envelope and a
  fail-closed private bridge before the later full identity/session cutover.
  Client-supplied actor, organization, version, or fence fields can never
  establish authority.
- The supported startup must have one listener decision recorded per phase:
  either Actix owns the sole supported socket and any Node bridge is private,
  route-scoped, request-bound, expiring, and fail-closed, or Rust remains
  private. A second public listener is prohibited.
- Audit/activity, receipt, projection, and business state must have an explicit
  atomicity contract. D1 requires rollback of all of them on audit failure and
  a recovery test after process interruption.
- First-party CLI/MCP and native process resolution need executable negative
  checks for missing Rust binaries and must fail explicitly rather than select
  a bundled Node implementation. User-selected external provider processes and
  plugins remain retained exceptions only when their ownership is recorded.

These findings add the following serial ordering to the phase gates:

1. Complete the semantic inventory and delivery packet.
2. Freeze the actor envelope, state-row provisioning, writer fence, receipt,
   audit/outbox, and listener contracts.
3. For each authority unit, inventory all writers, provision state, drain or
   fence old writers, activate Rust, run the independent verifier, then retire
   the old authority.
4. Only after those gates may D1 public writes proceed; identity/session and
   SQLx migration cutover remain later authority transfers with their own
   gates.

## Staged real-environment integration correction (2026-09-22)

The user explicitly corrected the delivery pace: real environments should be
connected incrementally as slices become safe, because offline tests and a
real installed/runtime path expose different failures. This correction changes
the sequencing of validation, not the authority and safety contract.

For every slice that passes its local contract and stage review, the delivery
owner must immediately bind it to the narrowest authorized real target that can
exercise the same entrypoint: disposable installed runtime, supported default
startup, staging, or an explicitly allowlisted/preview production target. The
target, candidate, organization/data identity, process topology, rollback
action, and observed old-authority receipts are recorded before the next slice
is accepted. Slices that are independent may be implemented and connected in
parallel; the plan no longer waits for all Phase 0-7 implementation before
real-entry validation.

An authorized production canary, tenant allowlist, shadow/read probe, or
operator-triggered slice is a valid real-entry target when its credentials and
rollback authority are available. Broad production database migration,
unreviewed traffic switching, stable publication, and destructive data actions
remain separate release/production gates. Missing credentials, signing,
platform access, or target-specific authorization blocks only that target's
probe and must not stop local, disposable, installed, or other authorized
slice work. `production_verified` remains false until the complete final
production evidence set exists.

## Moving-main adaptation loop (2026-09-22)

The migration branch is not a frozen product branch. Main may add routes, change
contracts, alter startup topology, or change UI/CLI/MCP behavior while this work
is in progress. The migration therefore runs a source-adaptation loop before
each slice candidate, not only at final integration.

- Before freezing a slice, observe the current `origin/main` ref and compare it
  with the migration base. Reconcile changed routes, shared types, schema,
  migrations, CLI/MCP descriptors, startup/packaging, and Product Logic before
  treating an existing Rust adapter as compatible.
- Perform the reconciliation in an isolated sync worktree or equivalent
  alternate checkout. Never reset the migration worktree or discard user/agent
  changes to absorb Main. Preserve a source-diff fingerprint for the pre-sync
  and post-sync candidates.
- Re-run the affected authority, writer, fallback, migration, and contract
  scans after every Main sync. A Main change in a neighboring route or shared
  contract invalidates the affected slice's review/verifier lease even when the
  Rust files were untouched.
- Keep implementation lanes parallel only when their write sets, transaction
  owners, and runtime authorities are disjoint. One integration owner resolves
  conflicts and records the resulting source/tree identity; a green child
  branch is not evidence for a stale parent candidate.
- Record Main drift as a durable event with the old ref, new ref, changed paths,
  compatibility decision, re-run checks, and invalidated receipts. The next
  executable step must name the exact slice that resumes after reconciliation.

The previous reconciled Main ref for packet v16 was
`d1f55c5c180901392804178aa44b3ba3f077a6cb`, fifteen commits after the migration
base `c54001819ca38079b627994557db0a18ed278fc0`. Since the previous
`b4c2f46966d080a18b8ce8d9545e427aa5b50ced` observation, Main changed the
Desktop update/quit handoff, extracted the Desktop update child launcher, and
updated the associated UI and E2E states. Those changes were reconciled in the
isolated snapshot worktree `/private/tmp/rudder-rust-main-reconcile-20260922-v4`
(`ef71a1462a5c7998e361fe2193e585318a6a9f91`, tree
`fb968231c160d5ff75095cf89a336f43e035ef86`) over the migration checkpoint
`5873b34bc3522807248aa179da22aa7a9ab7ca9a`. The current clean committed source
candidate is rebound to that reconciled content; the clean committed candidate
is `fc73374bb15933ef5bad7f3056336c87e455cee0` and packet v16 is the durable
source of truth. This observation is not a merge or a completion claim; it is
the synchronization input for the v16 exact-candidate receipts.

For the next v17 slice, Main was refreshed to
`5ef9b5475787dd662b2c8ec04b64158387d9dcb7`. The only additional path is
`docs/ga.js`; its documentation-site analytics change does not alter backend,
database, auth, CLI/MCP or startup contracts. Preserve it during subsequent
integration. The migration branch has not yet rebased onto this additional
commit; observation and compatibility assessment do not imply integration.

## Current checkpoint (2026-09-22)

The current isolated candidate includes the persisted `organization_mutation_state.fence_token`
contract and rotates the token whenever the mutation epoch advances. Selected
Node writers now acquire and hold the owner row lock before their first
business write, validate non-negative version/epoch and token shape, and keep
the transaction open through commit. Rust uses the same row for handoff; the
PostgreSQL lock-sequence regression proves a handoff waits for an in-flight
Node transaction and a post-handoff writer fails closed. This is the selected
serialized owner-lock contract, not a claim that every business table embeds a
token predicate. It remains a fencing prerequisite, not an authority handoff:
Goal route/issue projection bypasses and the approval, comment, storage,
portability, onboarding, skills/plugin, budget/settings, automation, heartbeat,
workspace/runtime, and background effect writers remain unresolved. The D1
route therefore remains private and the three completion claims remain false
until the remaining writers, signed bridge, supported listener, audit/recovery
boundary, and installed workflow are independently verified.

## Incremental real-entry checkpoint (2026-09-22)

The scalar organization `brandColor` mutation has now been connected through a
disposable real startup path with `RUDDER_RUST_ORGANIZATION_BRANDING_MODE=required`:
the supported Node API accepted the authenticated board request, the private
Actix bridge invoked SQLx, PostgreSQL readback observed the Rust owner/version/
epoch, immutable receipt, activity, and retryable outbox row, and a complete
server/database restart replayed the same idempotency key without duplicating
the receipt or activity. The exact evidence is recorded in
`doc/plans/artifacts/2026-09-22-rudder-branding-real-entry-probe-v2.json`.

This changes the capability ledger for organization branding to
`real_entry_connected`; it does not make branding the default installed
authority, retire every legacy writer, or activate the broader D1 owner. The
Project-Goal route also has an explicitly selected real Node entry through the
private Actix bridge, as recorded by packet v16 below. Default Rust listener
authority and complete old-runtime retirement remain unverified. Its signer,
CLI/MCP parity, and independent verifier gates have exact local evidence. The migration
continues to refresh `origin/main` before each candidate and keeps
`implementation_complete`, `release_ready`, and `production_verified` false.

The next candidate is locally checkpointed as
`17c9613e3df39e2c67c07d455206312b7ac33a75` (tree
`62dfdaee0a14c0072ca970b423a6b6af01fc6cdc`) in
`codex/rudder-branding-outbox-recovery-20260922` from `6e37a563523db92b63589557be18d12e65593101`.
It extends branding CLI/MCP and rejected-writer evidence and repairs the
transitional outbox's persisted claim/recovery protocol. Five disposable
PostgreSQL scenarios currently pass, including upgrading a stopped 0169
publisher's pending event to 0170, claim-owner process death, stale claimant
rejection, death after broadcast before ACK, and persisted retry backoff.
These are author checks, not a new independent acceptance receipt.

This candidate's recovery claim is limited to one local server with the old
publisher stopped before schema upgrade. It does not establish mixed-version
rolling deployment, multi-server WebSocket fanout, exactly-once consumer
delivery, or Rust event-transport ownership. The new UI reconnect helper now
reconciles branding/Project-Goal read models and selected-organization activity
queries, including data-less in-flight reads. Mounted regressions and an author
probe using the real UI, WebSocket, HTTP, Actix and PostgreSQL passed after
correcting a stale served UI build. The durable author receipt is
`artifacts/2026-09-22-rudder-branding-reconnect-author-probe-v1.json`; it is not
an independent frozen-candidate acceptance receipt. Managed-local process
handoff and final independent browser verification remain open.

Packaged account-gate, automatic-update recovery, Computer Use runtime and
App Builder checks passed for this local build. Development-shell Terminal
restart output still timed out and is under instrumented diagnosis; the
packaged checks do not exercise that same branch and cannot close it. The
checkpoint remains unpublished and has no final independent acceptance.

Independent stage review then exposed a recovery-marker-only startup bypass.
Checkpoint `b4793a868847a1f12bf1b9fb70bfc88ed00a5c9d` fixes that bypass
without narrowing the fail-closed criterion. Nine startup-lock regressions,
server typecheck and changed-file lint pass. Packet v17 now names this source;
managed startup and affected packaged evidence require fresh binding. The
Rust and UI inputs are unchanged from the previous checkpoint.

Managed startup safety also requires that a live startup-lock PID never loses
ownership just because a migration exceeds thirty seconds. The new guard
waits for that PID and serializes dead-owner reclamation. An unreadable partial
lock or an abandoned `.recovery` lock fails closed; it is not evidence of an
automatically recoverable startup. Operators must inspect the named instance,
lock owner and runtime descriptor before recovering those files. This plan
does not authorize deleting instance data to repair startup.

The v10 Project-Goal probe was rerun on clean committed `fc73374bb` after the
latest Main reconciliation using fresh Rust foundation and migration-preflight
binaries. It passed the same supported Node API, private Actix/SQLx, direct
CLI/MCP, explicit allowlist, unlisted fail-closed, idempotency,
cross-organization, clear-all, deletion fence, and restart/replay workflow. The
probe is still disposable local
evidence only; it does not make the listener, migration authority, old-writer
retirement, release, or production claims true.

## Explicit scope boundary

### Mandatory Rust target: `rust_product_runtime`

The ledger must include every state-owning executable or resident service in
these classes:

- HTTP/WebSocket listener, route/application services, database queries,
  transactions, migrations, activity/audit and outbox effects;
- organization, Goal, Project, Agent, Issue, routing, approval, review, budget,
  execution, run result, transcript, Chat, Side Chat, Automation, scheduler,
  workers, retry/recovery, and provider adapters;
- identity/session/device exchange, local/offline auth boundaries, analytics
  collector, managed MCP, and first-party CLI/MCP;
- embedded PostgreSQL start/readiness/stop/recovery and database lifecycle;
- update, installation, release-set selection, last-known-good, rollback,
  repair, and other tools that own product state or recovery decisions.

### Retained exceptions

- React and frontend/build tooling remain JavaScript/TypeScript.
- Electron remains the Desktop shell and renderer host.
- `npx`, JavaScript, shell, and PowerShell installation entrypoints may remain
  short-lived and bounded. They may download/verify/select a signed Rust release
  but may not own business state, credentials, migrations, scheduling, queues,
  persistent server behavior, or a hidden Node fallback.
- User-selected external provider CLIs, external MCP servers, Local Apps, and
  Plugin component implementations remain external. Their processes still count
  in complete-workflow performance and recovery evidence.
- Declarative assets, SQL history while it is being consumed by the accepted
  Rust migration runner, fixtures, generated descriptors, and test-only
  protocol fixtures are not resident business runtimes.

## Truth model and claim vocabulary

Every capability row in the ledger uses these independent statuses:

| Status | Meaning | Does not imply |
| --- | --- | --- |
| `implemented` | Rust code or a contract exists in the candidate | any real entrypoint uses it |
| `private_verified` | focused unit, integration, differential, or recovery checks pass | public/default workflow adoption |
| `real_entry_connected` | an installed/user-facing API, CLI, MCP, Desktop, or lifecycle entry invokes Rust | default packaged path or old-authority retirement |
| `default_path_verified` | clean supported install/startup/default workflow uses Rust with exact runtime identity | production or public release proof |
| `old_authority_retired` | the old first-party writer/runtime is absent from executable receipts and guarded by tests | stable release or production rollout |

The status files must also report three top-level claims independently:

- `implementation_complete`: all mandatory Rust authority units implemented and
  accepted locally, with old authorities retired in the candidate.
- `release_ready`: exact release set, packaging, install/bootstrap, upgrade,
  rollback, supported-platform, CLI/MCP, and packaged workflow evidence passes.
- `production_verified`: real production evidence under separately authorized
  production conditions. This remains `false` unless such evidence exists.

No percentage estimate is a status. A phase is complete only when its ledger
rows, review receipt, exact-candidate verifier, and final reviewer receipt agree.

## Durable records

This plan is accompanied by:

- `2026-09-21-rudder-full-rust-backend-completion-status.yml`: current phase,
  claim states, exact candidate/runtime/data identity, blockers, receipts, and
  next executable action. Update it after every accepted slice, drift event,
  failed gate, or interruption.
- `2026-09-21-rudder-full-rust-backend-completion-ledger.yml`: one row per
  authority capability or a link to the expanded route/writer/CLI/MCP inventory.
  It records owner, entrypoint, auth, organization scope, transaction, audit,
  side effects, recovery, CLI/MCP parity, fence, evidence, and retirement gate.
- A delivery packet created from
  `.agents/skills/maintainer/delivery-lifecycle-maintainer/assets/delivery-packet.template.json`
  for each high-risk candidate. It is validated with the maintainer script and
  is the source of truth for candidate drift and review/verifier receipts.

The existing route, transaction/writer, CLI/MCP, performance, and Electron/
release inventories remain detailed inputs. Phase 0 must refresh them against
the exact current source; historical counts in G0 documents are observations,
not current completion claims.

## Current baseline at plan start

The migration branch starts from current `origin/main` candidate
`c54001819ca38079b627994557db0a18ed278fc0` in an isolated worktree. The
original checkout and all user state remain untouched.

The following facts are established but intentionally limited:

- `native/` contains an existing Rust workspace, native contracts, migration
  source inspection, runtime/read helpers, `rudder-server-foundation`, D1 core
  crates, update/process helpers, and CLI/MCP contract artifacts.
- The G0 contract and current D1 plan explicitly leave the public Node listener,
  Drizzle query/migration authority, and Node product writers active. The Actix
  foundation is not a public product-route replacement.
- D1 includes private SQLx persistence code and PostgreSQL tests for organization
  branding and Project-Goal links, but the public route/CLI/MCP entrypoint,
  authority handoff, all legacy-writer fencing, and Node writer retirement are
  not thereby proven.
- `server/`, `packages/db/`, `cli/`, and `packages/agent-runtime-utils/` still
  contain first-party Node/TypeScript runtime assets. Their presence is expected
  at the baseline and becomes a retirement target only after each authority row
  passes its own gate.
- The last accepted G0/source-delta inventories recorded 498 direct public
  route declarations plus 506 bindings, 187 transaction call sites, 161 SQL
  files/159 journal entries, 117 CLI capabilities, and 106 canonical MCP tools.
  Those figures must be regenerated at the current candidate before they are
  used for a current claim.

## Phase 0: refresh authority, contract, and evidence baseline

Phase 0 changes no broad runtime authority. It produces the current inventories
and acceptance packet schema, while allowing already-safe read or lifecycle
probes to be connected to an explicitly authorized real target as soon as the
relevant narrow contract is frozen.

### Work

- Enumerate every public HTTP/WS route, private collector, WebSocket upgrade,
  transaction call site, direct SQL query, migration/journal entry, queue/job
  claim, worker/scheduler, provider/helper process, identity/session path,
  analytics collector, managed MCP server, embedded PostgreSQL lifecycle,
  update/recovery tool, CLI capability, MCP tool, installer entrypoint, and
  Desktop attachment point.
- Classify each row as `node_authoritative`, `rust_authoritative`,
  `frozen_for_cutover`, `retained_external`, `bounded_installer`,
  `frontend_or_shell`, `fixture`, or `unknown`. Any `unknown` state-owning
  executable blocks Node retirement.
- Reconcile route/writer counts against the current source and bind every count
  to a candidate SHA, tree, scan command, and timestamp.
- Freeze behavior contracts: request/response/error/stream framing, auth actor,
  organization scope, projections and byte budgets, ordering/cursors,
  idempotency, audit/outbox effects, cancellation, reconnect, timeout, retry,
  and recovery behavior.
- Record state-row lifecycle explicitly: provisioning for existing and newly
  created organizations, deletion ordering, baseline version/fence, and the
  owner token/epoch used by every writer. Record activity, audit, notification,
  terminal-effect, and outbox writers separately from business transactions.
- Record the exact listener topology and startup process graph. Include a
  negative receipt for duplicate public listeners, stale private bridges,
  Node fallback, and Node subprocess wrapping of a first-party implementation.
- For every authority row, keep independent fields for implementation,
  private verification, real-entry connection, default-path verification, and
  old-authority retirement. A single progress status or percentage cannot
  substitute for these dimensions.
- Freeze the performance manifest and complete-workflow attribution. Keep Rust
  core and Electron/PostgreSQL/external-process workflow closure separate.
- Create the first delivery packet and evidence directory outside the source
  tree for mutable run logs/screenshots; commit only durable plan/status/ledger
  records intended for repository history.

### Exit gate

No route, transaction-connected writer, state-owning process, CLI command, MCP
tool, migration, or lifecycle authority remains unclassified; the source scan,
contract inventory, benchmark manifest, and acceptance packet pass independent
review. This gate does not enable Rust writes.

## Phase 1: Actix, SQLx, Rust CLI/MCP foundation, and first real read path

Phase 1 makes the foundation observable through a real local entrypoint while
keeping the Node authority for un-migrated product state. It must not introduce
a second public listener or a silent fallback.

### Work

- Build the Rust modular-monolith server around Actix/Tokio with bounded body,
  response, WebSocket, queue, SQLx pool, database/provider/helper timeout,
  backpressure, tracing, drain, and shutdown policies.
- Add health/readiness and build/route/command/tool/schema/ownership receipts
  without secrets. Add a private bridge only if an explicitly inventoried
  Node-authoritative route needs it; bind the actor envelope to request, method,
  canonical body hash, nonce, audience, organization, expiry, and a
  server-side session/revocation epoch. The bridge must reject client-forged
  actor data and must have a bounded lifetime.
- Add versioned Rust CLI/MCP contracts and runtime-locked dispatch. CLI/MCP must
  share Rust authorization and business services rather than duplicate Node
  state machines. MCP must fail closed on missing/conflicting identity and
  preserve result limits, framing, cancellation, and run attribution.
- Connect an initial read-only public route through the supported local startup
  path, with organization authorization and differential tests. Prove the
  actual installed process tree and listener identity. Immediately repeat the
  same probe through the available installed/default or explicitly authorized
  real target; do not defer this proof until the rest of the backend moves.
- Treat the supported-startup probe as a short feedback loop: after a successful
  local contract, run the same route through the real startup, record the
  candidate/runtime/data identity and rollback action, then return to the next
  independent slice without waiting for later phases.

### Exit gate

Actix is observable through the named local entrypoint, but no claim is made
that it is yet the sole public listener. The read workflow, CLI/MCP contract
probe, limits, shutdown/restart, organization negative cases, and private
bridge failure behavior pass on an immutable candidate. Node remains the
explicit authority for all un-migrated writes.

### First default-read increment (2026-09-22)

Start with the installed Desktop member-directory entry because its package
already stages the foundation binary. Select the required mode from the
installed-runtime configuration, never from whether the binary happens to
exist: a missing or unusable asset must fail closed. Electron supplies launch
configuration only; it must not acquire backend query or authorization logic.
Standalone server and CLI defaults remain unchanged until their native-asset
installation slice is complete. Explicit off and shadow retain their existing
meaning and are recorded as remaining Node read paths, not retired authority.

Before acceptance, reconcile query normalization, duplicate/array parameters,
limits, cursors, fullIds and error bodies against the existing public contract.
Generate a fresh bridge key per process spawn unless an explicit static-key
configuration was selected; invalidate ephemeral keys on child exit. Installed
acceptance must prove the default read, organization isolation, missing-binary
failure, child restart and process/listener identity on the frozen candidate.

## Phase 2: native data and read surfaces

Move archive/backup/evidence/filesystem metadata and read-only product views by
authority unit. Each row must prove organization scope, bounded projections and
bytes, pagination/order, auth, errors, cancellation, reconnect where relevant,
and restart behavior. Backup create/delete/restore remains Node-owned until a
separately fenced mutation slice passes recovery and retention gates.

The public read path, not only a native binary invocation, is the acceptance
boundary. A native helper invoked behind the old Node service remains
`private_verified` until the public call graph and default packaged path are
Rust-owned. Once a read slice passes that boundary, connect its real entry to
the narrowest authorized target and record the old-authority negative receipt
before starting the next dependent slice.

## Phase 3: organization, Goal, Project, and Agent transaction slices

Migrate ordinary organization-scoped CRUD and activity-connected mutations in
small vertical slices. The first complete write slice is the existing D1
organization branding plus Project-Goal link domain described below. Subsequent
slices may cover settings, Goal/Project/Agent state only after the writer audit
and D1 receipts are accepted.

Each slice includes the route/WS or CLI/MCP entry, actor and organization
authorization, SQLx transaction, activity/audit/outbox effects, idempotency and
replay semantics, side effects, ownership/fence checks, crash/retry/recovery,
cross-organization negatives, differential behavior, and retirement of every
old writer for that component. A schema table or private crate alone cannot
advance a row. Local acceptance and real-entry connection are separate gates,
but the real-entry probe starts immediately after the local gate instead of
being deferred to a late global cutover.

## Phase 4: Issue, routing, governance, and review

Migrate checkout, assignment, attention, comments, review, approvals, budgets,
activity, and governed state machines. Preserve single assignee, atomic
checkout, approval gates, hard-stop budget pause, stale actor rejection,
terminal effects, notification/outbox ordering, contention, retries, and
organization isolation. Chat remains independently modeled and is not made an
Issue dependency by this migration.

## Phase 5: execution, Chat, Side Chat, Automation, workers, and adapters

Migrate Agent Run admission/execution/result/transcript/workspace lifecycle,
Chat and Side Chat, Automation definitions/triggers/runs/outputs, scheduler,
workers, retries, recovery, provider adapters, analytics collection, managed
MCP, and normal backend helpers. Preserve temporary/expired/promoted Side Chats,
history, stream/cancel/reconnect, session continuity, run identity, activity,
cost/budget effects, and restart recovery.

Rust must supervise or own every Rudder-owned provider/backend process. A
user-selected external provider CLI/MCP/Plugin/Local App remains an external
process and is not reimplemented, but its lifecycle and failure behavior must
be represented in the complete workflow receipt.

## Phase 6: identity, auth/session, SQLx migration authority, lifecycle, and cutover

Migrate identity/session/device exchange, credential rotation/revocation,
audience and organization binding, offline/local behavior, CLI/MCP auth, and
WebSocket auth only after real credential fixtures and Desktop/packaged paths
pass. Preserve external IdPs as identity roots.

Make SQLx the migration runner only after historical journal fixtures, advisory
lock fencing, pre-mutation recovery backup, immutable checksums, normalization
and journal transaction boundaries, post-migration invariants, and declared
old-version compatibility/rollback boundaries pass. Rust must own embedded
PostgreSQL startup/readiness/stop/recovery before Node lifecycle assets are
removed.

Actix becomes the sole public listener only after route authority is complete,
private bridge receipts are no longer needed, and no Node process is on the
default product path. Public cutover is a drain/fence/probe/rollback operation,
not a runtime flag that silently chooses Node when Rust is unavailable.

## Phase 7: legacy Node retirement and installed-workflow proof

Remove or make non-runtime all first-party Node server queries, Express route
registration, Drizzle runtime authority, Node auth/session handlers, Node
scheduler/workers/adapters/helpers, first-party Node CLI, and first-party Node
MCP. Keep only the explicit exceptions in this plan.

Run static and runtime negative checks proving that installed UI/API/CLI/MCP,
database upgrade, scheduler, execution, Chat/Side Chat, automation, recovery,
update/rollback, and supported platforms cannot silently start or write through
the retired Node backend. Prove clean install/default path identity and exact
release-set hashes. Do not claim production verified without authorized
production evidence.

## First complete write slice: D1 organization branding and Project-Goal link

This slice combines the existing D1 capabilities because their correctness
boundary is transaction, activity, receipt, ownership, and legacy projection,
not the location of a Rust file.

### Required behavior

- Organization branding mutation preserves current validation, logo-asset
  organization scope, nullable fields, response/error behavior, and activity
  action identity.
- Project-Goal attach/detach/cancel/primary-projection behavior preserves the
  multi-goal relation, legacy `projects.goal_id` projection, target scope,
  ordering, replay, and conflict semantics.
- Board and permitted agent actors retain current authorization. Foreign org,
  inactive actor, missing entity, stale version/fence, replay conflict,
  overflow, and malformed receipt cases fail closed with compatible errors.
- Business state, mutation version/fence, immutable idempotency receipt, and
  activity/audit row commit atomically. Audit failure rolls back all effects.
- Recovery after process interruption is idempotent, leaves no partial
  projection, and makes the previous or new owner diagnosable. A stale Node
  writer cannot commit after fence advancement.

### Required implementation boundary

- Add a reviewed trusted integration hook from the private core command APIs to
  the public Rust application service without making actor binding forgeable.
- Add SQLx adapter wiring and one Actix route/application service for the real
  organization branding and Project-Goal operations. It must obtain actor and
  organization context from the same auth contract as other Rust routes.
- Provision `organization_mutation_state` for all existing organizations and
  transactionally for new organizations before advancing any owner fence.
  Bind all legacy TypeScript routes/services/writers for these exact operations
  to that fence or remove them from the default path. The old transaction must
  lock and validate owner/epoch before its first business write; a Rust fence
  row alone is insufficient. Do not activate Rust while a direct Drizzle
  writer can still race it.
- Implement the existing Project goal-set replacement as one Rust command and
  one transaction, including all links, the legacy `projects.goal_id`
  projection, receipt, activity, and version/fence advancement. Do not emulate
  it with independent single-link requests.
- Add matching Rust CLI/MCP operations only where the existing first-party
  capability exposes the mutation; generated descriptors and human/JSON output,
  exit status, cancellation, actor/run attribution, and organization scope
  must remain parity-checked.
- Add real PostgreSQL tests and public workflow tests for success, idempotent
  replay, conflicting key, cross-organization target, stale owner/fence,
  audit rollback, process/retry recovery, CLI/MCP parity, and old-writer
  rejection. The existing private tests are supporting evidence only.

### Acceptance workflow

On a disposable isolated database and the exact candidate: create two
organizations, one board actor and one permitted agent actor; update branding;
attach multiple goals, change the primary link, detach/cancel, replay and
conflict; attempt foreign-org and stale-fence mutations; force an audit or
process interruption; restart; read through the UI/API, CLI, and MCP; confirm
activity and projection state; and inspect the process/listener receipts to
prove no Node writer was used. Re-run from a clean default startup and capture
the exact source/build/runtime/data identity.

## Per-slice gate and handoff protocol

1. Reconcile the latest Main ref in an isolated sync worktree. If Main changed
   the route, actor, schema, descriptor, startup, or packaging contract,
   invalidate affected receipts and replay the affected source scans.
2. Implementer records changed paths, contracts, tests, authority ownership,
   fixture/data identity, and known gaps.
3. Reviewer performs the stage verdict against the intent, implementation,
   product behavior, adversarial cases, and proposed acceptance packet.
4. Freeze the exact candidate SHA or scoped dirty fingerprint, build/artifact,
   runtime/process, organization/data, workload, and packet version.
5. Independent verifier exercises the public workflow and returns exactly
   `PASS`, `FAIL`, or `QUESTION` for that frozen candidate. It does not review
   source or fix code. `QUESTION` blocks the handoff.
6. Resolve findings, invalidate stale receipts after relevant drift, rerun the
   affected checks, and obtain final reviewer `accept` on the same candidate.
7. Commit and push only the scoped accepted increment to a `codex/` branch and
   open/update its PR. Do not merge to protected `main` from this task without
   a separate authorized integration step and current CI identity.
8. Connect the accepted slice to the narrowest authorized real target that
   exercises the same entrypoint. Capture target credentials/authority class,
   process/listener identity, data identity, rollback result, and old-authority
   negative evidence. A missing production target blocks only that probe.
9. Update status/ledger with exact commit, checks, local and real-entry
   receipts, remaining work, blocker, and the next executable slice before
   continuing.

## Testing and evidence matrix

Every changed workflow requires focused unit/integration/differential coverage
plus real public workflow acceptance. High-risk slices add:

- organization-boundary negatives and actor/credential revocation;
- transaction rollback, idempotency, stale fence, duplicate delivery,
  restart/recovery, queue drain, and timeout/cancellation;
- exact route/CLI/MCP framing, output/error/exit-code parity and byte limits;
- default install and packaged Desktop identity where the slice touches startup,
  profile, migration, update, or lifecycle;
- Rust-core performance and complete workflow closure measurements with the
  frozen workload, platform, process attribution, and noise budget.
- A staged real-entry probe for every accepted slice, using the authorized
  installed/default, staging, or production-canary target available for that
  slice. Record missing credentials or platform access as a target-local gap.

Run repository baseline checks at the scope required by `AGENTS.md` and report
material omissions. UI claims require actual browser/Desktop evidence using
the supported browser workflow. Ad-hoc screenshots and runtime logs stay out of
the repository tree.

## Non-goals and blocked dimensions

This plan does not authorize broad production database migration, unrestricted
production traffic switching, stable publication, deletion of real user data,
platform signing, purchase of services, or external provider redesign. The
2026-09-22 correction does authorize incremental connection to an explicitly
authorized production canary/allowlist/shadow or operator-triggered target when
the target-specific rollback and credentials are available. Missing
credentials, signatures, platform environments, or production authorization
block only the affected real-entry or release row; local implementation and
disposable acceptance continue. The status file must name the exact missing
evidence rather than turning it into a general blocker.

The plan remains `in_progress` until Phase 7 and the final installed-workflow
proof pass. A completed D1 slice, merged PR, or accepted phase is a checkpoint,
not the final goal.

## 2026-09-23 Mainline-adapted D1 real-entry checkpoint

The current Mainline adaptation was assembled in the isolated worktree
`/private/tmp/rudder-rust-mainline-probe-20260923` from `origin/main`
`cf131c6de87ac7d29ad4acbda3da6729dc2c52a4`. Main migrations `0164`-`0168`
remain intact and the Rust migration set is appended as `0169`-`0174`, yielding
175 journal entries, 177 SQL files, and manifest fingerprint
`bda5ccbcea0293163db4bfd309da88cced8f69197905e132b94d2698c6e7acb7`.
The staged source candidate has index tree
`15c813eb7aff94e87f406e552b8d406e4512a5cd` and source fingerprint
`ffe4c7093515753d914553547b3a343a70e714ed894c62e2b4d63e199ae2f161` over
105 source paths; all `doc/plans/` records are excluded and the original dirty
migration checkout remains untouched.

The required-mode branding and Project-Goal scripts now pass through the real
Node startup, embedded PostgreSQL, private Actix/SQLx bridge, CLI, and MCP
entrypoints. Branding observes Rust owner/version/epoch, immutable receipt,
activity, outbox, and restart replay. Project-Goal observes create-with-goals
compatibility, explicit allowlist failure/success, unlisted fail-closed writes,
complete goal-set replacement, mixed-update rejection, signed idempotency
substitution rejection, organization isolation, delete fencing, CLI/MCP
dispatch, and restart replay. The first attempt failed closed because the
candidate build had not produced `migration-preflight`; building
`rudder-migration-service --bin migration-preflight` repaired only the local
artifact, after which both probes exited with their PASS markers.

This checkpoint is `real_entry_connected` for the two bounded D1 capabilities,
not `default_path_verified` or `old_authority_retired`. The public listener,
Node migration authority, full identity/session authority, unresolved writer
families, packaged/default path, and production evidence remain open. The
machine-readable evidence is in
`doc/plans/artifacts/2026-09-23-rudder-rust-d1-real-entry-probe-v22.json` and
`doc/plans/2026-09-23-rudder-full-rust-backend-completion-delivery-packet-v22.json`.

An independent verifier reran both real-entry workflows on the exact candidate
and returned `PASS` after a current lease recheck. The fresh disposable runs
used candidate-local `tsx`, embedded PostgreSQL, required native mode, and
produced `/tmp/rudder-v22-independent-branding.log` (SHA-256
`287db1dba74140406ad9c01f86db29597f4ff8d653e7ac2dd10a8df103eacdb1`) and
`/tmp/rudder-v22-independent-project-goal.log` (SHA-256
`207ad99233a2674fb39003465ae420e0f2ca3819a69ae4f4d015184bea7191c8`). This
is an accepted private real-entry slice only; default-path verification,
legacy-writer retirement, full Rust migration, release readiness, and
production verification remain false.

The final-review pass correctly rejected the first handoff packet as
`needs more evidence`: its concrete candidate data IDs still named the author
fixtures even though the independent verifier used fresh fixtures. The packet
now records the mismatch as an invalidated stage receipt and is rebound to the
verifier's concrete organization/data tuple. Boyle reissued the stage review
as `accept` on that rebound tuple. The final review returned `accept` with no
findings on the rebound tuple. The bounded slice is ready for a scoped commit
and PR; it is still not a claim that the overall migration is complete.

The reviewed slice was then committed as `8e5b3fff1b8b377cdf1ec64cac2c33ed32d9b36c`
with tree `d9ad1738ec9752cf07a279aa55f2ff1d98bc38b3`. A committed-blob hash
stream over the same 105 source paths is exactly the prior fingerprint
`ffe4c7093515753d914553547b3a343a70e714ed894c62e2b4d63e199ae2f161`, so the
behavioral candidate is content-equivalent. The three precommit receipts are
nevertheless invalidated until their issuing agents rebind them to the new
commit identity. Hegel then returned committed-candidate `PASS`, Boyle
reissued stage `accept`, and Jason reissued final `accept` with no findings on
the committed tuple. The next gate is the protected-branch PR handoff.
