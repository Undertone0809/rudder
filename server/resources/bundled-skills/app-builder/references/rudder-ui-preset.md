# Rudder UI Preset

The maintained scaffold includes a versioned, source-owned shadcn preset for
building local operator tools that feel immediately at home in Rudder.

## Source Of Truth

- `rudder.ui.json` identifies the preset and revision.
- `components.json` makes the generated project a conventional shadcn project.
- `app/globals.css` owns semantic color, radius, typography, and light/dark
  tokens.
- `components/ui/` owns copied component source. Generated Apps do not import
  components or CSS from the Rudder repository at runtime.
- `scripts/validate-rudder-ui.mjs` checks that the preset contract remains
  present before handoff.

For new Apps, use this preset without asking the user to select a shadcn style,
base palette, accent, radius, or component library. The default is Rudder's
spacious-but-compact `luma` character, neutral surfaces, emerald action color,
and system light/dark mode.

## Composition Rules

1. Start with the shipped primitives. Extend them with variants when the same
   need recurs; do not restyle each call site.
2. Use semantic Tailwind utilities rather than raw color utilities. New named
   product colors belong in the token layer.
3. Keep normal controls between 32 and 36 pixels high, use compact radii, and
   reserve pills for true circular or exceptional status affordances.
4. Bind native `button`, `input`, `select`, and `textarea` text to the inherited
   semantic foreground color so system dark mode cannot reintroduce browser-UA
   contrast regressions.
5. Use one primary panel or table region. Cards group independent objects or
   actions; they are not wrappers for every section.
6. Operational lists require search or filtering when useful, readable row
   actions, empty/loading/error states, and horizontal containment on narrow
   screens.
7. Use Lucide icons for familiar actions. Icon-only controls need accessible
   labels; icons inside buttons inherit their size from `Button`.
8. Preserve keyboard focus, semantic headings, persistent labels, inline
   validation, and destructive confirmation.

## Appearance Boundary

The preset is copied into the App as a stable creation-time baseline. It does
not read Rudder's browser-local Appearance preferences or import host CSS at
runtime. This keeps the App portable and prevents a later Rudder theme change
from silently changing an independently branded product.

An App may add a documented host-theme bridge later, but light/dark following
must be optional and the standalone URL must still render correctly. Changing
that boundary is product behavior, not an incidental styling edit.

## Existing Projects

Do not install or overwrite the preset in an existing project by default.
Inspect its framework, component library, tokens, and brand first. If the user
explicitly asks to align it with Rudder, preserve application behavior and
choose a bounded migration:

- token-only alignment when components are already coherent;
- primitive-by-primitive alignment when a source-owned component system exists;
- full preset adoption only when the user accepts the wider visual change.

Never run a shadcn overwrite command over locally modified components without
explicit approval and a reviewed diff.

## Verification

Run `pnpm ui:check`, typecheck, tests, build, and the App's Playwright suite.
In Browser, inspect the primary workflow, loading or empty state, inline error,
destructive action, desktop layout, 390px layout, and light/dark contrast.
Capture the useful populated state rather than a decorative empty dashboard.
