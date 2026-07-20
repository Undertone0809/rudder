---
title: Oreo agent avatar style
date: 2026-07-20
kind: implementation
status: completed
area: ui
entities:
  - agent_avatar
  - agents
issue: R6-17
related_plans:
  - 2026-04-26-agent-avatar-upload.md
supersedes: []
related_code:
  - packages/shared/src/constants.ts
  - packages/shared/src/validators/agent.ts
  - server/src/services/agents.ts
  - server/src/routes/agents.management-routes.ts
  - server/resources/bundled-skills/rudder-docs/references/agent-creation.md
  - ui/src/lib/agent-avatar.ts
  - ui/src/components/AgentIconPicker.tsx
  - ui/src/components/AgentAvatar.tsx
  - tests/e2e/agent-avatar.spec.ts
  - doc/product/domains/agents/identity-config.md
  - doc/product/registry.yml
commit_refs: []
updated_at: 2026-07-20
---

# Oreo Agent Avatar Style

## Summary

Add Oreo as the default generated avatar style for newly created and hired
agents while retaining DiceBear Notionists and uploaded images as supported
choices. Store Oreo identity in the existing `agents.icon` field, render it
through the shared avatar helpers used across the UI, and expose both generated
styles in a compact avatar picker.

The affected Product Logic contract is `AGENT.IDENTITY.CONFIG.001`. R6-17
explicitly authorizes the corresponding `doc/product/**` delta for the
approved behavior in this plan.

## Problem

New agents currently receive a generated DiceBear Notionists reference, and
the avatar picker only changes the DiceBear background or uploads an image.
Rudder needs a richer deterministic Oreo style without breaking persisted
DiceBear, uploaded-image, legacy named-icon, or missing-icon behavior.

## Scope

In scope:

- Pin `@oreo-design/avatar` to `0.1.0` in the UI workspace.
- Add the six Oreo shape IDs and 40 palette IDs from that exact package version
  to shared constants and types.
- Validate the strict `oreo:<shape>:<palette>:<uuid>` format together with the
  existing DiceBear and `asset:<uuid>` formats.
- Generate and persist `oreo:bloom:rose-milk:<uuid>` when creation or hiring
  omits `icon` or supplies a legacy named icon.
- Preserve valid Oreo, DiceBear, and uploaded-image references during create
  normalization.
- Render Oreo references as deterministic circular SVG data URIs with the UUID
  passed as `variantId`, cached by the complete persisted reference.
- Replace the single-style picker with compact Oreo and DiceBear tabs. Oreo
  exposes all shapes and palettes; DiceBear retains Random and the six current
  background presets; Random affects only the active style; upload remains a
  shared action.
- Update the creation prompt/reference, Product Logic Registry traceability,
  unit/component tests, and the existing Agent avatar E2E workflow.
- Verify desktop/mobile and light/dark rendering in the real local UI and
  attach final screenshots to R6-17.

Out of scope:

- Database schema or migration changes.
- Rewriting existing agents' stored `icon` values.
- Oreo initials, OKLCH tone controls, light/dark appearance selection, or
  custom drift controls.
- Removing the legacy named-icon and missing-icon display fallbacks.
- Changing avatar upload compression, organization ownership checks, or
  activity logging semantics.

## Implementation Plan

1. Extend shared avatar constants and types with the Oreo prefix, default
   shape/palette, six shape IDs, and 40 palette IDs. Add an Oreo Zod schema and
   include it in the agent icon union, with tests for every supported reference
   family and malformed, missing, and unknown Oreo parts.
2. Update the server creation helpers so the default is a UUID-backed Oreo
   reference and normalization preserves only valid Oreo, DiceBear, and asset
   references. Apply that helper consistently to direct create, canonical hire,
   and agent-service creation paths, then update tests that assert the former
   DiceBear default.
3. Synchronize the bundled Rudder agent-creation reference and its `/llms`
   coverage so agents are told that omitting `icon` uses the server Oreo
   default and that callers may provide a supported generated/upload reference.
4. Add the pinned UI dependency and extend `ui/src/lib/agent-avatar.ts` with a
   strict Oreo parser, deterministic `createAvatar(...).toDataUri()` rendering,
   full-reference caching, Oreo random/reference helpers, and style/selection
   readers. Keep existing DiceBear, uploaded-image, and fallback behavior
   intact.
5. Refactor `AgentIconPicker` into a small two-tab popover. Default the visible
   tab to Oreo on every open, show six shape buttons and a quiet internally
   scrolling 40-palette grid, retain six DiceBear
   backgrounds, scope Random to the selected tab, and keep upload outside both
   tab-specific option regions. Constrain width/height to the viewport and use
   Rudder's auto-hiding scrollbar pattern.
6. Expand renderer and picker component tests for Oreo stability, full-reference
   cache identity, tab initialization, shape/palette selection, style-scoped
   Random, shared upload, and compact overflow classes. Update dependent UI
   fixtures only where the new default contract changes expectations.
7. Expand `tests/e2e/agent-avatar.spec.ts` to prove default Oreo creation,
   Oreo-to-DiceBear-to-Oreo switching, refresh persistence, image upload, and a
   mobile viewport without overflow.
8. Update `AGENT.IDENTITY.CONFIG.001` and `doc/product/registry.yml` with the
   two generated styles, Oreo new-agent default, no migration for existing
   identities, upload compatibility, and new code/test/plan traceability.

## Design Notes

- The Oreo reference is the source of truth. Shape and palette select the
  package presets; the UUID is the stable `variantId`; no rendered SVG is
  persisted.
- Shared constants deliberately duplicate the package's stable IDs because the
  server validator must enforce the same contract without importing a UI-only
  rendering dependency. The pinned package version and tests keep the two sets
  aligned.
- `bloom` and `rose-milk` are the deterministic server defaults; only the UUID
  varies for a new agent.
- Valid existing DiceBear and uploaded-image references pass through unchanged.
  Existing stored named icons and null values continue to render through the
  current UI fallback path; only create/hire normalization converts an omitted
  value or incoming named icon to the Oreo default.
- Oreo images are already clipped circular by the package, and Rudder keeps the
  existing circular `<img>` shell. DiceBear alone uses the six background
  presets and `?bg=` suffix.
- The picker is an operator popover, not a design playground. It uses terse
  labels, fixed compact controls, one bounded nested scroll region for palettes,
  and no tone/appearance explanation inside the active workflow.

## Success Criteria

- Creating or hiring without `icon` returns and persists a valid
  `oreo:bloom:rose-milk:<uuid>` reference.
- Every supported Oreo shape and palette can be selected, rendered, saved, and
  restored after refresh with stable geometry.
- Random creates a new reference only for the active style.
- DiceBear Notionists, uploaded images, named legacy icons, and null-display
  fallbacks have no rendering regression.
- Invalid Oreo shape, palette, UUID, missing segment, or extra suffix is
  rejected by API validation.
- The upload route still compresses images, enforces organization ownership,
  logs the mutation, and updates the agent.
- The picker remains within desktop and mobile viewports and is legible in
  light and dark themes.

## Validation

- `pnpm vitest run packages/shared/src/validators/agent.test.ts`
- `pnpm vitest run server/src/__tests__/agent-shortname-collision.test.ts`
- Relevant agent creation, hire, avatar route, and bundled Rudder docs tests.
- `pnpm vitest run ui/src/components/AgentIconPicker.test.tsx ui/src/components/AgentAvatar.test.tsx`
- `pnpm test:e2e --grep "Agent avatar"`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm product-logic:check`
- `pnpm build`
- Real local UI inspection and screenshots for desktop light, desktop dark,
  mobile light, and mobile dark states.

## Open Issues

- The shared shape/palette constants must be reviewed whenever the pinned Oreo
  package version changes; an explicit alignment test should make drift visible.
- Full-repository checks may expose unrelated failures from the shared working
  tree. Any such failures must be reproduced against scoped tests or the clean
  comparison ref before being attributed to R6-17.
