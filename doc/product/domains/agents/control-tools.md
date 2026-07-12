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
  - cli/src/commands/client/browser.ts
  - packages/agent-runtime-utils/src/rudder-mcp.ts
  - packages/agent-runtime-utils/src/rudder-mcp-server.ts
  - packages/agent-runtime-utils/src/types.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - server/src/routes/browser.ts
  - server/src/services/browser-broker.ts
  - server/resources/bundled-skills/browser/SKILL.md
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/resources/bundled-skills/rudder/references/cli-reference.md
related_tests:
  - cli/src/__tests__/browser-command.test.ts
  - cli/src/__tests__/agent-v1-registry.test.ts
  - cli/src/__tests__/agent-v1-mcp-server.test.ts
  - server/src/__tests__/claude-local-execute.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - server/src/__tests__/opencode-local-execute.test.ts
  - server/src/__tests__/pi-local-execute.test.ts
  - server/src/__tests__/browser-routes.test.ts
  - server/src/services/browser-broker.test.ts
  - tests/e2e/agent-detail-integrations-tab.spec.ts
related_plans:
  - doc/plans/2026-06-30-agent-v1-mcp-tools.md
  - doc/plans/2026-07-12-built-in-browser.md
edit_policy: user_confirmed_only
---

# Agent Control Plane Tools

## AGENT.CONTROL.TOOLS.001

### Contract Summary

Rudder exposes a first-party `rudder-control-plane` MCP server for supported
agent runtimes. The server presents the stable `agent-v1` command contract as
typed MCP tools using `rudder_<capability_id>` names, conditionally projects
the Built-in Browser tool set from trusted runtime capability state, dispatches
core control-plane tools directly through Rudder's runtime API context when
supported, falls back to the existing Rudder CLI command path for remaining
capabilities, and gets organization, agent, run, API, and project-library
identity only from runtime-owned environment.

### Intent / User Job

Runtime agents need a reliable control-plane tool surface for issue, run,
chat, automation, library, approval, skill, agent, and bounded Browser
operations. Operators need this surface to be typed, auditable, and scoped to
the current run instead
of relying on model-invented shell commands or user/home MCP configuration.

### Why / Design Reasoning

The bundled `rudder` CLI skill remains the compatibility fallback and human
reference, but agent runtimes that support MCP should prefer first-party
Rudder tools. MCP gives the model a typed schema, stable tool names, and a
clear transport boundary while preserving CLI compatibility for capabilities
that have not moved to direct runtime API dispatch.

The control-plane server is runtime infrastructure, not a custom integration.
The operator does not configure its URL, credentials, binding, or allowlist from
Agent Detail. Rudder injects it only when a supported runtime can receive
managed MCP config or an equivalent runtime-managed native tool bridge for the
current run.

### Actors / Objects / State

- Runtime agent: calls the typed MCP tools during a run.
- Board operator: can inspect that built-in Rudder MCP tools are available from
  Agent Detail Integrations Manage when runtime metadata exposes them.
- `agent-v1` capability: stable Rudder agent command contract entry.
- MCP tool manifest: `rudder.agent-mcp-tools/v1` manifest for
  `rudder-control-plane`.
- Managed MCP runtime config: adapter-owned MCP server config injected for the
  current run.
- Managed native tool bridge: adapter-owned tool exposure that presents the same
  Rudder tool names to a runtime that cannot consume MCP server configuration
  directly.
- Runtime MCP identity: environment values such as `RUDDER_API_URL`,
  `RUDDER_API_KEY`, `RUDDER_ORG_ID`, `RUDDER_AGENT_ID`, `RUDDER_RUN_ID`, and
  `RUDDER_PROJECT_LIBRARY_PATH`.
- Browser capability state: the runtime-managed `RUDDER_BROWSER_ENABLED` flag
  controls manifest projection, while the Browser API independently enforces
  the live instance setting and active-run/tab ownership on every call.

### Entry Points / Inputs

- `rudder mcp-server` runs the first-party MCP server over stdio.
- `tools/list` returns the `agent-v1` MCP tool manifest for
  `rudder-control-plane`.
- When Built-in Browser is enabled for a supported local run, the manifest also
  exposes `rudder_browser_tabs`, `rudder_browser_open`,
  `rudder_browser_navigate`, `rudder_browser_read`, `rudder_browser_click`,
  `rudder_browser_type`, `rudder_browser_screenshot`, and
  `rudder_browser_close`.
- `tools/call` maps a `rudder_<capability_id>` tool call to direct runtime API
  dispatch for supported core tools or to a CLI-backed invocation plan for
  remaining capabilities, then returns JSON/structured MCP content.
- Supported runtime adapters inject managed MCP config for Codex, Claude, and
  OpenCode local runs.
- Pi local exposes the same first-party Rudder tool surface through a managed Pi
  extension because Pi does not expose a supported MCP server configuration
  surface in this adapter.
- Agent Detail Integrations Manage may show the built-in `Rudder MCP tools`
  row using runtime metadata from `AGENT.CUSTOM.INTEGRATIONS.001`.

### Product Logic Flow

1. Rudder builds the stable `agent-v1` capability registry.
2. The MCP manifest converts each `agent-v1` capability id into a stable tool
   name such as `rudder_issue_checkout`; it includes the eight Browser tools
   only when trusted run context marks Built-in Browser enabled.
3. A supported runtime invocation prepares managed MCP server config or a
   runtime-managed native tool bridge for `rudder-control-plane`.
4. Runtime-owned environment supplies API URL, agent token, organization id,
   agent id, run id, and project library path when available.
5. The model calls MCP tools with only the capability's task arguments.
6. The server rejects model-supplied runtime identity or auth fields such as
   org id, agent id, run id, API base, API key, or authorization.
7. The server validates that required runtime context is present for the
   selected capability.
8. For supported core tools, the server calls Rudder APIs directly with
   runtime-managed auth and agent/run headers.
9. For remaining capabilities, the server materializes any temporary file
   arguments and invokes the matching Rudder CLI command with `--json`.
10. Success returns structured JSON content. Failure returns an MCP error result
   with a stable Rudder MCP error code and safe diagnostic details.
11. When MCP/native tool exposure is unavailable or a transport/configuration
   error blocks the tool, the bundled CLI reference remains the agent fallback
   path.
12. Browser calls additionally verify the live setting, active run, safe web
    URL, and run-owned tab before forwarding an allowed action to the in-memory
    Desktop Broker. A stale manifest cannot bypass live disablement.

### Decision Table

| Case | Result |
| --- | --- |
| Supported runtime has managed MCP config | Runtime receives `rudder-control-plane` with runtime-owned env and `rudder mcp-server` command. |
| Runtime supports first-party native tool bridging instead of managed MCP config | Runtime receives an adapter-managed native bridge exposing the same `rudder_<capability_id>` tool names with runtime-owned env. |
| Runtime does not support managed MCP config | Agent uses the bundled `rudder` CLI skill/reference fallback. |
| Model supplies `orgId`, `agentId`, `runId`, `apiKey`, `apiBase`, or authorization fields | Tool call is rejected with `rudder_mcp_reserved_identity_argument`. |
| Required runtime context is missing | Tool call is rejected with `rudder_mcp_missing_runtime_context`. |
| Direct runtime API dispatch succeeds | MCP/native tool result returns structured JSON content without shelling out to the Rudder CLI. |
| Direct dispatch is not implemented for the capability and CLI invocation succeeds with JSON output | MCP result returns structured JSON content. |
| Direct API dispatch, CLI invocation, or native bridge invocation fails | Tool result is marked error with a stable Rudder diagnostic code or safe error text. |
| Browser capability is enabled for a supported local run | Manifest exposes exactly the eight `rudder_browser_*` tools; Browser API derives identity and enforces the live setting and tab lease. |
| Browser is disabled after run start | Browser tools disappear from future manifests/runs and current calls fail with `browser_disabled`; active leases are revoked. |
| Desktop Browser Broker is unavailable | Browser call fails with `browser_unavailable` instead of hanging or falling back to an uncontrolled browser. |
| Browser tab belongs to another organization, agent, or run | Call is rejected without revealing tab or page data. |
| Agent Detail Discover is open | Built-in Rudder MCP tools are not shown as connectable integrations. |
| Agent Detail Manage is open and runtime metadata says MCP is available | Built-in Rudder MCP tools may be shown as a read-only runtime-managed row. |

### Actor-Visible Input

The runtime agent sees typed tool names and JSON schemas for the `agent-v1`
capabilities. When enabled, the Browser surface accepts bounded URL, tab,
structured element-reference, text, and screenshot inputs; it never accepts
raw cookie access or arbitrary script execution. The agent does not provide
organization, agent, run, API, Broker, or auth identity; those come from
Rudder-managed runtime environment.

### Operator-Visible Output

Operators may see `Rudder MCP tools` on Agent Detail Integrations Manage with
the `rudder-control-plane` server name, runtime-managed auth label, tool count,
tool-name list, and runtime transport metadata. This row is informational and
has no configure or disconnect action.

### Persisted Evidence

Evidence can include:

- adapter command notes stating that first-party Rudder MCP tools were
  configured
- managed runtime config files that include the `rudder-control-plane` server
- managed native tool extension files that expose `rudder-control-plane` tools
  for runtimes without direct MCP config support
- CLI/MCP server tests proving the manifest, schemas, runtime identity
  rejection, missing-context errors, stdio handling, and direct runtime API
  dispatch for supported core tools
- runtime adapter tests proving inherited user/provider MCP config is stripped
  while Rudder-owned MCP config or native bridge config is injected
- Agent Detail E2E proving the read-only Manage row is visible only where
  applicable
- Browser route/Broker activity showing action and sanitized origin without
  query tokens, cookies, typed values, screenshots, or page content

### Canonical Scenarios

- A Codex local run starts with Rudder-managed MCP config. The runtime receives
  `rudder-control-plane`, calls an `agent-v1` MCP tool such as
  `rudder_issue_context`, and the server uses runtime-owned auth to dispatch the
  tool through the direct API path when supported or the CLI fallback path when
  needed.
- A Claude local run starts with inherited user MCP config present. Rudder
  strips inherited MCP/plugin config from the run surface, then injects only
  the first-party `rudder-control-plane` server with runtime-owned env.
- A Pi local run starts without a supported MCP server config surface. Rudder
  writes an adapter-managed `rudder-control-plane` Pi extension, exposes the
  same `rudder_<capability_id>` tool names to the model, and records
  `rudderNativeTools` metadata with `transport: "pi_extension"`.
- A Browser-enabled local run receives the conditional Browser skill and eight
  Browser tools. It opens a run-owned tab, reads and interacts through bounded
  actions, and cannot access a tab leased to another run.
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
- Native bridges must preserve runtime-managed identity and must not bake API
  keys, organization ids, agent ids, or run ids into generated extension source.
- Browser tool projection is not authorization. Every Browser call must enforce
  current enablement, active-run identity, safe protocols, and exact tab lease;
  Broker credentials must remain outside model-visible config and arguments.
- The current contract does not promise remote MCP discovery for custom
  integrations, external tool dispatch, or plugin tool semantics.

### Drift Boundaries

Update this contract and `doc/product/registry.yml` when changing the
`agent-v1` MCP naming scheme, server name, runtime injection policy, identity
source, reserved argument rules, direct-dispatch coverage, fallback behavior,
stdio protocol support, native bridge transport, operator-visible Manage row
semantics, or related traceability.

### Traceability

- Plan: `doc/plans/2026-06-30-agent-v1-mcp-tools.md`
- Plan: `doc/plans/2026-07-12-built-in-browser.md`
- Related active contracts:
  - `AGENT.BROWSER.001` for Browser settings, profile, tab lease, and lifecycle
    semantics.
  - `AGENT.CUSTOM.INTEGRATIONS.001` for the Agent Detail Integrations Manage
    visibility of the built-in row and custom integration separation.
  - `AGENT.INSTRUCTIONS.001` for runtime prompt and fallback reference loading.
  - `AGENT.RUNTIME.PERMISSIONS.001` for managed runtime state and
    operator-home boundaries.
  - `AGENT.RUNTIME.ADAPTERS.001` for adapter capability and execution
    boundaries.
