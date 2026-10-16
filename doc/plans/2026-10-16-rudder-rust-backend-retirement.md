---
title: Complete Rust backend migration and retire Node runtime
date: 2026-10-16
kind: implementation
status: in_progress
area: api
entities:
  - backend_authority
  - rust_migration
  - runtime_lifecycle
issue:
related_plans:
  - 2026-09-21-rudder-full-rust-backend-completion-plan.md
supersedes: []
related_code:
  - native/crates/server-foundation
  - native/crates/migration-service
  - server/src/index.ts
commit_refs: []
updated_at: 2026-10-16
---

# Outcome

Implement the approved full migration plan. All first-party backend authority,
including HTTP/WebSocket, authentication, migrations, workers, orchestration,
CLI/MCP and recovery decisions, must execute in Rust. New backend functionality
must be Rust-owned immediately. React, Electron presentation, build tools,
bounded launchers and user-selected external providers remain permitted.
The September plan remains the historical authority ledger; this continuation
refreshes current source evidence rather than inheriting old completion claims.

# Execution and ownership

The root chat schedules bounded implementation work and independent review.
All child sessions must be verified as gpt-6-luna with xhigh effort. Concurrent
workers own disjoint modules; the root owns shared registration, manifests,
workflow wiring and integration. No existing user profile or database is reset.

| Track | Delivery | Completion gate |
| --- | --- | --- |
| Inventory and policy | Source-derived entrypoints and runtime owners; trusted-base CI ratchet; Rust-only new backend policy | No silent unknowns or new unreviewed Node authority |
| Authentication | Native key, session, cookie, JWT/device and OAuth compatibility | Existing identity and revocation work without Node auth |
| Database lifecycle | Native apply using existing SQL and journal; recovery backup, lock, validation and lifecycle | Old databases upgrade and recover with a single migration owner |
| Domains | Reuse migrated reads; complete writes, effects, idempotency and recovery | Direct public Rust workflow plus old-writer retirement |
| Runtime | Scheduling, execution, Chat, Automation, integrations and recovery | One durable owner, race/cancel/restart evidence |
| CLI/MCP and cutover | Native first-party commands/tools; Rust default startup | Installed workflows pass after removing Node backend artifacts |

Authentication and database work run in parallel with isolated domains. Direct
public cutover depends on native authentication; workers depend on their domain
transactions and durable state machines. No unsupported stub or proxy counts
as migrated. Temporary bridges remain explicit incomplete debt.

# Compatibility and acceptance

Keep existing public method/path, JSON/error/stream behavior, CLI and MCP
contracts, credentials, PostgreSQL data and immutable migration history. Fix
security defects with explicit regression coverage rather than reproducing them.
Native failures fail closed; no hidden Node retry/fallback. Compare legacy and
Rust outcomes against disposable production-shaped fixtures, including volume,
time zones, private data, revocation, races, replay, crash and restart.

Each bounded runtime delivery follows stage review, frozen candidate identity,
independent public-workflow verification, final review, protected PR and exact
CI. Record source/build/runtime/data identities in the delivery packet. Run the
full repository baseline for cross-package changes and desktop:verify for
startup/migration/packaging changes. A Rust helper test is not public acceptance.

Final acceptance removes legacy backend artifacts from a disposable installed
product and exercises auth, persisted domain work, streaming, agent execution,
CLI/MCP, upgrade and recovery while inspecting listeners and process ancestry.
Release readiness and production deployment are separate claims.

# Initial current-source checkpoint

Base: ae74493a38f9688980d9ff46d49fff1a32896eab. Rust ingress is opt-in and most
routes still proxy to Node. Rust migration-service only preflights; Node applies
migrations. This initial snapshot predates the merged PR289 policy. PR262
and PR264 are historical branches requiring selective reuse and new acceptance,
not blanket merging. All phases and the parent objective remain incomplete.

# First implementation batch (in progress)

- Native `pcp_` Board/Agent credential resolution now owns the member-directory
  public path. Recognized invalid credentials fail closed; the directory read
  revalidates credentials and organization scope in its data snapshot. Stage
  review accepted the slice after preserving query-validation precedence.
  Independent public-entry acceptance returned PASS on the frozen binary and
  final independent reviewer handoff returned ACCEPT. Cookie/session/device/
  OAuth/JWT and other public routes remain migration debt.
- The migration service now has an explicit opt-in writer and `migration-apply`
  operator entry. It shares Node's advisory lock, closes locked connections on
  cancellation, applies SQL plus journal per transaction, and validates source
  identity and database invariants. Actual historical-source upgrade and a real
  pg_dump/restore passed author tests. Stage review rejected the first backup
  marker validation as insufficient. Actual dump-structure validation and
  empty/wrong-dump refusal tests fixed the finding; re-review accepted the
  opt-in slice. Independent real operator acceptance returned PASS and final
  reviewer ACCEPT. Invalid dump attempts retain private diagnostic artifacts;
  no invalid recovery point is returned and no database mutation occurs. Node
  remains the default startup migration owner.
- Source inventory and trusted-base CI ratchet cover runtime sources, dynamic
  structural candidates, immutable SQL and journals. The inventory explicitly
  retains 10 lexical unknown surfaces and 789 backend Node source files;
  the companion semantic classification explains all ten without claiming retirement;
  these are debt signals, not a completion percentage or semantic endpoint count.
- Repository typecheck and build passed. Lint reports 20 unchanged baseline
  import-order files. The full test run completed with 11 failing server test commands; the
  remaining suites passed. It used a separate temporary root after the existing Vitest
  prefix-based PostgreSQL cleanup interfered with concurrent fixtures.
  Desktop verification passed development smoke, packaging and macOS arm64
  packaged startup/update smoke. This evidence predates the follow-up process
  transport correction and does not establish cross-platform or no-Node acceptance.
  Canonical temporary paths resolve the workspace-browser and heartbeat fixture
  failures (38, 63 and 3 focused tests passed). Goal read tests passed all 21
  cases on a focused rerun; the initial single failure remains a nondeterministic
  baseline observation, not a diagnosed source defect. The legacy public ingress
  auth suite was updated and its 20 cases passed. Provider failures exposed a real
  child-exit transport mapping defect; its bounded compatibility fix now has
  independent PASS, final reviewer ACCEPT, and a hash-bound policy exception.

No batch has been published yet. Final reviewer acceptance, exact-candidate
verifier evidence, applicable CI, and protected PR delivery remain mandatory.

# Existing PR integration audit

The user explicitly authorized merging needed qualified PRs and closing obsolete
ones on 2026-10-16. Current-main lookup found API migrations #290, #291, #295,
#296, #298-#304 already merged; old open drafts must not be treated as wholly
unimplemented work. #289 passed independent artifact review and exact-head
Linux/macOS/Windows/native/packaged/security CI, then merged by rebase as
1021d5c5ba7d0b758fae42fd6569810c1a456a77. This is source integration only.

#292 received independent merge review ACCEPT, but GitHub refused rebase
merging its merge-commit head (rebaseable=false). It is now Ready and rebased
onto main as 5e1f8221ea91b85d1a6644eb80817b53050fff72, preserving all six
reviewed files byte-for-byte; new exact-head CI is running before merge. Independent five-binding
comparison confirmed #276 is superseded by #302/#303/#304; it was closed with
its branch preserved and the replacement rationale recorded. #264 targets the old #262 branch rather than main and needs dependency
reconciliation. #262 overlaps this accepted native bearer slice; do not discard
its remaining work until replacement integration is recorded. #226 is an
incomplete native Chat draft with unresolved runtime/UI/retention acceptance;
its useful work remains migration input, not a ready full-product merge.

Current-candidate Desktop rerun: startup recovery and App Builder passed, but
the clean scenario timed out waiting for Agent Terminal output after restarting
an intentionally obstructed workspace. Evidence is preserved in
`/private/tmp/acceptance-rudder-desktop-20261016/rudder-desktop-smoke-j3UN39`
and `/tmp/rudder-retirement-desktop-current.log`. The previous packaged PASS
does not cover this later candidate; diagnosis and affected revalidation remain
open. No timeout increase or baseline waiver was applied.

A focused `--mode=dev --scenario=terminal` rerun passed without source or timeout
changes. This resolves the observed Terminal scenario for that rerun, but does
not replace the remaining current-candidate packaged verification.

PR264 audit found seven coherent CLI commits after 7a416d0, reusable after the
current bearer source is committed. PR262's remaining unique policy is native
required/optional ingress auth configuration and startup propagation; preserve
the compatibility bridge until its replacement has separate acceptance. PR226
has 671 changed paths relative to its old base and no new Rust backend service
implementation; preserve unique runtime contracts and writer-fence behavior as
inputs for narrow Rust-owned successors rather than merging the whole draft.

# Checkpoint 24e86ee: current bounded evidence

The accepted source was checkpointed locally as
`24e86ee038971cebed653b05411c995319441652`; no batch publication or full-goal
completion is implied. The public-ingress auth workflow suite was updated to
require native fail-closed behavior for recognized keys with a disabled database
and zero Node adapter calls; all 20 cases and server typecheck passed. Real
PostgreSQL success/revocation remains covered by the independent bearer packet.

The process transport now requires valid spawned-process and unique app-exit
evidence for success and failure. Requested Stop retains its signal result only
with the matching stop confirmation. Independent re-verification passed six
real-host outcomes, 51 runner cases and 113 provider cases, followed by final
review ACCEPT. All 14 evidence-manifest hashes were checked by the root and
reviewer. Evidence is retained in
`/private/tmp/rudder-transport-reverify.D8KkWB/`; this supersedes the earlier
transport acceptance only for the explicitly frozen hashes in that ledger.

The latest complete Desktop verification is still running; its prior failed
Terminal scenario and earlier successful package run remain historical evidence.
PR264's seven CLI commits are being replayed onto this checkpoint with separate
CLI tests and real-endpoint acceptance. Full migration and production deployment
remain incomplete.
