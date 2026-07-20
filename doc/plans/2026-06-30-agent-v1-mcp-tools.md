---
title: Agent V1 MCP Tools
date: 2026-06-30
kind: implementation
status: completed
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
  - packages/agent-runtime-utils/src/rudder-mcp.ts
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
commit_refs: []
updated_at: 2026-06-30
---

# Agent V1 MCP Tools

## Summary

Rudder should move agent operating-layer work away from shell-first `rudder`
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
- Real-local acceptance used an isolated Rudder instance at
  `/tmp/rudder-mcp-real2` with `RUDDER_INSTANCE_ID=mcp-real2` and disposable
  organization `62a219ba-d2b7-461d-bef5-406cfbcf48c6`.
- Codex local run `91d46da7-40de-4ad7-8192-1a8dd47bf568` used
  `rudder-operating-layer` MCP tools to run `rudder_issue_context`,
  `rudder_issue_checkout`, `rudder_issue_comment`, and `rudder_issue_done` for
  issue `MCP-1`; the issue ended `done` with both marker comments.
- Claude local run `173120da-ea9d-4b7b-be8c-94bd250d37df` used the same MCP
  workflow for issue `MCP-2`; the issue ended `done` with both marker comments.
- Direct transcript inspection found no shell `rudder ...` command executions
  in either accepted run; the operating-layer writes came through MCP tool calls.
- Both managed runtime configs contained runtime-owned MCP identity environment:
  `RUDDER_API_URL`, `RUDDER_API_KEY`, `RUDDER_ORG_ID`, `RUDDER_AGENT_ID`, and
  `RUDDER_RUN_ID`.
- Real-local config mode inspection after the credential-permission hardening
  confirmed Claude `rudder-mcp.json`, Claude `settings.json`, and Codex
  `config.toml` were all owner-only `0600`.
