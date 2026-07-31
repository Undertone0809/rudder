---
title: Identity And Access Domain
domain: identity-and-access
status: active
coverage: seed
contract_ids: []
related_code:
  - identity/src/handler.ts
  - desktop/src/identity-runtime.ts
  - server/src/services/local-account-auth.ts
related_tests:
  - identity/src/identity.e2e.test.ts
  - server/src/__tests__/local-account-auth.test.ts
  - desktop/scripts/smoke.mjs
edit_policy: user_confirmed_only
---

# Identity And Access Domain

## Owns

- Rudder Account root authentication and verified identity linking.
- Web, Desktop device, and Local Server authentication boundaries.
- Desktop authorization, device revocation, and offline Local authorization.
- Authentication release isolation and the login-specific Local data boundary.

## Does Not Own

- Organization identity, membership, roles, or invitations. See `ORG.*`.
- Desktop startup presentation and recovery. See `DESKTOP.STARTUP.RECOVERY.001`.
- Local runtime and Built-in Browser capabilities. See
  `AGENT.RUNTIME.PERMISSIONS.001` and `AGENT.BROWSER.001`.
- Remote Server discovery, Local-to-Remote migration, Computer enrollment, or
  Runtime Discovery.

## Contract Index

- `IDENTITY.AUTH.001`: Supabase Auth is the Rudder Account root and formal
  builds require one of the supported login methods before Board entry.
- `IDENTITY.ACCOUNT.LINKING.001`: supported login identities converge
  automatically only through the same safely normalized verified email.
- `IDENTITY.DEVICE.SESSION.001`: web, Desktop device, and Local sessions remain
  separate, with bounded PKCE and revocation semantics.
- `IDENTITY.SERVER.EXCHANGE.001`: a short-lived one-time exchange creates a
  Local principal without granting Organization authority by itself.
- `IDENTITY.LOCAL.OFFLINE.001`: Local offline access is device-bound,
  proof-of-possession protected, and limited to 30 days.
- `CLIENT.AUTH.RELEASE.ISOLATION.001`: development fixtures and test issuers
  cannot become release authentication capabilities.
- `PRIVACY.LOCAL.DATA.BOUNDARY.001`: account login does not upload Local work
  content or runtime/provider credentials to Rudder Identity.
