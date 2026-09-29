---
title: Rust Project creation through the shared service
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
  - 2026-09-29-rust-project-delete-ownership.md
supersedes: []
related_code:
  - server/src/services/projects.ts
  - server/src/routes/projects.ts
  - native/crates/d1-persistence/src/transaction.rs
commit_refs:
  - 89859a26b002828a61faf7a542d8f07d3b522884
  - 0b064066c1a19da9181a3208a5c61ff3723978c8
updated_at: 2026-09-29
---

# Project-create service-path pilot

Implementation preparation in parallel with PR235 qualification; publish only after PR235 convergence. Route eligible `projectService.create` calls through one Rust command for public HTTP/CLI/MCP and board onboarding, including empty goals and supported resources. Preserve synchronous Library-ready success. Import remains explicitly Node-owned orchestration; worktree merge remains one complete Node transaction creating Node-owned rows; seed remains supported. Select these trusted caller lanes before mutation, never as fallback after a failed Rust call. This is service-path ownership, not organization-wide creator retirement.

## Minimal delivery sequence

1. **Integrate command and callers.** Pass explicit actor/run, idempotency key, and caller audit context through the shared service for public API and board onboarding; preserve HTTP 201 and legacy response shape. Generate an optional key once per invocation and retain it across transport retries. Explicit-key retries bind the original request. Preserve import orchestration and the complete worktree-merge transaction on their named Node lanes.
2. **Reuse existing fences.** In one SQLx transaction: organization lock → receipt lookup/current actor authorization → mutable name/default/reference resolution → Project insert → existing Project mutation row assigned Rust owner/epoch → goals/resources/attachments → audit, immutable receipt, existing outbox → commit. Provision Library before commit as below. All SQL effects roll back on failure. The org lock serializes participating creators; it does not grant exclusive creator authority. Preserve branding → organization → Project ordering; never acquire branding after organization.
3. **Port synchronous Library provisioning into Rust.** Reproduce current directory/README semantics before commit and success, including existing directory symlinks and shared same-name directories. Before writing Project artifacts, record command intent under a stable private instance data root, separate from the shared Library directory. Bind organization, command, request fingerprint, intended Project UUID, resolved name/key, and organization workspace root. An identical retry may reuse it; a changed identity fails with a conflict before creating a second path. Malformed intent fails closed and is retained for diagnosis. The record never grants directory ownership. SQL rollback may leave reusable filesystem artifacts; no filesystem rollback or automatic orphan cleanup is claimed. Postcommit acknowledgement loss replays the receipt without calling provisioning. No async worker/queue is proposed.
4. **Route later mutations by owner.** Use the existing Project mutation row for generated Rust-owned IDs across later routes and restart; retain Node routing for merge-created rows. Use receipts for deleted-ID replay. Preserve transactional owner/epoch checks and stale-writer failure. A dedicated cohort row is unnecessary unless a later slice needs online organization-wide transfer.

## Affected paths

Relative to `/Users/zeeland/.codex/worktrees/rudder-member-directory-default-20260922/rudder-oss`:

- Service/callers: `server/src/services/projects.ts`, `server/src/routes/projects.ts`, `server/src/routes/onboarding.ts`, `server/src/services/knowledge-portability/organization-portability.import.ts`.
- Semantics/routing: `server/src/services/resource-catalog.ts`, `server/src/home-paths.ts`, `server/src/services/project-goal-mutation-fence.ts`.
- Native: new `native/crates/d1-persistence/src/project_creations.rs`; existing `native/crates/d1-persistence/src/lib.rs`, `native/crates/d1-persistence/src/transaction.rs`, `native/crates/d1-persistence/tests/postgres.rs`; adapter/provisioning integration in `native/crates/server-foundation/` and `native/bins/rudder-server-foundation/`.
- Receipt-kind change if needed: `packages/db/src/schema/organization_mutations.ts`, `packages/db/src/migrations/` and generated metadata. Compatibility checks: `cli/src/commands/client/project.ts`, `cli/src/agent-v1-mcp-d1-capabilities.ts`, `ui/src/api/projects.ts`. Preserved direct writers: `cli/src/commands/worktree-merge.ts`, `packages/db/src/seed.ts`.

## Reviewer decisions and gates

- **Shared fencing:** mixed creators are intentional. If a direct writer omits the org lock for conflicting mutable resolution, close that narrow gap. Existing Project ownership fences must protect later writes; neither this pilot nor its org lock guarantees exclusive Rust creation.
- **Metadata/audits:** preserve goalIds precedence over legacy goalId and caller metadata/default precedence. Preserve public/onboarding actor attribution and creation metadata; move their creation audits into the transaction without duplicate Node events. Do not add per-Project import audits in this pilot.
- **Filesystem:** approve stable command intent, shared-path collision rules, and explicit conflict when mutable name/path resolution changes. Test precommit crash/provisioning failure, audit/receipt rollback, postcommit replay/restart, and replay after deletion without touching a new incarnation. Filesystem work holds the org lock; assess latency. Existing Node organization-layout preparation, friendly-name mapping and root ownership checks remain a separately recorded authority; only internally resolved roots cross the signed native wrapper. Public request data cannot select these roots.
- **Parity:** cover Rust HTTP/CLI/MCP and onboarding, preserved Node import and atomic worktree merge, large payloads, both owners after restart, Library-ready success, replay audit uniqueness, and current actor/run reauthorization. Disabling any supported workflow is not completed parity.

Import scope was narrowed after actual caller inspection: CEO safe import creates
a new target organization while its actor/run remain source-organization scoped.
Migrating that path needs constrained delegation semantics; ordinary target-org
authorization would regress it. Preserve the existing import lane now, without
inventing an authorization exception or silently falling back from Rust. Its
writer retirement remains a later explicit slice.

## Delivery coordination

The focused recovery review rejected publishing an incomplete intent directly
at its final pathname: a crash could permanently poison an otherwise valid key.
The repair must stage and sync complete contents, then publish atomically without
replacing an existing record. Incomplete staging files do not block retries;
an externally corrupted final record still fails closed. Use platform-correct
durability operations and verify Windows separately. Host integration must map
intent drift to HTTP 409. This is a stage finding, not final slice acceptance.

The helper repair subsequently received bounded static-review acceptance:
Unix stages/syncs then hard-links without replacement; Windows stages/syncs then
uses no-replace write-through publication. Twenty-three native unit tests passed
on the local host, including retryable incomplete staging and UUIDv5 identity.
Windows runtime and integrated HTTP/installed acceptance remain pending. Unix
staging entries are retained; automatic cleanup is not part of this slice.

The frozen Project DELETE candidate remains in PR235 and its own checkout.
This successor reuses the freed member-default checkout on
`codex/project-create-pilot-20260929`, based on the exact PR235 candidate above.
The unrelated untracked v18 packet remains untouched (SHA256
`5bf0c51a3c21ad69fcd7f465ed9af10bc62f5ae0148ead0e38295dc274827e13`).
PR235 is merged; this successor is the sole active publication candidate.
The successor was rebased onto actual merged Main `89859a26b` using the explicit
old-base boundary `0cd278728`. Only duplicated 0175 test expectations conflicted;
0175 and 0176 remain present, and all non-plan content matches checkpoint
`72b6e620e`. The resulting local checkpoint is `0b064066c`; it is not acceptance.
Do not modify PR235's runtime or use its acceptance as this slice's evidence.

Draft PR #236 now publishes source `606c729df` for early CI (matrix
`36505621311`, real-entry `36505621372`). Full stage review and author public
smoke run concurrently; neither draft publication nor green CI replaces frozen
installed verification and final review. PostgreSQL workflows remain serialized
in one local lane, while static review, fixture preparation and CI run in parallel.

The first real public create exposed a missing-instance-data assumption: the
private fixture precreated `instance/data`, but a fresh installed profile does
not. Rust now durably creates that single directory below the existing trusted
instance parent using the same platform-specific intent-directory publication
logic. It rejects an existing file, absent instance parent, or workspace-contained
state path without replacing user data. Twenty-five project unit cases pass;
the rebuilt binary passed full macOS public HTTP/CLI/MCP/restart/auth/outage
smoke and Delete regression. CI also caught one stale
startup capability expectation; adding `project_create` restored its exact local
black-box check. Windows CI additionally exposed CREATE_NEW returning access
denied for an existing README directory. Source `aef29616e` preserves that entry
only for Windows error 5 plus a confirmed existing directory; unrelated access
errors still propagate. Windows rerun is required. All failures remain in the
candidate evidence history.

Source `a683918a8` freezes two test corrections without changing runtime source:
MCP returns an intentional typed short reference, checked against its persisted
UUID/owner; the native failure fixture now uses an absent instance parent to
exercise genuine I/O 500. An absent data leaf is supported, and an existing
file root correctly returns invalid-input 422, so neither is an I/O-500 fixture.
The corrected actual-PostgreSQL black-box case passes, including SQL rollback,
no Project files and no invented instance parent. Stage implementation review
accepted and explicitly refreshed its initial file-root/500 description. The
independent installed verifier returned FAIL on packet v27.2: the normal CLI
tarball omitted its lazy worktree command module. The bounded repair explicitly
emits worktree and db-backup entry modules; focused build coverage exercises
their actual output, with a loader only for workspace TypeScript dependencies.
Installed acceptance must use normal published dependencies without that loader.
CI `36508241444` passes all four real-entry smokes; matrix `36508241419` passes
all other applicable jobs but fails the combined Intel log-store test timeout.
Its test-only split preserves assertions and adds proof of the intended fallback
error. No final acceptance yet; backend observations require equivalence binding
and affected CLI workflows require fresh installation and verification.

### Installed seed/merge authority finding

Independent v27.4 acceptance on `7a4d1120f` passed the repaired CLI loading,
interactive merge rollback and import, then failed public PATCH on the imported
Project with 409 because its target owner row was absent. Read-only inspection
found 15 triggers and 11 trigger functions in the source and zero in the cloned
target. The seed copied all 179 migration journal rows, so startup did not rerun
0174. Both database sessions used the normal replication role after restore.

Repair backup schema preservation, not the merge writer with a second owner-row
insertion. Preserve routine definitions, CHECK validation state and trigger
enablement; install triggers after restored data so ALWAYS triggers cannot
duplicate provisioning/audit side effects. A real PostgreSQL regression must
prove new Project provisioning and ownership/receipt guard rejection after
restore. Rebuild the affected DB package and repeat the normal installed seed,
merge and subsequent API mutation before accepting this slice. Existing user
databases and historical backup files are not modified by this repair.

## Bounded successor after this pilot merges

Default ordinary public/onboarding Project creation to required Rust, retaining
existing Node-owned rows and explicit import/atomic-merge lanes. Reuse the current
mode rather than adding a second create mode. The concrete changes are config
and bridge defaults, startup admission, keyless public PATCH/resource parity,
and installed-default workflow coverage. Do not start another publication
candidate before this pilot converges.

An inherited Project allowlist must not silently transfer existing rows when the
default changes. Require explicitly configured required mode for selected legacy
adoption; reject the ambiguous dormant-allowlist configuration. No schema change,
bulk backfill, or whole-creator retirement is implied. New Rust-created rows
already receive their owner/epoch atomically. Off/shadow retain Node creation;
existing Rust ownership remains fail closed and is never downgraded.

Preserve ordinary HTTP compatibility by generating one internal key per keyless
PATCH/resource invocation, while retaining explicit-key replay/conflict. Extend
the existing installed member-directory harness with mode/path/signer overrides
omitted, predecessor Node ownership preserved, HTTP/CLI/MCP/onboarding creation,
Library readiness, restart/replay, later mutation/delete and native outage.
Reuse scoped attempt counters for pre-write stale-writer rejection and the
public import/interactive merge fixtures. This can advance only the bounded
Project default path; organization deletion/root preparation and other writers
remain separate authorities.

Hilbert rejected the earlier prerequisite-heavy schedule, recommending reuse
of existing fences and a service-path pilot. Hilbert accepted the revised proposal
with implementation gates: name/URL-key Library paths cannot be exclusively bound
to one Project UUID, existing user content and same-name recreation must work,
and precommit retries cannot silently adopt a second resolved path. Resolve those details
before activating any create path; no default-path or retirement claim follows
from helper implementation. Preserve synchronous readiness and all existing
onboarding/import/merge behavior. All full-migration terminal claims stay false.
