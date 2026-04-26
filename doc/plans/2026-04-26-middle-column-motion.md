---
title: Middle column sliding active indicators
date: 2026-04-26
kind: implementation
status: completed
area: ui
entities:
  - motion_system
  - middle_column_navigation
  - desktop_shell
issue:
related_plans:
  - 2026-04-25-motion-v1.md
supersedes: []
related_code:
  - doc/DESIGN.md
  - ui/src/motion.css
  - ui/src/components/ThreeColumnContextSidebar.tsx
commit_refs:
  - "feat: extend sliding indicators to middle columns"
  - "fix: keep messenger thread selection static"
updated_at: 2026-04-27
---

# Middle Column Sliding Active Indicators

## Summary

Extend the sliding active-indicator pattern from the primary rail and Issues
view selector to the repeatable middle-column navigation lists used by Rudder's
three-column workspace surfaces, excluding Messenger thread lists.

## Diagnosis

The product issue is interaction consistency. The active state now moves in the
primary rail and one Issues group, but other middle-column lists still jump
between static backgrounds. That makes the same navigation gesture feel
different across Agents, Issues, Org, and Projects. Messenger is excluded by
product direction because thread-heavy rows should keep their static chat-row
selection treatment.

## Scope

In scope:

- codify middle-column active-item motion in the design guide
- reuse the existing CSS motion primitives for context-column lists
- apply sliding indicators to stable-height middle-column item groups:
  issue views, issue project slices, org workspace entries, org project cards,
  and agent rows
- keep reduced-motion behavior movement-free
- add focused unit/CSS coverage for the motion contract

Out of scope:

- Messenger thread rows
- animating variable-height editor states
- adding page transitions
- changing route, data, or sidebar ownership contracts
- replacing the sidebar layout system

## Implementation Plan

1. Add a small reusable context-list wrapper for active-index driven indicators.
2. Convert the existing Issues selector to that wrapper.
3. Apply the wrapper to the other stable middle-column lists.
4. Add CSS height modifiers for compact, agent, and project-card rows.
5. Update Motion V1 design guidance to include middle-column active indicators.
6. Run focused UI typecheck and tests, then repository validation where feasible.

## Success Criteria

- Active middle-column list items move with a visible sliding surface instead of
  instantly repainting.
- Each list keeps its existing density, labels, and hover behavior.
- Reduced-motion users see the active state without movement.
- Tests protect the CSS hooks and active-index behavior used by the pattern.

## Validation

- `pnpm --filter @rudderhq/ui typecheck`
- `pnpm --filter @rudderhq/ui exec vitest run src/components/MessengerContextSidebar.test.tsx src/components/PrimaryRail.test.tsx src/lib/motion-css.test.ts`
- `pnpm build`
- 2026-04-27 follow-up: Messenger thread lists were removed from this motion
  scope, with the focused UI typecheck, focused Vitest run, and build passing.
- 2026-04-27 follow-up: `pnpm -r typecheck` passed.
- 2026-04-27 follow-up: `pnpm test:run` failed outside this UI surface:
  Postgres shared-memory initialization failed for multiple DB-backed suites,
  and `server/src/__tests__/chat-routes.test.ts` had two chat-route assertion
  failures.
- `pnpm -r typecheck` failed on the pre-existing CLI import/export E2E type
  error in `cli/src/__tests__/company-import-export-e2e.test.ts`.
- `pnpm test:run` failed on the pre-existing CLI import/export E2E data
  fidelity mismatch and temp-directory cleanup error.
- Browser visual verification was attempted against `http://localhost:3100/messenger`,
  but Chrome MCP timed out before returning a screenshot.
