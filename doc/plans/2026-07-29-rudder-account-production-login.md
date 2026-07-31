---
title: Rudder Account production login
date: 2026-07-29
kind: implementation
status: in_progress
area: security
entities:
  - rudder_account
  - identity_device
  - local_user_session
issue:
related_plans:
  - 2026-02-21-humans-and-permissions-implementation.md
supersedes: []
related_code:
  - identity
  - packages/identity-core
  - packages/identity-db
  - identity/src/auth.ts
  - identity/src/handler.ts
  - identity/src/verified-identity-adapter.ts
  - server/src/middleware/auth.ts
  - desktop/src/main.ts
  - ui/src/pages/Auth.tsx
  - tests/e2e
commit_refs: []
updated_at: 2026-07-30
---

# Rudder Account production login

## Summary

Deliver the minimum production vertical slice required for the next Rudder
release to require a real Rudder Account before a user can enter the packaged
Local product. Supabase Auth is the root identity system for the account. The
independent Rudder Identity service remains responsible for device and
server-connection security rather than duplicating Supabase users, identities,
or web sessions.

The production target is:

- `accounts.rudderhq.dev` on a dedicated Vercel project;
- Supabase Auth for Google, GitHub, Email OTP, password/reset,
  verified-email identity linking, and base user/identity/session/refresh-token
  ownership;
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

### Root authentication and database

- A Better Auth production Canary was implemented and verified before the root
  identity decision changed. It is now migration source and rollback-only
  infrastructure, not the release target.
- On the 2026-07-30 production snapshot, Supabase Auth is empty:
  `auth.users = 0`, `auth.identities = 0`, and `auth.sessions = 0`. The current
  user therefore does not yet appear in Dashboard `Authentication -> Users`.
- The private `rudder_identity` schema contains one verified legacy user with
  one primary normalized email, linked Google and GitHub identities, six
  unexpired Better Auth web sessions, one active Desktop device, six active
  device refresh credentials, and 27 security events.
- The legacy Rudder user ID is not a UUID and already owns device and Local
  trust records. It cannot be replaced by `auth.users.id`; an explicit
  Supabase UUID to stable Rudder subject binding is required.
- The production account has no password hash or provider token to migrate.
  If a Better Auth password appears before cutover, its scrypt hash must not be
  copied into Supabase Auth; the user must use OTP or password reset.
- Better Auth web sessions cannot become Supabase JWT/refresh sessions and
  must be invalidated at cutover. Existing device records, Local bindings, and
  stable Rudder ownership remain, but Rudder device refresh credentials and
  new Offline Grants are blocked so every online/upgraded client re-proves the
  new root identity. A pre-cutover client that remains fully offline cannot
  learn a remote epoch change and may retain its existing Grant until its
  original maximum 30-day expiry.

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

### Identity service boundaries

Keep three boundaries, with Supabase Auth as the root:

- Supabase Auth: authoritative Google/GitHub identities, Email OTP,
  password/reset, verified-email linking, `auth.users`, `auth.identities`,
  `auth.sessions`, and refresh tokens. Rudder users must be visible in
  Dashboard `Authentication -> Users`.
- `identity/`: a same-origin Vercel façade and Rudder device/security service.
  It performs Supabase PKCE callbacks using secure HttpOnly cookies and owns
  Desktop Device Authorization, device registration/revocation, Local Server
  Exchange, Offline Grant, Local Workspace claim, security events, and custom
  rate limits.
- `packages/identity-db`: Identity-only Drizzle schema, migrations, and
  database client.
- `packages/identity-core`: stable Rudder-subject mapping, issuer/audience
  claims, device token policy, JWKS, and release capability policy.

The private `rudder_identity` schema remains outside the Supabase Data API.
Runtime requests use the TLS Transaction Pooler; migrations use a separately
scoped direct or session connection. The browser never receives a service-role
key, and the Identity page does not persist Supabase refresh tokens in
`localStorage`.

### Identity records

Supabase Auth owns:

- base users and verified emails;
- Google and GitHub provider identities;
- password and Email OTP authentication;
- web sessions and rotating refresh tokens.

The private Identity schema owns:

- `supabase_auth_user_binding`, mapping an authoritative Supabase UUID to one
  stable Rudder subject;
- Rudder account profile and normalized-email projections;
- Identity devices and hashed rotating refresh credentials;
- OAuth authorization codes with PKCE challenge, audience, expiry, `jti`, and
  `consumed_at`;
- Rudder-owned Device Authorization codes;
- security events;
- persistent email/IP/device rate-limit buckets.

Legacy Better Auth `account`, `session`, `verification`, and rate-limit records
remain read-only during the rollback window and stop minting at cutover.
Provider tokens are neither copied into `rudder_identity` nor returned to
Desktop. Supabase owns OTP storage and verification; Rudder adds
enumeration-safe UI responses, supplemental abuse controls, and security-event
logging.

### Desktop and Local Server

Desktop owns the user-facing launcher and all durable device credentials.
The renderer receives only a bounded account/session summary.

Desktop uses:

- system-browser Authorization Code + PKCE;
- a main-process ephemeral loopback callback;
- Device Authorization as fallback and the CLI-compatible path;
- Electron `safeStorage` or a platform-specific secure helper;
- memory-only sessions when Linux reports an insecure `basic_text` backend.

There are two deliberately separate PKCE layers. Supabase OAuth returns only
to `accounts.rudderhq.dev/auth/callback`; after that browser session is
verified, Rudder Identity maps the Supabase `sub` to the stable Rudder subject
and issues its own one-time Desktop authorization code to the loopback
callback. A Supabase authorization code is never used as a Desktop code, and
Desktop never stores a Supabase web refresh token.

After Rudder Identity login, Desktop requests a short-lived, audience-bound,
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

The signed grant carries two independent revocation domains. The
`localSignOutEpoch` is a Desktop-owned tombstone echoed by Identity only from
the current sign-in/refresh request; Identity must never derive it from a
server device epoch. `authSchemaEpoch`, `accountAuthEpoch`, and
`deviceAuthEpoch` are server-owned values used for online renewal and
cutover/revocation. Local sign-out advances only the encrypted local tombstone,
while server revocation advances only its corresponding server epoch.

### Production topology

- Vercel team: `zeelands-projects`
- Dedicated Vercel project: `rudder-identity`
- Production hostname: `accounts.rudderhq.dev`
- Function region: `sin1`
- Supabase project: `rudder` (`qroqfgbaifzeqlygafjr`)
- Supabase region: `ap-southeast-1`
- Supabase Auth Site URL: `https://accounts.rudderhq.dev`
- Google/GitHub provider callback:
  `https://qroqfgbaifzeqlygafjr.supabase.co/auth/v1/callback`
- Supabase redirect allow-list: production Identity callback, confirmation,
  and recovery URLs only; explicitly configured real-auth development uses a
  separate development project
- Production is hard-locked in code to Supabase project ref
  `qroqfgbaifzeqlygafjr`; a deployment variable cannot redefine that trust
  anchor. Startup fails when the configured URL points anywhere else, even
  when the URL and a supplied expected-ref variable agree with each other.
- Preview must declare its own expected project ref and must use a project
  separate from production. Startup fails when its configured URL does not
  match that ref or when the ref is `qroqfgbaifzeqlygafjr`.
- Resend sending domain: `updates.rudderhq.dev`
- Production sender: a dedicated Rudder Account address under the verified
  sending domain, configured through Supabase Custom SMTP

The current Supabase Organization is on the Free plan. Free, including its
50,000 MAU allowance, is permitted only for development and Canary. A stable
production release is blocked until the project is on Pro or an equivalent
paid plan with backups and no inactivity pause.

### Development root-auth selection

Development and test use `auto` selection:

- with no Supabase/Auth variables, `pnpm dev` starts a zero-configuration,
  in-process Root Identity Fixture. It is a complete local login system, not an
  authentication bypass: the real login UI, Email OTP, password lifecycle,
  web sessions, Desktop Device Authorization, Desktop PKCE, and Local exchange
  remain active;
- fixture email enters the local captured mailbox, and Google/GitHub use
  deterministic local mock providers;
- when a complete development Supabase URL and publishable key are present,
  the same service automatically uses real development Supabase Auth for
  Google/GitHub/email debugging;
- non-loopback hosted development/test Auth additionally requires an explicit
  allow-list of development project refs. The production ref
  `qroqfgbaifzeqlygafjr` is rejected in development/test even if it is
  accidentally allow-listed;
- a partial Supabase configuration is rejected rather than silently mixing
  fixture and hosted state;
- preview, Canary, and Stable never select the fixture. Missing hosted
  Supabase configuration fails closed before serving authenticated routes.

An explicit auth-bypass switch may remain for exceptional debugging, but it is
not the default developer path and is forbidden in packaged Canary/Stable
artifacts.

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

1. Freeze every Better Auth root-identity mutation before the migration
   window: registration, OAuth/OTP/password login that could create an
   account, email verification/change, password write/reset, provider
   link/unlink, and session minting. Export immutable legacy counts and
   checksums; keep the tables and old build available for one rollback window.
2. Add the private, unique `supabase_auth_user_binding` migration and a durable
   migration ledger keyed by normalized email and legacy subject, with
   `pending`, `auth_user_created`, `bound`, `linked`, `verified`, and `failed`
   states. Preserve the existing non-UUID Rudder subject and every device,
   Local claim, exchange, and Offline Grant reference.
3. Add a `RootIdentityAdapter` and Supabase server adapter. Validate sessions
   using the authoritative user/session path or verified issuer, audience,
   signature, expiry, and `session_id`; never authorize from decoded,
   unverified JWT data or user metadata.
4. Configure Supabase Auth for Google, GitHub, Email OTP, password/reset,
   automatic verified-email linking, PKCE callbacks, redirect allow-lists,
   password/session policy, and production Resend Custom SMTP.
5. Migrate each verified legacy email through the server-only Admin API. Before
   creation, preflight one-to-one uniqueness for normalized email, legacy
   subject, and Supabase UUID, and stamp the created user with server-managed
   `app_metadata` containing the migration batch and legacy subject. Admin
   creation and the private ledger/binding are not one transaction. On an
   unknown result, crash, or duplicate-email response, page the Admin user list
   for the exact normalized email, require the immutable snapshot plus
   migration marker/legacy subject to match, adopt that UUID into the ledger,
   and continue; otherwise stop for manual recovery. This closes the crash
   window before `auth_user_created` is persisted without risking a second
   user. Never insert directly into the managed Auth schema and never expose
   the secret/service key.
6. For the existing production owner, complete OTP reauthentication, explicitly
   link Google and GitHub from the authenticated Supabase account, and verify
   the provider subjects match the legacy records. Migration is idempotent and
   must leave exactly one `auth.users` row.
7. Replace Better Auth browser calls with the Supabase adapter while retaining
   the approved Rudder login card, official logo, Google/GitHub buttons, Email
   OTP primary path, password entry, recovery, and Account & Security UI.
8. Preserve the separate Rudder Desktop Authorization Code + PKCE flow,
   rotating device credentials, JWKS, one-time audience-bound Local Server
   exchange, Local Workspace claim, security events, and custom limits.
9. Replace the Better Auth Device Authorization plugin endpoints with
   Rudder-owned device-code endpoints. Approval requires a current Supabase web
   user; polling issues only a Rudder device session.
10. Cut over with Supabase as the only accepted web root and a distinct cookie
    namespace. Invalidate all Better Auth web sessions, Rudder device refresh
    credentials, and pending authorization codes. An auth schema epoch makes
    upgraded/online clients reject pre-cutover Offline Grants and require full
    re-login while preserving device records, the stable subject, and Local
    ownership. Fully offline old clients retain the documented maximum 30-day
    residual window.
11. Use Supabase-native `current`, `others`, and `global` web sign-out and a
    15-minute access-token lifetime. Sensitive password, device, and account
    actions additionally require an online `session_id` existence check.
    Before a Supabase password mutation or global sign-out, persist a private
    credential-revocation intent. Provider completion and Rudder credential
    revocation are separate retryable stages; every Rudder device access or
    refresh-token resolution fails closed while an intent is pending. Rudder
    devices remain independently revocable. Apply the session-action matrix
    below and durably record every security event.
12. Implement root-auth `auto` selection. Zero-config dev/test uses the
    in-process full Auth Fixture with captured mail and deterministic mock
    providers; complete Supabase development configuration selects real Auth.
    Partial configuration fails, and preview/Canary/Stable reject fixture,
    test issuers, test keys, production bypasses, and browser refresh-token
    persistence. Hard-lock production to `qroqfgbaifzeqlygafjr`; require
    Preview to declare a matching, separate non-production ref; allow only
    loopback or explicitly allow-listed non-production refs in development/test.
13. Run migration concurrency/failure tests and deterministic auth E2E, then
    real Google, GitHub, OTP, password/reset, Dashboard-count, device/session,
    Desktop PKCE, packaged Board/restart, and local-plaintext-storage checks.
14. Deploy Canary only after independent review and black-box verification.
    Stable remains blocked on Supabase Pro, backups/no pause, deliverability,
    and the listed product-contract decision.

### Session action matrix

Supabase sign-out revokes refresh-token reuse, but an already issued access JWT
can remain valid until its 15-minute expiry. All sensitive Identity mutations
therefore check that the JWT `session_id` still exists online.

| Action | Supabase web refresh sessions | Issued access JWT | Rudder device and Local sessions | Offline Grant |
| --- | --- | --- | --- | --- |
| Set first password | Keep current and other sessions | Valid to expiry; online check for the mutation | Keep | Keep |
| Change password | Keep current and other sessions by default; optional “sign out others” revokes `others` | Revoked sessions can read only until expiry; sensitive actions fail online check | Keep by default; the explicit “sign out others” option revokes every Rudder Desktop cloud credential because a browser session cannot safely identify one Desktop as “current” | Keep unless “sign out others” is selected; only then advance the account/device revoke epoch |
| Forgot/reset password | Revoke `global` | Old JWTs expire within 15 minutes and fail sensitive online checks immediately | Revoke every Rudder Desktop cloud credential. An already-issued Local Server session ends at local expiry or its next identity/epoch synchronization; the cloud response must not claim immediate Local deletion | Upgraded/online clients reject the new epoch; fully offline old clients may retain access until original expiry |
| Sign out current | Revoke `current` | Valid only to expiry; sensitive actions fail online check | Keep Rudder devices and Local Server sessions; a browser session has no trustworthy current-Desktop mapping | Keep |
| Sign out others | Revoke `others` | Other JWTs expire within 15 minutes and fail sensitive online checks | Keep Rudder devices and Local Server sessions; they remain independently visible and revocable | Keep |
| Sign out all | Revoke `global` | All old JWTs expire within 15 minutes and fail sensitive online checks | Revoke all Rudder Desktop cloud credentials. Already-issued Local Server sessions end at local expiry or next identity/epoch synchronization, not synchronously from the cloud request | Current client deletes on its next online synchronization; upgraded/online clients reject the new epoch; fully offline residual is bounded by original expiry |

## External Production Configuration

The following production resources are required:

- Google Cloud project and OAuth consent brand dedicated to Rudder Account;
- Google Web OAuth client with the Supabase Auth callback;
- GitHub OAuth App dedicated to the Supabase Auth callback; because a GitHub
  OAuth App has one callback URL, use a new app or an atomic maintenance-window
  switch so the Better Auth rollback path is not silently broken early;
- Resend production sender configured in Supabase Custom SMTP, including
  templates, provider/Supabase rate limits, delivery monitoring, and a retained
  rollback credential for the previous Supabase-adapter deployment;
- Vercel production project with Supabase URL/publishable key and a server-only
  secret/service key;
- Supabase runtime pooler URL and separately scoped migration URL;
- independent Rudder device/exchange/offline-grant signing keys;
- Terms, Privacy, account-deletion, and security-contact URLs.

No secret value may be committed, printed in tests, included in screenshots, or
returned to the renderer. Development, preview, and E2E must not connect to the
production Identity database.

## Implementation Status

The Better Auth vertical slice was implemented and independently verified,
including the login UI, official Rudder logo, Google/GitHub/OTP/password,
verified-email linking, device/session flows, packaged Desktop gate, private
schema, and production deployment. It is now explicitly superseded as the root
identity architecture and must not be released as the next Rudder Account
version.

Migration audit is complete. Supabase Auth currently has no users, identities,
or sessions; the one verified production account and its two providers remain
in `rudder_identity`. The account has no password or provider token to migrate.
The binding migration, Supabase adapter, managed Auth configuration, controlled
account import/linking, session cutover, and new black-box verification are not
yet complete.

Canary publication is paused until Supabase Auth is the only web root and an
independent reviewer and packaged black-box verifier pass every required login
path. Stable publication has the additional paid-plan and backup gates below.

## Success Criteria

- A new packaged Desktop user must authenticate through Rudder Account before
  entering Local Rudder.
- Google, GitHub, Email OTP, and password login work in deterministic E2E and
  controlled production smoke.
- Every formal account exists in Supabase `auth.users` and appears in
  Dashboard `Authentication -> Users`; the migrated owner has one user and the
  expected Google/GitHub identities, never duplicate users.
- Same verified email across supported methods resolves to one account;
  unverified email never auto-links.
- Password reset invalidates the old password and other long-lived sessions.
- Web sessions support Supabase-native current/others/global sign-out; Rudder
  devices are visible and independently revocable.
- Migration preserves the existing stable Rudder subject, device records,
  Local Workspace claim, and security history while invalidating Better Auth
  web sessions and Rudder device credentials. Upgraded/online clients reject
  pre-cutover Offline Grants; a fully offline old client retains only its
  original maximum 30-day residual.
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
- Migration idempotency, same-email concurrency, non-UUID legacy-subject
  mapping, provider-subject equality, partial-failure recovery, counts, and
  checksums.
- Unit and service tests for OTP security, password lifecycle, account-link
  concurrency, sessions, devices, authorization codes, exchange replay,
  security events, and log redaction.
- E2E for all four login methods, password recovery, account linking,
  unverified-email rejection, session revocation, Device Authorization, legacy
  Local claim, Organization isolation, and logout.
- Zero-variable `pnpm dev` black-box login through fixture OAuth, OTP,
  password, sessions, Device Authorization, PKCE, and captured mailbox;
  complete development Supabase variables select real Auth; partial variables
  fail; preview/Canary/Stable without hosted configuration fail closed.
- Desktop black-box PKCE, vault persistence, Linux insecure-vault fallback,
  offline grant, renderer boundary, and sign-out tests.
- Real Google, GitHub, and Resend smoke using dedicated non-personal test
  accounts/mailboxes.
- Supabase Dashboard verification for the unique user and linked identities,
  plus database verification that the binding points to the unchanged Rudder
  subject.
- Packaged Desktop Google, GitHub, OTP, and password flows through Board entry
  and restart; inspect the real profile to prove no Supabase/browser refresh
  token or Local Workspace content is persisted outside intended vault/data
  boundaries.
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

- Before Supabase public admission, Identity deployment remains independently
  versioned and a feature/provider flag may return the service to the
  preserved Better Auth snapshot/build, explicitly ending the maintenance
  freeze before it accepts new identity mutations. The binding migration is
  additive and Supabase users/identities are not deleted during rollback.
- After the first new Supabase-only user is admitted, rollback to Better Auth
  would fork identity state and is prohibited. Roll back only to a previous
  Supabase-adapter build or forward-fix while preserving Auth users,
  identities, and bindings.
- Migration runs in a maintenance window: freeze all Better root-identity
  mutations, export counts/checksums, advance the durable migration ledger,
  create and bind users idempotently, verify, then cut over. A partial failure
  leaves Better Auth authoritative until the entire owner migration passes.
- All Better Auth web sessions use a separate cookie namespace and are
  invalidated at cutover. Rudder device refresh credentials are revoked.
  Upgraded/online clients reject pre-cutover Offline Grants through a recorded
  epoch and complete one full login; fully offline old clients retain only the
  already documented maximum 30-day residual. Stable Rudder subjects preserve
  device records and Local ownership; no Local Workspace is re-claimed or
  uploaded.
- Legacy `local-board` authority is transferred only inside the successful
  claim transaction.
- A failed login or expired grant never deletes Local data.
- Production OAuth apps and Resend credentials can be revoked independently.
- Before public Supabase admission, the previous Better Auth package is a
  binary rollback point. After admission, only a package already compatible
  with the Supabase adapter, binding, cookie namespace, and session semantics
  may be used as a binary rollback point.

## Open Issues and Release Gates

- The Supabase `Zeeland` organization is currently Free. Free/50k MAU is
  permitted only for development and Canary. Pro or equivalent paid service,
  backups, and no inactivity pause are stable-production gates.
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
- Supabase exposes current/others/global web-session sign-out rather than an
  arbitrary public per-session revoke API. The proposed
  `IDENTITY.DEVICE.SESSION.001` wording must reflect that web-session model
  while retaining per-device revocation; this specific `doc/product/**`
  semantic delta still requires explicit authorization.
