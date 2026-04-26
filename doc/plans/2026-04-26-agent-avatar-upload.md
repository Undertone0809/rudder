---
title: Agent avatar upload
date: 2026-04-26
kind: implementation
status: completed
area: ui
entities:
  - agent_avatar
  - agents
related_plans:
  - 2026-04-21-agent-workspace-browser-identity-labels.md
  - 2026-04-22-agent-dashboard-skills-analytics.md
supersedes: []
related_code:
  - packages/shared/src/validators/agent.ts
  - server/src/routes/agents.ts
  - ui/src/components/AgentIconPicker.tsx
  - ui/src/pages/AgentDetail.tsx
commit_refs: []
updated_at: 2026-04-26
---

# Agent Avatar Upload

## Context

Rudder already stores an `agents.icon` text value and renders it across the
Agent detail, sidebar, mentions, and assignment surfaces. Today that value is
effectively limited to built-in icon names in the shared validator, while the UI
renderer already tolerates custom text. The missing product surface is a
first-class way for an operator to choose an emoji or upload an image avatar.

## Decision

Keep avatar identity on the existing `agents.icon` field to avoid a schema
migration and preserve old icon names. Use three supported value shapes:

- built-in icon names from `AGENT_ICON_NAMES`
- short custom emoji/text values
- uploaded image references in the controlled form `asset:<assetId>`

Uploaded images will be accepted through an agent-scoped avatar endpoint. The
server will validate organization access, compress the image with `sharp` to a
bounded WebP avatar, store it through the existing asset storage service, update
the agent icon to `asset:<assetId>`, and log the mutation.

## Implementation

1. Broaden shared agent icon validation so create/update accepts built-in icons,
   emoji, or server-issued `asset:<uuid>` references with a tight length cap.
2. Add `POST /api/agents/:id/avatar` for image upload and compression.
3. Update the UI agent picker to support built-in icons, emoji entry, image
   upload, and reset to default.
4. Render `asset:<id>` values as avatar images everywhere `AgentIcon` is used.
5. Add backend route tests and a focused UI test around picker behavior.

## Verification

- `pnpm vitest run server/src/__tests__/agent-avatar-routes.test.ts`
- `pnpm vitest run ui/src/components/AgentIconPicker.test.tsx`
- `pnpm -r typecheck`
- `pnpm build`
- Manual API verification against `pnpm dev`: emoji PATCH succeeds; image
  upload returns `201`, stores `image/webp`, and updates `agents.icon` to
  `asset:<assetId>`.
- Browser Use DOM verification against `pnpm dev`: the avatar picker opens from
  the Agent detail header, emoji application updates the avatar button, and an
  uploaded avatar renders as an `<img>` with `/api/assets/<id>/content`.
- `pnpm test:e2e --grep "Agent avatar"` was attempted twice but did not execute
  the test body because Playwright timed out launching
  `chrome-headless-shell`.

`pnpm test:run` was also attempted. Avatar tests passed, but the full suite was
blocked by unrelated dirty worktree failures in `PrimaryRail` ordering and the
CLI organization import/export fixture, plus an existing automation e2e suite
startup error.

## Notes

`agent_avatar` is a new retrieval entity minted for this plan because existing
taxonomy entities cover broader agent runtime/workspace surfaces but not visual
profile identity.
