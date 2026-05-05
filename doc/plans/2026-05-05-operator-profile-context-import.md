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

Add a guided import workflow to the existing Profile settings page so operators
can bring standing context from another AI provider into Rudder's lightweight
operator profile.

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

- Add an `Import from another AI` action to Profile settings.
- Show a modal with a copyable provider-export prompt.
- Accept pasted markdown/text from another provider.
- Parse known category headers when possible.
- Let the operator include/exclude categories, review the generated draft, and
  append or replace the current `More about you` field.
- Increase the `moreAboutYou` profile limit enough for imported context.
- Keep saving through the existing profile settings API.
- Do not persist the raw import separately.
- Do not add provider connectors, memory bindings, memory operation logs, or
  automatic memory capture.
- Do not inject imported context into agent heartbeats or runtime instructions.

## Implementation Plan

1. Add local parsing and draft-building helpers in `InstanceProfileSettings`.
2. Add a profile import dialog with copy, paste, category selection, draft
   preview, append/replace mode, and apply action.
3. Add English and Chinese i18n strings for the import workflow.
4. Raise the shared `moreAboutYou` validation limit and UI `maxLength`.
5. Add or update focused tests for the profile page import flow and validator
   limit where coverage exists.
6. Run targeted UI/shared checks, then broader verification as time permits.

## Design Notes

- Naming should say "profile context" or "another AI", not generic "memory",
  because the first version only edits the operator profile.
- The dialog applies changes to the editable form state first. The existing
  `Save profile` button remains the durable commit path, preserving the current
  profile settings behavior.
- Appending is the default when existing context is present. Replacing is an
  explicit operator choice.
- Parsed categories are a review aid, not a strict import schema. Unrecognized
  text remains importable after review.
- Raw provider exports may contain sensitive information. The first version
  avoids storing raw import payloads.

## Success Criteria

- A user can copy the prompt, paste exported context, review the draft, apply it
  to `More about you`, and save the profile.
- Existing profile editing remains unchanged when the import dialog is unused.
- Long imported context is accepted up to the new shared limit.
- The UI copy makes clear that imported context affects Rudder chat/profile
  context, not a full memory system.

## Validation

- Unit/component coverage for the import workflow passed.
- Shared validator coverage for the raised `moreAboutYou` limit passed.
- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `pnpm test:run` was attempted. The new tests passed, but existing
  embedded-Postgres suites failed to initialize with `Postgres init script
  exited with code 1`.
- Targeted Playwright E2E was added and attempted, but the isolated E2E server
  hit the same embedded-Postgres initialization failure before the browser test
  could run.
- Browser verification was attempted with the current worktree UI proxied to an
  existing local backend. Browser MCP calls timed out and local Playwright
  browser launch hung before page navigation, so no final screenshot was
  captured in this environment.

## Open Issues

- Whether future versions should summarize imports with the chat assistant.
- Whether a later provider-backed memory service should preserve raw imports
  with provenance, retention policy, and deletion controls.
