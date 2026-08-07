---
title: Agent Traceability
domain: agents
status: active
coverage: seed
contract_ids: []
related_code:
  - server/src/services/agent-run-context.ts
  - server/src/services/agent-instructions.ts
related_tests:
  - server/src/__tests__/agent-instructions-service.test.ts
edit_policy: user_confirmed_only
---

# Agent Traceability

Use `doc/product/registry.yml` as the machine-readable source for agent contract
to code/test mappings.

## Managed MCP OAuth Integrations

The approved
`doc/plans/2026-07-23-managed-mcp-oauth-integrations.md` change spans three
active agent contracts:

- `AGENT.CUSTOM.INTEGRATIONS.001` owns organization-managed connection,
  provider OAuth, discovery, agent binding, dispatch audit, custom STDIO/HTTP,
  and `legacy_manual` compatibility behavior.
- `AGENT.CONTROL.TOOLS.001` owns the separation between external MCP proxies
  and the first-party `rudder-tools` server plus the provider-neutral
  `managedExternalMcpBindings` runtime contract.
- `AGENT.RUNTIME.PERMISSIONS.001` owns OAuth token, run identity, network,
  STDIO process, and environment-variable boundaries.

The approved
`doc/plans/2026-07-25-managed-mcp-access-and-interactions.md` refinement keeps
the same ownership split while adding official-provider canonical identity,
Supabase account scope, Discover/Manage modal behavior, coarse Agent access,
server-derived fail-closed capability policy, run-start policy snapshots, and
two-phase OAuth replacement.

The approved
`doc/plans/2026-07-27-managed-mcp-connection-scopes.md` refinement adds
immutable Organization and Agent connection targets, independent OAuth
credentials, target-specific official uniqueness, automatic Organization
inheritance, Agent-first runtime resolution, explicit-deny behavior, and
revocation fallback. Primary implementation evidence lives in
`packages/db/src/schema/mcp_connections.ts`,
`server/src/services/mcp/managed-connections.ts`,
`server/src/services/mcp/managed-bindings.ts`,
`ui/src/pages/OrganizationMcpSettings.tsx`, and
`ui/src/pages/AgentDetail.integrations.tsx`. Regression evidence lives in the
managed MCP connection/binding service tests, both integration page tests, and
the managed MCP connection-scope E2E workflow.

The approved `doc/plans/2026-08-07-github-managed-mcp.md` and
`doc/plans/2026-08-07-github-mcp-pat.md` additions extend the same ownership
split with curated GitHub PAT setup. `createMcpConnectionSchema` and the
generic connection route are Custom-only; GitHub uses the provider-specific
connect/reconnect lifecycle, account scope, fixed endpoint, encrypted managed
credential, and provider-neutral runtime forwarding. Regression evidence lives
in the shared validator, provider registry, connection service/routes, binding,
runtime, UI, migration, and managed MCP E2E tests listed in the registry.

Task 1 data-contract evidence lives in
`packages/db/src/mcp-connections-schema.test.ts`,
`packages/db/src/migrations/managed-mcp-connections.test.ts`,
`packages/shared/src/validators/mcp.test.ts`, and
`scripts/managed-mcp-product-contract.test.mjs`. Server, adapter, and UI
evidence is added by the implementation tasks that own those layers.
