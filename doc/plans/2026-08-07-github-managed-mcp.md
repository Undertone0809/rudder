---
title: GitHub Managed MCP PAT Integration
date: 2026-08-07
kind: implementation
status: completed
area: agent_runtimes
entities:
  - mcp_connections
  - runtime_mcp
  - agent_custom_integrations
issue: R6Z-63
related_plans:
  - 2026-07-25-managed-mcp-access-and-interactions.md
  - 2026-07-27-managed-mcp-connection-scopes.md
supersedes: []
superseded_by: R6Z-93
related_code:
  - packages/shared/src/constants.ts
  - packages/shared/src/validators/mcp.ts
  - server/src/routes/managed-mcp-connections.ts
  - server/src/services/mcp/managed-connections.ts
  - server/src/services/mcp/managed-bindings.ts
  - server/src/services/mcp/managed-runtime.ts
  - ui/src/pages/OrganizationMcpSettings.tsx
  - ui/src/pages/AgentDetail.integrations.tsx
  - docs/reference/permissions-and-platforms.mdx
commit_refs:
  - "pending: GitHub managed MCP review follow-up"
updated_at: 2026-08-07
---

# GitHub Managed MCP PAT Integration (Superseded)

> This completed PAT implementation is historical. R6Z-93 replaces its
> operator-facing credential flow with managed GitHub OAuth. The current
> connection path accepts no PAT input.

## Scope

The R6Z-63 release added GitHub as a curated managed MCP provider at
`https://api.githubcopilot.com/mcp/` using a GitHub personal access token. That
PAT path is superseded by R6Z-93, which uses a server-configured OAuth App,
official browser authorization, and encrypted managed OAuth grants.

GitHub connections are account-scoped, target either the organization or one
Agent, and default to read-only access. Organization and Agent targets have
independent credentials and canonical connection slots. An Agent target takes
precedence over the organization target for that Agent, while an explicit
no-access binding continues to block fallback.

## Lifecycle And Concurrency

Connect, reconnect, disconnect, and tool discovery use the existing managed MCP
lifecycle. R6Z-93 replaces the OAuth grant only after a successful callback and
tool validation, while preserving an active grant during reauthorization.
Disconnect disables the connection and removes the managed GitHub OAuth secret.

## Product Logic Alignment

The R6Z-63 Product Logic delta covered the historical PAT lifecycle. R6Z-93
synchronizes the current OAuth grant lifecycle, explicit access-mode scope
policy, and Custom-only generic create boundary across
`AGENT.CUSTOM.INTEGRATIONS.001`, `AGENT.RUNTIME.PERMISSIONS.001`, and
`AGENT.CONTROL.TOOLS.001`.

## Acceptance

- Organization and Agent setup open the official OAuth flow without a PAT field.
- Public summaries, logs, runtime descriptors, and screenshots contain no PAT
  or OAuth secret.
- GitHub read-only OAuth requests only the explicit least-privilege scope set;
  it never inherits the protected-resource metadata scope list.
- GitHub accepts only `account` scope and uses the fixed curated endpoint.
- Generic connection create rejects every curated provider; GitHub uses only
  the provider-specific connect/reconnect path.
- Concurrent reconnect and disconnect operations leave one consistent final
  connection state with no orphan credential records.
- Mocked upstream discovery proves Bearer forwarding without real GitHub access.
- Organization and Agent UI flows, type checks, focused tests, and isolated E2E
  verification pass.
