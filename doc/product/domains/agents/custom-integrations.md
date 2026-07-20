---
title: Agent Custom Integrations
domain: agents
status: active
coverage: current
spec_depth: logic_contract
contract_ids:
  - AGENT.CUSTOM.INTEGRATIONS.001
related_code:
  - packages/db/src/schema/custom_integrations.ts
  - packages/shared/src/types/custom-integration.ts
  - packages/shared/src/validators/custom-integration.ts
  - server/src/services/integrations/custom-integrations.ts
  - server/src/routes/agents.ts
  - server/src/services/agent-run-context.ts
  - ui/src/api/agents.ts
  - ui/src/pages/AgentDetail.integrations.tsx
related_tests:
  - server/src/__tests__/custom-integrations-service.test.ts
  - ui/src/pages/AgentDetail.integrations.test.tsx
  - tests/e2e/agent-detail-integrations-tab.spec.ts
related_plans:
  - doc/plans/2026-06-27-agent-custom-integrations.md
edit_policy: user_confirmed_only
---

# Agent Custom Integrations

## AGENT.CUSTOM.INTEGRATIONS.001

### Contract Summary

Rudder supports custom agent integrations for `custom_api` and `mcp_server`
entries. A custom integration belongs to one organization, is either
organization-scoped or agent-scoped, stores credentials as organization secrets,
binds an allowlist of tools to agents, and exposes only enabled tool summaries
to runtime prompt assembly.

### Intent / User Job

Operators need to connect internal APIs, remote MCP servers, and organization
specific tools to agent work loops without waiting for each provider to become a
first-party Rudder integration. Some tools are shared infrastructure; others
are personal or identity-bound and must attach to exactly one agent.

### Why / Design Reasoning

Custom integrations are agent-visible runtime capabilities, not generic global
settings. The product separates them from fixed provider integrations such as
Feishu because fixed providers may have provider-specific identity, chat, and
runtime semantics. Custom integrations need explicit organization, owner-agent,
binding, tool, credential, and audit records so Rudder can enforce scope before
any prompt or tool-call surface sees them.

Rudder's first-party operating-layer MCP server is not a custom integration. It is
runtime-owned built-in infrastructure exposed as `rudder-operating-layer` during
supported agent runs. Agent Detail may show this built-in operating-layer tool
surface so operators understand what the runtime can call, but operators do not
configure its URL, credentials, binding, or tool allowlist from the custom
integration setup flow. `AGENT.CONTROL.TOOLS.001` owns the runtime injection,
tool naming, identity, and fallback semantics for that built-in surface.

### Actors / Objects / State

- Board operator: creates, configures, binds, and revokes custom integrations
  from Agent Detail Integrations.
- Agent: may read its own enabled custom tools through runtime prompt context.
- Custom integration: organization-owned definition with `kind`, `scope`,
  display metadata, non-secret config, status, and optional credential secret.
- Custom integration tool: Rudder-namespaced callable tool metadata owned by a
  custom integration.
- Agent custom integration binding: per-agent status and enabled-tool allowlist.
- Custom integration tool call: sanitized audit evidence for attempted custom
  tool dispatch.
- Rudder MCP tools: built-in, runtime-managed operating-layer tools represented
  as a read-only Agent Detail Manage row, not persisted custom integration rows.

### Entry Points / Inputs

- `GET /api/agents/:id/custom-integrations` lists custom integrations bound to
  the agent.
- `POST /api/agents/:id/custom-integrations` creates a new custom integration
  and creates the initial binding for that agent.
- `PATCH /api/agents/:id/custom-integrations/:integrationId/binding` updates or
  creates a binding allowlist for an existing integration.
- `DELETE /api/agents/:id/custom-integrations/:integrationId` revokes the
  binding. Agent-scoped integrations are also revoked as definitions.
- `POST /api/agents/:id/custom-integrations/:integrationId/tool-calls` records
  a validated blocked audit event for the first implementation slice.
- Agent Detail Integrations exposes Custom API and MCP Server setup controls.
- Agent Detail Integrations Manage exposes a read-only built-in `Rudder MCP
  tools` row for the first-party `rudder-operating-layer` Agent V1 MCP server.

### Product Logic Flow

1. The operator opens Agent Detail Integrations and chooses Custom API or MCP
   Server.
2. The operator chooses `This agent` or `Organization` scope.
3. Rudder stores non-secret config on the custom integration row and stores
   credential material as an organization secret when provided.
4. Rudder creates tool rows with organization-unique, Rudder-namespaced tool
   names such as `custom.linear-mcp.search_issues`.
5. Rudder creates an active binding for the selected agent and stores only
   enabled tool ids on that binding.
6. Runtime prompt assembly reads only active integrations with active bindings
   for the exact organization and agent.
7. Runtime prompt text lists tool names, integration display names, kind, scope,
   external tool names, and descriptions. It never includes credential ids,
   secret values, or raw credential material.
8. Tool-call audit creation validates organization, agent, integration, binding,
   and enabled-tool ownership before persisting a sanitized blocked event.
9. Separately, Agent Detail Manage can show built-in Rudder MCP tools using the
   Rudder logo, server name, runtime-managed auth label, and full exposed tool
   list. This row is informational and cannot be configured or disconnected
   through custom integration actions.

### Decision Table

| Case | Result |
| --- | --- |
| Organization-scoped integration bound to another agent in the same organization | Allowed when the tool ids belong to that integration. |
| Organization-scoped integration referenced from another organization | Rejected as not found or forbidden. |
| Agent-scoped integration referenced by a non-owner agent | Rejected. |
| Revoked binding | Hidden from runtime prompts and disabled in UI actions. |
| Disabled or non-allowlisted tool | Hidden from runtime prompts and rejected for tool-call audit. |
| Credential value is provided on create | Stored as an organization secret; not returned in API summaries. |
| Both `credential` and `credentialSecretId` are provided | Rejected. |
| Tool dispatch is requested in this implementation slice | Validated and recorded as `blocked` with `dispatch_not_implemented`. |
| Operator opens Discover | Shows Custom API, MCP Server, fixed-provider setup, and planned provider cards; does not show built-in Rudder MCP tools. |
| Operator opens Manage | Shows active fixed/custom integrations plus the built-in Rudder MCP tools row when available. |

### Actor-Visible Input

The operator supplies display name, optional description, scope, endpoint
configuration, optional credential value or credential secret reference, and at
least one tool definition. The runtime agent sees only prompt-safe tool
summaries for enabled tools.

### Operator-Visible Output

Agent Detail Integrations shows Custom API and MCP Server setup controls,
connected custom integration rows, scope labels, enabled tool names, credential
presence, status, and disconnect actions. It does not display secret ids or
secret values. The Manage view also shows built-in Rudder MCP tools with the
Rudder logo, `rudder-operating-layer` server name, runtime-managed auth, tool
count, and complete tool-name list. The Discover view does not show that
built-in row because it is not something the operator connects.

### Persisted Evidence

Rudder persists:

- `custom_integrations`
- `custom_integration_tools`
- `agent_custom_integration_bindings`
- `custom_integration_tool_calls`
- organization secret rows and versions for inline credentials
- activity log events for create and revoke mutations

### Canonical Scenarios

- An operator creates an agent-scoped MCP server for a personal Feishu-like
  identity. Only that agent can bind or see its enabled tools.
- An operator creates an organization-scoped Custom API for an internal CRM and
  binds it to multiple agents in the same organization.
- A second organization attempts to reference another organization's custom
  integration id and receives no usable integration.
- Runtime prompt assembly includes an enabled tool and excludes disabled,
  revoked, or non-allowlisted tools.
- Agent Detail Integrations shows Custom API and MCP Server controls alongside
  fixed-provider setup rows, and E2E covers agent-scoped, organization-scoped,
  and cross-organization boundary behavior from that surface.
- Agent Detail Integrations Manage shows the built-in Rudder MCP row with the
  Rudder logo and representative Agent V1 tool names, while Discover keeps that
  row hidden.

### Invariants / Non-Goals

- Custom integrations are never global across organizations.
- Agent-scoped integrations cannot be listed, bound, prompted, or called by any
  non-owner agent.
- Organization-scoped integrations can be reused only by agents in the same
  organization.
- Runtime-supplied organization, agent, integration, tool, or secret ids are not
  trusted for authorization.
- Tool names exposed to agents are Rudder-namespaced and organization-unique.
- Tool-call logs and prompt text must not expose secrets.
- First-party Rudder MCP tools are runtime-managed and must stay separate from
  Custom API / MCP Server integrations. They do not create custom integration
  rows, do not need operator-supplied credentials, and are not configurable from
  Discover.
- The current implementation does not perform real remote MCP discovery,
  external HTTP dispatch, server-side credential injection into outbound calls,
  or result normalization. Those remain follow-up work.

### Drift Boundaries

Changes that alter scope semantics, credential visibility, runtime prompt
visibility, tool-call audit status, or custom integration API paths must update
this contract and `doc/product/registry.yml`. Fixed provider integration
semantics remain governed by their provider contracts, not this page.

### Traceability

- Plan: `doc/plans/2026-06-27-agent-custom-integrations.md`
- Related active contracts:
  - `AGENT.SKILLS.001` for discovery vs runtime enablement.
  - `AGENT.INSTRUCTIONS.001` for runtime prompt assembly.
  - `AGENT.RUNTIME.PERMISSIONS.001` for runtime credential boundaries.
  - `AGENT.CONTROL.TOOLS.001` for built-in Rudder MCP operating-layer tools.
  - `PLUGIN.CAPABILITY.001` for namespaced tool capability principles.
  - `IM.FEISHU.001` for the existing fixed-provider, agent-bound precedent.
