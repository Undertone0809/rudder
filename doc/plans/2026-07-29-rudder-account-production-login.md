---
title: Rudder Account production login
date: 2026-07-29
kind: implementation
status: review_ready
area: security
entities:
  - rudder_account
  - identity_device
  - local_user_session
  - account_security
issue:
related_plans:
  - 2026-02-21-humans-and-permissions-implementation.md
supersedes: []
related_code:
  - identity
  - packages/identity-core
  - packages/identity-db
  - packages/db/src/schema/auth.ts
  - server/src/auth/better-auth.ts
  - server/src/middleware/auth.ts
  - desktop/src/main.ts
  - ui/src/pages/Auth.tsx
  - tests/e2e
commit_refs: []
updated_at: 2026-07-29
---

# Rudder Account production login

## Summary

Deliver the minimum production vertical slice required for the next Rudder
release to require a real Rudder Account before a user can enter the packaged
Local product. The account is owned by an independent Rudder Identity control
plane rather than by an individual Rudder Server.

The production target is:

- `accounts.rudderhq.dev` on a dedicated Vercel project;
- a private Identity schema in the existing Supabase `rudder` project;
- Google and GitHub OAuth applications dedicated to Rudder Account;
- verification and security email through the already verified
  `updates.rudderhq.dev` Resend domain;
- Desktop Authorization Code + PKCE with a loopback callback and Device
  Authorization fallback;
- an audience-bound, one-time exchange into a Local Server user session;
- a 30-day proof-of-possession Local offline grant;
- production builds that cannot accept development bypasses, test issuers, or
  test signing keys.

This plan implements the Identity and Local-login release slice only. It does
not implement Remote Server connections, Organization invites, Local-to-Remote
migration, Computer, Daemon, or Runtime Discovery.

Source proposal:

- `/Users/zeeland/projects/uranus/rudder/proposals/2026-07-29-rudder-unified-login-local-remote-proposal.md`

## Current-State Gap

### Better Auth and database

- Better Auth `1.6.23` is mounted inside each Rudder Server and therefore
  represents a server-local user, not a global Rudder Account.
- Only email/password is enabled. Email verification is disabled.
- Google, GitHub, Email OTP, password recovery, account security, Device
  Authorization, and production email delivery are absent.
- The existing Better Auth tables lack the unique normalized verified-email
  and provider-subject constraints needed to prevent duplicate global
  accounts during concurrent first login.
- The existing account schema can persist provider tokens. A login-only
  Identity must discard them after callback where supported, or encrypt and
  minimize them if unavoidable.
- The current secret falls back to the Agent JWT secret. Identity production
  keys must be independent and environment-specific.

### Server

- `local_trusted` assigns unauthenticated requests the `local-board` instance
  administrator principal.
- Local WebSocket access is also implicitly trusted.
- The current synthetic session response cannot accurately identify the
  current session or device.
- Browser, Path, IDE, Local Apps, and managed local runtime capabilities are
  coupled to `deploymentMode === "local_trusted"`. Simply changing Local to
  `authenticated` would remove trusted Desktop capabilities.
- There is no global-subject-to-local-user binding, one-time exchange
  redemption, Local installation binding, or atomic legacy-data claim.

### UI and Desktop

- The UI has only explicit email/password sign-in and sign-up forms.
- There is no Email OTP primary flow, social login, password recovery, account
  security page, session list, device revocation, or recent reauthentication.
- Desktop starts or attaches the anonymous Local Server before presenting a
  Rudder Account launcher.
- Desktop has no Identity controller, PKCE callback, Credential Vault, device
  credential, or offline grant.
- The current portable distribution cannot rely on a custom URI scheme as its
  only OAuth callback. A main-process loopback callback is the primary path;
  Device Authorization is the fallback and CLI path.

### Tests and release gates

- The main Playwright suite runs `local_trusted`.
- The Docker authenticated smoke covers only the legacy server-local password
  onboarding path.
- Desktop smoke depends on anonymous `local-board`.
- There are no deterministic OAuth Provider, mailbox, account-linking,
  device-session, exchange replay, release-isolation, or offline-grant tests.

## Locked Technical Architecture

### Identity control plane

Add three boundaries:

- `identity/`: Vercel Node Functions, Better Auth configuration, Identity
  login/security UI, Resend adapter, rate limits, and security-event service.
- `packages/identity-db`: Identity-only Drizzle schema, migrations, and
  database client.
- `packages/identity-core`: verified-email normalization, issuer/audience
  claims, account-linking transaction rules, token policy, JWKS, and release
  capability policy.

Supabase is PostgreSQL only. Supabase Auth is not used. Identity tables live in
a private schema not exposed through the Supabase Data API. Runtime requests
use the TLS Transaction Pooler; migrations use a separately scoped direct or
session connection.

### Identity records

The Identity schema owns:

- Rudder accounts;
- normalized verified account emails;
- provider identities with unique `(provider, provider_subject)`;
- Better Auth credential and web-session records;
- Identity devices and hashed rotating refresh credentials;
- OAuth authorization codes with PKCE challenge, audience, expiry, `jti`, and
  `consumed_at`;
- Device Authorization codes;
- security events;
- persistent email/IP/device rate-limit buckets.

Email OTP uses hashed storage, a ten-minute lifetime, one successful use,
rotation that invalidates older codes, bounded attempts, uniform account
enumeration-safe responses, and log redaction.

### Desktop and Local Server

Desktop owns the user-facing launcher and all durable device credentials.
The renderer receives only a bounded account/session summary.

Desktop uses:

- system-browser Authorization Code + PKCE;
- a main-process ephemeral loopback callback;
- Device Authorization as fallback and the CLI-compatible path;
- Electron `safeStorage` or a platform-specific secure helper;
- memory-only sessions when Linux reports an insecure `basic_text` backend.

After Identity login, Desktop requests a short-lived, audience-bound,
one-time Local Server exchange code. The Local Server atomically redeems it,
maps `(issuer, subject)` to a local user, and creates its own HttpOnly session.
Identity login alone never creates an Organization membership or instance
role.

The Local Server adds:

- `external_user_bindings`;
- `installation_account_bindings`;
- `server_exchange_redemptions`.

The first legacy claim transfers the `local-board` instance role and all active
Organization memberships in one installation-serialized transaction. Historic
creator references remain unchanged. A second Rudder Account cannot inherit
the bound Local data.

Authentication requirement is separated from Local Desktop trust. Data access
requires a user session, while Browser, Path, IDE, Local Apps, and runtime
capabilities remain controlled by Desktop attestation and per-run capability
context.

### Offline Local access

Identity may issue a maximum 30-day signed Device Grant bound to the Local
installation and the device public key. Desktop proves possession for Local
authorization. Trusted-time and local sign-out state prevent ordinary clock
rollback and copied-token reuse. Expiry or device-key loss requires an online
login and never deletes or uploads Local data.

### Production topology

- Vercel team: `zeelands-projects`
- Dedicated Vercel project: `rudder-identity`
- Production hostname: `accounts.rudderhq.dev`
- Function region: `sin1`
- Supabase project: `rudder` (`qroqfgbaifzeqlygafjr`)
- Supabase region: `ap-southeast-1`
- Resend sending domain: `updates.rudderhq.dev`
- Production sender: a dedicated Rudder Account address under the verified
  sending domain

The current Supabase Organization is on the Free plan. Production launch is
blocked until the operator explicitly approves and completes the paid upgrade
to a plan with production availability and backups. Development and fixture
work can continue without this purchase.

## Scope

### In scope

- independent Rudder Identity service and private schema;
- Google, GitHub, Email OTP, and email/password login;
- set, change, forgot, and reset password;
- verified-email automatic account linking;
- account login-method management with at least one remaining method;
- web and device sessions, list/revoke/other-device sign-out;
- PKCE, Device Authorization, and security events;
- Desktop launcher and secure credential persistence;
- Local Server one-time exchange, user mapping, and legacy data claim;
- production Local HTTP and WebSocket authentication;
- authentication/trusted-capability separation;
- 30-day Local offline grant;
- deterministic fixtures, real-provider smoke, packaged release isolation, and
  user-visible UI verification;
- production Identity deployment and public-surface verification.

### Out of scope

- Remote Server discovery or connection profiles;
- Organization Invite links and membership redemption;
- Local-to-Remote migration;
- Computer Registry, Daemon enrollment, remote execution, or Runtime
  Discovery;
- billing, SAML, SCIM, or self-hosted OIDC.

## Product Logic Alignment

No `doc/product/**` files may be edited without explicit user authorization.
The external proposal is not authorization.

Proposed new contracts:

- `IDENTITY.AUTH.001`: formal login requirement, four login methods, verified
  email/password lifecycle, and Identity data boundary.
- `IDENTITY.ACCOUNT.LINKING.001`: only normalized verified email may link
  accounts; database uniqueness, concurrency, reauthentication, and audit
  rules.
- `IDENTITY.DEVICE.SESSION.001`: web/device-session separation, PKCE, rotating
  device credentials, OS vault, device list, and revocation.
- `IDENTITY.SERVER.EXCHANGE.001`: short-lived one-time audience-bound exchange
  creates a local principal/session but never grants Organization authority.
- `IDENTITY.LOCAL.OFFLINE.001`: 30-day proof-of-possession grant, trusted time,
  sign-out, revocation, recovery, and accepted offline boundary.
- `CLIENT.AUTH.RELEASE.ISOLATION.001`: development, E2E, canary, and stable
  issuers, keys, bypasses, and build manifests remain non-interchangeable.
- `PRIVACY.LOCAL.DATA.BOUNDARY.001`: login does not upload Local Organization,
  Workspace, Prompt, Transcript, Run, path, runtime credential, or provider
  credential content to Rudder Identity.

Proposed updates:

- `DESKTOP.STARTUP.RECOVERY.001`: add Identity unavailable, login failed,
  grant-expired, and local-data-safe recovery states.
- `ORG.IDENTITY.001`: global subject maps to a local user before membership;
  email does not grant authority; legacy Local claim is atomic.
- `AGENT.RUNTIME.PERMISSIONS.001`: authentication requirement and Local
  Desktop/runtime trust are independent predicates.
- `AGENT.BROWSER.001`: authenticated Local Desktop retains Browser capability;
  an authenticated ordinary browser does not receive Desktop Bridge access.

`SERVER.LIFECYCLE.001` changes only if a new callback listener or auth
background resource enters server lifecycle ownership. Otherwise there is no
semantic delta.

Audit-only IDs such as Agent Skills, Custom Integrations, Inbox, and Messenger
remain unchanged when stable local user mapping preserves their current
semantics.

## Implementation Plan

1. Add Identity packages, private Drizzle schema, migrations, configuration
   validation, health route, and development fixture bootstrap.
2. Configure Better Auth for Google, GitHub, verified email/password, hashed
   Email OTP, password lifecycle, web sessions, Device Authorization, and
   Rudder security hooks.
3. Implement verified-email account resolution as a transaction with unique
   constraints and concurrent-login recovery.
4. Implement Resend and deterministic captured-mail adapters, persistent rate
   limits, log redaction, and security-event persistence.
5. Build the Identity login, password recovery, device approval, and Account &
   Security UI.
6. Implement Identity Authorization Code + PKCE, device-session rotation,
   revocation, JWKS, and one-time audience-bound server exchange.
7. Implement Desktop Identity controller, loopback callback, secure credential
   vault, account launcher, sign-out, and renderer-minimal IPC.
8. Add Local Server bindings, exchange redemption, HttpOnly sessions, legacy
   data claim, and authenticated HTTP/WebSocket enforcement.
9. Separate auth requirement from Desktop/Local runtime capabilities and prove
   Browser, Path, IDE, Local Apps, CLI, and Agent-run boundaries.
10. Implement the signed 30-day proof-of-possession Device Grant, trusted time,
    offline recovery, and sign-out invalidation.
11. Add development/test/release capability manifests and make stable/canary
    builds reject test issuers, test keys, and auth bypass.
12. Add deterministic E2E, real-provider smoke harnesses, packaged Desktop
    auth smoke, upgrade/rollback tests, and visual verification.
13. Create production Google/GitHub OAuth applications and a dedicated Resend
    API key; inject all credentials only through encrypted Vercel environment
    variables.
14. Create the independent Vercel project, bind `accounts.rudderhq.dev`, apply
    Supabase migrations, deploy the locked source, and verify every public auth
    surface.

## External Production Configuration

The following production resources are required:

- Google Cloud project and OAuth consent brand dedicated to Rudder Account;
- Google Web OAuth client with Identity callback URLs;
- GitHub OAuth App dedicated to Rudder Account;
- Resend production API key restricted to sending;
- Vercel production project and encrypted environment variables;
- Supabase runtime pooler URL and separately scoped migration URL;
- independent Better Auth/session secret and asymmetric signing keys;
- Terms, Privacy, account-deletion, and security-contact URLs.

No secret value may be committed, printed in tests, included in screenshots, or
returned to the renderer. Development, preview, and E2E must not connect to the
production Identity database.

## Implementation Status

Implemented and independently reviewed:

- production Identity service with Google, GitHub, Email OTP, and password
  lifecycle;
- atomic verified-email linking, web sessions, Device sessions, PKCE, Device
  Authorization, and one-time Local Server exchange;
- packaged Desktop account gate, secure device credentials, and a 30-day
  proof-of-possession Offline Grant;
- Local HTTP, Browser, CLI, and WebSocket session enforcement, including
  revoke-all and upgrade-race protection;
- development/preview/production release isolation that fails closed on
  Vercel environment mismatch;
- private Supabase schema and least-privilege runtime role;
- production Google/GitHub OAuth applications, Resend sender, Vercel project,
  hostname, secrets, and Supabase migrations.

Production Identity is deployed at `accounts.rudderhq.dev`. The final
continuous packaged Desktop black-box smoke passed against production:
the stable package ignored the requested auth bypass, completed account
authorization and one-time Local exchange, claimed a fresh installation,
opened the real onboarding Board, exposed exactly one current device, returned
`200` for the renderer-authenticated Organization request and `401` for the
same anonymous request, and installed an HttpOnly, SameSite=Lax Local session
cookie. Independent security review and black-box verification both passed.

The production launch gates listed below remain operator decisions rather than
implementation gaps.

## Success Criteria

- A new packaged Desktop user must authenticate through Rudder Account before
  entering Local Rudder.
- Google, GitHub, Email OTP, and password login work in deterministic E2E and
  controlled production smoke.
- Same verified email across supported methods resolves to one account;
  unverified email never auto-links.
- Password reset invalidates the old password and other long-lived sessions.
- Devices and sessions are visible and independently revocable.
- Local exchange is audience-bound and replay-safe; login alone never grants
  Organization authority.
- Existing Local data is claimed atomically without creator-history rewrites or
  cross-account exposure.
- Signed-out or unauthenticated users cannot access production Local HTTP,
  WebSocket, Browser, or CLI Board entry points.
- Authenticated Local Desktop retains intended local Browser, IDE, Path, Local
  Apps, and runtime capabilities.
- Offline Local access works only with a valid device-bound grant for at most
  30 days and never deletes or uploads Local data on expiry.
- Stable/canary artifacts cannot enable development bypass or accept test
  identity material.
- Production Identity is reachable at `accounts.rudderhq.dev`, uses TLS and the
  intended issuer, and does not expose Identity tables through the Supabase
  Data API.

## Validation

- Identity schema migration on an empty database and a production-shaped
  migration clone.
- Unit and service tests for OTP security, password lifecycle, account-link
  concurrency, sessions, devices, authorization codes, exchange replay,
  security events, and log redaction.
- E2E for all four login methods, password recovery, account linking,
  unverified-email rejection, session revocation, Device Authorization, legacy
  Local claim, Organization isolation, and logout.
- Desktop black-box PKCE, vault persistence, Linux insecure-vault fallback,
  offline grant, renderer boundary, and sign-out tests.
- Real Google, GitHub, and Resend smoke using dedicated non-personal test
  accounts/mailboxes.
- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- relevant `pnpm test:e2e`
- `pnpm desktop:verify`
- packaged artifact scan for test issuers, signing keys, and bypass markers.
- browser/Desktop visual verification with final screenshots outside the
  repository.
- independent exploratory reviewer and real-environment black-box verifier.

## Rollback

- Identity deployment remains independently versioned and can be rolled back
  without changing Local Organization data.
- Database migrations are additive until the new login path has passed
  production smoke.
- Legacy `local-board` authority is transferred only inside the successful
  claim transaction.
- A failed login or expired grant never deletes Local data.
- Production OAuth apps and Resend credentials can be revoked independently.
- The previous packaged Rudder release remains the binary rollback point until
  authenticated Local upgrade and downgrade drills pass.

## Open Issues and Release Gates

- The Supabase `Zeeland` organization is currently Free. A paid-plan upgrade is
  a production availability and backup gate and requires explicit operator
  purchase approval.
- Supabase reports that Row Level Security is disabled on the private Identity
  tables. The schema is not exposed through the Data API and explicitly
  revokes `anon` and `authenticated`, but enabling an additional RLS layer
  requires explicit operator authorization.
- The implemented Terms, Privacy, account-deletion contact, and security
  contact copy should receive legal review before broad public release.
- The first real OTP message delivered through Resend was accepted by Gmail
  but placed in Spam. Deliverability monitoring and domain reputation warming
  remain launch operations.
- The proposed Product Logic Contract delta requires explicit authorization
  before `doc/product/**` can be synchronized or the product behavior change
  can be declared complete.
