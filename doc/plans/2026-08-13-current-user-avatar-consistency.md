---
title: Current user avatar consistency
date: 2026-08-13
kind: fix-plan
status: completed
area: ui
entities:
  - user_identity
  - issue_properties
  - assignee_labels
issue:
related_plans:
  - 2026-07-25-simplify-issue-agent-identity.md
supersedes: []
related_code:
  - ui/src/hooks/useCurrentUserAvatar.ts
  - ui/src/components/Identity.tsx
  - ui/src/components/AssigneeLabel.tsx
commit_refs: []
updated_at: 2026-08-13
---

# Current User Avatar Consistency

## Summary

Use the signed-in Desktop account avatar everywhere the current user appears as
a person in Rudder. Preserve the existing fallback for other users, signed-out
sessions, accounts without an avatar, unavailable Desktop identity bridges, and
image load failures.

This is a presentation-only consistency fix. It does not add arbitrary user
avatar lookup, change persistence or API contracts, or modify the guarded
Product Logic Registry.

## Implementation

- Let shared user identity and assignee labels render an optional avatar URL
  while retaining their current fallback visuals and dimensions.
- Reuse `useCurrentUserAvatar` at Issue, comment, list, and Chat proposal
  surfaces, and pass the image only when the rendered user ID matches the
  current board user ID.
- Keep existing Activity and Dashboard avatar behavior aligned with the same
  identity source.
- Audit person-identity `User` placeholders without changing navigation,
  filtering, or other functional icons.

## Acceptance

- Current-user Assignee, Reviewer, Created by, comment author, child Issue,
  Issue list, inline assignment, and Chat proposal identities use the account
  avatar when present.
- Other user identities never reuse the current account avatar.
- Missing, failed, or unavailable avatar images retain the existing fallback
  without layout shift.
- Component tests, relevant E2E coverage, repository checks, and real rendered
  Desktop and constrained-width inspection pass for the same candidate.

## Validation

- Focused UI component and hook tests.
- Relevant Issue and Chat Playwright E2E coverage.
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `pnpm product-logic:check`
- Independent reviewer, exact-candidate black-box verifier, and final reviewer.

## Result

- Shared current-user avatar state now follows Desktop identity updates while
  preventing delayed initial state/profile reads from overriding newer state.
- Current-user identities use the account image across Issue, list, Kanban,
  creation, approval, comment, transcript, and Chat surfaces; other user IDs
  keep their existing fallback.
- Playwright covers the representative Issue, Kanban, New Issue, Chat, mobile,
  and broken-image workflows. Ego-browser rendered verification confirms the
  final desktop and mobile layouts without avatar overlap or horizontal
  overflow.
