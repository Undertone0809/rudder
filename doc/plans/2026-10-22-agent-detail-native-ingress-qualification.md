---
title: Qualify Agent detail and move its public ingress to Rust
date: 2026-10-22
kind: fix-plan
status: in_progress
area: api
entities:
  - agent
  - backend_authority
  - rust_migration
issue:
related_plans:
  - 2026-10-16-rudder-rust-backend-retirement.md
supersedes: []
related_code:
  - native/crates/server-foundation/src/public_ingress/agent_core.rs
  - native/crates/d1-persistence/src/agent_core/instructions/mod.rs
  - server/src/routes/agents.core.ts
commit_refs: []
updated_at: 2026-10-22
---

## Problem and bounded outcome

The remaining Agent qualification debt includes historical managed recovery and
requests that wait on an Agent row lock after their JWT expires while crossing
the private Node bridge. Upstream PR #352, now on main at `b38b171364`, already
supplies the opaque external-root error repair and Claude history-path fix.
Those upstream outcomes are preserved rather than counted again as this change.

Move GET/HEAD `/api/agents/:id` and `/api/agents/me`, including casing and
trailing-slash aliases, directly into the Rust public adapter. Resolve trusted
host placement in Rust and revalidate the original credential after row locks,
before full or restricted projections can allocate workspace keys. Suppress the
corresponding private Node adapters in native mode; native dependency failure
must return 503 without Node business fallback. The production CLI continues to
reject missing native identity configuration before binding its public port.

Preserve reference lookup, query multiplicity, error precedence, redaction,
integrations, tool descriptors and HEAD representation lengths. External roots
remain opaque, including files and symlinks. Historical managed recovery
rejects symlink ancestors before writes, recovers contents larger than 1 MiB,
and preserves valid existing managed edits and aliases. The Claude Windows
history repair is already on the new base and has no diff in this candidate.

Compatibility deployments without the native public listener remain registered
debt. This slice does not complete authentication or backend retirement.

## Acceptance and exact candidate

The original API-only candidate `8873539ba` contained eight source/test files and
three documents. Its independent v3.1 acceptance returned PASS for 21
observations against source fingerprint
`1bca411f1f68dfec26940e8c197b3cbf0a15d4cf07b8f953055bb893cb1741ab`
and frozen foundation SHA
`c52e17449ffff8e22756f0d006ce495ec8934c60e755b5fea7aecbdca84a6ad3`.
The issuer subsequently verified exact content equivalence for that commit;
final review accepted draft publication only.

Before publication, main advanced to `b38b171364` through #352. The work branch
was pushed, but no PR was created. The rebase preserves upstream public-create
Profile-default coverage and its external-root regression alongside the native
credential lock-race and managed-recovery changes. Claude is already identical
on main, leaving seven changed source/test paths and three documents. The
remaining credential/recovery implementation matches the original source;
upstream Native Chat/create code and the combined test fixture have changed.

Old API PASS receipts remain historical. Rebuild the combined native artifact
and qualify affected public entry on the rebased source before final review.
Do not call the old binary a build of the new base. Desktop identity, first-run
startup and smoke fixture changes are preserved on a separate local WIP ref;
their QUESTION/FAIL receipts are not acceptance of this API candidate.

The rebased source fingerprint is
`31ee9f5d638ed951fcfacbf72ee3bbb97357dd4e9cc7ba3d01ed1b1f2daffcd6`.
The rebuilt foundation SHA is
`5d5c2ebca0ad9937995544462abf592606dccff1cbba05973c3f4872662f51a5`;
its process-host sibling is
`440fd409fb6ecd2eb9f63e010400275ebf41aa54132700411098576a09f97363`.
Author public-entry checks pass 44/44 with no skips in 101.713 seconds; full
repository typecheck passes in 43.491 seconds. Rust format and scoped all-target
clippy pass. Current full lint reports 22 unchanged files; neither modified
TypeScript file is among them. The current machine-readable v5 packet records
remaining targeted instruction, independent runtime and final-review gates;
old receipts are not substituted for those gates.

## Author checks and delivery gates

Before the rebase, native workspace checks passed 1110 tests with 79 ignored,
plus the added no-identity test. Public Agent coverage passed 42 cases; the
frozen v3 critical replay passed 3/3. Full typecheck/build passed. Repository
test coverage was composite: all 316 server files, eight package projects,
UI/CLI/Desktop/scripts passed after corrected runner-environment replays, not
one green full-test invocation. These are historical checks, not a claim that
the combined new base has been revalidated. Changed-file lint passed; full lint
retained 25 pre-existing import-order failures. Runtime packaging passed 18/18.

The rebased authority inventory check and ratchet against `b38b171364` pass.
Full Desktop verification remains failed; excluded Desktop supplement remains
QUESTION. Complete packaged validation, protected PR CI, Windows native CI and
final review continue to block merge and corresponding platform/product claims.
No merge, release, deployment, real-provider acceptance or whole-backend
completion is claimed.

Use one shared-baseline integration candidate. Bound long commands with owned
process groups and timeouts, isolate fixture paths, and reuse evidence only
for unchanged relevant content. Preserve prior FAIL/QUESTION receipts and
record base drift. Sustained throughput improvement requires delivered results,
not another process proposal.
