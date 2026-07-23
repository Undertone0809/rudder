# Deployment Modes

Status: Canonical deployment and auth mode model  
Date: 2026-02-23

## 1. Purpose

Rudder supports two runtime modes:

1. `local_trusted`
2. `authenticated`

`authenticated` supports two exposure policies:

1. `private`
2. `public`

This keeps one authenticated auth stack while still separating low-friction private-network defaults from internet-facing hardening requirements.

## 2. Canonical Model

| Runtime Mode | Exposure | Human auth | Primary use |
|---|---|---|---|
| `local_trusted` | n/a | No login required | Single-operator local machine workflow |
| `authenticated` | `private` | Login required | Private-network access (for example Tailscale/VPN/LAN) |
| `authenticated` | `public` | Login required | Internet-facing/cloud deployment |

## 3. Security Policy

## `local_trusted`

- loopback-only host binding
- no human login flow
- optimized for fastest local startup

## `authenticated + private`

- login required
- low-friction URL handling (`auto` base URL mode)
- private-host trust policy required

## `authenticated + public`

- login required
- explicit public URL required
- stricter deployment checks and failures in doctor

## Managed MCP Deployment Policy

Managed custom MCP servers use instance-administrator environment allowlists
for exceptions to the default network and process boundary:

- `RUDDER_MCP_HTTP_ALLOWLIST`: comma-separated exact HTTP(S) origins. Public
  HTTPS needs no entry; HTTP, loopback, private, link-local, and reserved
  targets require an exact origin entry. Every DNS answer and redirect target
  is still validated and the request is connected to a pinned address.
- `RUDDER_MCP_STDIO_COMMAND_ALLOWLIST`: JSON array of exact argv arrays accepted
  in `authenticated` mode, for example
  `[["/opt/mcp/acme","--stdio"],["/usr/local/bin/node","/opt/mcp/server.mjs"]]`.
  The executable must be absolute, and its real path plus every argument must
  match one configured entry.
- `RUDDER_MCP_STDIO_CWD_ALLOWLIST`: comma-separated exact working directories
  accepted in `authenticated` mode.
- `RUDDER_MCP_STDIO_ENV_ALLOWLIST`: comma-separated environment variable names
  that an authenticated managed MCP process may receive.

`local_trusted` permits custom STDIO commands because it is a single-operator
host boundary. `authenticated` denies STDIO commands, working directories, and
environment names unless all requested values are allowlisted. Organization
owners cannot extend these instance-level lists through a connection payload.
Legacy SSE is not a managed MCP transport; remote MCP uses Streamable HTTP.

## 4. Onboarding UX Contract

Default onboarding remains interactive and flagless:

```sh
pnpm rudder onboard
```

Server prompt behavior:

1. ask mode, default `local_trusted`
2. option copy:
- `local_trusted`: "Easiest for local setup (no login, localhost-only)"
- `authenticated`: "Login required; use for private network or public hosting"
3. if `authenticated`, ask exposure:
- `private`: "Private network access (for example Tailscale), lower setup friction"
- `public`: "Internet-facing deployment, stricter security requirements"
4. ask explicit public URL only for `authenticated + public`

`configure --section server` follows the same interactive behavior.

## 5. Doctor UX Contract

Default doctor remains flagless:

```sh
pnpm rudder doctor
```

Doctor reads configured mode/exposure and applies mode-aware checks. Optional override flags are secondary.

## 6. Board/User Integration Contract

Board identity must be represented by a real DB user principal for user-based features to work consistently.

Required integration points:

- real user row in `authUsers` for Board identity
- `instance_user_roles` entry for Board admin authority
- `company_memberships` integration for user-level task assignment and access

This is required because user assignment paths validate active membership for `assigneeUserId`.

## 7. Local Trusted -> Authenticated Claim Flow

When running `authenticated` mode, if the only instance admin is `local-board`, Rudder emits a startup warning with a one-time high-entropy claim URL.

- URL format: `/board-claim/<token>?code=<code>`
- intended use: signed-in human claims board ownership
- claim action:
  - promotes current signed-in user to `instance_admin`
  - demotes `local-board` admin role
  - ensures active owner membership for the claiming user across existing companies

This prevents lockout when a user migrates from long-running local trusted usage to authenticated mode.

## 8. Current Code Reality (As Of 2026-02-23)

- runtime values are `local_trusted | authenticated`
- `authenticated` uses Better Auth sessions and bootstrap invite flow
- `local_trusted` ensures a real local Board user principal in `authUsers` with `instance_user_roles` admin access
- company creation ensures creator membership in `company_memberships` so user assignment/access flows remain consistent

## 9. Naming and Compatibility Policy

- canonical naming is `local_trusted` and `authenticated` with `private/public` exposure
- no long-term compatibility alias layer for discarded naming variants

## 10. Relationship to Other Docs

- implementation plan: `doc/plans/deployment-auth-mode-consolidation.md`
- Historical V1 baseline: `doc/archive/SPEC-implementation.md`
- operator workflows: `doc/engineering/DEVELOPING.md` and `doc/engineering/CLI.md`
