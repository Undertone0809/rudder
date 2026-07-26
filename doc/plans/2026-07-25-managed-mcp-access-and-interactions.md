---
title: Managed MCP Access And Interaction Simplification
date: 2026-07-25
kind: implementation
status: completed
area: agent_runtimes
entities:
  - agent_custom_integrations
  - runtime_mcp
  - oauth_grants
  - mcp_connections
issue:
related_plans:
  - 2026-07-23-managed-mcp-oauth-integrations.md
  - 2026-06-27-agent-custom-integrations.md
  - 2026-06-30-agent-v1-mcp-tools.md
supersedes: []
related_code:
  - packages/db/src/schema/mcp_connections.ts
  - packages/db/src/schema/custom_integrations.ts
  - packages/shared/src/types/mcp.ts
  - packages/shared/src/validators/mcp.ts
  - server/src/services/mcp/managed-connections.ts
  - server/src/services/mcp/managed-bindings.ts
  - server/src/services/mcp/managed-runtime.ts
  - server/src/services/mcp/oauth.ts
  - ui/src/pages/OrganizationMcpSettings.tsx
  - ui/src/pages/AgentDetail.integrations.tsx
  - ui/src/pages/AgentManagedMcpConnections.tsx
commit_refs: []
updated_at: 2026-07-25
---

# Managed MCP Access And Interaction Simplification

## Summary

Simplify managed MCP integrations around two concepts: an organization owns one
official provider connection, and each agent receives a coarse access level that
cannot exceed the organization maximum. Organization and agent integration
surfaces both use Discover and Manage tabs. Object-level management happens in
focused dialogs rather than by expanding tool inventories inline.

Supabase becomes account-scoped by default. OAuth activation no longer requires
project selection, and project-specific calls carry their own `project_id`.
Supabase, Linear, and Notion each have one canonical logical connection per
organization; custom MCP connections may remain multiple.

## User Experience

- Organization Discover cards derive their status and primary action from the
  canonical provider connection.
- Organization Manage is a compact list. A provider dialog owns maximum access,
  OAuth identity, reconnect, upgrade, and disconnect actions.
- Agent Discover distinguishes unavailable organization providers from providers
  that are available but not enabled for the agent.
- Agent management uses one explicit access choice:
  - Supabase and Linear: no access, read only, or read and write.
  - Notion: no access or provider-granted access.
  - Custom MCP: no access or full server access.
- Tool checkboxes, tool counts, and user-facing per-tool allow/deny controls are
  removed. Server-owned policy derives the effective tool set.
- Loading and error states never masquerade as disconnected states. Tabs and
  dialogs use keyboard-accessible semantics, focus containment, focus return,
  and live status announcements.

## Contracts And Runtime

- Add a provider availability contract that separates organization connection
  state and maximum access from per-agent access.
- Add organization and agent provider-status endpoints.
- Replace client-generated official connection names with an atomic server-side
  ensure/get-or-create operation.
- Store coarse `accessMode` and `policyRevision` on agent bindings. Legacy tool
  identifiers may only narrow the derived policy during compatibility.
- Classify tools as read, normal write, destructive, admin or billing, or
  unknown. Version the classification policy.
- Read-only access permits read tools. Read-write access additionally permits
  normal writes. Destructive, administrative, billing, and unknown tools fail
  closed in this release.
- Persist a run-start binding policy snapshot. Tool listing and dispatch both
  enforce the intersection of that snapshot, the current binding, and the
  current provider policy. Permission reductions apply immediately; increases
  begin on the next run.
- Make OAuth reconnect a two-phase credential replacement so failed or cancelled
  reauthorization does not disrupt an existing grant.

## Canonicalization And Migration

- Add canonical, superseded, and legacy metadata to official connections plus a
  canonical partial unique index by organization and provider.
- Migrate duplicate official rows deterministically without deleting history.
  Losing rows become disabled and reference the canonical row.
- Preserve existing project-scoped Supabase connections as legacy until an
  operator explicitly upgrades to account access.
- Account-scope upgrade revokes and supersedes the old project grant only after
  successful OAuth completion. Existing agent access resets to no access so the
  broader scope is never granted silently.
- Preserve historical Linear read-only capability until an explicit
  reauthorization grants broader access.

## Product Logic Registry Delta

- `AGENT.CUSTOM.INTEGRATIONS.001`: account-scoped Supabase, canonical official
  providers, coarse agent access, server-derived tool policy, and Discover /
  Manage dialog behavior.
- `AGENT.CONTROL.TOOLS.001`: external MCP authorization remains separate from
  first-party `rudder-tools`, with effective access derived from a run policy
  snapshot.
- `AGENT.RUNTIME.PERMISSIONS.001`: per-agent access, two-phase OAuth,
  fail-closed capability classes, and runtime permission change semantics.

The user explicitly approved this product logic delta as part of the
implementation request.

## Delivery Sequence

1. Add failing data, API, runtime, and UI tests for the new contracts.
2. Implement schema, shared contracts, deterministic migration, and official
   provider canonicalization.
3. Implement account-scoped Supabase OAuth, two-phase reconnect, provider status,
   coarse agent access, and runtime policy enforcement.
4. Implement Organization and Agent Discover / Manage views and focused dialogs.
5. Synchronize the approved Product Logic Registry delta and add end-to-end
   coverage.
6. Run targeted and full repository verification, real-browser visual and
   accessibility checks, independent adversarial review, and black-box
   verification.

## Acceptance

- Repeated or concurrent official-provider Connect actions never create a second
  canonical connection.
- Supabase OAuth reaches a usable account-level connection without a project
  selection screen or `project_ref` endpoint parameter.
- Organization connection changes are reflected in Agent Integrations without a
  false disconnected intermediate state.
- Manage actions open dialogs and never expose the tool inventory wall.
- Read-only agents cannot list or dispatch write tools. Read-write agents still
  cannot list or dispatch destructive, administrative, billing, or unknown
  tools.
- Runtime permission decreases apply during the current run; increases require a
  new run.
- Legacy scope upgrades are explicit and do not silently broaden agent access.
- Migration is idempotent and preserves tool-call, binding, credential, and
  activity history.
- Relevant E2E tests cover the visible journey and high-risk failure cases.
- Product logic check, lint, typecheck, automated tests, build, rendered UI
  review, and independent black-box verification pass before hand-off.
