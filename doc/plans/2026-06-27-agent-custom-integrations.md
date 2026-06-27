---
title: Agent Custom Integrations
date: 2026-06-27
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - agent_custom_integrations
  - mcp_servers
  - custom_api_tools
issue:
related_plans:
  - 2026-06-21-product-logic-registry.md
  - 2026-06-24-agent-run-scene-runtime-contract.md
  - 2026-06-27-google-oauth-backend-hardening.md
supersedes: []
related_code:
  - packages/db/src/schema/agent_integrations.ts
  - packages/shared/src/constants.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/chat-assistant.ts
  - ui/src/pages/AgentDetail.integrations.tsx
commit_refs: []
updated_at: 2026-06-27
---

# Agent Custom Integrations

## Overview

Add user-configurable Custom API and MCP Server integrations to Rudder so
operators can expose external tools to agent work loops without waiting for a
first-party provider integration.

The product model must support two scopes:

- **Organization-scoped custom integrations**: configured once inside an
  organization and attachable to multiple agents in that organization.
- **Agent-scoped personal custom integrations**: configured for one agent only,
  used when credentials, identity, or policy should not be shared with other
  agents.

Both scopes are still organization-bound. A custom integration must never be
visible, callable, discoverable, or reusable across organizations.

## What Is The Problem?

Current agent integrations are provider-shaped. The existing
`agent_integrations` model works for fixed providers such as Feishu, Gmail, and
Google Calendar, but it is not a good fit for user-defined Custom API or MCP
connections:

- `provider` is a fixed enum-like product value.
- the effective uniqueness is one provider per agent.
- Feishu-style setup is naturally agent-bound because one bot/integration maps
  to one agent identity.
- MCP servers can be organization-level shared infrastructure or personal
  agent-only connections.
- Custom APIs often need multiple named instances per agent or organization.

If Rudder only adds `custom_api` and `mcp` as new providers in the current table,
it will lose the difference between a reusable organization tool and a personal
agent credential. It will also make multiple Stripe/Sentry/internal API
connections awkward.

## What Will Be Changed?

The proposed direction is a new custom-integration layer rather than overloading
the fixed-provider `agent_integrations` table.

Core product objects:

- `custom_integration`: organization-bound definition with type
  `custom_api` or `mcp_server`, display name, slug, description, scope, status,
  and config metadata.
- `custom_integration_secret`: organization-bound encrypted secret references
  for headers, bearer tokens, API keys, or MCP authentication.
- `custom_integration_tool`: discovered or operator-defined tool metadata,
  including name, description, input schema, output handling, method/path for
  Custom API, and MCP tool identity for MCP servers.
- `agent_custom_integration_binding`: agent-to-integration binding with enabled
  tool allowlist, runtime visibility, and status.
- `custom_integration_tool_call`: auditable evidence for server-side tool
  dispatch, linked to run/chat/issue where available.

Scope model:

- `organization` scope: one integration definition may bind to many agents in
  the same org. Example: an internal read-only docs MCP server.
- `agent` scope: one integration definition is owned by exactly one agent and
  cannot be bound to any other agent. Example: a personal MCP server or a
  user-specific API token.
- `agent_integrations` remains the fixed-provider home for Feishu and similar
  first-party provider integrations. Feishu stays agent-bound.

## Success Criteria For Change

- An operator can create more than one Custom API and more than one MCP Server
  in the same organization.
- An organization-scoped MCP Server can be enabled for multiple agents within
  that organization.
- An agent-scoped MCP Server or Custom API can be used only by the owning
  agent.
- No custom integration crosses organization boundaries in listing, binding,
  tool discovery, prompt assembly, execution, logs, or audit data.
- Credentials never return to the browser or runtime prompt.
- Agents see only the tools enabled for the exact organization, agent, and run
  context.
- Server-side dispatch validates tool name, integration scope, agent binding,
  input schema, and credential availability before any external call.
- Tool calls persist enough evidence for review without leaking secrets.

## Out Of Scope

- A public integration marketplace.
- Cross-organization integration templates or sharing.
- User/account-level OAuth brokering for arbitrary providers.
- Local `stdio` MCP process management in the first implementation slice.
- Letting agent runtimes receive raw API keys, refresh tokens, or arbitrary
  operator credentials.
- Replacing fixed provider integrations such as Feishu, Gmail, or Google
  Calendar.

## Non-Functional Requirements

- Security: organization scope and agent ownership checks are mandatory on every
  API, binding, discovery, and dispatch path.
- Security: credentials are stored as organization secrets or equivalent
  encrypted secret references and are injected only server-side at dispatch.
- Observability: health checks, discovery attempts, tool calls, failures, and
  revocations must be visible enough for operators to debug.
- Maintainability: fixed provider integrations and custom integrations should
  share UI concepts where useful but keep separate persistence and dispatch
  policy.
- Usability: the UI must distinguish organization-shared and agent-personal
  integrations without making users learn provider plumbing first.
- Scalability: list and call-history endpoints should be paginated or bounded;
  tool discovery should not block normal Agent Detail rendering.

## User Experience Walkthrough

1. Operator opens Agent Detail -> Integrations.
2. The top of the page shows two creation cards: `Custom API` and `MCP Server`.
3. For MCP Server:
   - operator chooses scope: `Organization shared` or `This agent only`;
   - enters name, transport, server URL, optional auth header/secret;
   - Rudder tests connectivity and discovers tools when supported;
   - operator enables a tool allowlist for the current agent.
4. For Custom API:
   - operator chooses scope;
   - enters name, base URL, description, and secret injection rules;
   - defines one or more tools with method, path, description, and input schema;
   - operator enables the tools for the current agent.
5. Agent runs and chat turns receive a runtime tool section describing only the
   enabled tools. The prompt never includes secret values.
6. When an agent requests a tool call, Rudder validates scope and schema,
   injects credentials server-side, calls the external API/MCP server, and
   appends sanitized result evidence to the run transcript.
7. If an org-shared integration is later disabled, every agent binding becomes
   unavailable until the integration is restored or rebound.
8. If an agent-personal integration is revoked, only that agent loses the tool.

## Implementation

### Product Or Technical Architecture Changes

Add a new custom-integration service boundary:

- schema: definitions, tool metadata, agent bindings, call audit;
- shared validators/types for create/update/bind/test/discover/dispatch;
- server routes under organization and agent contexts;
- runtime prompt assembly for enabled custom tools;
- host tool dispatcher for Custom API and remote MCP calls;
- Agent Detail Integrations UI for creation, management, binding, and status.

The first runtime path should use Rudder host-tool dispatch rather than
provider-native MCP config. This keeps credentials server-side and works across
chat and run scenes before each local adapter has native MCP support.

### Breaking Change

No breaking change is intended. Existing fixed-provider integrations stay in
place. The only likely migration risk is naming/API overlap if current Google
host tools are later folded into the custom tool dispatcher; that should be an
internal refactor with compatibility preserved.

### Design

Data model sketch:

```text
custom_integrations
  id
  org_id
  owner_agent_id nullable
  scope enum('organization', 'agent')
  kind enum('custom_api', 'mcp_server')
  slug
  display_name
  description
  status enum('active', 'disabled', 'error', 'revoked')
  config_json redacted/non-secret config
  credential_secret_id nullable
  created_at / updated_at

custom_integration_tools
  id
  org_id
  integration_id
  external_tool_name
  rudder_tool_name
  description
  input_schema_json
  output_policy_json
  status

agent_custom_integration_bindings
  id
  org_id
  agent_id
  integration_id
  enabled_tool_ids
  status
  created_at / updated_at

custom_integration_tool_calls
  id
  org_id
  integration_id
  tool_id
  agent_id
  run_id nullable
  conversation_id nullable
  issue_id nullable
  status
  sanitized_input_json
  sanitized_result_json
  error_code nullable
  started_at / completed_at
```

Key policy:

- `scope = organization` requires `owner_agent_id = null` and may bind to any
  agent in the same org.
- `scope = agent` requires `owner_agent_id` and may bind only to that agent.
- All rows carry `org_id`; every query filters by org before joining.
- Tool names exposed to agents are Rudder-namespaced to prevent collisions.
- Discovery output is metadata only; enabling a tool is a separate operator
  action.

### Security

New risks:

- arbitrary outbound HTTP requests;
- secret injection into remote calls;
- prompt/tool schema injection through external MCP metadata;
- cross-agent or cross-organization data leakage through shared tools;
- SSRF if local/private URLs are allowed without policy.

Required mitigations:

- validate outbound URLs and block dangerous defaults unless explicitly allowed
  by local-trusted policy;
- store secrets separately from config and redact in all API responses;
- sanitize MCP tool descriptions before prompt injection;
- require agent binding and tool allowlist before dispatch;
- add timeouts and response-size limits;
- log sanitized inputs/results only.

## What Is Your Testing Plan (QA)?

### Goal

Prove that Custom API and MCP tools can be configured and used by the intended
agent while organization boundaries, agent-personal boundaries, and credential
secrecy hold.

### Prerequisites

- Seed organization with at least two agents.
- Mock Custom API server with authenticated and unauthenticated endpoints.
- Mock remote MCP server with discovery and callable tools.
- Existing agent runtime capable of Rudder host-tool calls.

### Test Scenarios / Cases

- Create organization-scoped MCP Server, bind it to two agents in the same org,
  and verify both can see enabled tools.
- Create agent-scoped MCP Server for Agent A and verify Agent B cannot list,
  bind, discover, or call it.
- Attempt cross-organization access by id and verify `404` or `403` without
  leaking existence.
- Create Custom API with bearer/header secret and verify API responses never
  include secret values.
- Agent calls an enabled Custom API tool and receives sanitized result evidence.
- Agent attempts a disabled or non-allowlisted tool and receives a policy error.
- Remote MCP discovery returns malicious/oversized descriptions; Rudder
  sanitizes or rejects before prompt exposure.
- Revoke an organization-scoped integration and verify all bindings become
  unavailable.

### Expected Results

- Runtime prompt lists only enabled tools for the exact agent and org.
- Tool dispatch never uses runtime-supplied org id, agent id, or secret id.
- Tool-call evidence links back to run/chat/issue where applicable.
- Operator-facing UI distinguishes `Organization shared` from
  `This agent only`.

### Pass / Fail

Pending implementation.

## Documentation Changes

- Add proposed product contract:
  `doc/product/domains/agents/custom-integrations.md`.
- After implementation, promote `AGENT.CUSTOM.INTEGRATIONS.001` from proposed
  to active and add the final code/test traceability.
- Update public docs only after the feature is user-ready.

## Open Issues

- Whether `stdio` MCP should be supported in the first production slice or only
  after remote MCP is stable.
- Whether organization-scoped tools need per-agent parameter defaults.
- Whether Custom API tool schemas should support OpenAPI import in v1 or only
  manual tool definitions.
- Whether response data should be stored fully, summarized, or only referenced
  for high-volume tools.
