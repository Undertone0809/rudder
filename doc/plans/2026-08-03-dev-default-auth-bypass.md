---
title: Dev default local workspace access and auth capabilities
date: 2026-08-03
kind: implementation
status: in_progress
area: desktop
entities:
  - desktop_auth
  - identity_providers
  - local_trusted
issue:
related_plans:
  - 2026-07-29-rudder-account-production-login.md
supersedes: []
related_code:
  - scripts/dev-shell.mjs
  - identity/src/handler.ts
  - desktop/src/boot-screen.ts
commit_refs: []
updated_at: 2026-08-03
---

# Dev Default Local Workspace Access and Auth Capabilities

## Decision

`pnpm dev` and `pnpm dev:watch` default to local workspace access without the
Desktop Account Gate. `RUDDER_DESKTOP_AUTH_BYPASS=0` explicitly restores the
full development authentication flow for testing. Packaged, Preview, Canary,
and Stable clients remain account-gated.

The development Identity service continues to run so the complete fixture flow
can be tested when the bypass is disabled. Email OTP is the email sign-in and
registration path: a new verified email creates an account without requiring a
password.

Google and GitHub are exposed only when the matching complete client
configuration is present. Missing or indeterminate provider capabilities are
hidden from the UI and rejected by the OAuth endpoint.

## Contract Delta

This implementation updates `CLIENT.AUTH.RELEASE.ISOLATION.001` to distinguish
the explicit development-only local access default from the full fixture login
path. It updates `IDENTITY.AUTH.001` so supported provider presentation follows
runtime capabilities and email OTP is visibly usable as registration. Release
authentication, account/device boundaries, and Local data privacy remain
unchanged.

## Acceptance

- A fresh `pnpm dev` Desktop opens the Local Workspace without a login screen.
- `RUDDER_DESKTOP_AUTH_BYPASS=0 pnpm dev` shows only configured OAuth providers
  and a clear email sign-in/create-account path.
- Provider-free Identity does not render or accept Google/GitHub OAuth.
- A new email can complete OTP verification and obtain the same Desktop/local
  authorization path as an existing email.
- Packaged Desktop still shows the Account Gate while signed out, regardless of
  the bypass environment variable.
- Relevant unit, Identity UI/E2E, Desktop smoke, product-logic, typecheck,
  lint, test, build, and packaged verification checks pass.
