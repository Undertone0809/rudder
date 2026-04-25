---
title: Chat project context selector
date: 2026-04-26
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - project_context
  - project_resources
issue:
related_plans:
  - 2026-03-26-rudder-chat-mvp.md
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-04-17-org-resources-onboarding-and-ready-state.md
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - server/src/services/chat-assistant.ts
  - server/src/services/agent-run-context.ts
  - tests/e2e/chat-options-menu.spec.ts
commit_refs: []
updated_at: 2026-04-26
---

# Chat Project Context Selector

## Summary

Add a compact project selector to the chat composer so a new or existing chat can
be scoped to a Rudder project, or explicitly left unscoped. When a project is
selected, the conversation stores a project context link. The chat runtime then
uses the linked project to resolve the execution workspace and load project
resources into the chat prompt.

## Problem

Chat can already reference projects through context links, but the primary
composer does not expose project choice as a first-class context control. This
makes new chats feel detached from work objects and makes project resource
loading depend on hidden route/context behavior instead of an explicit user
choice.

## Scope

- In scope:
  - add a Cursor-style compact project selector in the chat composer
  - allow `No project` as a deliberate selection
  - create new conversations with a selected project context link
  - remember the last project used by chat and default new chats to it
  - allow changing a conversation's selected project context
  - include selected project summary plus project resources in chat prompt
  - add E2E coverage for selector persistence/default behavior
- Out of scope:
  - multi-project chat context selection
  - project creation from the chat selector
  - changing issue conversion UI beyond existing project-aware structured
    payload support

## Implementation Plan

1. Derive the active project from the selected conversation's project context
   link or the new-chat draft state.
2. Add a small project dropdown beside the agent/runtime controls in the
   composer, with `No project` plus active projects.
3. Persist new-chat project choice in local storage per organization and use it
   as the default for the next new chat.
4. When creating a conversation, include a project context link if the draft
   selection is not `No project`.
5. When changing an existing conversation, update the conversation's project
   context link through the chat context API.
6. Extend chat prompt assembly with a selected-project section while preserving
   the existing project-resource prompt loaded from run context.
7. Update tests to verify user-visible project selection and persisted default.

## Success Criteria

- A user can choose a project or `No project` before sending the first message.
- A conversation created with a project stores that project as a context link.
- The next new chat defaults to the last selected project.
- Existing project-linked chats show the correct project in the composer.
- Chat prompt context includes both selected project metadata and project
  resources when a project is selected.

## Validation

- Passed: `pnpm vitest run server/src/__tests__/chat-assistant.test.ts server/src/__tests__/chat-routes.test.ts`
- Passed for affected workspaces during full run: `pnpm -r typecheck`; full command still fails in unrelated `cli/src/__tests__/company-import-export-e2e.test.ts` because that dirty test references a missing `status` property.
- Added E2E coverage in `tests/e2e/chat-options-menu.spec.ts`; direct Playwright execution reached the new worker but hung before assertions due the local Playwright/Chromium runner, matching the current environment issue observed outside this change.
- Passed visible UI verification with an Electron-rendered local page at `http://127.0.0.1:4310`; screenshot saved to `/tmp/rudder-chat-project-selector.png`.
- `pnpm test:run` ran the suite and failed only in the existing `@rudder/cli` organization import/export E2E, where a round-trip export duplicated catalog skills and cleanup hit a non-empty temp directory.
- Passed: `pnpm build`
