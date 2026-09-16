# Private bearer authentication boundary

This crate is a candidate Rust replacement for the **bearer-only** portion of
`server/src/middleware/auth.ts`. It is not wired into the production listener.
Node still owns production authentication, sessions/OAuth, implicit local-board
mode and every existing public route. No schema or migration ownership changes.

The primary implementation thread completed the missing middleware and tests
from the incomplete delivery in PR comment `5702026080`. That comment's actual
`lib.rs` bytes did not match its declared Git blob and it did not include the
referenced middleware/test files. This implementation does not inherit its test
or acceptance claims; its own source tree must be qualified.

## Contract

Board API keys are resolved before Agent keys. Board identity includes the
current user, active memberships, instance-admin role and key identifier.
Agent keys recheck same-organization Agent identity, status and revocation while
holding transaction-connected locks. Ambiguous duplicate keys fail closed.
Local-Agent JWTs use explicitly supplied HS256 configuration and the existing
Node claims semantics. There is no built-in secret or default administrator.

`BearerAuth` only inserts a `TrustedActor` produced by database/cryptographic
verification. The actor's representation is private and not deserializable.
Routes still require an appropriate extractor and organization check. Missing
credentials are not authenticated. Session/OAuth is not silently substituted.
Signed run mismatch and mutating CLI Agent-context errors preserve Node status,
code and details. Database failures return an error rather than an anonymous
fallback. Debug formatting redacts the JWT signing key.

This is request-time authentication. Business mutations must independently
recheck current authorization where required inside their write transaction.
A successful read of an actor is not a long-lived capability or an ownership
lease. No private compatibility bridge or public cutover is authorized by this
crate's existence.

## Qualification

Run with disposable PostgreSQL and Node capable of loading TypeScript:

```sh
cargo fmt --manifest-path native/Cargo.toml --all -- --check
cargo clippy --manifest-path native/Cargo.toml --locked --workspace --all-targets -- -D warnings
cargo test --manifest-path native/Cargo.toml --locked -p rudder-bearer-auth-service -- --test-threads=1
cargo test --manifest-path native/Cargo.toml --locked --workspace -- --test-threads=1
```

The tests use the actual migration journal and existing Node JWT signer, not
production data. They cover revocation races, current memberships/admin roles,
status changes, duplicate/corrupt keys, restart, signed metadata, cross-org
requests, exact context errors, malformed headers and database unavailability.
Hosted qualification is not independent reviewer/verifier acceptance and does
not establish full session/OAuth parity or final migration completion.
