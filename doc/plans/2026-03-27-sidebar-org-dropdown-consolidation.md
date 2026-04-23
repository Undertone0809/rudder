# Sidebar Org Dropdown Consolidation Plan

## Summary

- First implementation step: write this plan into `doc/plans/2026-03-27-sidebar-org-dropdown-consolidation.md`.
- Remove the far-left org rail and make the sidebar’s top-left org header the single organization entry point.
- Replace the current static org header with an `OrgDropdownMenu` that combines org switching, add org, and the current org-level sidebar links.
- Keep the current routing model, organization context, and per-org remembered-page behavior.

## Key Changes

### 1. Layout and shell

- Remove `CompanyRail` from board layout in `ui/src/components/Layout.tsx` for both desktop and mobile board sidebars.
- Keep `InstanceSidebar` unchanged for `/instance/*`.
- Preserve existing mobile overlay, swipe, and sidebar open/close behavior.

### 2. Org dropdown

- Replace the top block in `ui/src/components/Sidebar.tsx` with a clickable org dropdown trigger.
- The trigger should show current org brand dot if available, org name, and a chevron.
- The dropdown should contain:
  - org switch list for non-archived orgs
  - `Add organization`
  - separator
  - org links: `Structure`, `Skills`, `Costs`, `Activity`, `Settings`
- Switching org should:
  - call `setSelectedOrganizationId(...)`
  - preserve existing remembered-page behavior from `useOrganizationPageMemory`
  - close the sidebar on mobile
- Clicking org links should:
  - navigate with the existing prefixed router helpers
  - close the sidebar on mobile
- `Add organization` should open the existing onboarding flow via `openOnboarding()`.

### 3. Sidebar restructuring

- Remove the standalone `Organization` section from the sidebar body.
- Keep all non-org sections unchanged: main items, `Work`, `Projects`, `Agents`, plugin sidebar slots.
- Keep the search button outside the dropdown trigger but adjacent in the header row.
- Reuse the existing dropdown primitives already in the repo.
- Consolidate on a single org-switcher component implementation; do not leave both old and new switchers active.

## Public Interfaces / Contracts

- No API, schema, shared type, or route changes.
- `OrganizationContext` remains the source of truth for org list, selected org, switching, and creation.
- Existing org routes remain unchanged:
  - `/org`
  - `/skills`
  - `/costs`
  - `/activity`
  - `/organization/settings`
- Existing localStorage behavior remains unchanged:
  - selected org persistence
  - remembered per-org last page

## Test Plan

- Verify `CompanyRail` is no longer rendered in board layout.
- Verify the old `Organization` sidebar section is gone.
- Verify the dropdown includes org switching, `Add organization`, and the five org-level links.
- Verify switching org updates selection and preserves remembered-page behavior.
- Verify org-level dropdown links route correctly.
- Verify mobile interactions close the sidebar after selection/navigation.
- Verify instance settings sidebar remains unchanged.
- Run:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Assumptions

- The plan doc is created before UI code changes.
- `Add organization` reuses onboarding rather than adding a new inline create flow.
- Archived orgs stay excluded from quick switching.
- Org switching keeps current remembered-page behavior instead of forcing dashboard.
