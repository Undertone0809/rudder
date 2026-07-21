---
name: visualize
description: "Create safe inline visual explanations in Rudder Chat. Use when asked for a chart, plot, diagram, timeline, comparison, static map, simulator, scenario view, or compact visual that materially improves understanding. Prefer Mermaid for static node-and-edge structures; use Rudder's runtime-neutral HTML/SVG/CSS message envelope for custom geometry. Rudder visuals are declarative and scriptless: convert simulator requests to static scenarios or disclosure-based comparisons and never rely on JavaScript, network access, or external assets."
compatibility: "Rudder Chat v1 inline visual message protocol. Provider-neutral and filesystem-independent; outside Rudder Chat, fall back to Mermaid, Markdown, or prose."
---

# Visualize

Create a visual only when it materially improves what the user can understand,
compare, or decide. The Rudder inline runtime is scriptless and has no network
access, so design for a useful first render with declarative HTML, SVG, and CSS.

## Choose The Output

1. Use a normal fenced Mermaid block when labeled nodes and edges fully explain
   a static structure or flow. Do not create an HTML artifact for that case.
2. Use an inline visual for charts, timelines, comparisons, spatial layouts,
   static scenario views, or compact reports that benefit from custom geometry.
3. Use the v1 message envelope only in Rudder Chat. It is a Rudder protocol,
   independent of Codex, Claude, Gemini, Cursor, OpenCode, Pi, Hermes, process,
   HTTP, or gateway filesystem conventions.
4. Outside Rudder Chat, fall back to Mermaid, Markdown tables, or concise prose.
   Do not emit a Rudder envelope on a surface that cannot render it.

## Message Envelope

- Write only an HTML fragment. Do not include a doctype or `html`, `head`, or
  `body` elements.
- Keep every fragment at or below 64 KiB UTF-8, all fragments together at or
  below 128 KiB, and the complete visual-bearing final reply at or below
  256 KiB. Emit at most three visuals in one assistant message.
- Give the fragment one top-level markup root, `<div id="widget">`. Bounded
  `<style>` blocks may precede that root.
- Put any custom CSS in bounded `<style>` elements. Inline `style` attributes
  are removed.
- Check the fragment before replying. Fix escaped markup such as literal `\"`
  or `\n`, missing labels, clipped content, and malformed SVG.
- Put this exact opening marker on its own line where the visual should render,
  then the fragment, then the exact closing marker on its own line:

```text
:::rudder-inline-visual:v1
<style>#widget .series { color: var(--viz-series-1); }</style>
<div id="widget">...</div>
:::rudder-inline-visual:end
```

The markers must have no indentation, attributes, or trailing text. Keep any
necessary explanation outside the envelope. Never emit
`::codex-inline-vis{...}`, `::rudder-inline-vis{...}`, a file path, an iframe,
or a second link to source HTML; Rudder owns capture, trusted placement,
persistence, sandboxing, and rendering.

## Rudder Safety Boundary

Rudder sanitizes the fragment before rendering, but generate valid input rather
than relying on sanitization:

- Do not write scripts, event handlers, JavaScript URLs, forms, links, images,
  media, nested frames, embedded objects, canvas, or external resources.
- Do not use `fetch`, XHR, WebSocket, module imports, CDN libraries, web fonts,
  or URL-bearing CSS. The artifact has no network access.
- Do not use active controls such as buttons, inputs, selects, or textareas.
  They are removed because the scriptless runtime cannot preserve their state
  or behavior safely.
- Do not implement a parent bridge, follow-up prompt action, filesystem access,
  or access to Rudder state, credentials, cookies, storage, or APIs.
- Use `<details>` and `<summary>` for the only stateful native disclosure.
  Use `data-tooltip` on `<summary>` for short supplementary hover/focus text.
  A tooltip on any other preserved element is hover-only and must not contain
  essential information.
- Keep all data needed for the visual inside the fragment. Use inline SVG for
  charts and supplied geometry; never fetch a basemap or invent geography.

Read [references/runtime-contract.md](references/runtime-contract.md) before
writing custom markup or CSS. Use
[assets/example-chart.html](assets/example-chart.html) as a structure example,
not as data or copy to repeat.

## Composition

- Start with the visual itself. Do not add decorative KPI rows, repeated
  legends, permanent toolbars, or explanatory paragraphs inside the fragment.
- Use one dominant chart, diagram, or comparison. Add up to three compact
  summary cards only when their values are central to reading the visual.
- For a requested simulator or adjustable explorer, show representative static
  scenarios or a disclosure-based comparison and state the limitation in the
  surrounding response. Do not pretend controls survived when they cannot.
- For maps, use only user-supplied or locally available geometry that can be
  embedded as safe SVG. Otherwise choose a table, ranked plot, or schematic.
- Keep the outer surface transparent and unframed. Use `.card` only for a real
  bounded summary or detail; never nest cards.

## Layout And Accessibility

- Design for the full Chat width around 736px and reflow cleanly down to 320px.
- Avoid fixed outer widths, viewport-height layouts, horizontal scrolling,
  fixed positioning, and clipped labels.
- Use semantic headings sparingly. Do not restate the user prompt or render a
  title inside the fragment when the surrounding Markdown already names it.
- Give each meaningful SVG `role="img"` plus an accessible name or description.
  Include `<title>` and `<desc>` when they improve screen-reader output.
- Label important values directly. Add a legend only when multiple series
  cannot be labeled on the marks.
- Pair color with text, shape, or line style so meaning never depends on color
  alone.

## Theme And Utilities

- Use Rudder theme variables for every color. Start with `--foreground`,
  `--muted-foreground`, `--border`, and `--viz-series-1`; use
  `--viz-series-2` through `--viz-series-6` only for stable categories.
- Use host utilities such as `.viz-grid`, `.viz-row`, `.viz-stat`,
  `.viz-stat-value`, `.viz-badge`, `.card`, `.text-small`, `.text-muted`,
  `.text-destructive`, and `.sr-only` before adding custom CSS.
- Keep custom selectors scoped below `#widget`. Use only theme variables already
  provided by Rudder; custom CSS variables are removed.
- Use normal text by default and weights 400 or 500. Reserve compact secondary
  text for annotations, never essential labels.

## Verification

Before replying:

1. Confirm each envelope uses the exact v1 markers, satisfies the 64/128/256 KiB
   limits, and the message has no more than three visuals.
2. Confirm the fragment contains no scripts, handlers, URLs, external assets,
   active controls, document-level elements, or unsupported embeds.
3. Confirm SVG view boxes, labels, referenced IDs, table semantics, and CSS
   selectors are valid.
4. Check both narrow and wide layout when a preview path is available. If not,
   keep the geometry responsive and the composition conservative.
5. Emit the envelope only after the fragment is complete and valid. Never leave
   an opening marker unterminated.
