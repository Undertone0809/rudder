---
title: Agent Custom Integrations
domain: agents
status: proposed
coverage: proposal
spec_depth: logic_contract
contract_ids:
  - AGENT.CUSTOM.INTEGRATIONS.001
related_code:
  - packages/db/src/schema/agent_integrations.ts
  - packages/shared/src/constants.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/chat-assistant.ts
  - ui/src/pages/AgentDetail.integrations.tsx
related_tests: []
related_plans:
  - doc/plans/2026-06-27-agent-custom-integrations.md
edit_policy: user_confirmed_only
---

# Agent Custom Integrations

This is an approved product direction, not current shipped behavior. Keep this
contract `status: proposed` until the implementation, tests, and E2E evidence
exist. When the feature ships, promote the registry entry to `active` and fill
the final code/test traceability.

## AGENT.CUSTOM.INTEGRATIONS.001

Why:

- Operators need to connect organization-specific tools, MCP servers, and
  internal APIs to agent work loops without waiting for every provider to become
  a first-party Rudder integration.
- Some MCP servers and APIs are shared organization infrastructure. Others are
  personal or identity-bound and must only attach to one agent.
- Custom tools are agent-visible runtime capabilities, so scope and credential
  boundaries must be explicit before any implementation exposes them in prompts
  or dispatch.

Product model:

- A custom integration belongs to exactly one organization.
- A custom integration has a kind: `custom_api` or `mcp_server`.
- A custom integration has a scope:
  - `organization`: may be bound to multiple agents in the same organization.
  - `agent`: owned by one agent and bindable only to that agent.
- Fixed provider integrations such as Feishu remain separate from custom
  integrations. Feishu stays agent-bound because its provider identity maps to
  one agent integration.
- MCP and Custom API integrations must not cross organizations. Their
  definitions, secrets, tool discovery, bindings, runtime prompts, dispatch
  calls, and audit evidence all remain organization-scoped.
- Credentials are stored as server-side secrets and are never returned to the
  browser or placed in runtime prompt text.
- Discovery does not equal enablement. Operators must explicitly enable tools
  for an agent binding before a runtime can see or call them.

Proposed flow:

1. Operator creates a Custom API or MCP Server from Agent Detail Integrations.
2. Operator chooses scope: organization-shared or this agent only.
3. Rudder stores non-secret configuration separately from encrypted credential
   material.
4. For MCP, Rudder can test the server and discover tool metadata. For Custom
   API, the operator defines one or more callable tools.
5. Operator enables a per-agent tool allowlist.
6. Runtime prompt assembly lists only tools enabled for the exact organization
   and agent.
7. When an agent requests a tool call, Rudder validates organization, agent
   binding, integration status, tool allowlist, input schema, and credential
   availability before dispatch.
8. Rudder injects credentials server-side, calls the external API or MCP server,
   redacts/sanitizes results, and persists tool-call evidence linked to the run,
   chat, or issue where available.

Invariants:

- Custom integrations are never global across organizations.
- Agent-scoped custom integrations cannot be listed, bound, prompted, or called
  by any other agent.
- Organization-scoped custom integrations can be reused only by agents in the
  same organization.
- Runtime-supplied org id, agent id, integration id, tool id, or secret id is
  never trusted for authorization.
- Tool names exposed to agents are Rudder-namespaced and cannot collide with
  fixed provider tools, plugin tools, or other custom integrations.
- Disabled, revoked, errored, undiscovered, or non-allowlisted tools are absent
  from runtime prompts and rejected at dispatch.
- External MCP metadata is treated as untrusted input and sanitized before it
  appears in any prompt.
- Tool-call logs and transcript evidence must not expose secrets.

Known gaps before activation:

- No custom integration schema or routes exist yet.
- No organization-vs-agent custom integration binding UI exists yet.
- No MCP discovery or Custom API tool definition workflow exists yet.
- No server-side custom tool dispatcher exists yet.
- No E2E coverage exists for cross-organization isolation, agent-personal
  isolation, credential secrecy, or tool-call evidence.

Traceability:

- Plan: `doc/plans/2026-06-27-agent-custom-integrations.md`
- Related active contracts:
  - `AGENT.SKILLS.001` for discovery vs runtime enablement.
  - `AGENT.INSTRUCTIONS.001` for runtime prompt assembly.
  - `AGENT.RUNTIME.PERMISSIONS.001` for runtime credential and execution
    boundaries.
  - `PLUGIN.CAPABILITY.001` for namespaced tool capability principles.
  - `IM.FEISHU.001` for the existing fixed-provider, agent-bound integration
    precedent.
