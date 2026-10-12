# Ordinary Run workspace updates

This is a partial Rust migration. Neither PATCH handler is fully migrated (0 of 2 aliases).

Both `/api/run-workspaces/:id` and `/api/execution-workspaces/:id` first use the existing strict shared Zod validator. Dispatch then depends only on the validated request body:

| Request | Mutation authority |
| --- | --- |
| `status` is exactly `archived` | Existing Node archive handler, including repeated archive requests |
| Every other valid body, including `{}` or a patch to an already archived row | Rust ordinary update authority |

The private action is `run_workspace.ordinary_update`, served at `/internal/run-workspace-ordinary-update`; the advertised capability is `run_workspace_ordinary_update`. The signed native endpoint rejects an `archived` status. A native outage returns 503 for an ordinary update and never invokes the Node mutation path. Explicit archive requests continue to select Node even during that outage.

Rust validates the ordinary input, looks up the target before checking organization access, and accepts Board users and same-organization Agents under the existing access contract. It updates only the ordinary fields and returns the existing Run workspace projection, including both derived-workspace aliases. The shared datetime grammar and JavaScript Date millisecond precision are retained.


Ordinary TEXT values use the same UTF-8 replacement of isolated UTF-16 surrogates as postgres.js. Metadata travels in a signed base64 JSON sidecar with an exact null placeholder, so invalid JSONB Unicode still reaches PostgreSQL only after target lookup and authorization. Valid metadata retains the existing JavaScript numeric normalization and literal object keys. Malformed sidecars and non-Unicode parser failures remain invalid private commands; no shared parser behavior changes. If the original metadata JSON.stringify itself raises RangeError, the adapter signs that exact encoding-failure fact with a null placeholder instead of serializing the deep object. Rust returns the legacy generic 500 only after target lookup and fresh authorization, preserving missing 404 and forbidden 403; the fact is strictly exclusive with the base64 sidecar and cannot cause a write. Other host failures are not classified as metadata serialization failures.

The public parser remains 10 MiB. Only this ordinary private action allows 80 MiB: JS numeric formatting expands at most 5.25 times (short tokens such as `1e20` are the maximum), followed by at most base64's 4/3 expansion. At the public maximum this is 73,400,320 bytes, plus 2 bytes of metadata-only base64 rounding, 6 × the current Node 16,384-byte header/URL budget, and 1,024 bytes of command framing: 73,499,650 bytes, below 80 MiB. This is a transport bound under the current Node configuration, not a heap-memory limit. Existing admission limits concurrent workers before reading request bodies. The focused probe sends a real public request whose signed form exceeds the old 20 MiB cap and checks both public and private over-limit rejection without mutations.

Two deliberate transaction changes apply to ordinary updates. The workspace update, `run_workspace.updated` activity, and durable live-event outbox commit together, so an audit or outbox failure rolls the update back. Authentication and organization access are checked after the workspace row lock and again after activity persistence, so a revoked or expired credential cannot survive a real database wait. Browser sessions are bound to the current session ID, user and expiry. Board keys, Agent keys, and Agent JWT expiry and signed organization/run context are checked against current authority. The existing local implicit Board exception remains exact.

The existing outbox publisher delivers `activity.logged`. Ordinary updates retain sorted `changedKeys`; the public route supplies no filesystem or process effects.

Archive behavior and its known lifecycle limitations remain owned by Node. This change adds no archive intent, artifact provenance, global lifecycle admission, schema migration, recovery field, maintenance command, or process/filesystem mechanism. A complete archive migration requires a separate reviewed implementation and evidence.

The author probe is `scripts/smoke/rust-workspace-ordinary-real-entry.ts`. It requires an explicit native binary hash and PostgreSQL 18.4, uses real public HTTP, BetterAuth cookies, signed Rust requests and temporary PostgreSQL data, and records every executed case and failure. A successful author probe is not independent acceptance; final evidence binds the reviewed source and immutable binary.

Set `RUDDER_LOG_DIR` to an owned temporary log directory before starting the probe or focused server tests; logger imports happen before the probe creates its fixture. The probe additionally requires `RUDDER_ORDINARY_BINARY`, `RUDDER_ORDINARY_BINARY_SHA256`, `RUDDER_ORDINARY_REPORT`, and `RUDDER_POSTGRES_BIN_DIR`. Run it with the repository's installed `tsx` entrypoint, under the same serialized heavy-check lease used for native builds and database tests.
