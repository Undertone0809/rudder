---
title: Authentication Release Isolation And Local Data Boundary
domain: identity-and-access
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - CLIENT.AUTH.RELEASE.ISOLATION.001
  - PRIVACY.LOCAL.DATA.BOUNDARY.001
related_code:
  - packages/identity-core/src/release-policy.ts
  - identity/src/config.ts
  - identity/src/runtime.ts
  - scripts/dev-identity-env.mjs
  - desktop/src/identity-startup-policy.ts
  - desktop/src/identity-credential-vault.ts
  - server/src/routes/access.ts
related_tests:
  - packages/identity-core/src/release-policy.test.ts
  - identity/src/config.test.ts
  - identity/src/root-identity-fixture.test.ts
  - scripts/dev-identity-env.test.mjs
  - scripts/release-workflow-contract.test.mjs
  - desktop/src/identity-startup-policy.test.ts
  - desktop/src/identity-credential-vault.test.ts
  - server/src/__tests__/cli-auth-routes.test.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-29-rudder-account-production-login.md
edit_policy: user_confirmed_only
---

# Authentication Release Isolation And Local Data Boundary

## CLIENT.AUTH.RELEASE.ISOLATION.001

### Contract Summary

Development can run a complete zero-configuration authentication fixture, but
Preview, Canary, and Stable fail closed unless configured for their intended
hosted Supabase Auth environment. Test identity capability is not a releasable
runtime option.

### Intent / User Job

Contributors get a working login flow from `pnpm dev`, while release users
cannot be authenticated by fixture keys, mock providers, test issuers, or an
environment-variable bypass.

### Why / Design Reasoning

Zero-configuration development must still exercise login. Release security
cannot rely only on mutable deployment variables, so channel and capability
policy must reject incompatible identity material before authenticated routes
are served.

### Actors / Objects / State

- Contributor, release operator, Identity runtime, Desktop, auth capability
  policy, Supabase project ref, fixture issuer, bypass, and test marker.
- Modes: development auto-fixture, development hosted, explicit debug bypass,
  packaged test, Preview, Canary, and Stable.

### Entry Points / Inputs

- `pnpm dev`, Supabase URL/publishable key, development project-ref allow-list,
  release channel, Vercel environment, packaged test marker, and bypass request.

### Product Logic Flow

1. With no Supabase/Auth variables, development selects the in-process fixture
   and runs real UI, OTP/password, mock OAuth, sessions, PKCE, Device
   Authorization, and Local exchange.
2. A complete development Supabase configuration selects hosted Auth; partial
   configuration is rejected rather than mixed with fixture state.
3. Hosted development/test rejects the production project ref even if listed.
4. Preview requires its declared non-production ref. Production is pinned to
   the production ref. A URL/ref mismatch fails startup.
5. Canary and Stable reject fixture, bypass, test issuer/keys/marker, and
   missing hosted configuration. Packaged test and publishable artifacts remain
   distinct outputs.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Zero-config dev | No Auth variables | Complete fixture login | Anonymous default bypass | Dev-env/fixture tests |
| Hosted dev | Complete allowed dev ref | Real development Supabase | Connect production | Config tests |
| Partial config | Some required values missing | Fail with configuration error | Mix fixture and hosted state | Config tests |
| Canary/Stable | Fixture, bypass, test marker, or missing hosted config | Fail closed | Serve Board/login under test trust | Release tests/smoke |

### Actor-Visible Input

Developers see the normal login UI and captured mailbox/mock providers. Release
operators receive an actionable startup/configuration failure, not a silent
fallback.

### Operator-Visible Output

Published artifacts use only their pinned hosted issuer and cannot enable the
development bypass after packaging.

### Persisted Evidence

Build/channel policy and deployment configuration identify the selected trust
boundary. Fixture users/mail remain local to the development process and do not
enter production Auth.

### Canonical Scenarios

1. `pnpm dev` with no Auth variables completes fixture OTP and Desktop login.
2. Full development variables select a non-production Supabase project.
3. A Canary containing a test marker refuses to start.

### Invariants / Non-Goals

- Fixture is full authentication, not anonymous bypass.
- Production project ref is forbidden in dev/test and mandatory in production.
- Stable additionally requires its operational availability/backup gates; this
  contract does not purchase or configure the Supabase plan.

### Drift Boundaries

Update for mode selection, issuer/project pinning, bypass, test-marker, build
manifest, or release fail-closed behavior.

### Traceability

Release policy/config/dev-env tests, workflow contract, startup policy, and
packaged smoke prove mode selection and artifact isolation.

## PRIVACY.LOCAL.DATA.BOUNDARY.001

### Contract Summary

Rudder Account login sends only identity, device, connection, abuse-prevention,
and security-event data required for authentication. It does not upload Local
Workspace work content or runtime/provider credentials to Rudder Identity.

### Intent / User Job

Operators can use a Rudder Account while keeping Local work local and can sign
out, recover, or lose an offline grant without losing Local data.

### Why / Design Reasoning

Authentication requires honest processing of account/security data, but it
must not become an implicit synchronization or telemetry channel for Local work.
The browser, Desktop renderer, Local Server, and credential vault each enforce
part of this boundary.

### Actors / Objects / State

- Operator, Rudder Identity, Supabase Auth, Desktop, Local Server, OS vault,
  browser cache, and Local Workspace.
- Identity data: email, provider subject, session/device metadata, exchange
  audience, rate-limit signal, and security event.
- Local-only data: Organizations, tasks, agents, prompts, files, transcripts,
  runs, paths, runtime credentials, and provider credentials.

### Entry Points / Inputs

- Login, callback, Desktop authorization/refresh, Local exchange/offline grant,
  password reset, device revoke, sign-out, and account deletion.

### Product Logic Flow

1. Identity requests and responses contain only the bounded account/device and
   authorization fields required by their contract.
2. Provider and Supabase refresh tokens remain inside their owning root-auth
   boundary; Rudder device credentials remain in the OS vault.
3. Local exchange carries verified account claims and target binding, not Local
   work content.
4. Auth/challenge responses use no-store cache controls; renderer IPC returns a
   bounded summary and never a long-lived credential.
5. Sign-out, revoke, password recovery, account deletion, or grant expiry
   changes authorization only. Local-data deletion remains a separate explicit
   operation.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Login/refresh | Identity fields required | Process account/device data | Upload workspace content | Identity E2E |
| Renderer state | Current Desktop renderer asks | Bounded account/device summary | Return refresh/provider token | IPC/vault tests |
| Auth HTTP response | Account/challenge payload | No-store headers | Persist identity payload in Chromium cache | CLI auth tests |
| Sign-out/expiry | Authorization ends | Preserve Local files and DB | Treat auth action as Local deletion | Local/packaged smoke |

### Actor-Visible Input

Login copy states that identity and devices are connected while Local Workspace
content stays on the machine. Privacy and Terms links remain available.

### Operator-Visible Output

Auth operations expose only account/device state and honest recovery effects.
The operator is never told that Rudder processes no data at all.

### Persisted Evidence

Supabase and Identity persist only the root identity, device, authorization,
rate-limit, and security records. Local work stays in Local storage; durable
Desktop secrets are encrypted and auth HTTP payloads are non-cacheable.

### Canonical Scenarios

1. Google login connects a device without storing Google tokens in Desktop.
2. Restart preserves the secure device session and Local Board without browser
   cache copies of account responses.
3. Sign-out returns to the gate while the Local Workspace remains unchanged.

### Invariants / Non-Goals

- Login is not Local Workspace upload, backup, migration, or telemetry opt-in.
- External model providers may receive explicitly selected run inputs under
  their own integration; that is not Rudder Identity data processing.
- Remote Server and Local-to-Remote migration data contracts are out of scope.

### Drift Boundaries

Update for any new Identity field, telemetry, cache/persistence location,
credential exposure, Local upload, or coupling between auth and data deletion.

### Traceability

Identity E2E, Desktop credential/IPC tests, Local auth tests, no-store route
tests, and packaged profile scans prove the enforced data boundary.
