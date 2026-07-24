---
title: Liquid glass transient surfaces
date: 2026-07-24
kind: design-note
status: proposed
area: ui
entities:
  - design_guide
  - desktop_shell
  - transient_surfaces
issue:
related_plans:
  - 2026-05-25-ui-lab.md
  - 2026-07-22-default-rudder-appearance.md
supersedes: []
related_code:
  - ui/src/index.css
  - ui/src/components/ui/command.tsx
  - ui/src/components/ui/context-menu.tsx
  - ui/src/components/ui/dialog.tsx
  - ui/src/components/ui/dropdown-menu.tsx
  - ui/src/components/ui/popover.tsx
  - ui/src/components/ui/select.tsx
  - ui/src/components/ui/sheet.tsx
  - ui/src/components/ui/tooltip.tsx
  - ui/src/pages/DesignGuide.tsx
commit_refs: []
updated_at: 2026-07-24
---

# Liquid Glass Transient Surfaces

## Summary

Introduce a shared liquid-glass visual language for Rudder's transient
surfaces on both Web and Desktop. The treatment is intentionally expressive:
strong edge refraction, restrained chromatic separation, a soft luminous rim,
and a rounded liquid silhouette. Motion remains operationally quiet: a surface
may deform briefly as it opens or receives direct pointer pressure, but it must
be geometrically stable while the user reads, types, scrolls, or chooses an
action.

This is a presentation-system change. It does not change workflow behavior,
data, permissions, navigation, or any current Product Logic Registry contract.
No `doc/product/**` change is required.

## Design Decision

### Visual direction

Use the approved expressive direction:

- visible edge refraction instead of blur alone
- restrained red/green/blue separation at the refracted rim
- theme-aware specular highlights that respond to the surface background
- softer corners than current compact overlays, without turning controls or
  list rows into pills
- sufficiently opaque inner frosting to preserve text and icon contrast

The glass is a transient layer above the work. Workspace cards, tables, message
content, editors, and other persistent work surfaces remain materially stable
and mostly opaque.

### Motion direction

Use restrained elasticity:

- opening may include one short compress-and-settle deformation
- direct pointer pressure or an intentional draggable edge may produce a small
  local deformation
- pointer travel across content must not continuously warp the whole surface
- scrolling, keyboard navigation, text input, and menu selection keep the
  surface stable
- `prefers-reduced-motion: reduce` removes elastic deformation and animated
  highlight travel while preserving a static glass material

Motion must not delay focus, pointer hit testing, menu selection, dialog close,
or portal positioning.

## Surface Coverage

The shared system covers:

1. `modal`: dialogs, sheets presented as modal tool windows, and the command
   palette
2. `menu`: dropdown menus, context menus, selects, popovers, and composer action
   menus
3. `preview`: floating hover previews, rich tooltips, and comparable temporary
   inspection cards

Small text-only tooltips use a lighter version of `preview` so the material
does not overwhelm a one-line label.

The following are explicitly excluded:

- normal list-row hover and active-row fills
- persistent workspace cards and sidebars
- message bubbles, form fields, tables, and inline badges
- full-screen backdrops themselves

Inline hover and selection states continue to use quiet translucent fills.
They may borrow the glass color palette, but they do not receive refraction,
chromatic separation, elastic geometry, or independent elevation.

## Component Architecture

Create one internal glass surface primitive and apply it through the shared UI
entry points instead of updating individual feature pages.

The primitive owns:

- one material contract with `modal`, `menu`, and `preview` variants
- light- and dark-theme tokens
- edge-filter identifiers that remain unique across multiple open portals
- resize-aware filter geometry
- capability detection and reduced-motion behavior
- CSS fallback classes

Radix primitives retain ownership of portals, focus management, dismissal,
collision handling, accessibility attributes, and keyboard interaction. The
glass layer decorates the existing content node or a non-interactive inner
layer; it does not replace the Radix content root with a behavior-owning
wrapper.

Shared entry points include `DialogContent`, `DropdownMenuContent`,
`ContextMenuContent`, `PopoverContent`, `SelectContent`, `TooltipContent`, and
the command dialog. Feature-specific floating previews that do not use these
primitives adopt the `preview` variant directly. Existing one-off
`glass-popover`, `glass-modal`, and `surface-overlay` styles are consolidated
behind the same material tokens, with compatibility aliases retained during
the migration.

## Rendering Strategy

Use the MIT-licensed `rdev/liquid-glass-react` project as a technical reference
for SVG displacement, edge masking, chromatic channel separation, and elastic
response. Adapt the required rendering ideas into a small Rudder-owned
primitive with license attribution. Do not make application behavior depend on
the reference project's component wrapper, and do not let feature components
import it directly. This keeps Radix portal, focus, sizing, and dismissal
behavior under Rudder's existing shared primitives while limiting the adapted
surface area to the approved visual effect.

Enhanced rendering is progressive:

1. use SVG edge displacement and chromatic separation where verified
2. retain backdrop blur, saturation, rim light, and theme tint when displacement
   is unsupported or unstable
3. fall back to an opaque elevated surface when backdrop filtering is
   unavailable

Safari and Firefox must remain fully usable even when displacement is absent.
The fallback is a supported rendering mode, not an error state.

## Material Rules

All variants share the same family resemblance but differ in intensity:

- `modal`: strongest refraction depth, highest inner opacity, broadest shadow
- `menu`: medium refraction depth, compact shadow, stable item contrast
- `preview`: lighter refraction and shadow; small tooltips use minimal
  chromatic separation

Theme behavior:

- dark mode uses smoked neutral glass with controlled emerald and violet edge
  pickup
- light mode uses warm paper-glass, not cool blue translucent plastic
- semantic destructive, warning, and approval states remain semantic content
  colors inside the neutral glass rather than tinting the entire surface

Backdrop dimming remains separate from material rendering. A modal overlay
should establish focus without becoming another visible glass panel.

## Accessibility And Interaction

- Preserve current Radix roles, focus traps, escape handling, outside-click
  handling, and keyboard navigation.
- Maintain readable contrast over both quiet and visually busy backgrounds.
- Do not encode selection, danger, warning, or approval through refraction or
  color separation alone.
- Keep hit targets and content geometry unchanged during steady interaction.
- Disable nonessential deformation for reduced-motion users.
- Ensure the filter and decoration layers use `pointer-events: none`.
- Preserve high-contrast and forced-colors usability with an opaque surface
  fallback.

## Performance Guardrails

- Do not attach global pointer listeners per open surface.
- At most one animation loop may run for the active interactive glass surface.
- Pause material animation when a surface is idle or the document is hidden.
- Recompute filter geometry only when the surface size changes.
- Avoid displacement on ordinary row hover and other high-frequency list
  interactions.
- Validate nested portals and more than one simultaneously open transient
  surface.
- Establish a measured frame-time baseline before enabling pointer-reactive
  behavior broadly.

If performance testing shows that full edge displacement cannot maintain
smooth interaction on representative hardware, keep the approved visual
direction through static refraction and rim lighting rather than reducing text
clarity or input responsiveness.

## UI Lab And Migration

Add a Liquid Glass section to the existing UI Lab showing every variant in:

- light and dark themes
- enhanced and fallback rendering
- reduced-motion mode
- short and long content
- nested menu/popover cases
- destructive menu items and semantic states

Migrate shared primitives first, then audit feature-specific transient surfaces
and remove duplicated material declarations. Screens called out during design
review include the command palette, composer action menu, Messenger row context
menu, page-level chat context menu, and floating chat hover preview.

## Verification

Automated coverage:

- focused unit tests for variants, unique filter IDs, capability fallback,
  reduced motion, and non-interactive decoration layers
- primitive regression tests preserving Radix events and accessibility
- real E2E coverage for command palette, modal, dropdown/context menu, composer
  menu, tooltip/hover preview, keyboard navigation, dismissal, and nested
  overlays
- a production-shaped edge case with multiple open or nested transient surfaces
- Web E2E in supported browser coverage
- packaged Desktop smoke/E2E for the same representative workflow

Visual verification:

- real rendered screenshots in Web and packaged Desktop
- light and dark mode
- busy and quiet backgrounds
- enhanced and forced-fallback rendering
- reduced-motion behavior

Repository checks:

- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- relevant E2E suites
- `pnpm desktop:verify`

Independent reviewer and verifier agents must inspect the implementation. The
verifier performs black-box testing in real local Web and packaged Desktop
environments before acceptance.

## Acceptance Criteria

- Covered transient surfaces share one visibly coherent liquid-glass material
  on Web and Desktop.
- The expressive rim refraction is visible where supported.
- Unsupported displacement degrades to a polished, readable frosted surface.
- Reading, typing, scrolling, keyboard navigation, focus, dismissal, and menu
  selection behave exactly as before.
- Ordinary inline row hover remains lightweight and does not create a separate
  refractive surface.
- Reduced-motion and forced-colors users receive stable, usable surfaces.
- Representative nested surfaces remain legible and correctly positioned.
- UI Lab examples, automated E2E coverage, real-environment verification, and
  final screenshots are included.
