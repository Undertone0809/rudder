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

# GitHub Managed MCP PAT Integration

## Scope

Rudder supports GitHub as a curated managed MCP provider at
`https://api.githubcopilot.com/mcp/`. The first release uses a GitHub personal
access token instead of managed OAuth because this deployment has no GitHub
OAuth client configuration. Tokens enter only mutation requests, are encrypted
as organization secrets, and are forwarded to GitHub only as a Bearer header.

GitHub connections are account-scoped, target either the organization or one
Agent, and default to read-only access. Organization and Agent targets have
independent credentials and canonical connection slots. An Agent target takes
precedence over the organization target for that Agent, while an explicit
no-access binding continues to block fallback.

## Lifecycle And Concurrency

Connect, reconnect, disconnect, and tool discovery use the existing managed MCP
lifecycle. Reconnect replaces the PAT and reactivates the connection only after
the replacement secret is ready. Disconnect disables the connection and removes
the managed GitHub secret. Lifecycle mutations lock the connection inside the
transaction and use a lifecycle revision compare-and-set, so concurrent PAT
replacement and disconnect operations serialize without resurrecting disabled
connections or orphaning secrets.

## Product Logic Alignment

The current user explicitly authorized the reviewer-requested Product Logic
delta in Issue R6Z-63. `AGENT.CUSTOM.INTEGRATIONS.001` now covers GitHub's
curated account-scoped PAT lifecycle and Custom-only generic create boundary;
`AGENT.RUNTIME.PERMISSIONS.001` covers encrypted server-side PAT handling and
Bearer-only runtime forwarding; `AGENT.CONTROL.TOOLS.001` records that the
provider-specific endpoint and credential remain outside the provider-neutral
runtime descriptor. The registry, contract pages, traceability, and test lists
are updated together.

## Acceptance

- Organization and Agent setup accept a PAT without opening OAuth.
- Public summaries, logs, runtime descriptors, and screenshots contain no PAT.
- GitHub accepts only `account` scope and uses the fixed curated endpoint.
- Generic connection create rejects every curated provider; GitHub uses only
  the provider-specific connect/reconnect path.
- Concurrent reconnect and disconnect operations leave one consistent final
  connection state with no orphan credential records.
- Mocked upstream discovery proves Bearer forwarding without real GitHub access.
- Organization and Agent UI flows, type checks, focused tests, and isolated E2E
  verification pass.
