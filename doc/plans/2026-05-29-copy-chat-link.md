---
title: Copy chat link references
date: 2026-05-29
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_composer
issue:
related_plans:
  - 2026-05-10-messenger-pinned-thread-summary.md
supersedes: []
related_code:
  - packages/shared/src/project-mentions.ts
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/MarkdownBody.tsx
  - tests/e2e/messenger-copy-chat-link.spec.ts
commit_refs:
  - "feat: copy chat references from messenger"
updated_at: 2026-05-29
---

# Copy Chat Link References

## Summary

Add a Messenger sidebar action that copies a chat conversation as a structured
reference, so pasting it into the New Chat composer and other Rudder text inputs
renders as a compact chat reference instead of a raw UUID.

## Problem

The current action copies only the conversation ID. That is technically useful
for debugging, but it does not carry enough UI semantics for operators to paste
the reference into another input and see what object is being referenced.

## Scope

- Rename the action to `Copy Chat Link`.
- Copy canonical markdown in the existing Rudder inline-reference style.
- Add a shared `chat://` reference parser/builder alongside existing
  `agent://`, `project://`, and `issue://` references.
- Render pasted chat references as inline chips in the plain-text composer and
  rendered markdown surfaces.
- Keep the referenced chat itself unchanged; this is a copy/paste reference
  affordance, not a new chat-link persistence model.

## Non-Goals

- Do not add a server-side chat reference attachment table.
- Do not auto-expand the referenced transcript into the prompt.
- Do not turn the chat composer into a general Markdown editor.
- Do not change archive, pin, unread, or thread ordering semantics.

## Acceptance Criteria

- The Messenger chat row menu exposes `Copy Chat Link`.
- Selecting it writes markdown like `[Chat title](chat://<chat-id>)` to the
  clipboard.
- Pasting that value into New Chat renders a chat reference chip while preserving
  canonical text copy/export.
- Rendered markdown surfaces link chat references to `/messenger/chat/<chat-id>`.
- Focused unit/component tests and an E2E workflow cover the copy and paste
  path.

## Validation Plan

- Run focused shared/UI tests for chat reference parsing, sidebar copy behavior,
  and markdown rendering.
- Run the Messenger copy-link E2E test.
- Run repo-required typecheck/test/build where feasible, reporting any unrelated
  existing failures separately.

## Implementation Notes

- The copied value is canonical markdown: `[Chat title](chat://<chat-id>)`.
- `chat://` is parsed in the same shared mention pipeline as existing
  `project://`, `issue://`, and `agent://` references.
- The composer remains plain text; only recognized Rudder reference links are
  decorated as inline chips.
- Rendered markdown links `chat://<chat-id>` to `/messenger/chat/<chat-id>`.

## Validation Results

- `pnpm --filter @rudderhq/shared exec vitest run src/project-mentions.test.ts --reporter=verbose`
  passed.
- `pnpm --filter @rudderhq/ui exec vitest run src/lib/mention-chips.test.ts src/lib/mention-aware-link-node.test.ts src/components/MarkdownBody.test.tsx src/components/MessengerContextSidebar.actions.test.tsx --reporter=verbose`
  passed.
- `pnpm --filter @rudderhq/shared typecheck` passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/messenger-copy-chat-link.spec.ts --project=chromium`
  passed.
- Browser proof captured the pasted chat reference chip in New Chat at
  `/tmp/rudder-copy-chat-link.png`.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `pnpm test:run` had one transient failure:
  `server/src/__tests__/companies-route-path-guard.test.ts` returned
  `socket hang up` during the full concurrent suite. The focused rerun
  `pnpm --filter @rudderhq/server exec vitest run src/__tests__/companies-route-path-guard.test.ts --reporter=verbose`
  passed.

## Review Gate

Spawned reviewer tooling was unavailable in this runtime, so the lifecycle
review gate is recorded as blocked rather than passed. Local implementation,
automated validation, and browser proof were completed.
