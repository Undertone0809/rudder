# Backend Architecture

This is the current contributor policy for backend implementation, ownership,
and migration acceptance. Implementation and tests describe what runs today;
this document defines where new work belongs and what evidence a completion
claim needs. Historical migration proposals and partial-slice receipts do not
supersede this policy.

## Rust Owns Backend Business Logic

All new backend features must be implemented directly in Rust in the `native/`
workspace, including native chat. Do not implement a feature in Node/TypeScript
first with a promise to port it later. Extract or extend a cohesive Rust crate
rather than adding the feature to a legacy Node service because it is nearby.

Backend business authority includes:

- Domain validation, authorization and organization-boundary decisions
- Query/filter/aggregation semantics and authoritative response projection
- State transitions, orchestration, scheduling, ordering, and cancellation
- Database writes, transactions, idempotency, ownership fences, and audit/effects
- Runtime/chat session state, event reduction, replay/deduplication, and terminal
  outcomes

TypeScript remains appropriate for React/UI presentation, frontend interaction
state, typed API clients, build/test tooling, and explicit transport adapters.
Client-side validation can improve UX but cannot replace authoritative backend
validation. An adapter may frame/serialize a protocol, manage a process or
connection, or relay typed requests and events. It must not decide domain state,
reimplement Rust results, query business data, or become a second writer.

Existing Node business handlers are migration debt. Fixing a legacy regression
may require a scoped compatibility repair, but does not authorize a new Node
feature or a second implementation of newly migrated behavior. Preserve the
existing schema/migration workflow while moving runtime authority; the presence
of TypeScript schema definitions or migration-generation tooling is not itself
Node runtime business authority. Coordinate data-model changes with
[Database](DATABASE.md) and [Developing](DEVELOPING.md).

## Target And Honest Coverage

The target is 100% of Rudder's first-party backend runtime authority implemented
in Rust: public APIs and streams, authentication, database migrations, workers,
CLI/MCP, startup, and recovery. An 80% threshold, selected domains, or a public Rust listener forwarding
to Node is not completion. Frontend TypeScript is outside this backend target.

Keep ingress/transport coverage separate from business-authority coverage:

- A Rust listener or proxy proves transport ownership only
- A private Rust helper proves only the delegated operation, not the surrounding
  public route's auth, decisions, state, persistence, or effects
- A public route is Rust-authoritative only when its backend business decisions
  and effects are Rust-owned end to end, including failure and recovery paths
- An unsupported handler that returns an error is not a migrated capability

For a route-level claim, derive a fresh inventory from the exact candidate's
public router registrations and mount paths. Record method plus normalized
public path, source locations, relevant auth/stream/upgrade/alias branches,
current business owner, and supporting tests. Reconcile wildcard or delegated
routers instead of silently dropping them. Keep unresolved and legacy entries
in the denominator. Date and bind counts to a source SHA; do not copy an older
route total or turn a historical count into a promised fixed denominator.

Report partial slices precisely. Native tests, route reachability, a forwarded
success, or a green architecture ratchet cannot establish full migration.

## Temporary Adapters And Legacy Boundaries

Before adding or changing a temporary adapter, record the boundary in the
feature's acceptance evidence or migration inventory. Keep one maintained entry
per boundary with:

- Public method/path or runtime operation, adapter source path, and Rust owner
- Exact remaining Node responsibilities and why that transport is still needed
- Whether any pre-existing Node business authority remains, explicitly marked
  as unmigrated debt and excluded from Rust-authoritative coverage
- Protocol, data/effect ownership, authentication context, and error mapping
- Responsible owner, removal/cutover criterion, and linked regression tests

This inventory is not an exception process for new Node business logic. New
features must keep business authority in Rust even when a transport adapter is
required. Do not hide a residual policy decision, session reducer, database
write, or fallback behind names such as bridge, gateway, adapter, or compatibility.

The two package-level Rust migration and PostgreSQL-owner process transports
require fixed path and source-hash admissions in the trusted checker. The
checker also pins the migration-preflight child-escalation timer to one source
hash, helper owner and signature. These allowances grant no Node SQL or
lifecycle policy authority. Deliver admission policy through its own protected
PR before adding those adapters: CI evaluates a candidate with the checker
from its comparison base, so a candidate cannot approve its own allowance.

The source-backed authority ratchet is lexical evidence, not a semantic proof:
it hashes runtime files and recognizes structural candidates, but cannot prove
the behavior of arbitrary call graphs. `reviewed_node_changes` records cover
only Node source changes against the current comparison base. Once those
source changes are already in that base, remove their records from the next
candidate; Git history retains the original review. Inventory generation
preserves review metadata and does not retire these records automatically.
New or modified Node sources still require fresh, matching base/head hashes
and boundary review. Do not remove persistent `reviewed_transport_admissions`
records while their exact admitted mounts remain present.

The managed MCP runtime negative-fence admission replaces one existing
`managedMcpConnectionRoutes` mount with the same arguments plus
`nativeRuntime: Boolean(opts.rustPublicIngress?.identityAuth)`. The checker pins
the complete cutover caller and connection-router module hashes, its original
options, order, import and Rust owner. Only that caller may use the replacement
as the existing Goal router's preceding anchor; the main anchor remains valid.
Long inventory expressions match their full content hash, never a display
prefix. A matching reviewed transport record and current base/head Node review
are still required. This admits removal of the Node MCP runtime handler only;
connection management, OAuth management and their legacy business logic remain
visible migration debt. It does not establish backend completion or allow a
Node fallback when the Rust runtime fails.

The trusted-base checker pins two
separate middleware admission capabilities: the exact Rust-signed native-session
proof mount and the exact Rust-signed native-identity proof mount. Each
capability pins its verifier module hash; the identity capability also pins the
full caller-file hash. The candidate inventory must bind the exact caller file
hash, factory options, import, receiver, guard, position after reserved
workspace-preview handling and before body parsing, Rust proof owner,
retirement criterion, and reviewer reference. Each mount remains visible in the
structural inventory and comparison output.

The identity-proof caller pin retains the current-main source hash and permits
one separately pinned future caller hash for the email-auth cutover. That
conditional hash admits exactly one additional single-argument `app.use`
middleware: the Rust-mode negative fence for the fixed email sign-up, sign-in,
and sign-out paths, before the Better Auth wildcard. The fence must use the
exact reviewed middleware signature and Rust-ingress guard. A candidate still
needs matching base/head `reviewed_node_changes` evidence; inventory metadata
cannot create or widen this static checker allowance. No general middleware or
Node auth-handler exception is implied, and the current-main source pin remains
valid until the cutover candidate is based on it.

The session adapter verifies the Rust assertion's method, target, signature,
and freshness; consumes a bounded in-memory nonce; binds its session identity
to the request; strips the proof header; rejects unsupported methods for the
native get-session path; and preserves its explicit Bearer and Node-owned
lifecycle pass-throughs. The identity adapter verifies the pinned Rust
identity-envelope proof at the fixed private ingress and binds its signed
identity envelope to the request. This transport capability does not authorize
the Node actor consumer, permission lookups, route decisions, or any other
identity business logic; those remain separately visible migration debt.
Neither capability permits adding or changing route registrations, database
access, writers, timers, listeners, or other runtime surfaces. The checker
cannot establish that either adapter has no indirect semantic effect, so
reviewers must inspect the pinned source and surrounding call graph. These
records do not claim that Node session or business authorization is migrated.

Rust failure must be visible through the documented public error contract.
Missing binaries, unavailable native processes, timeouts, malformed responses,
and rejected operations must not quietly invoke a Node implementation, report
success, or create a second effect. Explicitly test applicable failures. Legacy
pilot switches and rollback paths must not enable a Node implementation of a
new feature or make a migrated route's completion claim conditional on hidden
fallback behavior.

## Native Chat Example

For native chat, Rust must own the conversation/turn lifecycle, runtime-to-durable
identity mapping, ordered event reduction, replay/deduplication, and authoritative
completed/failed/cancelled state. An interim assistant message or tool event
must not be promoted to final completion by a Node adapter. Reconnect, cancel,
and late/duplicate events must preserve that authority. TypeScript can render
or transport Rust's results; it cannot run a parallel lifecycle state machine.

Acceptance needs the public chat journey, persisted/read-back terminal state,
and representative interrupted or repeated flows. Include ordering, stale or
replayed events, cancellation racing completion, and a native error with no
hidden Node fallback where those risks apply. These are requirements for a new
implementation, not a claim that the current chat runtime already satisfies them.

## Testing And Evidence

Use the repository's proportional checks and independent review rules in
[AGENTS.md](../../AGENTS.md#7-verification-before-hand-off). For backend work:

Before expensive builds and qualification, run the cheap source comparisons
against a freshly fetched base:

```sh
node scripts/architecture-audit.mjs --baseline scripts/architecture-audit-baseline.json --compare-ref origin/main --fail-on-regression
node scripts/rust-backend-authority-inventory.mjs check
node scripts/rust-backend-authority-inventory.mjs compare --compare-ref origin/main
```

Both architecture size limits and backend-authority boundaries apply to
compatibility route changes. Resolve their regressions before starting the
full platform matrix.

1. Run affected Rust unit/integration tests for business rules and contract
   tests across the transport boundary. Keep UI/client contracts synchronized.
2. Exercise the real public method/path or workflow through the actual Rust
   implementation, with real PostgreSQL when persistence is part of the claim.
   Verify response, durable readback, and activity/outbox or external effects as
   applicable, including organization/permission denial and relevant replay,
   conflict, race, rollback, or restart cases.
3. Disable or fail the relevant Rust dependency in a disposable environment.
   Observe the documented public error and assert that Node business handlers
   were not invoked and no unintended writes/effects occurred. Where a Node
   transport is still required, keep it running and prove only its allowed
   transport responsibilities were used; removing all Node processes is not a
   substitute for checking the business-authority boundary.
4. Add/update the primary E2E workflow and its highest-risk adjacent state.
   Explain a concrete automation limit and the closest regression evidence
   rather than replacing the public workflow with mocks or a private helper.
5. Record candidate SHA/diff, build/runtime and data identity, commands, observed
   results, route/boundary inventory, and evidence limits. Apply independent
   reviewer/verifier gates when required by AGENTS section 9.1.

For changes to Rust backend code, the native verification baseline is:

```sh
cargo fmt --manifest-path native/Cargo.toml --all --check
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path native/Cargo.toml --all-targets --no-fail-fast -- --test-threads=1
```

Run the applicable repository baseline and public workflow checks as well;
these Cargo commands do not prove entrypoint wiring or replace real acceptance.
Report checks that were not run and why. Artifact-only policy changes need
links, diff/consistency checks, and representative instruction scenarios, not
a fabricated runtime acceptance claim.

## Review And Completion Gates

A backend feature is ready only when new business authority is Rust-owned,
adapter responsibilities are explicit, contracts and tests agree, and applicable
public workflow/error/no-fallback evidence passes for the same candidate.
Reviewers trace authority in source; verifiers observe the named public behavior.
Neither role can upgrade missing evidence into a pass.

Full backend migration additionally requires the complete current public API
inventory to be Rust-authoritative with no unresolved/legacy business handlers,
no hidden Node business fallback, and evidence for the default supported entry
and affected installed/packaged flows. Inventory every residual adapter or Node
process by its non-business responsibility. A scoped feature can be complete
while global migration remains incomplete; say both explicitly. Release readiness
and production verification remain separate claims needing their own evidence
and authorization.

## Final Node Backend Retirement

Temporary TypeScript transports are migration scaffolding, not retained backend
runtimes. The terminal product must start and complete its workflows without
the Node backend package, private auth adapter, HTTP/WebSocket proxy, migration
runner, scheduler, or JavaScript first-party CLI/MCP service. Electron remains
a shell and renderer host; it must delegate backend decisions to Rust. Frontend,
build/test tooling, bounded download/verification launchers, and user-selected
external provider CLIs/MCPs remain allowed.

Retirement acceptance removes the legacy backend artifacts from a disposable
installation, then exercises authentication, persisted business workflows,
streaming, CLI/MCP, upgrade, restart, and recovery. Record listeners and process
ancestry, distinguish allowed external tools from Rudder-owned services, and
prove native failure cannot start a hidden legacy backend. Preserve user data,
existing migration history, credentials, and public contracts. Database recovery
must use a verified recovery point; never reset an existing profile to pass.
