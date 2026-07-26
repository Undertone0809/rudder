---
title: Built-in Rudder Tools
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
  - packages/shared/src/types/mcp.ts
  - packages/shared/src/validators/mcp.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - server/src/routes/browser.ts
  - server/src/services/browser-broker.ts
  - server/resources/bundled-skills/browser/SKILL.md
  - server/resources/bundled-skills/rudder-docs/SKILL.md
  - server/resources/bundled-skills/rudder-docs/references/cli-reference.md
  - server/resources/bundled-skills/rudder-docs/references/agent-creation.md
related_tests:
  - packages/shared/src/validators/mcp.test.ts
  - scripts/managed-mcp-product-contract.test.mjs
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
  - doc/plans/2026-07-23-managed-mcp-oauth-integrations.md
  - doc/plans/2026-07-25-managed-mcp-access-and-interactions.md
  - doc/plans/2026-07-12-built-in-browser.md
  - doc/plans/2026-07-18-rudder-docs-skill-proposal.md
  - doc/plans/2026-07-20-merge-rudder-creation-skills-into-docs.md
  - doc/plans/2026-07-26-managed-mcp-runtime-failure-isolation.md
edit_policy: user_confirmed_only
---

# Built-in Rudder Tools

## AGENT.CONTROL.TOOLS.001

### Contract Summary

Rudder exposes a first-party `rudder-tools` MCP server for supported
agent runtimes. The server presents the stable `agent-v1` command contract as
typed MCP tools using `rudder_<capability_id>` names, conditionally projects
the Built-in Browser tool set from trusted runtime capability state, dispatches
built-in Rudder tools directly through Rudder's runtime API context when
supported, falls back to the existing Rudder CLI command path for remaining
capabilities, and gets organization, agent, run, API, and project-library
identity only from runtime-owned environment.

Organization-managed external MCP servers are a separate runtime surface.
Rudder projects each enabled external connection as an independent run-scoped
proxy through the provider-neutral `managedExternalMcpBindings` contract. These
proxies do not add tools to, rename, replace, share credentials with, or weaken
the identity boundary of the first-party `rudder-tools` server.

### Intent / User Job

Runtime agents need a reliable Rudder tool surface for issue, run,
chat, automation, library, approval, skill, agent, and bounded Browser
operations. Operators need this surface to be typed, auditable, and scoped to
the current run instead
of relying on model-invented shell commands or user/home MCP configuration.

### Why / Design Reasoning

The bundled `rudder-docs` skill remains the compatibility reference for exact
CLI command details, but agent runtimes that support MCP should prefer
first-party Rudder tools. The skill is always discoverable; that does not mean
an agent must read it on every run. MCP gives the model a typed schema, stable
tool names, and a clear transport boundary while preserving CLI compatibility
for capabilities that have not moved to direct runtime API dispatch.

The Rudder server is runtime infrastructure, not a custom integration.
The operator does not configure its URL, credentials, binding, or allowlist from
Agent Detail. Rudder injects it only when a supported runtime can receive
managed MCP config or an equivalent runtime-managed native tool bridge for the
current run.

The Agent runtime remains the primary executor when this tool infrastructure is
degraded. A failed Rudder MCP preflight disables or degrades the affected tool
surface and emits safe diagnostics; it must not prevent model execution,
ordinary Chat replies, or non-MCP work.

### Actors / Objects / State

- Runtime agent: calls the typed MCP tools during a run.
- Board operator: can inspect that built-in Rudder MCP tools are available from
  Agent Detail Integrations Manage when runtime metadata exposes them.
- `agent-v1` capability: stable Rudder agent command contract entry.
- MCP tool manifest: `rudder.agent-mcp-tools/v1` manifest for
  `rudder-tools`.
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
- Managed external MCP binding: provider-neutral run-scoped descriptor with a
  binding id, proxy server name, server-derived effective tool policy, policy
  revision, required behavior, startup timeout, and tool timeout. The fixed
  Rudder proxy URL and run-owned proxy authorization are derived outside the
  binding array. Provider scope, connection identity, and provider credentials
  remain server-side.

### Entry Points / Inputs

- `rudder mcp-server` runs the first-party MCP server over stdio.
- `tools/list` returns the `agent-v1` MCP tool manifest for
  `rudder-tools`.
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
- Codex, Claude, and OpenCode may receive multiple managed external MCP
  bindings as independent server entries. Pi may receive the same allowlisted
  external tools through its generic native bridge. Neither path merges
  external tool schemas into the `rudder-tools` manifest.

### Product Logic Flow

1. Rudder builds the stable `agent-v1` capability registry.
2. The MCP manifest converts each `agent-v1` capability id into a stable tool
   name such as `rudder_issue_checkout`; it includes the eight Browser tools
   only when trusted run context marks Built-in Browser enabled.
3. A supported runtime invocation prepares managed MCP server config or a
   runtime-managed native tool bridge for `rudder-tools`.
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
   error blocks the tool, the agent may consult `rudder-docs` for the exact CLI
   reference and use that compatibility path.
12. Browser calls additionally verify the live setting, active run, safe web
    URL, and run-owned tab before forwarding an allowed action to the in-memory
    Desktop Broker. A stale manifest cannot bypass live disablement.
13. Separately, run context selects canonical active organization connections,
    derives the effective coarse Agent policy, and snapshots the allowed
    external tool surface at run start. The snapshot is server-owned; legacy
    enabled-tool ids may only narrow it.
14. The adapter renders every external binding as its own server or generic
    native-tool group. The adapter derives the fixed Rudder proxy URL and
    run-scoped proxy authorization once outside the array. The binding never
    carries those coordinates, provider OAuth tokens, organization secret ids,
    connection ids, or provider-specific project/workspace fields.
15. Every external `tools/list` and `tools/call` returns through the Rudder
    proxy and evaluates `run-start snapshot ∩ current binding ∩ current
    provider policy`. A binding reduction blocks later calls in the active run;
    a binding increase is available only to the next run. The proxy writes
    redacted audit evidence.
    Failure of an external server does not alter first-party `rudder-tools`
    availability or identity.
16. A first-party Rudder MCP preflight failure is recorded as degraded tool
    availability instead of a runtime boot failure. Supported adapters continue
    model execution, and the Agent may use non-MCP work paths or the documented
    CLI compatibility path where available. A failed core MCP is omitted from
    downstream runtime configuration instead of being retried as a required
    startup dependency.

### Decision Table

| Case | Result |
| --- | --- |
| Supported runtime has managed MCP config | Runtime receives `rudder-tools` with runtime-owned env and `rudder mcp-server` command. |
| Runtime supports first-party native tool bridging instead of managed MCP config | Runtime receives an adapter-managed native bridge exposing the same `rudder_<capability_id>` tool names with runtime-owned env. |
| Runtime does not support managed MCP config and exact command guidance is needed | Agent consults the bundled `rudder-docs` skill/reference and uses the CLI compatibility path. |
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
| One agent has two managed external MCP connections | Runtime receives two independent server/proxy entries with separate allowlists and timeouts. |
| External connection is disabled, revoked, stale, or needs reauthorization | Binding is omitted or rejected by the proxy; `rudder-tools` remains unchanged. |
| Agent access is reduced during a run | Subsequent list/call authorization uses the smaller current intersection and blocks removed capabilities immediately. |
| Agent access is increased during a run | The current run remains limited to its run-start snapshot; the next run receives the increase. |
| Tool is destructive, administrative, billing-related, or unclassified | It is absent from the effective V1 external tool policy even when Agent access is read-write. |
| Model supplies another connection, organization, agent, run, or provider credential | Proxy rejects the call; model arguments never override runtime-owned identity. |
| Runtime uses Pi's native bridge | External tools keep the same per-connection authorization and audit boundary without becoming first-party Rudder tools. |
| First-party Rudder MCP preflight fails | Adapter records a safe degradation diagnostic and continues model execution without treating the MCP failure as Agent runtime unavailability. |

### Actor-Visible Input

The runtime agent sees typed tool names and JSON schemas for the `agent-v1`
capabilities. When enabled, the Browser surface accepts bounded URL, tab,
structured element-reference, text, and screenshot inputs; it never accepts
raw cookie access or arbitrary script execution. The agent does not provide
organization, agent, run, API, Broker, or auth identity; those come from
Rudder-managed runtime environment.

### Operator-Visible Output

Operators may see `Rudder MCP tools` on Agent Detail Integrations Manage with
the `rudder-tools` server name, runtime-managed auth label, tool count,
tool-name list, and runtime transport metadata. This row is informational and
has no configure or disconnect action.

### Persisted Evidence

Evidence can include:

- adapter command notes stating that first-party Rudder MCP tools were
  configured
- managed runtime config files that include the `rudder-tools` server
- managed native tool extension files that expose `rudder-tools` tools
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
  `rudder-tools`, calls an `agent-v1` MCP tool such as
  `rudder_issue_context`, and the server uses runtime-owned auth to dispatch the
  tool through the direct API path when supported or the CLI fallback path when
  needed.
- A Claude local run starts with inherited user MCP config present. Rudder
  strips inherited MCP/plugin config from the run surface, then injects only
  the first-party `rudder-tools` server with runtime-owned env.
- A Pi local run starts without a supported MCP server config surface. Rudder
  writes an adapter-managed `rudder-tools` Pi extension, exposes the
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
- External MCP proxies remain separate from `rudder-tools` in naming,
  schemas, credentials, failure handling, audit records, and runtime identity.
- MCP availability never owns Agent runtime admission. Both first-party and
  external MCP failures may remove tools, but must not prevent model execution.
- `managedExternalMcpBindings` is provider-neutral. Provider-specific project,
  workspace, OAuth, and token fields must not cross the runtime adapter
  contract.
- External MCP policy is derived server-side from coarse Agent access,
  capability classification, provider limits, and the run-start snapshot.
  Model arguments and legacy tool-id lists cannot expand it.
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
- External MCP discovery and dispatch are governed by
  `AGENT.CUSTOM.INTEGRATIONS.001`; plugin tool semantics remain separate.

### Drift Boundaries

Update this contract and `doc/product/registry.yml` when changing the
`agent-v1` MCP naming scheme, server name, runtime injection policy, identity
source, reserved argument rules, direct-dispatch coverage, fallback behavior,
stdio protocol support, native bridge transport, operator-visible Manage row
semantics, or related traceability.

### Traceability

- Plan: `doc/plans/2026-06-30-agent-v1-mcp-tools.md`
- Plan: `doc/plans/2026-07-12-built-in-browser.md`
- Plan: `doc/plans/2026-07-23-managed-mcp-oauth-integrations.md`
- Plan: `doc/plans/2026-07-25-managed-mcp-access-and-interactions.md`
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
