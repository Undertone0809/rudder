---
title: Agent short IDs and organization member directory
date: 2026-08-20
kind: implementation
status: complete
area: agent_runtimes
entities:
  - agent_runtime
  - organization_members
  - typed_references
issue:
related_plans: []
supersedes: []
related_code:
  - server/src/services/agent-startup-context.ts
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - cli/src/agent-v1-mcp-server.ts
commit_refs: []
updated_at: 2026-08-20
completed_at: 2026-08-20
---

# Agent Short IDs And Organization Member Directory

Implement the approved Agent-facing workflow update without changing durable
UUID storage or the guarded Product Logic Registry. Render typed short refs at
the final prompt and CLI/MCP display boundaries, and expose a read-only,
organization-scoped member directory for startup context and MCP lookup.

The startup context shows all active visible members when the organization has
fewer than ten members. At ten or more, it shows only the count and directs the
Agent to `rudder_organization_members_list` or `rudder org members`.
