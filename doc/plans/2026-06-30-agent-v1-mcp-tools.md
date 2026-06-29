---
title: Agent V1 MCP Tools
date: 2026-06-30
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - agent_v1_tools
  - runtime_mcp
  - agent_work_loop
issue:
related_plans:
  - 2026-06-27-agent-custom-integrations.md
supersedes: []
related_code:
  - cli/src/agent-v1-registry.ts
  - cli/src/agent-v1-mcp-server.ts
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
commit_refs: []
updated_at: 2026-06-30
---

# Agent V1 MCP Tools

## Summary

Rudder should move agent control-plane work away from shell-first `rudder`
commands and toward first-party typed tools. The CLI remains a human/admin
surface and compatibility fallback, but runtime agents should prefer Rudder MCP
tools when the adapter exposes them.

## Implementation Slice

- Expose a Full `agent-v1` MCP tool manifest with stable names derived from
  capability ids, such as `rudder_issue_checkout`.
- Add a stdio MCP entrypoint at `rudder mcp-server`.
- Implement every Full `agent-v1` tool as a CLI-backed invocation plan so the
  MCP surface preserves the current command contract while agents stop needing
  to compose shell commands directly.
- Inject the first-party Rudder MCP server into Codex and Claude managed
  runtime config while continuing to strip inherited plugin/user MCP config.
- Keep model-provided identity and auth fields out of the MCP input contract:
  the server uses `RUDDER_API_URL`, `RUDDER_API_KEY`, `RUDDER_ORG_ID`,
  `RUDDER_AGENT_ID`, and `RUDDER_RUN_ID` from the runtime environment.
- This slice intentionally uses the CLI as the internal compatibility executor
  behind the MCP server. A later cleanup can move command bodies into a shared
  package without changing the agent-facing tool names.

## Product Boundary

This is agent-visible product behavior. The affected Product Logic Registry
contracts are `AGENT.INSTRUCTIONS.001`, `AGENT.RUNTIME.PERMISSIONS.001`,
`AGENT.SKILLS.001`, `AGENT.INBOX.001`, and a likely new
`AGENT.CONTROL.TOOLS.001`.

This implementation does not edit `doc/product/**` because the guarded Product
Logic Registry requires explicit user approval for that delta.

## Validation

- Registry tests prove MCP metadata exists for every `agent-v1` capability.
- MCP server tests prove runtime env identity overrides model-supplied identity
  fields and every Full `agent-v1` tool can produce a CLI-backed invocation
  plan.
- Codex and Claude runtime tests prove first-party Rudder MCP config is managed
  and inherited user/provider MCP config remains stripped.
