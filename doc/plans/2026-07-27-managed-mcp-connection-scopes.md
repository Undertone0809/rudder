---
title: Managed MCP Organization And Agent Connection Scopes
date: 2026-07-27
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
  - 2026-07-25-managed-mcp-access-and-interactions.md
  - 2026-07-23-managed-mcp-oauth-integrations.md
supersedes: []
related_code:
  - packages/db/src/schema/mcp_connections.ts
  - packages/shared/src/types/mcp.ts
  - server/src/services/mcp/managed-connections.ts
  - server/src/services/mcp/managed-bindings.ts
  - ui/src/pages/OrganizationMcpSettings.tsx
  - ui/src/pages/AgentDetail.integrations.tsx
commit_refs: []
updated_at: 2026-07-27
---

# Managed MCP Organization And Agent Connection Scopes

## Summary

Give every managed MCP connection an explicit Organization or Agent target.
Organization Settings defaults connection setup to the organization and may
target one Agent. Agent Integrations defaults setup to the current Agent and
may target the organization. Each target owns an independent connection,
credential boundary, lifecycle, and official-provider uniqueness slot.

Organization connections are enabled for current and future eligible Agents.
An Agent-scoped official-provider connection takes precedence over the
Organization connection for the same provider. Explicit `No access` on the
Agent connection blocks fallback; disconnecting or revoking it restores the
Organization connection. Custom MCP connections remain additive and may have
multiple named instances.

## Data And API

- Add immutable `scope` and nullable `ownerAgentId` fields to managed MCP
  connections, with database checks enforcing Organization and Agent ownership.
- Backfill existing connections as Organization-scoped and replace the global
  official-provider canonical index with Organization- and Agent-targeted
  partial unique indexes.
- Extend connection creation and official-provider connect requests with the
  target scope. OAuth, reconnect, discovery, grants, and dispatch continue to
  use the connection id and enforce its organization and owner boundary.
- Extend provider availability with Agent-connection state, effective source,
  effective connection, explicit-disable state, and Agent connection counts.
- Make Supabase read-write by default.

## Runtime And Binding Policy

- Organization activation creates missing default bindings for all eligible
  current Agents; Agent creation inherits all active Organization connections.
- Agent activation creates a binding only for the owner.
- Existing bindings are never overwritten by automatic binding.
- For official providers, an extant Agent-scoped connection shadows the
  Organization source, including an explicit `No access`; revoked or
  disconnected Agent connections no longer shadow it.
- Organization and Agent Custom MCP connections remain independently loadable.

## User Experience

- Use one target picker in every Connect flow. Organization Settings offers
  Organization plus one Agent and defaults to Organization. Agent Integrations
  offers the current Agent plus Organization and defaults to the Agent.
- Manage surfaces show scope, owner, effective source, and existing target
  connections without creating duplicates. Scope changes require disconnect
  and reconnect.
- Keep provider management compact: Settings icon for Manage, Save in the
  dialog footer, direct Integrations/MCP settings links, and a readable modal
  backdrop that preserves the underlying Agent page.

## Product Logic Registry Delta

The user explicitly authorized these guarded updates:

- `AGENT.CUSTOM.INTEGRATIONS.001`: dual connection scope, independent
  credentials, targeted uniqueness, automatic Organization bindings, Agent
  precedence, and explicit-disable behavior.
- `AGENT.RUNTIME.PERMISSIONS.001`: runtime effective-source selection and
  scope-bound credential isolation.

## Verification

- Cover migration, schema constraints, concurrency, cross-organization and
  cross-Agent isolation, automatic bindings, future-Agent inheritance,
  precedence, explicit deny, disconnect fallback, and Supabase defaults.
- Add real workflow E2E coverage for both setup entry points and visual
  regression evidence for dialogs, settings deep links, focus, and backdrop.
- Run product-logic check, lint, recursive typecheck, test suite, build,
  relevant E2E, Desktop packaged verification, independent review, and
  black-box verification before handoff.
