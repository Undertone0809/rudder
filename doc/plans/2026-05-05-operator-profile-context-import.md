---
title: Operator Profile Context Import
date: 2026-05-05
kind: implementation
status: completed
area: ui
entities:
  - operator_profile
  - operator_profile_import
issue:
related_plans:
  - 2026-03-28-operator-profile-settings.md
  - 2026-03-17-memory-service-surface-api.md
supersedes: []
related_code:
  - ui/src/pages/InstanceProfileSettings.tsx
  - ui/src/i18n/locales/en.ts
  - ui/src/i18n/locales/zh-CN.ts
  - packages/shared/src/validators/instance.ts
commit_refs:
  - feat: import operator profile context
updated_at: 2026-05-05
---

# Operator Profile Context Import

## Summary

Add a lightweight import prompt helper to the existing Profile settings page so
operators can bring standing context from another AI provider into Rudder's
operator profile without a separate import wizard.

The first version remains scoped to `moreAboutYou`. It does not create a general
memory service, store raw provider exports, or alter agent heartbeat prompts.

## Problem

Rudder already supports a user-level operator profile with `Your nickname` and
`More about you`, but users who have built up useful memory in another AI
provider must manually discover, export, trim, and paste that context. Claude's
import-memory pattern gives users a clear two-step workflow: copy an export
prompt to the other provider, then paste the result back.

Rudder needs the same ergonomic path without overstating the current feature as
provider-backed memory.

## Scope

- Add a `Copy import prompt` action next to `More about you`.
- Copy the provider-export prompt to the system clipboard.
- Tell the operator to paste the other AI's result directly into `More about
  you`, then edit and save.
- Increase the `moreAboutYou` profile limit enough for imported context.
- Keep saving through the existing profile settings API.
- Do not persist the raw import separately.
- Do not parse, summarize, transform, or classify the pasted export.
- Do not add a modal, section picker, draft preview, append/replace mode, or
  second paste surface.
- Do not add provider connectors, memory bindings, memory operation logs, or
  automatic memory capture.
- Do not inject imported context into agent heartbeats or runtime instructions.

## Implementation Plan

1. Add the provider-export prompt copy action in `InstanceProfileSettings`.
2. Keep `More about you` as the only paste, edit, review, and save surface.
3. Add English and Chinese i18n strings for the copy helper and toast.
4. Raise the shared `moreAboutYou` validation limit and UI `maxLength`.
5. Add or update focused tests for the direct paste flow and validator
   limit where coverage exists.
6. Run targeted UI/shared checks, then broader verification as time permits.

## Design Notes

- Naming should say "profile context" or "another AI", not generic "memory",
  because the first version only edits the operator profile.
- `More about you` remains the durable form field and review point. Users can
  paste over existing text, append manually, trim, or rewrite before saving.
- The helper should not create a second editor or imply that Rudder understands
  provider memory structure. The user owns the final text.
- Raw provider exports may contain sensitive information. The first version
  avoids storing raw import payloads.

## Success Criteria

- A user can copy the prompt, paste exported context directly into `More about
  you`, edit it, and save the profile.
- Existing profile editing remains unchanged when the copy helper is unused.
- Long imported context is accepted up to the new shared limit.
- The UI copy makes clear that imported context affects Rudder chat/profile
  context, not a full memory system.

## Validation

- Unit/component coverage for the copy-helper and direct-paste workflow passed.
- Shared validator coverage for the raised `moreAboutYou` limit passed.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `pnpm test:run` was attempted. The new tests passed, and the full suite
  completed with one existing CLI import/export E2E teardown failure:
  `ENOTEMPTY: directory not empty, rmdir .../organizations`.
- Targeted Playwright E2E was updated and attempted against the existing local
  preview, but Chromium launch hung before test execution in this environment.
  The stuck Playwright/Chromium processes were killed.
- The current worktree preview health endpoint returned `ok` at
  `http://127.0.0.1:3310/api/health`. Browser MCP and local headless Playwright
  both timed out/hung before a visual screenshot could be captured.

## Open Issues

- Whether future versions should summarize imports with the chat assistant.
- Whether a later provider-backed memory service should preserve raw imports
  with provenance, retention policy, and deletion controls.
