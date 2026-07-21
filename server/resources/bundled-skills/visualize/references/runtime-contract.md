# Rudder Inline Visual Runtime Contract

Read this reference when producing a Rudder inline visual. The runtime is
scriptless, sanitized, isolated from Rudder state, and has no network access.
Every fragment must be at or below 64 KiB UTF-8, all fragment bodies together
must be at or below 128 KiB, the complete visual-bearing final reply must be at
or below 256 KiB, and one assistant message may contain at most three fragments.

## Output Envelope

Write a fragment with one top-level markup root, `<div id="widget">`. Bounded
`<style>` elements may precede that root. Do not write a doctype or `html`,
`head`, or `body`; Rudder extracts and sanitizes the CSS before it sanitizes the
markup.

The final Rudder Chat message places the fragment inside this exact v1 envelope:

```text
:::rudder-inline-visual:v1
<style>#widget .series { color: var(--viz-series-1); }</style>
<div id="widget">...</div>
:::rudder-inline-visual:end
```

Both marker lines must be unindented, exact, and free of trailing text. Rudder
rejects nested, empty, unterminated, excessive, and oversized envelopes. It
buffers the fragment during streaming, publishes it only after a successful
complete result, and replaces it with a Server-owned trusted placement. The
Agent never writes a provider visualization directory, file directive,
attachment id, canonical placement, iframe, or source link.

The v1 authoring protocol is the same for every conforming Rudder Agent Runtime.
Legacy `::codex-inline-vis{file="..."}` input remains readable during migration,
but new output must never emit it.

## Preserved Markup

Use these common HTML elements:

- Structure: `article`, `aside`, `div`, `section`, `main`, `header`, `footer`,
  `figure`, `figcaption`, `blockquote`, `hr`, `br`.
- Text: `h1` through `h6`, `p`, `span`, `small`, `strong`, `em`, `b`, `i`,
  `mark`, `s`, `u`, `code`, `pre`.
- Lists and data: `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `table`, `caption`,
  `colgroup`, `col`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `meter`,
  `progress`.
- Native disclosure: `<details>` and `<summary>`. This is the only supported
  stateful interaction.

Use inline `<svg>` for charts and diagrams. Supported primitives include
`svg`, `g`, `defs`, `title`, `desc`, `path`, `line`, `rect`, `circle`, `ellipse`,
`polygon`, `polyline`, `text`, `tspan`, `linearGradient`, `radialGradient`, and
`stop`. Do not use clipping paths; the runtime does not preserve a safe
`clip-path` reference.

Common preserved attributes include:

- Accessibility and structure: `role`, `aria-label`, `aria-labelledby`,
  `aria-describedby`, `aria-hidden`, `id`, `class`, `scope`, `colspan`,
  `rowspan`, `open`, `value`, `min`, and `max`.
- Tooltip: `data-tooltip`, limited to concise plain text.
- SVG geometry and paint: `viewBox`, `preserveAspectRatio`, `x`, `y`, `x1`,
  `x2`, `y1`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `width`, `height`, `d`,
  `points`, `transform`, `fill`, `stroke`, opacity, line, gradient, text-anchor,
  and vector-effect attributes.

IDs and class tokens must start with a letter and contain only letters, digits,
underscores, and hyphens. Keep each token at most 64 characters. A class list is
limited to 24 safe tokens. Use `url(#safe-id)` only for an inline SVG paint
reference such as a gradient; all external URL values are removed.

## Removed Markup

Do not generate `<script>`, `a`, `button`, `input`, `select`, `textarea`,
`form`, `img`, `image`, `audio`, `video`, `canvas`, `iframe`, `object`, `embed`,
`foreignObject`, `use`, SVG animation, document metadata, or external resource
elements. The runtime removes those elements and every URL-bearing or event
handler attribute.

There is no JavaScript, Lucide runtime, CDN library, parent bridge,
`window.openai`, API access, storage, cookies, or authenticated context. A
visual that depends on any of them is not a Rudder inline visual.

## CSS

Use host classes first:

- Layout: `.viz-grid` and `.viz-row`. `.viz-controls` is also available as a
  wrapping layout class, but it does not make removed buttons, inputs, selects,
  or other active controls usable.
- Summaries: `.card`, `.viz-stat`, `.viz-stat-value`, `.viz-badge`.
- Text: `.text-small`, `.text-muted`, `.text-destructive`, `.sr-only`.
- Tooltip: add `data-tooltip="Concise detail"` to `<summary>` for hover and
  keyboard-focus behavior. On another preserved element it is hover-only, so
  keep essential information visible elsewhere.

The host provides theme variables including `--background`, `--foreground`,
`--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`,
`--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`,
`--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`,
`--border`, `--input`, `--ring`, `--font-size-base`, `--radius`, and
`--viz-series-1` through `--viz-series-6`.

Custom `<style>` content is bounded to eight style blocks and 32 KiB total.
Use ordinary rules and responsive `@media` rules only. The sanitizer removes
custom properties, URL values, imports, fonts, namespaces, keyframes, property
registrations, malformed CSS, unknown functions, and unsupported declarations.
Inline `style` attributes are always removed.

Safe custom CSS commonly uses grid or flex layout, spacing, borders, text,
theme colors, dimensions, responsive media queries, and static transforms. Keep
selectors scoped beneath `#widget` and keep the result useful without animation.

## Responsive And Accessible Output

- Support widths from 736px down to 320px without horizontal overflow.
- Use responsive SVG view boxes and `max-width: 100%` behavior.
- Reserve enough space for the longest labels and values.
- Give charts and diagrams a screen-reader name and, when useful, description.
- Use tables when exact values matter more than spatial comparison.
- Pair every color encoding with text, shape, or another non-color cue.

See `../assets/example-chart.html` for a minimal contract-valid fragment. Its
data is illustrative; reuse the structure, not the values.
