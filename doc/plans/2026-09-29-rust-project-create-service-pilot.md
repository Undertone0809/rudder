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
  - 0cd278728871b78c27ffa3b9d6f5dab78a6b0b4c
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
Only two lanes are active: qualify/merge PR235 and prepare this successor.
Rebase this successor onto actual merged Main before candidate publication.
Do not modify PR235's runtime or use its acceptance as this slice's evidence.

Hilbert rejected the earlier prerequisite-heavy schedule, recommending reuse
of existing fences and a service-path pilot. Hilbert accepted the revised proposal
with implementation gates: name/URL-key Library paths cannot be exclusively bound
to one Project UUID, existing user content and same-name recreation must work,
and precommit retries cannot silently adopt a second resolved path. Resolve those details
before activating any create path; no default-path or retirement claim follows
from helper implementation. Preserve synchronous readiness and all existing
onboarding/import/merge behavior. All full-migration terminal claims stay false.
