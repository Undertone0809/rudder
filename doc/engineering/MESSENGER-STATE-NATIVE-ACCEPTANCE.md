# Messenger persistent-state native authority acceptance

## Candidate scope

Twelve public routes select Rust by default, including existing rows:

1. `GET /api/orgs/:orgId/messenger/saved-views`
2. `GET /api/orgs/:orgId/messenger/saved-views/:id`
3. `POST /api/orgs/:orgId/messenger/saved-views/keep`
4. `PATCH /api/orgs/:orgId/messenger/saved-views/:id`
5. `DELETE /api/orgs/:orgId/messenger/saved-views/:id`
6. `PATCH /api/orgs/:orgId/messenger/saved-views/reorder`
7. `POST /api/orgs/:orgId/messenger/groups`
8. `PATCH /api/orgs/:orgId/messenger/groups/:groupId`
9. `DELETE /api/orgs/:orgId/messenger/groups/:groupId`
10. `POST /api/orgs/:orgId/messenger/groups/:groupId/separate`
11. `DELETE /api/orgs/:orgId/messenger/groups/entries/:threadKey`
12. `POST /api/orgs/:orgId/messenger/threads/:threadKey/user-state`

The deprecated saved-view POST's existing 409 is excluded. Group listing,
assignment, group/entry reordering, merge, model title generation, thread
aggregation and thread-read advancement are excluded. No claim is made about
those endpoints or an overall migration percentage.

## Authority and concurrency boundary

- The only private ingress is signed POST `/internal/orgs/{org_id}/messenger-state`,
  action `messenger.state`, with a strict operation enum and closed input fields
- Node authenticates/authorizes the public caller and parses public parameters;
  the Rust principal is exclusively the verified envelope's user actor
- Actor, organization, method, path, action, bytes, request ID and nonce are
  bound by the existing envelope verifier; signed agent actors are rejected
- Rust owns SQL, target identity checks, pin limits, owner scoping, placement,
  hidden-row ordering, durable Keep receipts, audit data and transactions
- Every placement mutation acquires the existing owner advisory lock before
  sorted group locks. UUID lock components are lowercase in Rust and Node's
  shared helpers. Existing Node source-deletion cleanup, assignments and
  aggregate cleanup therefore retain the same concurrency contract
- Thread pinning is not a placement mutation and must not take that owner lock.
  Chat pinning takes a scoped `FOR KEY SHARE` parent-row lock before the user-state
  upsert. This preserves Node Chat deletion's parent/cascade-before-owner order,
  returns 404 if deletion commits first, and lets a later deletion cascade the
  state if pinning commits first
- Activity and event intent share the domain transaction. The existing
  `organization_mutation_outbox` publisher remains a Node transport adapter,
  with durable retry leases and dedupe keys. Group-removed activity preserves
  its legacy no-live-event behavior
- A native outage produces 503 with Node still responding; no migrated route
  calls its former Node business implementation as fallback

## Deliberate compatibility exception

The legacy pin path called `getById` before checking the conversation's
organization. Hydration could create a foreign-organization user-state row
before the request returned 404. The native path preserves the same 404 and
makes no foreign user-state, activity or outbox write. Its regression test
first demonstrates the former side effect, resets the fixture, then explicitly
asserts native rejection with unchanged state. This is not reported as full
state parity. The unmigrated thread-read route is outside this change.

## Automated acceptance matrix

`server/src/__tests__/messenger-state-rust.integration.test.ts` uses a freshly
initialized PostgreSQL database with all published migrations, real bearer actor
middleware and Express HTTP routes, a real child foundation executable, and the
signed bridge. No route/service/bridge/database mocks participate.

- Compare legacy responses and persistent state for scoped reads and writes
- Compare exact audit actions/details and event payloads, normalizing only
  generated row identifiers and verified recent mutation timestamps
- Restore raw PostgreSQL JSON between differential runs, preserving large
  numbers, overflow, null, Unicode, empty containers and 192-level legacy JSON
- Exercise all seven target kinds; group/loose/Chat/Issue placements; replay
  and conflicting request fingerprints; receipts surviving deletion
- Exercise hidden-row reserved ordering slots, omitted visible rows,
  pin/unpin, group removal/separation and empty-group cleanup
- Reject other organizations, other users, agents, anonymous users and forged
  body principals, including same-user multi-org and same-ID multi-user cases
- Observe competing PostgreSQL sessions blocked on the actual advisory lock;
  concurrently Keep/reorder; concurrently contend for the final primary-rail pin
- Use database-trigger gates and `pg_blocking_pids` to force real Node Chat
  deletion against public native pinning in both orders, with and without an
  existing user-state row. Assert two distinct competing sessions, the actual
  cascade/row-lock waits, bounded completion without deadlock/FK errors, and no
  surviving Chat, user state or group membership
- Inject failure on durable receipt insertion and assert rollback of saved view,
  anchor group, membership, activity and outbox with a successful later retry
- Stop/restart the outbox publisher; induce a publication failure and verify
  durable retry with the same dedupe key
- Keep public Node health live while the configured native executable is truly
  missing, asserting 503 and unchanged tables for all twelve migrated routes

## Reproduction

Use an isolated `RUDDER_HOME` before importing the server. Use a new Cargo
target directory for each worktree; sharing Cargo's registry is safe, sharing
cross-worktree compilation output is not. Build the current candidate and copy
its foundation executable to a candidate-specific path.

```sh
cargo test --locked --manifest-path native/Cargo.toml -p rudder-server-foundation-core
cargo clippy --locked --manifest-path native/Cargo.toml -p rudder-server-foundation-core --all-targets -- -D warnings
cargo test --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --test black_box health_readiness_capabilities_and_sigterm_are_observable
cargo build --locked --manifest-path native/Cargo.toml --bin rudder-server-foundation
RUDDER_HOME=/tmp/rudder-messenger-state-tests \
RUDDER_SERVER_FOUNDATION_PATH=/path/to/candidate/rudder-server-foundation \
pnpm exec vitest run --root server --config vitest.config.ts \
  src/services/messenger-state-bridge.test.ts \
  src/__tests__/messenger-routes.test.ts \
  src/__tests__/messenger-state-rust.integration.test.ts
```

PostgreSQL must be hydrated with its official package setup script when installed
with package scripts disabled. The test uses TCP and explicitly disables the
Unix socket directory; it never resets an existing Rudder instance.

Author checks are implementation evidence, not independent acceptance. Stage
review, exact-candidate black-box verification, final review and CI remain
separate gates before publication or completion claims.

## Initial author check receipt (2026-10-08; superseded for pin concurrency)

- Foundation core and binary `clippy --all-targets -- -D warnings`: passed
- Foundation core Rust tests: 59 passed
- Startup/health/readiness/capabilities/SIGTERM black-box test: passed
- Real PostgreSQL/public HTTP differential and adversarial suite: 47 passed,
  including the explicitly documented foreign-Chat isolation correction
- Route/schema unit tests: 9 passed; transport tests: 2 passed
- Server package TypeScript typecheck: passed
- Scoped import lint: passed; Git whitespace check: passed
- Architecture audit versus `b82f1b4488f027bbd3f61f3263b5fec3fcd8b841`:
  no comparison regressions; existing repository debt remains
- Initial independently rebuilt executable SHA-256:
  `f16972749aa75e726f80baadc286db67d0b01bb0a7ec6c05867a9b518cdb6495`
- Rebuild source commit: `480d1e1a26fb01b953d1d3573cc8c69e2f00f0fa`
- Rebuild source tree: `c58d77b213fd66aa1eb292c676a9c85b10411d85`
- New, worktree-private Cargo target: `rudder-messenger-target`; only the
  Cargo registry/toolchain were shared. Flags: `CARGO_PROFILE_DEV_DEBUG=0`,
  `CARGO_PROFILE_TEST_DEBUG=0`, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=2`.
  Debug assertions retained their normal profile defaults
- The new-target build repeated clippy, all 59 core tests, the lifecycle black
  box and all 58 JavaScript tests against the new executable. No build output
  from another worktree was reused

An earlier shared-target executable had SHA-256
`355d8b9393e8712e017f46c5563d16ec3fde29c458777d76f0c4d6b9162620eb` and
also passed its recorded matrix. Those are preliminary observations only; the
new-target executable above was the initial author-tested artifact, subsequently
rejected for pin concurrency. It is superseded by the corrected artifact below.

The final concurrency run also asserts that a mutation's `updated_at` is at or
after release of the contended owner lock. Native captures its mutation clock
after acquiring that lock; PostgreSQL transaction-start `now()` must not be used
for mutation timestamps after a wait.

Full-repository lint/typecheck/test/build, packaged Desktop verification, CI,
independent stage review, verifier acceptance and final review have not been
completed for this candidate. This receipt is a local implementation checkpoint,
not permission to publish, merge or deploy.


## Stage-review P1 correction

Stage review rejected the initial candidate's universal owner lock. Node Chat
removal deletes/cascades first and only then locks Messenger owners for group
cleanup. Native pinning held the owner lock before attempting a state upsert,
creating the opposite wait order.

The scoped fix excludes thread pinning from placement locking and takes an
organization-scoped Chat parent `FOR KEY SHARE` lock before the state upsert.
No Node deletion behavior, permissions, route inventory or Keep ordering changes.

Four deterministic real-database cases pause either the real Node deletion or
the real public native pin using database triggers. They confirm the first
session's advisory gate wait, actual cascade table locking, and a distinct
second session blocked by that first session's row lock. Existing and absent
user-state rows are tested in both interleavings. The rejected executable
`f16972749aa75e726f80baadc286db67d0b01bb0a7ec6c05867a9b518cdb6495`
failed all four: delete-first returned 500; pin-first exposed the reverse owner
advisory-lock wait. These are explicit regression observations, not passing
acceptance for that executable.

### Corrected artifact and author verification

- Frozen implementation commit: `53cbd264c46140237da2f5d90c26d3ead988bfd8`
- Frozen implementation tree: `b023b19b75cd1b14b751c02b4e11e1c1109f3778`
- Executable SHA-256:
  `261f1cf1f4a615bcf3c642f7e4b5c8fd013cc71d7d233c758c277e6fe9e8a610`
- Artifact is an independent mode-0555 copy in a hash-named directory, size
  36,734,896 bytes. All Cargo tests/clippy finished before the final ordinary
  `cargo build --bin rudder-server-foundation`; only then was the artifact copied
- The full HTTP matrix used that same copy. Later Cargo invocations cannot
  silently replace its tested bytes
- Worktree-private Cargo target, DEV_DEBUG=0, TEST_DEBUG=0, INCREMENTAL=0,
  JOBS=2; debug assertions remain at their profile defaults
- Core and binary all-targets clippy with `-D warnings`: passed
- Rust core: 59 passed; startup/health/readiness/capabilities/SIGTERM black box:
  1 passed
- Full real PostgreSQL/public HTTP suite: 51 passed, including all four forced
  Chat delete/pin races and the prior foreign-organization no-write regression
- Route tests: 9 passed; transport tests: 2 passed; total JavaScript: 62 passed
- Server TypeScript typecheck, scoped import lint and whitespace checks: passed

The receipt-only follow-up commit does not change production code or tests
relative to the frozen implementation commit. This addresses the author-side
P1 fix; independent stage re-review, verifier acceptance, final review, full
repository baseline and CI remain outstanding.
