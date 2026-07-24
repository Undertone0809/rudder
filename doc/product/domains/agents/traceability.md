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

Task 1 data-contract evidence lives in
`packages/db/src/mcp-connections-schema.test.ts`,
`packages/db/src/migrations/managed-mcp-connections.test.ts`,
`packages/shared/src/validators/mcp.test.ts`, and
`scripts/managed-mcp-product-contract.test.mjs`. Server, adapter, and UI
evidence is added by the implementation tasks that own those layers.
