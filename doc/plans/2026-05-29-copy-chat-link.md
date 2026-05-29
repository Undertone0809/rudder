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
  - tests/e2e/issue-comment-mentions.spec.ts
  - tests/e2e/chat-composer-reference-navigation.spec.ts
  - tests/e2e/messenger-copy-chat-link.spec.ts
commit_refs:
  - "feat: copy chat references from messenger"
  - "feat: navigate chat composer references"
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
- Chat composer inline tokens now support click navigation for `agent://`,
  `issue://`, `project://`, `chat://`, and organization skill references with
  a known details route.

## Global Editor Follow-Up

The inline-token click behavior belongs to `MarkdownEditor`, not to Chat. All
editor instances that decorate Rudder references should use the same default
navigation contract:

- `agent://<agent-id>` opens `/agents/<agent-id>`.
- `issue://<issue-id>?r=<identifier>` opens `/issues/<identifier-or-id>`.
- `project://<project-id>` opens `/projects/<project-id>`.
- `chat://<chat-id>` opens `/messenger/chat/<chat-id>`.
- Skill references open the organization skill details route when the editor's
  `mentions` metadata includes a `skillDetailsHref` for the markdown target.

Callers may still provide `onInlineTokenClick` when they need a custom action,
but normal Rudder editors should not duplicate this routing logic.

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

## Follow-Up Validation

Earlier Chat-composer navigation follow-up:

- Added `tests/e2e/chat-composer-reference-navigation.spec.ts` to verify that
  agent, issue, chat, and skill reference tokens in the Chat composer navigate
  to their target pages when clicked.
- `pnpm --filter @rudderhq/ui exec vitest run src/components/MarkdownEditor.test.tsx src/lib/inline-token-dom.test.ts src/lib/mention-chips.test.ts --reporter=verbose`
  passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-composer-reference-navigation.spec.ts tests/e2e/chat-composer-backspace.spec.ts --project=chromium`
  passed.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `pnpm test:run` failed only on unrelated transient/concurrent checks:
  two embedded PostgreSQL init suites and two credential-helper timeout tests.
  Focused reruns of all four failed checks passed.

Global editor navigation follow-up:

- Extended the issue comment composer E2E path to verify the same default
  `MarkdownEditor` navigation outside Chat.
- Moved default inline-token click navigation into `MarkdownEditor`, with Chat
  retaining only its mention and skill metadata instead of a page-local click
  router.
- `pnpm --filter @rudderhq/ui exec vitest run src/components/MarkdownEditor.test.tsx src/lib/inline-token-dom.test.ts src/lib/mention-chips.test.ts --reporter=verbose`
  passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-composer-reference-navigation.spec.ts tests/e2e/issue-comment-mentions.spec.ts --project=chromium`
  passed.
- After removing the Chat-local override prop, `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-composer-reference-navigation.spec.ts --project=chromium`
  passed, confirming Chat uses the shared `MarkdownEditor` default navigation.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `pnpm test:run` failed on unrelated existing/global-suite issues: multiple
  embedded PostgreSQL suites hit shared-memory initialization failures,
  `server/src/__tests__/codex-local-execute.test.ts` timed out in the existing
  GitHub credential-helper case, and `ui/src/pages/Chat.test.tsx` failed in an
  unrelated draft-project default test with `NO_PROJECT_ID is not defined`.

## Review Gate

Spawned reviewer tooling was unavailable in this runtime, so the lifecycle
review gate is recorded as blocked rather than passed. Local implementation,
automated validation, and browser proof were completed.
