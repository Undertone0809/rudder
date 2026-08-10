# Design Guidelines

Design for the user's actual workflow rather than for a technology demo.

For new maintained Apps, begin with the scaffold's versioned Rudder UI preset.
Do not replace its semantic tokens with a generic shadcn preset, a one-off
palette, or copied host application CSS. The generated App owns its component
source and must remain independently runnable outside Rudder.

- Put the primary action and current work state above decorative summaries.
- Use tables for operational lists, with search, meaningful filters, sorting,
  pagination when needed, empty states, and clear row actions.
- Use forms with persistent labels, inline validation, safe defaults, and
  explicit destructive confirmations.
- Keep navigation shallow. A small app usually needs one sidebar or top
  navigation, not both.
- Prefer readable density for CRM and marketing data. Avoid oversized KPI cards,
  excessive gradients, glass panels, and placeholder charts.
- Use the scaffold's shadcn primitives and semantic theme tokens before adding
  new components or one-off styling. Compose `Button`, `Input`, `Field`,
  `Table`, `Badge`, `Alert`, `Empty`, `Skeleton`, and `Separator` instead of
  recreating those patterns with styled `div` elements.
- Keep Rudder's default visual character: calm, dense, operational, quiet, and
  precise. Use compact radii, low-contrast borders, restrained elevation, one
  clear primary action, and color for state or emphasis rather than decoration.
- Use semantic utilities such as `bg-background`, `text-foreground`,
  `bg-muted`, and `text-destructive`. Do not hardcode product colors in
  workflow components or add component-local dark-mode colors.
- Treat the preset as a starting system, not a brand lock. When the brief calls
  for a distinct brand, keep the component structure, density, accessibility,
  and state behavior while changing the named token layer deliberately.
- Support keyboard use, visible focus, semantic headings, accessible names, and
  error text that does not rely on color.
- Verify at desktop width and at 390px mobile width unless the brief excludes
  mobile.
- Show loading, empty, error, populated, and destructive-operation states.
- Run `pnpm ui:check` before final verification for new maintained Apps.
