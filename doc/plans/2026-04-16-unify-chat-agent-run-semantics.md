---
title: Unify chat with agent-run semantics
date: 2026-04-16
kind: plan
status: planned
area: chat
entities:
  - messenger_chat
  - agent_run_context
  - rudder_copilot
issue:
related_plans:
  - 2026-04-17-chat-codex-trusted-workspace-fix.md
supersedes: []
related_code:
  - server/src/services/chat-assistant.ts
  - server/src/services/agent-run-context.ts
commit_refs: []
updated_at: 2026-04-17
---

# Unify Chat With Agent-Run Semantics

## Summary

Chat currently forks from heartbeat and only reuses runtime/model selection. This causes drift in instructions, enabled skills, workspace context, and agent identity. The implementation will move chat onto a shared agent-run preparation path, keep the existing structured chat envelope, and replace the old org-default built-in assistant fallback with a system-managed `Rudder Copilot` agent identity.

## Implementation

- Introduce a shared run-prep service used by heartbeat and chat to resolve:
  - runtime adapter config + secrets
  - enabled skills and realized runtime skills
  - skill sync fields injected into runtime config
  - workspace context hints and canonical agent/org workspace paths
  - scene metadata for `heartbeat` vs `chat`
- Update chat assistant runtime resolution:
  - preferred-agent chats use the selected agent’s prepared run context
  - fallback chats use a hidden system-managed Copilot identity derived from org chat defaults
  - chat prompt remains chat-scene specific and keeps the existing sentinel/envelope contract
- Update shared chat/runtime descriptors and UI labels so the visible speaker/runtime source is either the selected agent or `Rudder Copilot`.
- Keep chat proposal, approval, and persistence behavior unchanged.

## Tests

- Extend chat assistant service tests to verify prepared skill sync and instructions parity for preferred-agent chat.
- Add Copilot fallback tests for runtime descriptor and prompt identity.
- Update chat route tests for correct `replyingAgentId` behavior and unchanged issue/operation proposal flows.
- Update UI tests/copy assertions for Copilot terminology and source labels.

## Assumptions

- No routing or handoff to other agents in this change.
- No new public chat API endpoints or wire-shape changes.
- Org-level default chat runtime fields remain the Copilot config source for backward compatibility.
- First implementation avoids new persistence/schema for Copilot unless required by an uncovered runtime constraint.
