---
title: Remove Copilot Default Chat Runtime
date: 2026-05-07
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_runtime
  - organization_settings
issue: ZST-38
related_plans:
  - 2026-03-26-chat-revision-hybrid-runtime-claude-ui.md
  - 2026-04-16-unify-chat-agent-run-semantics.md
supersedes: []
related_code:
  - server/src/services/chat-assistant.ts
  - server/src/services/agent-run-context.ts
  - packages/shared/src/types/chat.ts
  - packages/db/src/schema/organizations.ts
  - ui/src/pages/Chat.tsx
  - ui/src/pages/OrganizationSettings.tsx
commit_refs:
  - 492c0de
  - 3c383cb
  - 45480ff
  - 723f9f5
updated_at: 2026-05-07
---

# Remove Copilot Default Chat Runtime

## Summary

Remove the organization-level default chat runtime and the hidden Rudder Copilot fallback. Chat assistant turns should only execute through an explicit preferred agent, so assistant replies always map to a real agent identity and runtime configuration.

## Problem

The current chat runtime path falls back to a system-managed Rudder Copilot agent when a conversation has no preferred agent. That makes replies attributable to a hidden synthetic identity and keeps organization-level runtime config in settings and persistence.

## Scope

- Remove server fallback resolution to organization default chat runtime.
- Stop creating or updating hidden Rudder Copilot agents.
- Remove organization default chat runtime fields from shared contracts, DB schema, and settings UI.
- Keep `defaultChatIssueCreationMode`; issue proposal behavior remains organization-configurable.
- Keep legacy hidden-agent filtering for any previously materialized Copilot rows.
- Do not build automatic agent routing or assignment selection in this change.

## Implementation Plan

1. Update shared chat/runtime descriptors to support only selected-agent or unconfigured states.
2. Remove organization default runtime fields from schema, validators, services, and UI API types.
3. Remove Copilot fallback creation from agent run context and chat assistant runtime resolution.
4. Update Chat UI copy and composer behavior so users always have a real selected agent when one is available.
5. Update tests around chat runtime availability, org defaults, and settings copy.

## Design Notes

- Conversations may still exist without `preferredAgentId`; the composer defaults to the last selected available agent, or the first available agent, and persists that selection before assistant execution.
- The organization settings Chat section remains the home for default issue creation mode and archived conversations.
- Existing database columns are dropped by migration; historical migration snapshots remain as history.

## Success Criteria

- Unassigned chat turns return an unavailable runtime descriptor and do not invoke adapters unless the UI first persists a real selected agent.
- Preferred-agent chat turns preserve agent instructions, skills, workspace context, and `replyingAgentId`.
- Organization responses no longer expose default chat runtime type/config.
- Settings no longer offers Copilot runtime configuration.

## Validation

- Run focused server and UI tests for chat assistant, chat routes, org service, and Chat page behavior.
- Run typecheck after migration/schema updates.
- Run broader repo checks before close-out if time allows.

## Open Issues

- E2E execution is currently blocked in this checkout by local embedded PostgreSQL init failures before the affected browser specs can run.
