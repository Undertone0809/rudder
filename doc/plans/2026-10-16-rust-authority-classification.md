---
title: Semantic classification of Rust migration authority gaps
date: 2026-10-16
kind: advisory
status: in_progress
area: api
entities:
  - backend_authority
  - rust_migration
  - runtime_lifecycle
issue:
related_plans:
  - 2026-09-21-rudder-full-rust-backend-completion-plan.md
  - 2026-10-16-rudder-rust-backend-retirement.md
supersedes: []
related_code:
  - doc/plans/2026-10-16-rudder-rust-backend-authority-inventory.json
  - server/src/bootstrap/create-http-app.ts
  - server/src/middleware/auth.ts
  - server/src/services/messenger.ts
  - server/src/routes/access.ts
  - native/crates/server-foundation
  - native/crates/migration-service
commit_refs: []
updated_at: 2026-10-16
---

# Purpose and method

This note records a source-level semantic reading of the ten entries in
`2026-10-16-rudder-rust-backend-authority-inventory.json`, then maps the largest
remaining Node authority families to the approved full-migration plan. It does
not edit that generated inventory, add scanner annotations, approve an
exception, or claim any capability migrated. The frozen JSON still has
`completion_gate.blocked: true`, `blocking_unknown_count: 10`, and 789 remaining
backend Node source files. These are structural debt signals, not route totals
or a completion percentage.

The scanner marks syntax that it cannot classify safely. Reading the source can
show that an expression is statically constrained while its enclosing
capability remains Node-authoritative. This note is a review aid only: the ten
lexical unknowns remain unknown in the machine inventory until its annotations
are separately reviewed and changed through the owned scanner workflow.

# The ten lexical unknowns

| Inventory location | What the source does | Current authority and Rust owner | Retirement evidence |
| --- | --- | --- | --- |
| `cli/src/commands/client/browser.ts:89` | A command loop iterates the literal action list `back`, `forward`, `reload`, then relays the selected action through `runBrowserAction`. The name `action` is not an open-ended command registration source. | The CLI surface is statically enumerated, but execution and browser state still cross the Node API. Node `server/src/routes/browser.ts` validates the `BROWSER_ACTIONS` allowlist and input schema, logs activity, and forwards to the browser registry. The target owner is a Rust browser orchestration/runtime capability plus the first-party native CLI/MCP dispatcher. | Exercise each action and invalid action through the supported native CLI/public contract; verify run, tab and organization scope, errors, logging/effects, and browser-runtime failure behavior. Remove the Node browser route/forwarder and CLI dependency on it. |
| `cli/src/commands/client/browser.ts:144` | The second command loop iterates a literal list of browser inspection/control actions (`snapshot`, `locator`, `cua`, `dom-cua`, `dialog`, `logs`, `download`, `assets`, `content`, `wait`); it normalizes `dom-cua` to the API spelling before calling the same relay. | Same Node browser route and registry remain authoritative for these operations. Existing `native/crates/cli-mcp-contract-core` is protocol/contract support, not a browser-action executor. The Rust owner must own action semantics and runtime dispatch; it may use an external browser process as an explicitly external dependency. | Cover every action's schema, access boundary, relevant side effect and failure path through the native entrypoint. Retire the Node route/registry and relay only after no action depends on Node behavior. |
| `server/src/services/messenger.ts:1197` | Calls `issueEntryRowsQuery` with a tagged SQL fragment restricting the issue id to a single result. | This is a fixed, parameterized SQL composition, not arbitrary SQL supplied by a caller. It still executes a Node-owned Messenger/Issue projection. The helper builds the `tracked_issue_ids` visibility set, joins issue activity/comment/project/active-run state, and derives viewer-specific preview and ordering. Rust has adjacent `issue_metadata_reads` and `messenger_state` modules, but no equivalent for this read projection. Intended owner: SQLx-backed Issue/Messenger read service in `server-foundation`/`d1-persistence`. | Differentially verify authorized and hidden issue visibility, per-viewer activity, preview projection, ordering and empty/missing issue behavior through the Rust public route. Remove the Node helper only after all callers use the Rust projection. |
| `server/src/services/messenger.ts:2209` | Calls the same helper with a fixed `ORDER BY latestActivityAt DESC, id ASC LIMIT 1` fragment to select the latest display entry. | Node currently owns this projection and its ordering semantics. The tagged fragment is internally constructed; the scanner cannot infer that from `db.execute`. Rust owner is the same Issue/Messenger read service, including stable tie-breaking. | Compare legacy/Rust results for equal activity timestamps, empty lists, hidden issues and organization isolation; then remove the Node selector and helper use. |
| `server/src/services/messenger.ts:2243` | Calls the helper with an internally assembled cursor predicate over `latestActivityAt` and `id`, plus a bounded `limit + 1`. User values are bound as SQL parameters. | This is a parameterized cursor query, not dynamic caller SQL. Node still owns cursor interpretation, visible-row filtering, ordering and page boundary behavior. Rust owner is the same read service, with cursor validation and response projection kept at the authoritative boundary. | Verify first/next/terminal pages, equal timestamps, malformed and stale cursors, hidden rows, and page-size limits through the public Rust endpoint. Remove this Node query path once parity and no-fallback behavior pass. |
| `server/src/bootstrap/create-http-app.ts:219` | In static UI mode, after mounting built UI assets, the wildcard GET responds with the already-loaded `index.html` for SPA navigation. An earlier `/api` 404 prevents this fallback from swallowing unknown API paths. | This is frontend presentation fallback, not backend business authority. Its current Node host is retained only as a presentation/development convenience. The allowed owner is the frontend/static hosting layer or an equivalent Rust static-file serving path; React remains an explicit retained exception. | Preserve deep-link SPA navigation, static assets and API 404 behavior on the supported product entrypoint. No API handler or state decision may move into the wildcard. |
| `server/src/bootstrap/create-http-app.ts:251` | In Vite development mode, the same wildcard serves Vite-transformed `index.html` after Vite middleware. | Development frontend tooling only. Vite/React presentation can remain JavaScript; this does not migrate or define a backend capability. | Keep development deep links working if the Vite host changes. This entry is not grounds to count a Rust backend route or mark a Node business capability retired. |
| `server/src/bootstrap/create-http-app.ts:142` | Mounts `privateHostnameGuard` before actor authentication. In authenticated/private mode it selects the first `x-forwarded-host` value when present, otherwise `Host`; it normalizes the hostname and accepts configured names, the bind host, and loopback names. Missing or disallowed hosts receive 403. | This is an ingress security decision. Rust `PublicIngressRuntime` currently binds an optional Actix listener and proxies most requests; its forwarding policy has no matching private-host allow-set gate. Intended owner: Rust public ingress configuration and request gate, before auth and proxy routing. | Test authenticated/private and other deployment modes, configured/bind/loopback hosts, missing Host, malformed values, spoofed and trusted forwarded-host behavior, and JSON/text errors through the supported ingress. Define proxy trust explicitly; remove Node guard only when the Rust gate is the sole effective policy. |
| `server/src/bootstrap/create-http-app.ts:149` | Mounts `actorMiddleware`. It supports local implicit Board identity, Better Auth cookie sessions, Board API keys, Agent API keys, local Agent JWTs, and request/run context checks; it also resolves current admin and organization membership state. `accountSessionRequired` and the session route follow this middleware. | This is the main Node actor-resolution authority. Rust `auth-core` verifies signed actor envelopes and related request context; `native_bearer_auth.rs` recognizes persisted `pcp_` Board/Agent keys for the member-directory route only. The public-ingress startup receipt explicitly leaves cookies, local Agent JWTs, local-trusted/implicit identities and other bearer credentials on the private Node compatibility adapter. Intended owner: native identity/session and credential resolution, using `auth-core` for authenticated internal envelopes. | Migrate each credential form and session/actor binding with revocation, expiry, organization/admin scope, run-context and local/offline compatibility tests. Prove recognized invalid credentials fail closed and Node auth is not called on Rust-owned paths. Remove middleware/adapters only when no public route depends on them. |
| `server/src/bootstrap/register-api-routes.ts:139` | Registers the `accessRoutes` router factory under `/api`; the factory contains many concrete routes rather than one opaque dynamic endpoint. It handles Board claim, CLI auth challenges, skill reads, invite/onboarding/acceptance, join requests, member permissions, organization access and instance-admin changes. Several handlers issue/revoke credentials, mutate memberships or grants, and write activity. | This is a collection of Node identity, access-control, organization and skill-read authorities. No single Rust handler is an equivalent. Intended ownership is split across native auth/session, organization/access domain services and a Rust skill-read surface where applicable. | Inventory and migrate each method/path as an individual boundary with its auth/admin/org checks, transaction, one-writer rule, audit/effects and public errors. Retire each Node handler only after public parity, cross-org denial and mutation/replay tests pass; removing the router mount alone is not migration. |

## Reading these classifications correctly

The two browser entries are statically constrained registrations, the three
Messenger entries are internally tagged SQL fragments, and the two wildcard
entries are presentation fallbacks. Those semantic findings reduce ambiguity
for a human; they do not establish Rust ownership. The remaining hostname,
actor-auth and access-router entries are direct Node authority. All ten remain
in the scanner's unknown set until a separate reviewed scanner change records
any improved lexical classifications. No route-count or unknown-count change
can substitute for business-authority review.

# Authority gap map against the approved full plan

This map follows the plan's phases and mandatory capability classes. It starts
at the current native public ingress and follows each path to its actual state
and lifecycle owner.

| Capability family | Current native entry and Rust ownership | Remaining Node authority and gap |
| --- | --- | --- |
| Public HTTP, WebSocket and hostname ingress (plan phases 1-2, 6-7) | `PublicIngressRuntime` exposes health/readiness, one direct member-directory route, and static `/llms/...` documents. A default handler forwards the other HTTP paths and WebSocket upgrades to Node. The listener is opt-in in `rudder-server-foundation`; it is not the default sole product listener. | Express still registers the product routers, handles hostname and actor middleware, and owns all non-migrated route behavior. WebSocket framing can be transported by Rust while chat/agent stream decisions remain in Node. Need complete method/path inventory and per-route auth, stream, alias, effect and retirement evidence before public cutover. |
| Organization, Goal, Project and general domain reads/writes (phases 2-4) | Rust foundation already contains selected SQLx-backed reads and bounded mutation pilots, including organization catalog, Goal/Project, run, backup, and member-directory slices. The Rust code is the owner only for the exact wired operation and scope documented by its acceptance evidence. | Node routes/services remain for the wider domain surface, including validation, reference resolution, mutations, transactions, activity/effects, and legacy writers. A migrated read/helper or a private Rust mutation bridge does not retire its public Node route or other writers. |
| Issue, routing, governance, review, budget and Messenger (phase 4) | Rust has issue metadata/live-run reads and Messenger state operations. These are useful modules but do not supply the Node `issueEntryRowsQuery` projection or all issue workflow semantics. | Node Issue and Messenger services continue to own visible-row rules, issue transitions, assignment/routing, approval/review, budgets, activity, and query projection not covered by named Rust slices. Need one ledger row per route/transaction/effect, then migrate cohesive public workflows with org/permission, ordering, idempotency and recovery evidence. |
| Runs, execution, Chat, Side Chat, Automation, workers and providers (phase 5) | Rust runtime and payload/evidence crates provide components and contracts; selected run reads are wired through Rust. Components do not prove that Rust owns a complete scheduler, worker lease, conversation lifecycle or terminal state. | Node runtime-kernel/heartbeat, chat background ownership, provider integration and worker/scheduler paths continue to own state machines, retries, cancellation, recovery and process coordination. Migrate durable lifecycle units and prove race, replay, cancellation, restart and single-writer behavior through public workflows. |
| First-party CLI/MCP and browser actions (phase 5-7) | `cli-mcp-contract-core` owns protocol/contract support. `rudder-native` provides native utility operations for files, archives and evidence; it is not the general product CLI/MCP backend. Browser CLI actions are statically listed but relay to Node. | Node/TypeScript CLI, MCP services and browser routes remain executable authorities. Build native dispatch against the public contracts, migrate domain semantics and effects, then remove the Node service and relay. Static action count alone does not show action semantics have moved. |
| Identity, sessions, device/OAuth and access (phase 6) | `auth-core` provides signed-envelope verification; `native_bearer_auth.rs` resolves recognized `pcp_` Board/Agent keys for the member-directory path. | Better Auth session/cookie resolution, local identity and Agent JWT handling, Board actor membership/admin scopes, access routes and credential issuance/revocation remain Node-owned. The member-directory acceptance explicitly excludes these paths. Migrate credential families and access capabilities incrementally; no public cutover may assume a bearer-only resolver is full auth. |
| Database migrations, embedded PostgreSQL, startup and recovery (phases 6-7) | `migration-service` plus `migration-apply` is an explicit opt-in Rust writer, sharing the advisory lock and SQL history. Author tests cover real source upgrade and dump/restore behavior; independent operator acceptance returned PASS and final review ACCEPT for the frozen opt-in slice. | `server/src/index.ts` still owns default `ensureMigrations` behavior, legacy journal repair, pre-migration backup/invariant sequencing and embedded PostgreSQL start/stop. Rust database migration authority is not the same as Rust database process lifecycle or default startup. Electron and frontend presentation may remain; Node product backend startup/migration ownership may not. |

The approved plan's exit remains the controlling standard: no unresolved or
legacy state-owning handler/process, no hidden Node business fallback, and
default supported workflows must run on the accepted Rust authorities. The
current ingress proxy is transport evidence only. The current source-derived
inventory remains the measurable baseline; this table is explanatory and does
not alter its counts.

# Recommended next bounded native slices

## Auth/session: native Board session inspection

After the accepted member-directory bearer slice, implement one bounded
cookie-session path: `GET /api/auth/get-session`. The Rust slice should
resolve the supported Better Auth cookie against the existing `session` and
`user` records, honor session expiry/revocation, and serve the route directly
from the native public entry. Preserve this route's actual response contract:
it returns a Rudder synthetic session id derived from actor source and user id,
plus the limited user projection, rather than exposing the Better Auth session
id. Keep all other cookie-authenticated routes, local Agent JWT, device/OAuth
flows and access mutations explicitly on their current private compatibility
path; this slice must not be presented as general native auth.

A follow-up read of the installed Better Auth 1.6.23 implementation found that
this is not a read-only operation: the current internal getSession call renews
session expiry/updatedAt after the default 24-hour updateAge and deletes expired
rows. Its generated Set-Cookie headers are currently discarded by Rudder's
resolver. Preserve those persistence effects or document an explicit correction;
a database-only reader would not satisfy compatibility. The local-account
resolver instead checks a fixed 30-day session with a separate Desktop-generated
secret and no renewal. Configuration must distinguish these credential modes,
secure cookie names and dont_remember behavior. Bearer precedence must not become
a cookie fallback. Any new externally visible cookie renewal requires explicit
compatibility-correction coverage rather than an accidental response change.

Acceptance should compare active, expired, revoked, missing and malformed
cookies against the established response contract; include user deletion and
session revocation during request races; assert no session read is delegated to
Node for this direct route; and show native/database failures return errors
without falling back. The retirement criterion for this slice is removal of
the Node session read for this route only. Actor middleware remains Node-owned
for every other route until its own credential-family boundaries migrate.

## Lifecycle: native migration before listener bind for one explicit mode

The repaired opt-in `migration-apply` operator passed independent acceptance
and final review. Next wire that same writer into one explicit native
startup mode for an externally managed PostgreSQL database: apply/validate
migrations before the native listener becomes ready, and fail startup closed on
missing migration support, lock/backup/apply failure, or post-migration
invariant failure. The Node API may remain temporarily as a private route
adapter, but it must skip migration ownership in this mode; verify there is
exactly one migration writer and no Node retry/fallback.

Keep embedded PostgreSQL process ownership, historical journal repair policy,
desktop packaged default cutover and full Node process retirement outside this
slice. Verify an empty database and a legacy upgrade in disposable PostgreSQL,
including a pending append-only migration, backup/restore, lock contention and
failure before listener bind. Its retirement criterion is removal of Node
`ensureMigrations` from this explicit startup mode; global lifecycle retirement
still requires the separate embedded-database, recovery, packaged-startup and
default-path gates in the approved plan.

These are proposed next slices, not authorization to mark either capability
complete. The current member-directory public-entry and migration-operator
acceptance packets remain the sources of truth for their exact candidates and
verdicts.

## Ratchet governance boundary

CI validates source hashes and reviewed-boundary record structure using the
trusted base checker. A `review_status: reviewed` field is not an authenticated
reviewer attestation. The current repository ruleset has no required approving
review count, so independent review remains a separately enforced delivery gate;
the scanner alone does not prove it occurred. The current transport exception
has independent acceptance and final reviewer evidence linked in the delivery
record. New Node authority remains prohibited even when a metadata record is
syntactically valid; semantic review is required for compatibility exceptions.
