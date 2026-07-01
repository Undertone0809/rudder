---
title: Agents Domain
domain: agents
status: active
coverage: seed
contract_ids: []
related_code:
  - server/src/services/agent-run-context.ts
  - server/src/services/agent-instructions.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
related_tests:
  - server/src/__tests__/agent-instructions-service.test.ts
  - server/src/__tests__/agent-run-context.test.ts
edit_policy: user_confirmed_only
---

# Agents Domain

## Owns

- Durable agent identity, role, capability, runtime config, and instruction
  loading.
- Enabled skill resolution for a runtime invocation.
- Agent-facing inbox and skill telemetry.
- Stable instruction and dynamic run-context separation.

## Does Not Own

- Heartbeat admission or execution lifecycle. See `RUN.*`.
- Issue assignment/reviewer routing. See `ROUTING.*`.
- Project resource ownership. See library-and-context.

## Contract Index

- `AGENT.INSTRUCTIONS.001`: stable instructions, runtime skills, workspace
  context, project resources, automations, and startup context are loaded in a
  bounded runtime context.
- `AGENT.IDENTITY.CONFIG.001`: agent identity and config define durable team
  membership and invocation eligibility.
- `AGENT.RUNTIME.ADAPTERS.001`: runtime adapter capabilities define what Rudder
  may test, inject, execute, parse, and report.
- `AGENT.RUNTIME.PERMISSIONS.001`: local runtime platform permissions define
  how managed homes, operator-home bridges, skills, credentials, and
  filesystem substitutions behave across macOS, Linux, and Windows.
- `AGENT.CONTROL.TOOLS.001`: first-party Rudder MCP control-plane tools expose
  the stable `agent-v1` command contract to supported runtimes through
  runtime-managed identity and auth.
- `AGENT.SKILLS.001`: skills have source, desired, enabled, materialized, and
  always-enabled semantics.
- `AGENT.SKILL.TELEMETRY.001`: skill analytics preserve evidence level.
- `AGENT.INBOX.001`: agent-facing inbox exposes actionable assignee and reviewer
  work.
