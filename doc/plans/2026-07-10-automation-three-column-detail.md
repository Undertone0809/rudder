---
title: Automation three-column detail workspace
date: 2026-07-10
kind: proposal
status: completed
area: ui
entities:
  - automation_detail
  - automation_workspace
issue:
related_plans:
  - 2026-05-22-automation-chat-output-and-activity-polish.md
  - 2026-03-30-rename-routines-to-automations.md
supersedes: []
related_code:
  - ui/src/App.tsx
  - ui/src/pages/Automations.tsx
  - ui/src/pages/AutomationDetail.tsx
  - ui/src/pages/AutomationDetail.parts.tsx
  - tests/e2e/automations-index-layout.spec.ts
  - tests/e2e/automation-detail-layout.spec.ts
commit_refs: []
updated_at: 2026-07-11
---

# Automation Three-Column Detail Workspace

## Context

Automations currently use a list-to-page transition: selecting a row replaces
the list with a standalone detail page. That loses the operator's list context
and makes inspecting several automations a repeated open-and-return loop.

The approved direction is the Codex Scheduled Tasks interaction model inside
Rudder's existing desktop shell. The primary rail remains the first column, the
Automation list becomes the second column, and a selected Automation opens as a
third-column detail inspector on the right.

## Decision

Treat Automations as one master-detail workspace rather than two separate page
layouts.

- `/automations` renders the list without an open detail inspector.
- `/automations/:automationId` renders the same list with the matching row
  selected and the detail inspector open.
- Selecting another row updates the route and swaps the inspector content in
  place without unmounting or hiding the list on wide screens.
- Closing the inspector navigates to `/automations`, preserves list context,
  and restores the list to the available workspace width.
- Direct links to an Automation continue to work and open the list plus the
  selected detail.

## User Journey

1. An operator opens Automations and scans the list using name, project,
   assignee, last-run evidence, and enabled state.
2. The operator selects a row. The row gains a clear selected state and the
   right-side inspector opens; the primary rail and Automation list stay in
   place.
3. The operator reviews or edits the definition, ownership, schedule, delivery
   rules, and recent run history without leaving the workspace.
4. The operator selects another row and the same inspector switches to the new
   Automation.
5. The operator closes the inspector and returns to the full-width list with
   the previous list position intact.
6. Creating an Automation continues through the existing focused composer;
   after creation, the new Automation opens in the right-side inspector.

## Detail Information Architecture

The inspector should follow the visual hierarchy of Codex Scheduled Tasks
while using Rudder's data and controls.

### Header

- Compact status label at the top.
- Overflow menu for destructive or less frequent actions.
- Pause/enable and close controls represented by familiar icons with accessible
  labels.
- Automation title immediately below the status/action row.

### Definition

- Instructions are the primary content block and remain directly editable.
- Autosave state stays visible without competing with the title.

### Details

- Compact property rows for assignee, project, output mode, and follow-created-
  issue behavior where applicable.
- Delivery rules remain progressively disclosed.

### Frequency

- Show the current repeat summary and next-run value first.
- Keep trigger creation and editing available from this section.

### Previous Runs

- Present recent runs/activity as a dense chronological list.
- Preserve links to issue or chat outputs and visible failure evidence.
- Keep live-run evidence visible when an Automation is executing.

The inspector is a single vertical reading surface. It must not reproduce the
old detail page's internal main-plus-sidebar split inside the third column.

## Layout And Responsive Behavior

- On wide desktop viewports, the Automation list and detail inspector share the
  workspace content area as independent outer workspace cards, each with its
  own card header and separated by the same compact gutter used by Rudder's
  Issues and Agents layouts. They must not be nested inside another work card.
- The list keeps enough width for identity and last-run scanning; lower-priority
  columns may collapse before the list becomes unusably narrow.
- The inspector gets a stable bounded width suitable for the Codex-like vertical
  layout and scrolls independently from the list.
- On narrow desktop and mobile viewports, opening an Automation replaces the
  list inside the main content area. A close/back affordance returns to the
  list. The UI must not introduce horizontal document overflow.
- The workspace header remains Rudder's existing shell header; this proposal
  does not create a nested application shell.

## Interaction Requirements

- The entire list row opens the inspector.
- Toggle and overflow-menu interactions stop row-selection propagation.
- The selected row exposes `aria-current` and a visible selected treatment.
- The close control returns to `/automations` and restores list focus when
  practical.
- Browser Back from a selected Automation closes the inspector before leaving
  the Automations workspace when the user arrived from the list.
- Loading, not-found, and request-error states stay contained in the inspector;
  a detail request failure must not replace the list.
- Switching between Automations must not save one Automation's draft into
  another Automation.

## Contract Impact

This work changes visible presentation and navigation, not Automation schema,
scheduler, permission, or output-routing semantics. Because the route-driven
master-detail behavior is an operator workflow that should not regress, the
implemented behavior is synchronized into the existing Product Logic Registry:

- `AUTOMATION.DEFINITION.001`, which requires detail to show definition,
  trigger, output, and state.
- `AUTOMATION.RUN.001`, which requires detail to show run history and terminal
  evidence.

## Implementation Shape

1. Route both Automation list and selected-detail URLs through the Automations
   workspace component.
2. Make Automation detail embeddable with an explicit Automation id and close
   callback instead of owning the whole workspace header and route transition.
3. Introduce a responsive master-detail shell around the existing list and
   detail data flows.
4. Recompose Automation detail into the Codex-like single-column sections while
   preserving current mutations, autosave, trigger editing, activity, and run
   actions.
5. Update unit and E2E coverage for selection, deep links, close/back behavior,
   independent controls, responsive fallback, and no horizontal overflow.

## Acceptance Criteria

- Clicking an Automation row opens its detail on the right without removing the
  list on a wide desktop viewport.
- Primary rail, Automation list, and Automation detail are simultaneously
  visible as three product columns.
- The selected row is visibly and accessibly selected.
- Detail uses a Codex-like vertical hierarchy: header, title/instructions,
  Details, Frequency, and Previous runs.
- Selecting a second Automation swaps the inspector content without returning
  to a standalone page.
- Closing the inspector returns to the list route and restores the list width.
- Direct `/automations/:automationId` navigation opens the same master-detail
  workspace.
- Enable/pause, run-now, delete, autosave, trigger editing, and run-output links
  remain functional.
- Narrow viewports show one usable content pane at a time and have no horizontal
  overflow.
- Automated E2E exercises the real list-to-detail workflow plus direct-link and
  responsive edge cases.
- Browser or Desktop-shell verification produces final screenshots outside the
  repository for both wide and narrow states.

## Non-Goals

- No Automation schema, API, scheduler, permission, or output-routing change.
- No rewrite of the Automation creation composer.
- No generic global side-panel framework migration.
- No new Product Logic contract ID; the approved interaction is recorded under
  the existing `AUTOMATION.DEFINITION.001` contract.
- No attempt to reproduce Codex branding or visual tokens; only its detail
  hierarchy and master-detail interaction are adopted within Rudder's design
  system.

## Validation Plan

- Targeted unit tests for route-driven selection and detail close behavior.
- Updated Automation list and detail E2E suites.
- `pnpm product-logic:check`.
- Targeted UI tests, then repository lint, typecheck, test, and build gates.
- Rendered browser verification at wide desktop and narrow/mobile viewports.
- Spawned black-box verifier followed by functional, adversarial, and
  heuristic/product-systems reviewers.
