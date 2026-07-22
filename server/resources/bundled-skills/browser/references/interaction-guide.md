# Browser Interaction Guide

Read this reference for workflows that require more than one simple Browser
operation. It is intentionally task-oriented; exact schemas and limits live in
`tool-contract.md`.

## Snapshot Discipline

Keep the latest relevant `rudder_browser_snapshot` result while it still
describes the UI you are operating.

- Re-snapshot after navigation when you need locator ground truth on the new
  page.
- Re-snapshot after a strict, stale, missing, hidden, covered, or timeout error.
- Do not print or request full snapshots repeatedly when `count`, one attribute,
  one state check, or a smaller max depth answers the question.
- Do not discover a page by iterating through broad results and reading each
  element separately. Take one bounded orientation snapshot, then narrow to the
  relevant region with declarative locator reads.
- Do not dump body text or embedded application-state JSON as exploratory
  search. Use a focused page, container, or result.

## Stable Locator Construction

Choose a strategy from evidence in the latest snapshot:

1. `testId` for an exact `data-testid`.
2. `css` for a stable copied `data-*` attribute or other durable attribute.
3. `href` for an exact visible destination, scoped if repeated.
4. `role` plus a plain-string accessible `name`.
5. `label` or `placeholder` for form controls.
6. Scoped `text` for visible text without a more stable contract.
7. Scoped CSS copied from actual page state.

Generic labels such as Menu, Close, Search, Size, Color, Sort, and Submit are
ambiguous by default. Scope them to the correct dialog, card, form, or section
and count before acting.

Use locator `scope` for a container, `filter.hasText` or `hasNotText` to narrow
it, and `and` or `or` only when each side is supported by current page evidence.
Use `frame` with outer-to-inner iframe CSS selectors for nested frames.

## Forms And Controls

- Locators are read-only and may only count, read bounded text/attributes/state,
  or wait for attached, detached, visible, or hidden state.
- For a simple input or clickable control, call `rudder_browser_read`, select
  the exact opaque ref, and call `rudder_browser_type` or
  `rudder_browser_click` once. Re-read before the next interaction because refs
  are invalidated.
- For select controls, checkboxes not represented by a safe high-level ref,
  keypresses, hover, scroll, or drag, verify the target with a current snapshot,
  screenshot, and `elementInfo`, then use explicit coordinate CUA.
- File upload is unavailable until Rudder can provide run-owned staged handles;
  do not attempt to operate a native picker or pass local paths.

For multi-field forms, fill fields one at a time or in small logical groups and
verify the narrow values that matter before submission. Submission is an
external side effect when it sends data or creates state; confirm if the user's
request did not already authorize that exact submission.

## Navigation And State Changes

Menus, filters, tabs, and accordions often do not navigate. Wait for their
specific visible or selected state instead of load state.

If you know an exact safe destination and click side effects do not matter,
direct navigation is more reliable than clicking a brittle link. Never generate
and probe a grid of guessed URL variants.

## Frames

Snapshot results include frame document metadata. Build the `frame` selector
chain from outer frame to target frame, then use the same locator strategies as
the main document. Re-snapshot if a frame navigates or its execution context is
replaced.

DOM-CUA is read-only. Its node ids are ephemeral snapshot evidence, not
interaction handles. Use a fresh high-level ref or an explicit coordinate
action to interact.

## Visual And Coordinate Interaction

Use a screenshot when canvas, rendered geometry, color, overlap, or pixel state
is the source of truth. Coordinates are viewport-relative CSS pixels.

Before a coordinate click or drag:

1. Ensure the latest screenshot represents the current viewport and state.
2. Use `elementInfo` at the point when DOM evidence can validate the target.
3. Click the center of the proven target, not its edge.
4. Verify one resulting visual or DOM signal.

Use `move` for hover-only UI, `scroll` with a point inside the intended scroll
container, and `drag` with a short bounded path. Coordinate input is a fallback,
not a replacement for stable locators.

## Dialogs

A synchronous JavaScript dialog blocks the page action that opened it.

- Open the dialog once through a high-level ref or verified explicit coordinate
  action, then call `rudder_browser_dialog` to inspect and handle it.
- JavaScript prompts can only be dismissed in the Electron runtime. An attempt
  to accept one fails closed after dismissal; prompt text is never bridged
  through page-visible state.
- Use `rudder_browser_dialog` for a dialog opened independently by navigation,
  a timer, or page code.
- Do not retry the opening click after a dialog timeout without inspecting the
  current dialog and page state; the first click may already have happened.

## Downloads

For explicit media or file links, use download mode `media` with a unique
locator. This reads the media URL and downloads it without firing page events.
Locator-triggered download clicks are unavailable because resolving a semantic
locator and separately dispatching input cannot be made atomic. Use an
authorized high-level ref or verified explicit coordinate action for a normal
page interaction, and do not search the user's Downloads folder.

Paths are opaque temporary artifacts and are removed on tab/run cleanup.

## Page Assets

1. Put the page into the relevant rendered state, including lazy-loaded content.
2. Call assets `list` and keep its inventory id.
3. Select explicit `assetIds` for narrow acquisition or explicit `kinds` for a
   bounded broad acquisition.
4. Call `bundle` once. Inspect failures rather than repeatedly downloading the
   same asset.

Inline SVG inventory entries contain only a stable inventory id, media type,
inline origin, and bounded dimensions. Raw SVG/page markup, attributes, text,
and embedded `foreignObject` content are never returned. File assets are
streamed with per-asset, per-bundle, and per-run limits.

## Content Export

- Raw HTML export is unavailable because markup can contain credentials. Use
  `text` for rendered readable text.
- Use `pdf` for a page PDF.
- On eligible Google Workspace URLs, use the requested `pdf`, `md`, `docx`,
  `xlsx`, `csv`, or `pptx` format.
- Returned files are temporary artifacts. Do not upload or transmit them unless
  the task authorizes that destination.

## Console And Clipboard

Use logs with the narrowest useful levels, substring filter, and limit. Clear
the buffer only when subsequent reads should exclude prior entries.

The clipboard belongs to the signed run. `writeText` and `readText` are the
simple path; structured items support bounded MIME text or Base64 data. The
state remains outside the page world. CUA `ControlOrMeta+C`,
`ControlOrMeta+X`, and `ControlOrMeta+V` explicitly transfer the focused
selection without reading or mutating the operating-system clipboard. Never
describe it as the system clipboard.

## Recovery Without Duplicate Side Effects

- On locator ambiguity or staleness, refresh the snapshot and rebuild once.
- After two failures against the same target, switch to a stable copied
  attribute or an explicitly verified coordinate action. Do not keep
  increasing timeout or selector complexity.
- On a Browser timeout, call `rudder_browser_tabs` before retrying. The active
  tab may have been closed and the website action may already have occurred.
- On navigation failure, inspect the tab URL/title before deciding to retry.
- On result size errors, reduce depth/node count, scope the locator, crop the
  screenshot, narrow log filters, or reduce asset selection.
- On disable, unavailable Broker, unsupported runtime, or inactive run, stop.
  Another browser or shell request would be a different surface and authority.
