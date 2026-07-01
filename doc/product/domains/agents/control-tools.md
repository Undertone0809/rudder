---
title: Agent Control Plane Tools
domain: agents
status: active
coverage: current
spec_depth: logic_contract
contract_ids:
  - AGENT.CONTROL.TOOLS.001
related_code:
  - cli/src/agent-v1-registry.ts
  - cli/src/agent-v1-mcp-server.ts
  - cli/src/program.ts
  - packages/agent-runtime-utils/src/rudder-mcp.ts
  - packages/agent-runtime-utils/src/rudder-mcp-server.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/resources/bundled-skills/rudder/references/cli-reference.md
related_tests:
  - cli/src/__tests__/agent-v1-registry.test.ts
  - cli/src/__tests__/agent-v1-mcp-server.test.ts
  - server/src/__tests__/claude-local-execute.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - tests/e2e/agent-detail-integrations-tab.spec.ts
related_plans:
  - doc/plans/2026-06-30-agent-v1-mcp-tools.md
edit_policy: user_confirmed_only
---

# Agent Control Plane Tools

## AGENT.CONTROL.TOOLS.001

### Contract Summary

Rudder exposes a first-party `rudder-control-plane` MCP server for supported
agent runtimes. The server presents the stable `agent-v1` command contract as
typed MCP tools using `rudder_<capability_id>` names, invokes the existing
Rudder CLI command path behind those tools, and gets organization, agent, run,
API, and project-library identity only from runtime-owned environment.

### Intent / User Job

Runtime agents need a reliable control-plane tool surface for issue, run,
chat, automation, library, approval, skill, and agent operations. Operators
need this surface to be typed, auditable, and scoped to the current run instead
of relying on model-invented shell commands or user/home MCP configuration.

### Why / Design Reasoning

The bundled `rudder` CLI skill remains the compatibility fallback and human
reference, but agent runtimes that support MCP should prefer first-party
Rudder tools. MCP gives the model a typed schema, stable tool names, and a
clear transport boundary while preserving the existing CLI implementation
contract behind the server.

The control-plane server is runtime infrastructure, not a custom integration.
The operator does not configure its URL, credentials, binding, or allowlist from
Agent Detail. Rudder injects it only when a supported runtime can receive
managed MCP config for the current run.

### Actors / Objects / State

- Runtime agent: calls the typed MCP tools during a run.
- Board operator: can inspect that built-in Rudder MCP tools are available from
  Agent Detail Integrations Manage when runtime metadata exposes them.
- `agent-v1` capability: stable Rudder agent command contract entry.
- MCP tool manifest: `rudder.agent-mcp-tools/v1` manifest for
  `rudder-control-plane`.
- Managed MCP runtime config: adapter-owned MCP server config injected for the
  current run.
- Runtime MCP identity: environment values such as `RUDDER_API_URL`,
  `RUDDER_API_KEY`, `RUDDER_ORG_ID`, `RUDDER_AGENT_ID`, `RUDDER_RUN_ID`, and
  `RUDDER_PROJECT_LIBRARY_PATH`.

### Entry Points / Inputs

- `rudder mcp-server` runs the first-party MCP server over stdio.
- `tools/list` returns the `agent-v1` MCP tool manifest for
  `rudder-control-plane`.
- `tools/call` maps a `rudder_<capability_id>` tool call to a CLI-backed
  invocation plan and returns JSON/structured MCP content.
- Supported runtime adapters inject managed MCP config for Codex and Claude
  local runs.
- Agent Detail Integrations Manage may show the built-in `Rudder MCP tools`
  row using runtime metadata from `AGENT.CUSTOM.INTEGRATIONS.001`.

### Product Logic Flow

1. Rudder builds the stable `agent-v1` capability registry.
2. The MCP manifest converts each `agent-v1` capability id into a stable tool
   name such as `rudder_issue_checkout`.
3. A supported runtime invocation prepares managed MCP server config for
   `rudder-control-plane` and points the server at `rudder mcp-server`.
4. Runtime-owned environment supplies API URL, agent token, organization id,
   agent id, run id, and project library path when available.
5. The model calls MCP tools with only the capability's task arguments.
6. The server rejects model-supplied runtime identity or auth fields such as
   org id, agent id, run id, API base, API key, or authorization.
7. The server validates that required runtime context is present for the
   selected capability, materializes any temporary file arguments, and invokes
   the matching Rudder CLI command with `--json`.
8. Success returns structured JSON content. Failure returns an MCP error result
   with a stable Rudder MCP error code and safe diagnostic details.
9. When MCP is unavailable or a transport/configuration error blocks the tool,
   the bundled CLI reference remains the agent fallback path.

### Decision Table

| Case | Result |
| --- | --- |
| Supported runtime has managed MCP config | Runtime receives `rudder-control-plane` with runtime-owned env and `rudder mcp-server` command. |
| Runtime does not support managed MCP config | Agent uses the bundled `rudder` CLI skill/reference fallback. |
| Model supplies `orgId`, `agentId`, `runId`, `apiKey`, `apiBase`, or authorization fields | Tool call is rejected with `rudder_mcp_reserved_identity_argument`. |
| Required runtime context is missing | Tool call is rejected with `rudder_mcp_missing_runtime_context`. |
| CLI invocation succeeds with JSON output | MCP result returns structured JSON content. |
| CLI invocation fails or returns invalid output | MCP result is marked error with a stable Rudder MCP diagnostic code. |
| Agent Detail Discover is open | Built-in Rudder MCP tools are not shown as connectable integrations. |
| Agent Detail Manage is open and runtime metadata says MCP is available | Built-in Rudder MCP tools may be shown as a read-only runtime-managed row. |

### Actor-Visible Input

The runtime agent sees typed tool names and JSON schemas for the `agent-v1`
capabilities. The agent does not provide organization, agent, run, API, or auth
identity; those come from Rudder-managed runtime environment.

### Operator-Visible Output

Operators may see `Rudder MCP tools` on Agent Detail Integrations Manage with
the `rudder-control-plane` server name, runtime-managed auth label, tool count,
and tool-name list. This row is informational and has no configure or disconnect
action.

### Persisted Evidence

Evidence can include:

- adapter command notes stating that first-party Rudder MCP tools were
  configured
- managed runtime config files that include the `rudder-control-plane` server
- CLI/MCP server tests proving the manifest, schemas, runtime identity
  rejection, missing-context errors, and stdio handling
- runtime adapter tests proving inherited user/provider MCP config is stripped
  while Rudder-owned MCP config is injected
- Agent Detail E2E proving the read-only Manage row is visible only where
  applicable

### Canonical Scenarios

- A Codex local run starts with Rudder-managed MCP config. The runtime receives
  `rudder-control-plane`, calls an `agent-v1` MCP tool such as
  `rudder_issue_context`, and the server invokes the matching CLI command with
  runtime-owned auth and `--json`.
- A Claude local run starts with inherited user MCP config present. Rudder
  strips inherited MCP/plugin config from the run surface, then injects only
  the first-party `rudder-control-plane` server with runtime-owned env.
- A model attempts to override `orgId`, `agentId`, `runId`, `apiKey`, or
  authorization inside tool arguments. The tool call is rejected before CLI
  invocation.
- An operator opens Agent Detail Integrations Manage for a runtime with Rudder
  MCP metadata. The built-in `Rudder MCP tools` row appears as read-only
  runtime-managed infrastructure, while Discover keeps it hidden.

### Invariants / Non-Goals

- Rudder MCP tools are first-party runtime infrastructure, not custom
  integrations or plugin tools.
- Model-supplied runtime identity and auth values are never trusted.
- Tool names must remain stable for the `agent-v1` contract.
- CLI fallback remains valid when MCP is unavailable or broken.
- Managed runtime config must not inherit arbitrary user/provider MCP servers
  into the Rudder-run tool surface.
- The current contract does not promise remote MCP discovery for custom
  integrations, external tool dispatch, or plugin tool semantics.

### Drift Boundaries

Update this contract and `doc/product/registry.yml` when changing the
`agent-v1` MCP naming scheme, server name, runtime injection policy, identity
source, reserved argument rules, fallback behavior, stdio protocol support,
operator-visible Manage row semantics, or related traceability.

### Traceability

- Plan: `doc/plans/2026-06-30-agent-v1-mcp-tools.md`
- Related active contracts:
  - `AGENT.CUSTOM.INTEGRATIONS.001` for the Agent Detail Integrations Manage
    visibility of the built-in row and custom integration separation.
  - `AGENT.INSTRUCTIONS.001` for runtime prompt and fallback reference loading.
  - `AGENT.RUNTIME.PERMISSIONS.001` for managed runtime state and
    operator-home boundaries.
  - `AGENT.RUNTIME.ADAPTERS.001` for adapter capability and execution
    boundaries.
