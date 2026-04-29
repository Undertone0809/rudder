---
title: Linear issue sidebar projects
date: 2026-04-30
kind: implementation
status: completed
area: ui
entities:
  - plugin_linear
  - issue_sidebar
  - external_projects
issue:
related_plans:
  - 2026-04-25-linear-import-plugin-completion.md
  - 2026-04-24-issue-board-display-properties.md
supersedes: []
related_code:
  - ui/src/components/ThreeColumnContextSidebar.tsx
  - ui/src/components/ThreeColumnContextSidebar.test.tsx
  - packages/plugins/examples/plugin-linear/src/ui/index.tsx
commit_refs:
  - "feat: show linear projects in issue sidebar"
updated_at: 2026-04-30
---

# Linear Issue Sidebar Projects

## Summary

Expose connected Linear projects in the Issues middle sidebar as a dedicated
`Linear` group. Keep Rudder projects and Linear projects visually distinct:
Rudder projects stay under `Projects`, while Linear projects appear under
`Linear` with an external-source marker on the group row.

## Problem

The Linear plugin already reads Linear projects and can filter the intake page by
Linear project, but those projects are only visible inside the plugin page. From
the Issue Tracker, the operator cannot quickly tell which connected Linear
projects are available or jump into a pre-filtered Linear intake view.

## Product Decision

- Do not add a generic `Sources` group.
- Add a direct `Linear` group under the existing Rudder `Projects` group.
- Mark the `Linear` group as an external source so it does not read as a native
  Rudder project list.
- Clicking a Linear project should open the Linear intake page with that Linear
  project preselected.
- Keep the main Rudder Issue board anchored to Rudder issues; imported Linear
  issues remain first-class Rudder issues after import.

## Implementation Plan

1. Add a small host-side Linear sidebar query that detects the ready
   `rudder.linear` plugin and reads its `linear-catalog` data for the selected
   organization.
2. Render a `Linear` group in the Issues sidebar only when the plugin returns
   connected Linear projects.
3. Link each Linear project to the Linear plugin page with a stable
   `linearProjectId` query parameter.
4. Teach the Linear plugin page to initialize and reset its project filter from
   the `linearProjectId` query parameter.
5. Add focused UI tests for the sidebar group and plugin page query handling.

## Success Criteria

- Issues sidebar still shows native Rudder projects exactly as before.
- A ready/configured Linear plugin adds a separate `Linear` group.
- The `Linear` row carries an external-source visual marker.
- Linear project rows navigate to the Linear intake page with the matching
  `linearProjectId`.
- The Linear intake page starts with that Linear project selected.

## Validation

- Passed: `pnpm --filter @rudderhq/plugin-linear test -- --run`
- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/components/ThreeColumnContextSidebar.test.tsx`
- Passed: `pnpm --filter @rudderhq/plugin-linear build`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- `pnpm test:run` ran the full suite and passed 1270 tests with 1 skipped, but
  failed the pre-existing CLI import/export E2E suite cleanup with
  `ENOTEMPTY` removing a temporary `organizations` directory.
- Added browser E2E coverage to
  `tests/e2e/linear-plugin-import.spec.ts`. A focused local run with
  `RUDDER_E2E_RUN_ID=linear-sidebar-projects npx playwright test tests/e2e/linear-plugin-import.spec.ts --config tests/e2e/playwright.config.ts --reporter=line --timeout=120000`
  started the dedicated server but failed before assertions because Chromium
  launch timed out after 180 seconds in this environment.
