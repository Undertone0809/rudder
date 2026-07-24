---
title: Chat failure Agent Run navigation
date: 2026-07-24
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - agent_runs
related_plans:
  - 2026-07-21-chat-agent-run-conversation-grouping.md
---

# Chat Failure Agent Run Navigation

## Approved Design

- A failed runtime-backed assistant message exposes a neutral `Open run` action
  for that message's exact Agent Run, alongside `Retry` when retry is available.
- The target requires both a run id and an agent id. Agent identity resolves in
  this order: the message replying agent, the conversation runtime agent, then
  the conversation preferred agent. Without a complete target, Chat does not
  render a dead link.
- The link opens the existing organization-aware Agent Run route in the current
  workspace. The short run id remains plain diagnostic text.
- The failure action area may wrap on narrow screens.
- Unit coverage proves exact per-message target resolution, retryable and
  non-retryable rendering, missing-identity behavior, coexistence with Retry,
  and exact hrefs. End-to-end coverage verifies the real failure message route
  and navigation.
- Synchronize `RUN.CHAT.AGENT.001` and `CHAT.LIFECYCLE.001` with the approved
  direct failed-message-to-run navigation behavior.

## Interfaces

No API, schema, or shared type changes are required.

## User-Approved Follow-Up

- Treat the top Agent Run summary card as the single failure-summary source in
  run detail. It retains `Run failed`, the operator-facing message, error code,
  and action guidance.
- Remove the duplicate bottom `Failure details` block. Transcript and Raw views
  continue to preserve the original diagnostic evidence.
- This is a presentation-only deduplication. `RUN.RESULT.001` remains satisfied
  by the top summary and transcript evidence, so no Product Logic Registry
  change is required.
