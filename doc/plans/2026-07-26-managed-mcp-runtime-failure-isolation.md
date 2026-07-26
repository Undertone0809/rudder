---
title: Managed MCP Runtime Failure Isolation
date: 2026-07-26
kind: fix-plan
status: completed
area: agent_runtimes
entities:
  - agent_custom_integrations
  - runtime_mcp
  - mcp_connections
issue:
related_plans:
  - 2026-07-25-managed-mcp-access-and-interactions.md
  - 2026-07-23-managed-mcp-oauth-integrations.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/managed-external-mcp.ts
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/managed-external-mcp.ts
  - server/src/services/mcp/managed-bindings.ts
commit_refs: []
updated_at: 2026-07-26
---

# Managed MCP Runtime Failure Isolation

## Problem

A managed MCP access-mode update added `accessMode` to the server-owned runtime
binding snapshot without updating the runtime utility's strict descriptor
parser. A Chat turn therefore persisted its user message and Agent Run, then
failed before model generation with
`managedExternalMcpBindings[0] contains unsupported fields: accessMode`.

The contract drift exposed a broader architectural flaw: an integration
capability could decide whether the Agent runtime starts at all. Provider
outages, expired grants, malformed binding snapshots, missing run
authentication, or MCP preflight failures must remove only the affected tool
surface. They must not prevent the Agent from thinking, replying, or using
unrelated capabilities.

## First-Principles Boundary

- The Agent runtime is the primary work executor.
- MCP integrations are revocable, failure-prone capability extensions.
- Security failures must fail closed for the capability: invalid or
  unauthorized MCP tools are omitted and cannot be called.
- Capability failure must fail open for the Agent process: model execution
  continues without that MCP binding.
- A persisted `required` connection may still raise operator attention, but it
  is not runtime-admission authority and cannot make model execution
  unavailable.

## Fix

1. Synchronize the managed binding descriptor with the shared `accessMode`
   contract and validate every legal coarse access value.
2. Isolate malformed descriptors per binding. Omit the bad binding instead of
   rejecting the complete runtime configuration.
3. Treat missing run authentication and proxy/schema preflight failures as
   degraded MCP capability for every binding, including records marked
   `required`.
4. Ensure Codex renders external MCP servers as non-blocking so the downstream
   CLI cannot turn an MCP startup failure into an Agent startup failure.
5. Apply the same degradation rule to Claude, OpenCode, and Pi adapters.
6. Omit a failed first-party MCP from downstream runtime configuration and cap
   synchronous MCP admission checks at a runtime-owned three-second budget.
7. Preserve bounded, secret-free diagnostics through runtime logs/callbacks.
8. Update `AGENT.CUSTOM.INTEGRATIONS.001` and its traceability to make the
   capability-isolation invariant explicit.

## Verification

- Runtime utility tests prove current `accessMode` snapshots are accepted.
- Invalid descriptors, missing auth, unreachable proxies, and failed schema
  discovery omit only the affected MCP binding.
- Adapter tests prove Codex, Claude, OpenCode, and Pi still produce runnable
  configurations when a formerly required MCP binding fails.
- A real local Chat run with an active managed MCP binding reaches model
  execution and completes instead of producing `chat_runtime_exception`.
- Independent review checks fail-closed tool authorization, cross-adapter
  consistency, and diagnostic redaction.
