---
title: Replace chat work mode with plan mode
date: 2026-04-18
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_plan_mode
  - issue_plan_document
issue: RUD-140
related_plans:
  - 2026-03-26-rudder-chat-mvp.md
  - 2026-03-13-issue-documents-plan.md
  - 2026-04-16-unify-chat-agent-run-semantics.md
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - server/src/services/chat-assistant.ts
  - server/src/services/chats.ts
  - server/src/routes/chats.ts
  - packages/shared/src/types/chat.ts
  - packages/db/src/schema/chat_conversations.ts
commit_refs:
  - feat: add chat plan mode
updated_at: 2026-04-18
---

# Replace Chat Work Mode With Plan Mode

## Summary

Replace the current chat composer `Work mode` concept (`Issue-focused` vs `Allow
lightweight changes`) with a single `Plan mode` toggle. When enabled, chat
should behave like a planning lane: the runtime stays read-only where supported,
the assistant should converge on an implementation plan, and the conversation
should end with a created issue that stores that plan as the issue `plan`
document.

## Problem

The current mode model solves the wrong problem. `Allow lightweight changes`
mixes chat clarification with direct control-plane mutations, while the user now
wants a planning-first toggle closer to Codex: on means "investigate and write a
plan only", off means "normal chat". If we only rename the UI, the backend will
still permit lightweight-change proposals and the runtime will still be able to
write, so the product contract would remain misleading.

## Scope

- In scope:
  - replace conversation `operationMode` state with `planMode`
  - remove lightweight-change proposal behavior from chat
  - add plan-mode runtime overlays for local coding runtimes that support
    stronger read-only / plan execution modes
  - require plan-mode issue proposals to carry a plan body
  - create/update the issue `plan` document when a plan-mode chat creates an
    issue
  - update chat UI copy and E2E / server tests
- Out of scope:
  - redesign the broader messenger shell
  - add a separate long-running planning agent workflow
  - retrofit all runtime adapters with hard read-only enforcement when their
    CLIs do not expose a usable planning mode

## Implementation Plan

1. Replace shared chat contracts and persistence from `operationMode` to
   boolean `planMode`, including schema, validators, API types, and route
   payloads.
2. Update chat assistant prompting so plan mode:
   - never emits lightweight change proposals
   - asks for read-only investigation and a final issue proposal
   - includes a structured plan payload that can become an issue document
3. Apply runtime-config overlays for plan mode on supported adapters:
   - `codex_local`: force `-s read-only`
   - `claude_local`: force `--permission-mode plan`
   - `cursor`: force `--mode plan`
4. Update chat issue conversion so plan-mode issue creation also upserts the
   issue `plan` document and keeps the normal chat-to-issue linkage.
5. Replace the composer menu's `Work mode` submenu with a single `Plan mode`
   toggle and update proposal rendering so issue proposals can show the plan
   body.
6. Refresh targeted server tests plus the chat options E2E to verify the new
   behavior and persistence.

## Design Notes

- The primary product correction is semantic, not visual. The old
  lightweight-change path should be removed from the chat scene instead of being
  hidden behind renamed labels.
- Plan mode should create a real issue artifact, not leave the plan stranded in
  chat-only prose. The existing issue `plan` document is the canonical storage
  target.
- Runtime enforcement is best-effort by adapter. Where the adapter exposes a
  concrete planning/read-only mode, use it. Where it does not, rely on prompt
  policy for this pass rather than blocking the whole feature.
- Existing conversations should default to `planMode = false` after migration.

## Success Criteria

- The chat composer exposes `Plan mode` instead of `Work mode`.
- No chat path emits or resolves lightweight change proposals anymore.
- A plan-mode conversation can produce an issue proposal with plan content and
  create an issue whose `plan` document is populated.
- Supported local runtimes receive a plan/read-only execution overlay when plan
  mode is on.
- Normal chat continues to function with plan mode off.

## Validation

- `pnpm -r typecheck`
- targeted server tests for chat assistant + chat routes
- `pnpm playwright test tests/e2e/chat-options-menu.spec.ts`
- manual chat UI verification for the composer toggle and plan proposal card

Validated on 2026-04-18:

- `pnpm -r typecheck`
- `pnpm vitest run server/src/__tests__/chat-assistant.test.ts server/src/__tests__/chat-routes.test.ts`
- `pnpm test:e2e -- tests/e2e/chat-options-menu.spec.ts`
- `pnpm test:run`
- `pnpm build`
- manual UI screenshot: `/tmp/rudder-plan-mode-toggle.png`

## Open Issues

- Some non-primary runtimes may only get prompt-level plan restrictions in this
  pass if their CLIs do not expose a reliable read-only or planning flag.
