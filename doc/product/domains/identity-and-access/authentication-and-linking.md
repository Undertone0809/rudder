---
title: Rudder Account Authentication And Linking
domain: identity-and-access
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - IDENTITY.AUTH.001
  - IDENTITY.ACCOUNT.LINKING.001
related_code:
  - identity/src/root-identity-adapter.ts
  - identity/src/root-identity-fixture.ts
  - identity/src/supabase-root-identity-adapter.ts
  - identity/src/handler.ts
  - identity/src/client-script.ts
  - identity/src/pages.ts
  - packages/identity-db/src/account-linking.ts
  - packages/identity-db/src/supabase-auth-binding.ts
related_tests:
  - identity/src/root-identity-fixture.test.ts
  - identity/src/supabase-root-identity-adapter.test.ts
  - identity/src/pages.test.ts
  - identity/src/identity.e2e.test.ts
  - desktop/src/boot-screen.test.ts
  - desktop/src/identity-client.test.ts
  - desktop/src/identity-ipc.test.ts
  - packages/identity-db/src/account-linking.test.ts
  - packages/identity-db/src/supabase-auth-binding.test.ts
related_plans:
  - doc/plans/2026-07-29-rudder-account-production-login.md
edit_policy: user_confirmed_only
---

# Rudder Account Authentication And Linking

## IDENTITY.AUTH.001

### Contract Summary

Supabase Auth is the root identity system for Rudder Account. Packaged Canary
and Stable clients require a signed-in Rudder Account before Local Board entry
and support Google, GitHub, Email OTP, and email/password authentication.

### Intent / User Job

An operator can sign in, recover access, and manage account security without
creating a different identity for each Rudder installation.

### Why / Design Reasoning

One managed root avoids split account and refresh-token authority. Rudder keeps
its device and Local authorization layer so provider credentials never need to
reach Desktop, a Local Server, or a runtime agent.

### Actors / Objects / State

- Operator, Supabase Auth, Rudder Identity, and Desktop.
- Supabase user, provider identity, verified email, password, OTP, web session,
  refresh token, and Rudder security event.
- States: signed out, pending verification, signed in, reauthentication
  required, recovery pending, and revoked.

### Entry Points / Inputs

- Google or GitHub continuation, Email OTP, password sign-in or sign-up,
  password set/change/reset, and current/other/global web sign-out.

### Product Logic Flow

1. The Desktop login surface presents Google, GitHub, and Email OTP as direct
   methods; password remains an explicit alternative and recovery path.
   Google/GitHub continue in the system browser. Email OTP, password sign-in,
   forgot password, and reset password remain native in Desktop.
2. Supabase Auth verifies the root identity and owns users, identities,
   passwords, OTP material, web sessions, and refresh tokens.
3. Rudder Identity accepts only an active verified Supabase principal, maps it
   to a stable Rudder subject, and records bounded security evidence. Native
   Desktop email/password transactions discard Supabase web-session material
   server-side and return only a short-lived, single-use Rudder authorization
   code bound to Desktop PKCE and the installation audience.
4. Password set/change requires a signed-in or recently reauthenticated user.
   Forgot/reset uses an enumeration-safe response and revokes old long-lived
   access according to the documented session matrix.
5. Supabase provider access or refresh tokens and Supabase web refresh tokens
   are never returned to Desktop or a Local Server.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Formal login | Supported verified method succeeds | Continue to Rudder Desktop authorization | Enter Board anonymously | Identity and packaged smoke |
| OTP request | Any syntactically valid email | Return the same accepted response | Reveal whether an account exists | Adapter tests |
| Password reset | Recovery proof and new password are valid | Replace password and revoke old long-lived access | Keep the old password usable | Identity E2E |
| Unverified principal | Provider cannot prove verified email | Reject or require verification | Create a formal Rudder Account | Supabase adapter tests |

### Actor-Visible Input

The operator sees the Rudder login card, supported methods, native Desktop
verification and recovery forms, clear errors, and Privacy/Terms links. Only
Google/GitHub transfer the operator to the system browser.

### Operator-Visible Output

Successful authentication continues the Desktop authorization flow. Security
actions state their actual revocation boundary and do not promise immediate
deletion of an already-issued Local session.

### Persisted Evidence

Supabase stores root users, identities, and sessions. The private Identity
schema stores the stable-subject binding and redacted security events; OTP,
password, provider token, and refresh-token plaintext are not duplicated there.

### Canonical Scenarios

1. Email OTP signs a new operator into one Supabase user through the native
   Desktop form, then exchanges a Rudder-owned PKCE code without launching the
   system browser.
2. Password reset invalidates the old password and long-lived credentials while
   preserving Local files.
3. A provider response without verified email fails closed.

### Invariants / Non-Goals

- Formal users appear in Supabase `Authentication -> Users`.
- Email OTP is the primary email path; password remains supported.
- Passwords and OTPs are never logged or implemented as Rudder-owned crypto.
- This contract does not grant Organization membership or runtime capability.

### Drift Boundaries

Update this contract for login-method, password-lifecycle, Supabase root,
session-action, verification, or provider-token-boundary changes.

### Traceability

The related adapter, page, E2E, and migration plan paths in frontmatter are the
canonical implementation evidence.

## IDENTITY.ACCOUNT.LINKING.001

### Contract Summary

Google, GitHub, and email identities may converge automatically only when they
prove the same safely normalized verified email. The Supabase user and stable
Rudder subject remain unique under concurrent first login.

### Intent / User Job

An operator can use any supported verified method without accidentally creating
parallel Rudder Accounts or losing the device and Local ownership already tied
to the account.

### Why / Design Reasoning

Verified email is the only cross-provider identifier with enough evidence for
automatic linking. Provider display names, usernames, and public unverified
emails are not account authority.

### Actors / Objects / State

- Operator, Supabase user/identity, verified email, stable Rudder subject,
  provider subject, binding, and migration/security evidence.
- States: unbound, bound, automatically linked, conflict, and manual repair.

### Entry Points / Inputs

- First login with a provider or email, migration of a verified legacy account,
  and concurrent same-email first login.

### Product Logic Flow

1. Trim and case-normalize email and normalize its domain safely; do not remove
   plus aliases, dots, or apply provider-specific folding.
2. Supabase linking converges verified identities on one root user.
3. Rudder creates one bidirectionally unique Supabase UUID to stable-subject
   binding and rereads the winner after a compatible uniqueness conflict.
4. Supabase retains provider-link evidence. Rudder records the unique root-user
   binding and migration state without storing provider OAuth tokens.
5. A conflicting provider subject, email, or migration marker stops for manual
   repair instead of creating a second user or rebinding Local ownership.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Same verified email | Supported identities prove the same normalized address | One Supabase user and Rudder subject | Duplicate account | Linking tests |
| Unverified/public email | Verification evidence absent | Reject auto-link | Merge by username or display name | Adapter tests |
| Concurrent first login | Google/GitHub prove the same verified normalized email | Advisory lock serializes creation and both providers use one subject | Allocate a second subject | Embedded-PostgreSQL Identity E2E |

### Actor-Visible Input

Operators can use any supported method that Supabase has automatically linked
to the verified account and see an actionable recovery state when identity
evidence conflicts. A separate manual provider link/unlink manager is not part
of this contract.

### Operator-Visible Output

All linked methods open the same Rudder Account, devices, and Local ownership.

### Persisted Evidence

Supabase persists root identities and Google/GitHub provider provenance. The
private schema persists the unique Supabase-to-Rudder binding, verified-email
projection, migration ledger, and bounded Rudder account/device security events
without claiming a separate event for every provider link inside Supabase.

### Canonical Scenarios

1. Google and GitHub with the same verified email resolve to one account.
2. A GitHub identity without a verified email is not merged.
3. Two concurrent first logins converge through uniqueness and reread.

### Invariants / Non-Goals

- A stable Rudder subject is not replaced by a Supabase UUID.
- Email equality never grants Organization membership or instance authority.
- Manual provider link/unlink management is not implemented or promised here.
- Manual recovery tooling is not specified here, but conflicts must fail safe.

### Drift Boundaries

Update this contract for normalization, verification evidence, binding
uniqueness, automatic-linking behavior, or migration takeover rules.

### Traceability

`account-linking`, `supabase-auth-binding`, and the embedded-PostgreSQL Identity
E2E prove unverified rejection, cross-provider concurrency, HTTP method
convergence, conflict handling, and stable-subject behavior.
