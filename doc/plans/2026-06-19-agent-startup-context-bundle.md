---
title: Agent startup context bundle
date: 2026-06-19
kind: implementation
status: completed
area: agent_runtimes
entities:
  - agent_startup_context
  - agent_memory
  - messenger_chat
issue:
related_plans:
  - 2026-04-30-agent-memory-instructions.md
  - 2026-04-07-agent-prompt-context-injection.md
  - 2026-06-14-runtime-heartbeat-prompt-and-studio-practices.md
supersedes: []
related_code:
  - server/src/services/agent-startup-context.ts
  - server/src/services/agent-run-context.ts
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
commit_refs: []
updated_at: 2026-06-19
---

# Agent Startup Context Bundle

## Summary

Add a compact `Recent Rudder Context` startup bundle to agent run prompt
assembly. The bundle gives agents a short operating snapshot without loading
full run logs or chat transcripts.

The default prompt shape is:

- `#### today memory/YYYY-MM-DD.md`
- `#### yesterday memory/YYYY-MM-DD.md`
- `#### recent issues`
- `#### recent chats`
- `#### startup context metadata`

Recent issues and chats use single-line `||||` fields to keep token use low.
Recent runs are intentionally not included in the default bundle; run history
should be loaded on demand for recovery/debug workflows.

## Scope

- Create today's and yesterday's daily memory files under
  `$AGENT_HOME/memory/` when the local trusted agent home is writable.
- Inject bounded daily-memory file contents directly under the matching
  `#### today ...` and `#### yesterday ...` headings.
- Add recently handled issues for the same organization and agent.
- Add recent chat snapshots for the same organization where the agent,
  current issue, or current project is linked.
- Append the bundle to `rudderWorkspace.resourcesPrompt`; keep
  `orgResourcesPrompt` synchronized as a legacy alias.
- Expose structured `rudderStartupContext` and `rudderStartupContextMetrics`
  in scene context for observability and tests.
- Persist only startup context metadata, metrics, and source references in
  heartbeat run snapshots; do not persist the injected daily-memory or chat
  snippet markdown.

## Non-Goals

- Do not include recent runs in the default startup bundle.
- Do not load full chat transcripts by default.
- Do not replace `$AGENT_HOME/instructions/MEMORY.md` as stable tacit memory.
- Do not add UI controls in this slice.

## Validation

- Formatter tests cover the compact headings, `||||` line format, metadata, and
  absence of `recent runs`.
- `agentRunContextService` tests prove the startup bundle is appended after
  curated project resources and mirrored through the legacy prompt alias.
- `agentStartupContextService` tests cover multi-linked chat dedupe, current
  chat exclusion in chat scene, and cross-organization isolation.
- Heartbeat actor-path test creates an org, agent, issue, chat, and daily memory
  files, triggers a local Codex run, verifies the adapter prompt includes the
  startup bundle, and reads back the sanitized run context snapshot.
- Server typecheck and runtime-utils typecheck pass.

## Follow-Up

Consider a chat assistant actor-path test once the chat runtime path has a
stable capture harness equivalent to the heartbeat fake Codex command.
