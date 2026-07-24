---
title: Managed MCP OAuth Integrations
date: 2026-07-23
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - agent_custom_integrations
  - runtime_mcp
  - oauth_grants
  - mcp_connections
issue:
related_plans:
  - 2026-06-27-agent-custom-integrations.md
  - 2026-06-30-agent-v1-mcp-tools.md
supersedes: []
related_code:
  - packages/db/src/schema/agent_integrations.ts
  - packages/db/src/schema/custom_integrations.ts
  - packages/db/src/schema/mcp_connections.ts
  - packages/shared/src/types/mcp.ts
  - packages/shared/src/validators/mcp.ts
  - server/src/services/integrations/custom-integrations.ts
  - packages/agent-runtime-utils/src/rudder-mcp.ts
commit_refs: []
updated_at: 2026-07-23
---

# Managed MCP OAuth Integrations

## Summary

Implement an organization-scoped MCP connection platform that keeps external
MCP servers separate from Rudder's first-party `rudder-tools` and
`rudder-browser` servers. The first release includes curated Supabase, Linear,
and Notion connections plus Codex-compatible custom STDIO and Streamable HTTP
configuration.

Rudder's existing user and organization membership system identifies the
authorizing operator. Provider OAuth grants are separate, encrypted
organization credentials and never enter model prompts, runtime configuration,
or tool arguments.

## Product And Data Model

- Add organization-owned MCP connections with provider, transport, external
  scope, access mode, status, safe configuration, and lifecycle timestamps.
- Add OAuth grants and short-lived PKCE sessions with encrypted token storage,
  one-time state consumption, refresh rotation, and reauthorization states.
- Reuse the existing custom-integration tool, agent binding, and tool-call
  audit model while preserving legacy manual MCP definitions.
- Add organization APIs for connection management, OAuth, scope selection,
  discovery, refresh, and revocation. Agent APIs only bind existing
  organization connections and manage tool allowlists.
- Restrict management to organization owners and instance administrators.

## MCP Transport And Runtime

- Match Codex custom MCP configuration for STDIO and Streamable HTTP, including
  arguments, environment handling, working directory, headers, Bearer
  environment references, enablement, required status, timeouts, and tool
  allow/deny lists.
- Allow arbitrary STDIO only in `local_trusted`. Authenticated deployments
  require instance-admin command, path, and environment allowlists.
- Permit public HTTPS custom MCP URLs by default. Private, loopback, HTTP,
  redirect, and OAuth metadata targets require deployment-admin allowlists and
  are protected against DNS rebinding and unsafe headers.
- Discover and validate MCP tool schemas, persist sanitized metadata, enable
  current tools on first agent binding, and never auto-enable newly discovered
  tools on existing bindings.
- Inject one run-scoped Rudder proxy per bound connection through a generic
  `managedExternalMcpBindings` runtime contract containing only binding id,
  server name, explicit tool policy, required behavior, startup timeout, and
  tool timeout. The fixed proxy URL and run-owned authorization are derived
  outside the array. Codex, Claude, and OpenCode render the list as independent
  MCP servers; Pi exposes the same dynamic tools through its generic native
  bridge.
- Keep all external credentials server-side. Each call revalidates
  organization, agent, run, connection, grant, binding, and tool allowlist,
  then writes a redacted audit record.

## Curated Providers

- Supabase uses the official MCP endpoint. OAuth is followed by project
  selection; active connections are project-scoped and `read_only` by default,
  while a Supabase Owner may explicitly enable `read_write`.
- Linear uses the official MCP endpoint with read/write and read-only modes and
  binds each connection to one authorized workspace.
- Notion uses the official MCP endpoint and its provider-granted workspace
  permissions with only `provider_default`; Rudder does not represent Notion as
  provider-native read-only and limits exposure through per-agent tool
  allowlists.
- Existing Linear issue-import plugin behavior remains unchanged.

## Product Logic Registry Delta

- Update `AGENT.CUSTOM.INTEGRATIONS.001` for real discovery, OAuth, dispatch,
  organization management, Codex-compatible custom MCP, and audit semantics.
- Update `AGENT.CONTROL.TOOLS.001` to preserve the hard boundary between
  external MCP proxies and first-party `rudder-tools`.
- Update `AGENT.RUNTIME.PERMISSIONS.001` for OAuth token, runtime identity,
  network, STDIO process, and environment-variable boundaries.
- Synchronize `doc/product/registry.yml` and contract traceability.

## Validation

- Test OAuth discovery, PKCE, DCR, callback replay, refresh rotation, 401
  retry, revocation, unauthenticated HTTP, Bearer/header auth, schema drift,
  rate limits, and cross-organization rejection using mock servers.
- Test SSRF protection, unsafe headers, STDIO allowlists, environment
  isolation, process cleanup, output limits, and secret redaction.
- Verify two external connections in Codex, Claude, OpenCode, and Pi while
  proving `rudder-tools` remains unchanged.
- Add UI E2E for all three curated providers, custom STDIO/HTTP, agent binding,
  tool defaults, permissions, reconnect, and disconnect.
- Run opt-in read-only smoke tests against the authorized Supabase `memos`,
  Linear, and Notion workspaces. Never execute SQL, access business rows, or
  mutate provider data in real smoke verification.
- Run product-logic check, lint, repository typecheck, automated tests, build,
  packaged Desktop verification, independent review, and black-box runtime
  verification.
