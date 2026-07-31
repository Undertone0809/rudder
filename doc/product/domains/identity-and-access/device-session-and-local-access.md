---
title: Identity Device Session And Local Access
domain: identity-and-access
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - IDENTITY.DEVICE.SESSION.001
  - IDENTITY.SERVER.EXCHANGE.001
  - IDENTITY.LOCAL.OFFLINE.001
related_code:
  - identity/src/handler.ts
  - packages/identity-db/src/desktop-authorization.ts
  - packages/identity-db/src/device-authorization.ts
  - packages/identity-db/src/server-exchange.ts
  - desktop/src/identity-client.ts
  - desktop/src/identity-device-authorization.ts
  - desktop/src/identity-credential-vault.ts
  - desktop/src/identity-offline-grant.ts
  - server/src/services/local-account-auth.ts
  - server/src/routes/local-account-auth.ts
related_tests:
  - identity/src/identity.e2e.test.ts
  - packages/identity-db/src/device-authorization.test.ts
  - desktop/src/identity-client.test.ts
  - desktop/src/identity-device-authorization.test.ts
  - desktop/src/identity-credential-vault.test.ts
  - desktop/src/identity-offline-grant.test.ts
  - server/src/__tests__/local-account-auth.test.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-29-rudder-account-production-login.md
edit_policy: user_confirmed_only
---

# Identity Device Session And Local Access

## IDENTITY.DEVICE.SESSION.001

### Contract Summary

Supabase web sessions, Rudder Desktop device sessions, and Local Server
sessions are separate credentials with separate audiences and revocation
semantics. Desktop authorization uses Rudder-owned PKCE or Device Authorization.

### Intent / User Job

An operator can connect and revoke a Desktop without giving it a browser refresh
token or provider credential, and can understand which access a security action
actually ends.

### Why / Design Reasoning

Browser authentication proves the account; it is not a portable Desktop token.
Separating credentials limits replay and lets device revocation remain a Rudder
control even though Supabase owns the root web session.

### Actors / Objects / State

- Browser session, Desktop installation, Identity device, authorization code,
  PKCE verifier/challenge, device refresh credential, OS vault, and Local
  session.
- States: pending, approved, exchanged, active, rotated, revoked, and expired.

### Entry Points / Inputs

- System-browser Desktop sign-in, loopback callback, Device Authorization,
  refresh, device list/revoke, Desktop sign-out, and account-wide sign-out.

### Product Logic Flow

1. Provider OAuth completes only at Supabase/Rudder Identity.
2. After a verified web session, Identity issues a different short-lived,
   single-use Rudder authorization code bound to Desktop PKCE and installation.
3. Device Authorization uses the same account/device boundary for fallback.
4. Desktop stores only Rudder device credentials in secure OS storage and gives
   the renderer a bounded account/device summary.
5. Refresh credentials rotate; replay or revocation ends future cloud access.
   Local sessions end at expiry or their next revocation/epoch synchronization.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| PKCE success | Verified browser session and matching verifier | Register/refresh one Desktop device | Treat Supabase code as Desktop code | Identity E2E |
| Device revoke | Authenticated owner selects a device | Revoke its Rudder credential and audit | Claim unrelated device | DB/E2E tests |
| Insecure vault | Durable encryption unavailable | Memory-only/online-safe behavior | Write credential plaintext | Vault tests |
| Renderer request | Current privileged main frame | Return bounded summary/action | Expose refresh/provider token | IPC tests |

### Actor-Visible Input

The operator sees system-browser login or a verification URL/code, device
status, and explicit revoke/sign-out actions.

### Operator-Visible Output

Desktop reports signed-in account and device state without exposing secret
material, and describes delayed Local-session revocation honestly.

### Persisted Evidence

Identity stores device, hashed refresh credential, rotation, revocation, and
security-event records. Desktop stores encrypted credential material in the OS
vault; renderer-visible state contains no secret.

### Canonical Scenarios

1. Browser sign-in completes a second PKCE exchange into a Desktop device.
2. Device Authorization approves the same bounded device credential.
3. Revoking a device blocks its next refresh without deleting Local files.

### Invariants / Non-Goals

- Desktop never stores a Supabase web refresh token or provider token.
- A browser session is not implicitly the current Desktop device.
- Device records are authentication devices, not a Computer Registry.

### Drift Boundaries

Update for PKCE, device-code, vault, refresh rotation, renderer IPC, or
revocation-matrix changes.

### Traceability

The Identity E2E, Desktop client/vault tests, and packaged smoke cover the
browser-to-device boundary and durable credential handling.

## IDENTITY.SERVER.EXCHANGE.001

### Contract Summary

A Local Server accepts only a short-lived, one-time, audience- and
installation-bound Identity exchange and creates its own HttpOnly user session.
Account login alone grants no Organization membership or instance role.

### Intent / User Job

A signed-in Desktop can enter its Local Rudder instance as the same account
without exposing its long-lived cloud credential to the Local Server.

### Why / Design Reasoning

Server-local authority must be established by a replay-safe handoff and local
mapping, not inferred from email or from possession of a generic Identity token.

### Actors / Objects / State

- Identity device, exchange code, issuer, subject, audience, installation,
  `jti`, local external-user binding, installation binding, local user/session,
  and legacy Local authority.
- States: issued, redeemed, consumed, mapped, claimed, revoked, and rejected.

### Entry Points / Inputs

- Desktop Local exchange, Local session creation, first legacy Local claim,
  sign-out, and replay or cross-audience attempt.

### Product Logic Flow

1. Identity issues an opaque exchange for one active device, installation, and
   Local audience with a short expiry and unique `jti`.
2. Local Server verifies through the pinned HTTPS Identity origin and atomically
   consumes the matching code.
3. It maps `(issuer, subject)` to one local user and creates an HttpOnly,
   SameSite-protected session.
4. The first legacy installation claim transfers active local authority in one
   installation-serialized transaction while preserving historic creator IDs.
5. A different account cannot inherit a claimed installation; sign-out/revoke
   removes access but does not delete Local data.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Valid exchange | Issuer, audience, installation, expiry, and unused `jti` match | Local user session | Grant org authority from email alone | Local auth tests |
| Replay | Code/`jti` already consumed | Reject conflict | Mint second session | DB/service tests |
| Cross-installation | Installation or audience differs | Reject unauthorized | Rebind exchange | Service tests |
| First legacy claim | Installation unclaimed and account session active | Atomic ownership transfer | Rewrite history or expose to second account | Local auth tests |

### Actor-Visible Input

Desktop performs the exchange after account authorization; claim actions require
the authenticated same-origin Local session.

### Operator-Visible Output

The operator enters the existing Local Board as the mapped account or sees a
recoverable authorization error with Local data left intact.

### Persisted Evidence

The Local database stores external-user binding, installation binding, consumed
exchange evidence, Local session, and preserved ownership records.

### Canonical Scenarios

1. A fresh signed-in Desktop exchanges once and opens Board.
2. Restart reuses a valid Local account/device path without anonymous access.
3. Replay and second-account claim attempts fail without data mutation.

### Invariants / Non-Goals

- Exchange is opaque, short-lived, one-time, and target-bound.
- Identity authentication alone does not create membership or role authority.
- This contract is not Remote Server discovery, invite redemption, or
  Local-to-Remote migration.

### Drift Boundaries

Update for exchange claims, redemption atomicity, Local mapping/session, legacy
claim, or sign-out/revocation semantics.

### Traceability

`server-exchange`, Local account service/routes, their tests, and packaged
Desktop smoke are the implementation evidence.

## IDENTITY.LOCAL.OFFLINE.001

### Contract Summary

After online login, Local access may continue offline for at most 30 days using
an Identity-signed grant bound to the installation and device public key with
proof of possession.

### Intent / User Job

An operator can keep using an already-authorized Local Workspace during a
temporary Identity or network outage without receiving indefinite bearer access.

### Why / Design Reasoning

Offline Local work is a product requirement, but remote revocation cannot be
instant while disconnected. A bounded device key, trusted-time floor, and
explicit residual-risk statement provide a defensible compromise.

### Actors / Objects / State

- Identity signer, Desktop device key, Offline Grant, proof nonce/body hash,
  trusted time, local sign-out tombstone, schema/account/device auth epochs,
  Local session, and encrypted grant store.
- States: valid, replayed, rolled back, expired, locally signed out, remotely
  revoked pending sync, key missing, and online recovery required.

### Entry Points / Inputs

- Online grant issue/refresh, offline Local start, sign-out, device revoke,
  system backup restore, clock rollback, and network recovery.

### Product Logic Flow

1. Identity issues a maximum 30-day grant for one account, device public-key
   thumbprint, and installation.
2. Desktop proves possession over method, path, body hash, nonce, and time.
3. Local Server verifies signature, audience, key, expiry, nonce, trusted time,
   local sign-out epoch, and server auth epochs before creating a Local session.
4. Successful online verification may roll the window forward. Reconnect first
   synchronizes server revocation before renewal.
5. Expiry, key loss, rollback, or sign-out requires online login and never
   deletes or uploads Local data.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Valid offline proof | All bindings, epochs, time, and nonce pass | Local session | Accept bearer grant without proof | Offline tests |
| Copied/replayed grant | Key or nonce invalid | Reject | Reuse on another device | Core/server tests |
| Clock rollback/expiry | Below trusted floor or over 30 days | Require online login | Extend offline window | Server tests |
| Current-device sign-out | Local tombstone advances | Clear grant/session immediately | Delete workspace files | Desktop/server tests |

### Actor-Visible Input

Ordinary valid offline startup needs no extra action. Recovery asks the operator
to reconnect and sign in, while stating that Local data remains on the device.

### Operator-Visible Output

The operator either enters the existing Local Board or sees a bounded recovery
state; no expiry path claims data deletion or cloud upload.

### Persisted Evidence

Desktop stores the encrypted grant, device key reference, trusted time, and
sign-out tombstone. Local Server stores replay nonces and session/binding state.

### Canonical Scenarios

1. A recently verified Desktop starts Local Rudder while offline.
2. A copied grant without the device key is rejected.
3. A grant older than 30 days returns to login with Local data preserved.

### Invariants / Non-Goals

- Offline authorization never exceeds 30 days from the last successful online
  renewal and never applies to a Remote Server.
- Plaintext JSON/SQLite fallback for durable secrets is prohibited.
- Complete same-machine administrator snapshot rollback is an accepted
  limitation; the contract does not claim hardware-counter protection.

### Drift Boundaries

Update for lifetime, proof fields, key storage, trusted-time, epoch, residual
offline revocation, or recovery-copy changes.

### Traceability

Identity-core, Desktop, and Local Server offline-grant tests plus packaged smoke
prove issue, storage, proof, replay, rollback, expiry, and sign-out behavior.
