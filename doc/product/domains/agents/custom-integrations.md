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

### Actor-Visible Input

The operator supplies display name, optional description, scope, endpoint
configuration, optional credential value or credential secret reference, and at
least one tool definition. The runtime agent sees only prompt-safe tool
summaries for enabled tools.

### Operator-Visible Output

Agent Detail Integrations shows Custom API and MCP Server setup controls,
connected custom integration rows, scope labels, enabled tool names, credential
presence, status, and disconnect actions. It does not display secret ids or
secret values.

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
  - `PLUGIN.CAPABILITY.001` for namespaced tool capability principles.
  - `IM.FEISHU.001` for the existing fixed-provider, agent-bound precedent.
