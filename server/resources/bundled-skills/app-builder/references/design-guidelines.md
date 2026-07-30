# Design Guidelines

Design for the user's actual workflow rather than for a technology demo.

- Put the primary action and current work state above decorative summaries.
- Use tables for operational lists, with search, meaningful filters, sorting,
  pagination when needed, empty states, and clear row actions.
- Use forms with persistent labels, inline validation, safe defaults, and
  explicit destructive confirmations.
- Keep navigation shallow. A small app usually needs one sidebar or top
  navigation, not both.
- Prefer readable density for CRM and marketing data. Avoid oversized KPI cards,
  excessive gradients, glass panels, and placeholder charts.
- Use the scaffold's component primitives and theme tokens before adding new
  one-off styling.
- Support keyboard use, visible focus, semantic headings, accessible names, and
  error text that does not rely on color.
- Verify at desktop width and at 390px mobile width unless the brief excludes
  mobile.
- Show loading, empty, error, populated, and destructive-operation states.
