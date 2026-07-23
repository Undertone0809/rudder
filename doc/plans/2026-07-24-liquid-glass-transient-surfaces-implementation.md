---
title: Liquid glass transient surfaces implementation
date: 2026-07-24
kind: implementation
status: completed
area: ui
entities:
  - design_guide
  - desktop_shell
  - transient_surfaces
issue:
related_plans:
  - 2026-07-24-liquid-glass-transient-surfaces.md
  - 2026-05-25-ui-lab.md
  - 2026-07-22-default-rudder-appearance.md
supersedes: []
related_code:
  - ui/src/components/ui/liquid-glass-surface.tsx
  - ui/src/components/ui/liquid-glass.css
  - ui/src/z-liquid-glass.css
  - ui/src/main.tsx
  - ui/src/motion.css
  - ui/src/components/BreadcrumbBar.tsx
  - ui/src/components/ui/context-menu.tsx
  - ui/src/components/ui/dialog.tsx
  - ui/src/components/ui/dropdown-menu.tsx
  - ui/src/components/ui/popover.tsx
  - ui/src/components/ui/select.tsx
  - ui/src/components/ui/sheet.tsx
  - ui/src/components/ui/tooltip.tsx
  - ui/src/components/PageTabBar.tsx
  - ui/src/components/RudderEntityPreview.tsx
  - ui/src/components/SkillReferenceToken.tsx
  - ui/src/pages/Chat.scroll-map.tsx
  - ui/src/pages/DesignGuide.tsx
  - ui/src/plugins/launchers.tsx
  - tests/e2e/ui-lab.spec.ts
  - tests/e2e/global-search-chat.spec.ts
commit_refs: []
updated_at: 2026-07-24
---

# Liquid Glass Transient Surfaces Implementation

## Goal

Implement the approved expressive liquid-glass material across Rudder's shared
transient-surface primitives on Web and Desktop without changing Radix focus,
portal, positioning, dismissal, or keyboard behavior.

The implementation restores no Product Logic Registry behavior and changes no
product contract. `doc/product/**` remains untouched.

## Constraints

- Preserve unrelated working-tree changes, including the existing experimental
  `liquid-glass-react` toolbar work.
- Do not make the new transient-surface system depend on the external component
  wrapper.
- Keep ordinary list-row hover lightweight and non-refractive.
- Use test-first development for every production behavior.
- Keep decoration layers non-interactive and stable while users read, type,
  scroll, or navigate with the keyboard.

## Implementation Sequence

### 1. Establish the shared contract

Add focused component tests that require:

- `modal`, `menu`, `preview`, and `tooltip` variants
- unique SVG filter identifiers for multiple mounted surfaces
- `aria-hidden` and `pointer-events: none` decoration
- a stable content layer that retains caller props and children
- reduced-motion and capability fallback hooks expressed through stable data
  attributes and CSS media queries

Run the focused test and confirm it fails because the primitive does not yet
exist.

### 2. Implement the Rudder-owned material primitive

Create `LiquidGlassSurface` with:

- a decorative SVG filter definition using edge displacement and restrained
  chromatic channel separation
- separate warp, tint, highlight, and content layers
- unique React IDs safe for portal use
- variant data attributes
- an `asChild`-free DOM contract suitable for placement inside Radix content
- no global pointer listener or continuous animation loop

Create a dedicated stylesheet loaded through `ui/src/z-liquid-glass.css` after
the existing global and motion styles. It defines theme-aware material tokens,
enhanced filters, CSS fallback, forced-colors behavior, and reduced-motion
behavior without modifying the unrelated dirty sections of `ui/src/index.css`.

### 3. Migrate shared transient entry points

Add the material decoration inside:

- `DialogContent` and command dialog through the dialog primitive
- `DropdownMenuContent` and sub-content
- `ContextMenuContent`
- `PopoverContent`
- `SelectContent`
- `SheetContent`
- `TooltipContent`

The Radix content element remains the positioned, focused, and interactive
root. Its children move into the stable glass content layer only where doing so
does not violate Radix collection or item traversal. Menu and select primitives
therefore use sibling decoration layers plus an isolated background treatment,
not a wrapper around item nodes.

Run existing primitive tests after every migrated entry point.

### 4. Cover feature-specific previews and UI Lab

Inventory non-primitive hover preview surfaces, beginning with Messenger chat
previews and skill reference previews. Apply the `preview` variant to the
representative shared or feature-owned root without changing its trigger or
timing.

Add a UI Lab section that shows modal, menu, preview, and tooltip variants in
light/dark, normal/reduced-motion, and enhanced/fallback examples.

### 5. Add end-to-end regression coverage

Extend the most relevant existing E2E suite, or add a focused liquid-glass
suite, to verify:

- command palette opens, accepts keyboard navigation, and closes
- a representative modal keeps focus and dismissal behavior
- dropdown and context menus remain selectable
- a hover preview appears without changing row hover behavior
- nested popover/menu surfaces remain positioned and interactive
- decoration layers are present and non-interactive

Cover one production-shaped corner case with nested or simultaneous transient
surfaces.

### 6. Validate visually and operationally

Run focused tests first, then:

- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- relevant E2E suites
- `pnpm desktop:verify`

Verify real rendered Web and packaged Desktop surfaces in light and dark mode.
Capture final screenshots outside the repository.

## Completion Notes

- The shared material now covers Radix dialogs, sheets, dropdown and context
  menus, popovers, selects, and tooltips, plus feature-owned entity, skill,
  transcript, search-result, tab previews, and plugin launcher shells.
- SVG displacement is assigned to the stable positioned host so long scrolling
  menus retain one continuous material while their item content moves.
- Ordinary inline row hover remains on the existing lightweight treatment.
- The UI Lab Design Guide contains representative modal, long-menu, preview,
  and tooltip examples used by the browser E2E workflow.
- Reduced-motion, forced-colors, and unsupported-backdrop-filter fallbacks are
  encoded in the shared stylesheet and covered by focused tests.

### 7. Independent acceptance

Ask one reviewer agent for exploratory and adversarial code/design review. Ask
one verifier agent to run black-box Web and packaged Desktop workflows. Resolve
all material findings, rerun affected checks, then commit only files belonging
to this task and push the task branch.

## Acceptance Criteria

- Shared modal, menu, preview, and tooltip surfaces visibly use the approved
  expressive liquid-glass family.
- Enhanced browsers show edge refraction and restrained chromatic separation.
- Fallback rendering is readable and polished without displacement.
- Reduced-motion and forced-colors modes remain stable and usable.
- Existing Radix keyboard, focus, portal, dismissal, and selection behavior
  passes regression tests and real interaction checks.
- Ordinary list-row hover remains non-refractive.
- UI Lab examples, E2E coverage, final screenshots, independent review, and
  black-box verification are complete.
