# Local account lifecycle transport

This contract describes the four local-account routes owned by the Rust public
listener when `RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG` is configured. The
legacy Express router is omitted for that configuration. A Rust validation,
authentication, storage, or verifier failure does not forward the request to the
old handler. An absent service fails closed.

## Requests and responses

All four canonical routes use `POST` under `/api/auth`. Unsupported methods
return `404` with `{ "error": "API route not found" }`.

| Route | Request | Success |
| --- | --- | --- |
| `/local-exchange` | `{ exchangeCode }` | `{ userId, session: { id, expiresAt } }` and session cookie |
| `/local-offline` | `{ grant, devicePublicKeySpki, proof }` | `{ userId, nextTrustedTimeMs, session: { id, expiresAt } }` and session cookie |
| `/local-claim` | JSON body ignored | `{ status: "claimed" or "already_claimed", localUserId, orgIds }` |
| `/local-signout-all` | JSON body ignored | `{ revokedSessionCount }` |

The exchange and offline request schemas are defined in
`packages/shared/src/validators/local-account-auth.ts`. Schema errors return
`400` with `{ error: "Validation error", details: issues }`. Unknown fields are
rejected by these two schemas. Claim and signout do not apply these schemas:
valid JSON arrays and objects are ignored, so they are not invalid-input test
fixtures. Use disposable data when exercising either mutating route.

Claim and signout derive the user from authenticated credentials. Cookie-based
mutations require the existing trusted board-origin checks. Invalid Bearer
credentials take precedence over a valid cookie. A successful claim preserves
the caller's current session. Claim retries retain the same installation owner;
a different account cannot claim that installation. Legacy organization
memberships are transferred to the owner and the legacy principal's memberships
are retained with revoked status. Signout deletes the user's current sessions;
a cookie for a deleted session cannot authorize the next request.

## Offline proof

Use the existing `@rudderhq/identity-core` grant and proof helpers and the
Desktop client in `desktop/src/identity-local-session.ts` as the client contract.
An offline request includes the device public key as base64url DER SPKI and a
signed proof payload containing `version`, `grantHash`, `method`, `path`,
`bodyHash`, `nonce`, and `issuedAtMs`.

For the local-offline request, the signed values are:

- `version`: `1` (proof protocol version, distinct from the grant's version).
- `method`: `POST`.
- `path`: `/api/auth/local-offline`.
- `bodyHash`: `offlineRequestBodyHash("")`.

Do not hash the request envelope or a subset of its grant/key fields. The proof
uses the hash of an empty body under the existing Desktop protocol. A proof
with another body hash is rejected even when its signature is valid. The grant
hash binds the proof to its grant; the device key, nonce, time window, issuer,
audience and installation checks also remain required. Reusing a successfully
redeemed proof is a conflict; changing to another device key is unauthorized.

## Verification boundaries

A controlled Identity exchange verifier and counting Node upstream are valid
fixtures for testing these routes, but do not establish hosted Identity or
whole-product Node retirement. Keep fixtures, database identity, source commit,
frozen binary hash, startup receipt and public request results bound together.
Restart checks must reuse the same session secret and lifecycle policy.

This slice does not complete dynamic offline-policy refresh, hosted Identity,
all WebSocket authorization, or the remaining backend migration. The offline
policy is currently a startup snapshot; do not claim that session deletion alone
implements persisted offline-grant epoch revocation.
