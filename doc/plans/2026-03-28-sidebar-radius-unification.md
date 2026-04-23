# Sidebar Dynamic Row Radius Unification

Date: 2026-03-28
Status: Approved

## Summary

- Fix the sidebar styling mismatch for dynamic `Agents` and `Projects` rows so their hover and selected states use the same rounded treatment as core nav items like `Dashboard` and `Chat`.
- Keep the change UI-only. No routing, data, or backend behavior should change.

## Implementation Changes

- Add an internal shared sidebar item style helper in `ui/src/components/` that defines:
  - shared base styles: `rounded-[var(--radius-md)]`, sidebar text sizing, gap, transitions, and the existing hover/active surface tokens
  - a `default` variant for `SidebarNavItem`
  - a `compact` variant for `SidebarAgents` and `SidebarProjects`
- Update `SidebarNavItem` to use the helper as the canonical source for top-level sidebar nav styling. Preserve its current spacing and active shadow behavior.
- Update top-level row `NavLink`s in `SidebarAgents` and `SidebarProjects` to use the `compact` variant:
  - keep current compact density (`px-3 py-1.5`)
  - add the same rounded corners as core nav items
  - use the same hover background/text treatment
  - use the same active background/text treatment
  - do not add the active shadow to compact rows, so agent/project lists stay visually lighter than primary nav
- Leave collapsible section headers, add buttons, drag-and-drop wrappers, budget/live badges, and nested project plugin sidebar items unchanged.

## Public Interfaces / Types

- No public API, schema, validator, route, or shared type changes.
- The new helper is internal to the UI component layer only.

## Test Plan

- Add a focused Vitest unit test for the new sidebar style helper covering:
  - `default` active/inactive output
  - `compact` active/inactive output
  - presence of the rounded class in both variants
  - shadow present only on `default` active, absent on `compact` active
- Manual UI verification:
  - `Dashboard` and `Chat` remain visually unchanged
  - hovering an agent row shows a rounded background
  - selecting an agent row shows a rounded active state instead of a full-width rectangle
  - project rows get the same rounded hover/active treatment
  - badges, icons, and project drag behavior still align correctly
  - mobile taps still close the sidebar
- Run `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.

## Assumptions

- Scope is `Agents + Projects` only.
- This change unifies radius and state styling, not overall sidebar spacing or a full sidebar redesign.
- Settings sidebars, plugin sub-items, and other non-core sidebar lists stay out of scope for this pass.
