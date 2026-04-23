# Agent Authentication — P0 Local Adapter JWT Implementation

## Scope

- In-scope adapters: `claude_local`, `codex_local`.
- Goal: zero-configuration auth for local adapters while preserving static keys for all other call paths.
- Out-of-scope for P0: rotation UX, per-device revocation list, and CLI onboarding.

## 1) Token format and config

- Use HS256 JWTs with claims:
  - `sub` (agent id)
  - `company_id`
  - `adapter_type`
  - `run_id`
  - `iat`
  - `exp`
  - optional `jti` (run token id)
- New config/env settings:
  - `RUDDER_AGENT_JWT_SECRET`
  - `RUDDER_AGENT_JWT_TTL_SECONDS` (default: `172800`)
  - `RUDDER_AGENT_JWT_ISSUER` (default: `rudder`)
  - `RUDDER_AGENT_JWT_AUDIENCE` (default: `rudder-api`)

## 2) Dual authentication path in `actorMiddleware`

1. Keep the existing DB key lookup path unchanged (`agent_api_keys` hash lookup).
2. If no DB key matches, add JWT verification in `server/src/middleware/auth.ts`.
3. On JWT success:
   - set `req.actor = { type: "agent", agentId, companyId }`.
   - optionally guard against terminated agents.
4. Continue board fallback for requests without valid authentication.

## 3) Opt-in adapter capability

1. Extend `ServerAgentRuntimeModule` (likely `packages/agent-runtime-utils/src/types.ts`) with a capability flag:
   - `supportsLocalAgentJwt?: true`.
2. Enable it on:
   - `server/src/agent-runtimes/registry.ts` for `claude_local` and `codex_local`.
3. Keep `process`/`http` adapters unset for P0.
4. In `server/src/services/heartbeat.ts`, when adapter supports JWT:
   - mint JWT per heartbeat run before execute.
   - include token in adapter execution context.

## 4) Local env injection behavior

1. In:
   - `packages/agent-runtimes/claude-local/src/server/execute.ts`
   - `packages/agent-runtimes/codex-local/src/server/execute.ts`

   inject `RUDDER_API_KEY` from context token.

- Preserve existing behavior for explicit user-defined env vars in `agentRuntimeConfig.env`:
  - if user already sets `RUDDER_API_KEY`, do not overwrite it.
- Continue injecting:
  - `RUDDER_AGENT_ID`
  - `RUDDER_ORG_ID`
  - `RUDDER_API_URL`

## 5) Documentation updates

- Update operator-facing docs to remove manual key setup expectation for local adapters:
  - `skills/rudder/SKILL.md`
  - `cli/src/commands/heartbeat-run.ts` output/help examples if they mention manual API key setup.

## 6) P0 acceptance criteria

- Local adapters authenticate without manual `RUDDER_API_KEY` config.
- Existing static keys (`agent_api_keys`) still work unchanged.
- Auth remains company-scoped (`req.actor.companyId` used by existing checks).
- JWT generation and verification errors are logged as non-leaking structured events.
- Scope remains local-only (`claude_local`, `codex_local`) while adapter capability model is generic.
