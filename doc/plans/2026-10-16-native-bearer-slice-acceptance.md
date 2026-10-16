---
title: Native bearer member-directory acceptance
status: in_progress
kind: implementation
area: api
entities: [backend_authority, rust_migration]
date: 2026-10-16
issue:
related_plans: [2026-10-16-rudder-rust-backend-retirement.md]
supersedes: []
related_code: [native/crates/server-foundation]
commit_refs: []
updated_at: 2026-10-16
---

# Native bearer member-directory acceptance

This is one slice of the approved full Rust backend retirement plan, not completion of native authentication or backend retirement.

## Candidate

Base: `ae74493a38f9688980d9ff46d49fff1a32896eab`.
Branch: `codex/rust-backend-completion-20261016`.
Independent stage reviewer: `/root/auth_stage_review`, verdict `accept`, including the query-validation precedence correction.
Auth four-file ordered SHA-256 manifest digest: `d6e55ec130281de312f045032545df3f709ff5916d7ad37b4fa9547076c228e2`.
The verifier must additionally fingerprint the full source dependency closure and binary before/after acceptance. Unrelated migration-service changes do not alter this binary's dependency closure.

## Observable criteria

- Run the real Rust public listener and migrated disposable PostgreSQL fixture with the Node auth adapter unavailable. Use `GET /api/orgs/{org_id}/members/directory`.
- Active Board membership, instance admin and same-organization Agent keys produce the expected directory data.
- Unauthorized Board scope, cross-organization Agent scope and inconsistent Agent/key organization return 403.
- Revoked/expired Board keys, revoked/unknown `pcp_` keys and terminated/pending-approval Agents return 401.
- Invalid recognized credentials and database/auth failures never reach the Node adapter. Record listener/process and adapter-call observations.
- Malformed type, limit and cursor retain their error behavior.
- Coordinate committed key revocation/expiry, membership removal, admin removal and user deletion with an in-flight request; invalidated credentials or removed scope must not return directory data. Scope denial may still touch last-used when the key was valid at the touch.
- A controlled adapter separately proves cookies, local Agent JWTs and local implicit/trusted identity still use the explicit compatibility path.

## Lease and evidence

Record timestamp, source/build inputs, binary hash, process/listener identities, database version/name, fixture organizations, commands, observations and final identity recapture. Keep temporary fixtures and detailed evidence outside the repository. The verifier is independent and read-only with respect to implementation; only disposable fixture writes are permitted. Return PASS, FAIL or QUESTION. Author tests support but do not replace public-workflow evidence.

## Global scope still outstanding

Sessions, OAuth/device identity, other public domains, background ownership and default startup remain unfinished. No Node-retirement or production-deployment claim is made by this packet.

## Deliberate security compatibility correction

The legacy Agent-key middleware checked Agent existence/status but did not reject
an Agent key whose stored organization differed from the Agent's organization.
Rust rejects that inconsistent state with 403. The PostgreSQL author tests and
public-entry acceptance explicitly cover this case. This is a security
correction, not a behavior to preserve during compatibility migration.
