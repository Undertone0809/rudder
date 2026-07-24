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
  - packages/db/src/schema/mcp_connections.ts
  - packages/shared/src/types/custom-integration.ts
  - packages/shared/src/types/mcp.ts
  - packages/shared/src/validators/custom-integration.ts
  - packages/shared/src/validators/mcp.ts
  - server/src/services/integrations/custom-integrations.ts
  - server/src/routes/agents.ts
  - server/src/services/agent-run-context.ts
  - ui/src/api/agents.ts
  - ui/src/pages/AgentDetail.integrations.tsx
related_tests:
  - packages/db/src/mcp-connections-schema.test.ts
  - packages/db/src/migrations/managed-mcp-connections.test.ts
  - packages/shared/src/validators/mcp.test.ts
  - scripts/managed-mcp-product-contract.test.mjs
  - server/src/__tests__/custom-integrations-service.test.ts
  - ui/src/pages/AgentDetail.integrations.test.tsx
  - tests/e2e/agent-detail-integrations-tab.spec.ts
related_plans:
  - doc/plans/2026-06-27-agent-custom-integrations.md
  - doc/plans/2026-07-23-managed-mcp-oauth-integrations.md
  - doc/plans/2026-07-25-managed-mcp-access-and-interactions.md
edit_policy: user_confirmed_only
---

# Agent Custom Integrations

## AGENT.CUSTOM.INTEGRATIONS.001

### Contract Summary

Rudder supports the existing `custom_api` and legacy `mcp_server` records plus
organization-owned managed MCP connections for Supabase, Linear, Notion, and
custom servers. Managed connections own provider, transport, external scope,
access mode, lifecycle, safe non-secret configuration, discovered tools, agent
bindings, and redacted dispatch evidence. OAuth grants and temporary OAuth
sessions are separate encrypted credential records. Public connection
summaries expose credential presence only, never secret identifiers or values.
External MCP credentials stay server-side throughout authorization, discovery,
and dispatch. Supabase, Linear, and Notion each have one canonical connection
per organization; Custom MCP remains multi-instance. Operators assign
coarse-grained Agent access instead of managing individual tool checkboxes.

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

Rudder's first-party Rudder MCP server is not a custom integration. It is
runtime-owned built-in infrastructure exposed as `rudder-tools` during
supported agent runs. Agent Detail may show this built-in Rudder tool
surface so operators understand what the runtime can call, but operators do not
configure its URL, credentials, binding, or tool allowlist from the custom
integration setup flow. `AGENT.CONTROL.TOOLS.001` owns the runtime injection,
tool naming, identity, and fallback semantics for that built-in surface.

### Actors / Objects / State

- Organization owner or instance administrator: creates, authorizes,
  configures, discovers, refreshes, disables, and revokes organization MCP
  connections.
- Board operator: continues to manage legacy custom integrations from Agent
  Detail Integrations where current permissions allow.
- Agent: may read its own enabled custom tools through runtime prompt context.
- Custom integration: organization-owned definition with `kind`, `scope`,
  display metadata, non-secret config, status, and optional credential secret.
- Custom integration tool: Rudder-namespaced callable tool metadata owned by a
  custom integration.
- Agent custom integration binding: per-agent status, coarse access mode, policy
  revision, and a legacy enabled-tool id filter that may only narrow the
  server-derived policy.
- Custom integration tool call: sanitized audit evidence for attempted custom
  tool dispatch.
- Managed MCP connection: organization-owned provider/server identity with a
  unique organization server name, transport (`stdio`, `streamable_http`, or
  `legacy_manual`), optional stable external scope, access mode, timeouts,
  enablement/required flags, and explicit lifecycle state.
- Canonical managed connection: the single active organization/provider record
  for Supabase, Linear, or Notion. Superseded records retain historical tools,
  bindings, calls, and audit evidence but are not offered as new connection
  choices.
- OAuth grant: connection-bound provider identity and scope metadata whose
  access/refresh/client credential material exists only through an encrypted
  organization-secret reference.
- OAuth session: one-time, 10-minute authorization record with hashed state,
  redirect URI, expiry and consumption timestamps, and encrypted PKCE or
  temporary client metadata stored through an organization-secret reference.
- Rudder MCP tools: built-in, runtime-managed Rudder tools represented
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
- Organization and Agent Detail Integrations expose `Discover` and `Manage`
  tabs. Provider cards and compact Manage rows open focused modals; Manage does
  not expand a page-sized tool list.
- Agent Detail Integrations Manage exposes a read-only built-in `Rudder MCP
  tools` row for the first-party `rudder-tools` Agent V1 MCP server.
- Organization integration management exposes managed connection CRUD,
  provider catalog, OAuth start/callback, external-scope selection, discovery,
  refresh, disable, and revoke actions only to organization owners and instance
  administrators.

### Product Logic Flow

1. The operator opens Agent Detail Integrations and chooses Custom API or MCP
   Server.
2. The operator chooses `This agent` or `Organization` scope.
3. Rudder stores non-secret config on the custom integration row and stores
   credential material as an organization secret when provided.
4. Rudder creates tool rows with organization-unique, Rudder-namespaced tool
   names such as `custom.linear-mcp.search_issues`.
5. Rudder creates an active binding for the selected agent with a coarse access
   mode and policy revision. A retained enabled-tool id list is compatibility
   data that may only reduce the effective server-derived policy.
6. Runtime prompt assembly reads only active integrations with active bindings
   for the exact organization and agent.
7. Runtime prompt text lists tool names, integration display names, kind, scope,
   external tool names, and descriptions. It never includes credential ids,
   secret values, or raw credential material.
8. Legacy Custom API and `legacy_manual` tool-call audit creation validates
   organization, agent, integration, binding, and enabled-tool ownership before
   persisting a sanitized blocked event; managed active connections use the
   real discovery and dispatch lifecycle below.
9. Separately, Agent Detail Manage can show built-in Rudder MCP tools using the
   Rudder logo, server name, runtime-managed auth label, and full exposed tool
   list. This row is informational and cannot be configured or disconnected
   through custom integration actions.
10. For an official provider, Rudder atomically ensures the organization's
    canonical provider connection instead of creating timestamp-named
    duplicates. It starts a one-time 10-minute OAuth session, stores only the
    state hash, and keeps PKCE, temporary client metadata, access tokens, and
    refresh tokens in encrypted organization secrets.
11. The OAuth callback consumes the session once, associates the authorizing
    Rudder user with provider subject/scope metadata, and moves the connection
    through `authorizing`, `active`, `needs_reauth`, `disabled`, `revoked`, or
    `error` without putting provider credentials in connection rows or public
    responses. Reauthorization is two-phase: an existing usable grant remains
    active until a replacement grant succeeds and is atomically swapped in.
12. Supabase authorizes account scope and defaults to `read_only`; setup does
    not select or persist one project. The Agent supplies `project_id` on
    project-specific calls, and Rudder does not inject `project_ref` into the
    account-scoped provider endpoint. Existing project-scoped connections remain
    `legacy_project` until the operator explicitly confirms an upgrade; the
    upgrade resets affected Agent access to `none` to prevent silent expansion.
    Linear binds one authorized workspace with `read_only` or `read_write`.
    Notion exposes only provider-granted workspace access and must not be
    mislabeled as enforceable provider-native read-only access.
13. Real MCP tool discovery stores raw schemas for evidence, sanitized schemas
    for exposure, a catalog revision, and a server-owned capability class:
    `read`, `normal_write`, `destructive`, `admin_or_billing`, or `unknown`.
14. Agent access is `none`, `read_only`, `read_write`, or
    `provider_granted`, constrained by the organization maximum. `read_only`
    permits only `read`; `read_write` permits `read` and `normal_write`.
    `destructive`, `admin_or_billing`, and `unknown` fail closed in this
    contract slice. Operators do not manage per-tool allowlists.
15. A managed dispatch revalidates organization, agent, run, eligible
    connection, grant, current binding, and provider policy before forwarding.
    New bindings target only the canonical official connection; preserved legacy
    bindings remain within their existing scope until explicitly migrated.
    Audit evidence stores sanitized input/result and a redacted outcome.
16. Custom STDIO accepts Codex-compatible command, arguments, working
    directory, non-sensitive static environment values, forwarded environment
    names, secret environment names, enablement, required behavior, and startup
    and tool timeouts within the deployment boundary owned by
    `AGENT.RUNTIME.PERMISSIONS.001`. Custom Streamable HTTP keeps URLs,
    non-sensitive static headers, header-name-to-environment-name mappings,
    Bearer environment references, secret header names, and credential-presence
    markers separate from encrypted credentials. Secret environment, header,
    and direct Bearer values enter only through a mutation-only `secrets`
    payload that the service encrypts as a whole and never returns. Manual
    Authorization header, Bearer environment, and direct Bearer sources are
    mutually exclusive; OAuth-grant conflicts are checked at the service
    boundary.

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
| Tool dispatch targets Custom API or `legacy_manual` compatibility data | Validated and recorded as blocked; legacy data is never silently made executable. |
| Operator opens Discover | Shows Custom API, MCP Server, fixed-provider setup, and planned provider cards; does not show built-in Rudder MCP tools. |
| Operator opens Manage | Shows compact active fixed/custom integration summaries plus the built-in Rudder MCP tools row when available; provider management opens a modal rather than an inline tool wall. |
| Official provider is already connected | Discover shows `Connected` and `Manage`; another Connect attempt resolves to the canonical connection rather than creating a duplicate. |
| Agent has no binding to a connected official provider | Agent Detail shows `Available` and offers `Set access`. |
| Organization maximum is read-only | Agent can select `none` or `read_only`; `read_write` remains unavailable with an explanation. |
| Notion is connected | UI and API describe its access as provider-granted, not read-only. |
| Supabase account connection is active | No project-selection step appears; project-specific tool calls carry `project_id`. |
| Supabase project-scoped legacy connection exists | It remains within its old boundary until explicit `Upgrade to account access`; ordinary reconnect does not broaden it. |
| Existing `mcp_server` row is migrated | Represented by a disabled, non-executable `legacy_manual` connection; its existing row, tools, bindings, audit history, and credentials remain readable. |
| OAuth callback state is replayed or older than 10 minutes | Rejected without exchanging or exposing credentials. |
| Managed connection becomes unauthorized | Moves to `needs_reauth`; calls remain blocked until a valid grant is restored. |
| Discovery finds a destructive, administrative, billing, or unclassified tool | Tool is persisted for evidence but unavailable under V1 coarse access. |
| Discovery no longer returns a prior tool | Tool is marked removed and cannot be dispatched; history remains. |
| Public connection or grant response | Exposes safe config and `hasCredentials` only, never secret ids, tokens, client secrets, or PKCE material. |
| Curated provider create or update supplies URL, headers, STDIO, legacy config, or manual secrets | Rejected; curated endpoints, transport, and OAuth credential handling are Rudder-managed. |
| Custom safe config marks an environment or header value secret | The public config retains only its name, mapping, or presence; the value must arrive in the mutation-only encrypted `secrets` payload. |
| Custom HTTP config selects more than one manual Authorization/Bearer source | Rejected before persistence. |

### Actor-Visible Input

The operator supplies display name, optional description, scope, endpoint
configuration, optional credential value or credential secret reference, and at
least one tool definition. The runtime agent sees only prompt-safe tool
summaries for enabled tools.

### Operator-Visible Output

Agent Detail Integrations shows Custom API and MCP Server setup controls,
connected custom integration summaries, actual access labels, credential
presence, status, and disconnect actions. Provider cards derive organization
lifecycle and Agent access separately so an organization connection immediately
appears as `Available` on Agent Detail. Provider Manage actions open focused
organization or Agent access modals. The UI does not display secret ids, secret
values, or per-tool permission checkboxes.

### Persisted Evidence

Rudder persists:

- `custom_integrations`
- `custom_integration_tools`
- `agent_custom_integration_bindings`
- `custom_integration_tool_calls`
- `mcp_connections`
- `mcp_oauth_grants`
- `mcp_oauth_sessions`
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
- Managed connections, grants, sessions, tools, bindings, and dispatch audits
  are organization-owned; identifiers supplied by a runtime do not establish
  organization membership or authorization.
- Connection/server names are unique within an organization. Curated provider
  canonical identity is unique by organization and provider for Supabase,
  Linear, and Notion; multiple Custom MCP connections remain allowed.
- Superseding a duplicate official connection must retain historical rows and
  audit evidence. Canonicalization must not physically delete connection,
  binding, tool, call, or secret-reference history.
- A legacy project-scoped Supabase grant cannot become account-scoped through
  reconnect or migration; scope expansion requires explicit operator action.
- User-supplied tool ids cannot widen the effective coarse access or bypass
  fail-closed capability classification.
- Raw access tokens, refresh tokens, client secrets, PKCE verifiers, and
  temporary dynamic-client credentials never live directly in managed MCP
  connection, grant, session, tool, binding, or audit rows.
- `legacy_manual` connections are compatibility records, not executable
  managed connections. Migration must not silently activate old
  `mcp_server` definitions.
- First-party Rudder MCP tools are runtime-managed and must stay separate from
  Custom API / MCP Server integrations. They do not create custom integration
  rows, do not need operator-supplied credentials, and are not configurable from
  Discover.
- Provider OAuth identity is separate from the authorizing Rudder user and from
  run-scoped runtime identity. Revoking one boundary must not be mistaken for
  revoking or authorizing another.

### Drift Boundaries

Changes that alter scope semantics, credential visibility, runtime prompt
visibility, tool-call audit status, or custom integration API paths must update
this contract and `doc/product/registry.yml`. Fixed provider integration
semantics remain governed by their provider contracts, not this page.

### Traceability

- Plan: `doc/plans/2026-06-27-agent-custom-integrations.md`
- Plan: `doc/plans/2026-07-23-managed-mcp-oauth-integrations.md`
- Plan: `doc/plans/2026-07-25-managed-mcp-access-and-interactions.md`
- Related active contracts:
  - `AGENT.SKILLS.001` for discovery vs runtime enablement.
  - `AGENT.INSTRUCTIONS.001` for runtime prompt assembly.
  - `AGENT.RUNTIME.PERMISSIONS.001` for runtime credential boundaries.
  - `AGENT.CONTROL.TOOLS.001` for built-in Rudder MCP tools.
  - `PLUGIN.CAPABILITY.001` for namespaced tool capability principles.
  - `IM.FEISHU.001` for the existing fixed-provider, agent-bound precedent.
