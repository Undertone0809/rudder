# Rudder Design System

Status: Active working design contract for visible product UI
Date: 2026-04-04
Audience: Product, design, and engineering contributors

## 1. Role of This Document

This document is the design source of truth for Rudder's product UI.
It exists to make visible product work consistent across contributors and across surfaces.

Use this document when designing or changing:

- pages
- dialogs and drawers
- cards and panels
- forms and tables
- empty states
- navigation and secondary controls

If a design choice is not explicitly covered elsewhere, this document controls the default.

## 2. Product Character

Rudder is a control plane for agent work.
It should feel like an operator tool, not a marketing site, not a consumer social app, and not a theatrical AI demo.

The default visual character is:

- calm
- dense
- operational
- quiet
- precise
- board-facing

The UI should communicate:

- what is happening
- who is doing it
- what needs intervention
- what the result is

It should not spend screen real estate trying to "sell" the action the user is already taking.

## 3. Core Principles

### 3.1 Tool, Not Stage

Most Rudder surfaces are work surfaces.
They should behave like tools: compact, direct, and easy to scan.

Avoid:

- hero-style empty whitespace
- oversized cards used only for decoration
- oversized typography that slows scanning
- explanatory copy that restates the obvious

### 3.2 Density With Clarity

High density is good when hierarchy remains clear.
We do not optimize for maximum emptiness. We optimize for scan speed and operator confidence.

Good density means:

- short eye travel
- meaningful grouping
- tight but readable spacing
- lightweight controls

Bad density means:

- cramped rows
- unclear grouping
- small hit targets
- multiple competing focal points

### 3.3 Progressive Disclosure

Top-level surfaces should show the minimum needed to act.
Secondary detail belongs in:

- detail pages
- advanced menus
- drawers
- tooltips
- expandable sections

Do not front-load instructions unless the user will fail without them.

On dense operator surfaces, explanatory copy should be on-demand by default.
If text only explains a control or concept and is not required to complete the action safely, prefer tooltip, hover help, or another progressive-disclosure pattern over persistent helper text.
Reserve always-visible helper copy for blocking, risky, or state-critical guidance.

### 3.4 Output First

Rudder is about work and outcomes.
The interface should bias toward artifacts, execution state, approvals, and results, not setup theater.

### 3.4.1 Transcript Rendering

Run transcripts are operator visibility surfaces, not raw protocol dumps.
Use presentation language that matches the entry type:

- Command entries should show the actual command and the command response. Hide shell wrappers such as `/bin/zsh -lc`, working-directory payload fields, transport metadata, and result envelope lines such as `command:`, `status:`, and `exit_code:`.
- Generic tool entries may show structured request and response payloads when expanded, because the payload shape is part of understanding the tool call.
- Standalone stdout/stderr entries should remain clearly labeled as stream output and should not be merged into generic tool metadata.
- Top-level transcript summaries should describe operator-meaningful activity such as reading, searching, editing, or running commands; expandable details are for the exact command, tool payload, or stream body.

### 3.4.2 Review Blocks Inside Chat

When chat produces a proposal, approval, or lightweight change that needs operator review, that object is no longer just another message, even if it has not become a formal issue yet.

It must become a self-contained review block.

Rules:

- Keep status, proposal summary, decision note, and decision actions in the same container
- Do not place a separate decision textarea outside the review block
- While a review block is actionable, do not let the freeform chat composer compete with it as a second primary input
- Use semantic state styling on the whole review block, not only on a tiny badge
- Approved should read clearly positive, rejected clearly negative, and revision requested clearly cautionary
- Supporting rationale may appear in the block, but it should remain secondary to the object being reviewed

### 3.5 Quiet Confidence

Use strong hierarchy, not loud styling.
Color, elevation, and emphasis should be used sparingly and intentionally.

## 4. Information Hierarchy

Every screen should have one clear primary focus.
Every component should answer one of these jobs:

- orient
- act
- inspect
- compare
- review

If a surface tries to do several jobs at once, split it.

Hierarchy order for most Rudder surfaces:

1. page or dialog intent
2. primary editable content or decision
3. key metadata needed to complete the action
4. advanced settings
5. supporting explanation

Supporting explanation is last by default, not first.

## 5. Typography

Typography should be compact and readable.
Rudder does not need display typography for normal product workflows.

Recommended default sizes:

- Page title: `24-28px`, `600` weight
- Section title: `16-18px`, `600` weight
- Dialog title or title-input surface: `18-20px`, `500-600` weight
- Body copy: `14-15px`
- Dense metadata text: `12-13px`
- Table text: `13-14px`
- Helper and tooltip text: `12-13px`

Rules:

- Avoid using multiple large text blocks on the same surface.
- Most forms should use body-size text, not title-size text.
- Placeholder text should guide, not explain the entire workflow.
- Muted text should be truly secondary. If everything is muted, nothing is.
- Do not use forced all-caps for section labels, metadata labels, status copy, or card overlines.
- Do not use wide tracking as a substitute for hierarchy. Use spacing, placement, weight, and surface structure instead.
- Small labels should stay in normal casing. Use title case for named sections and sentence case for explanatory copy.

## 6. Spacing and Rhythm

Use a tight spacing scale and repeat it consistently:

- `4`
- `8`
- `12`
- `16`
- `20`
- `24`

Default expectations:

- Dense row spacing: `8-12`
- Standard control grouping: `12-16`
- Section separation inside cards/dialogs: `16-20`
- Large section breaks: `24`

Avoid arbitrary large gaps such as `32`, `40`, `48`, or more unless the surface has a specific reason to breathe.

Whitespace should usually exist:

- between major groups
- outside the main working surface

Whitespace should not usually exist:

- as large dead zones inside cards
- above simple forms
- between label and control without a hierarchy reason

## 7. Surface Hierarchy

Not every container needs to look important.
Use fewer, quieter surfaces.

### 7.1 Preferred Stack

- page background
- one primary panel or table region
- quiet sub-panels only when grouping materially improves comprehension

### 7.2 Cards

Cards are for grouping, comparison, or independent action regions.
They are not the default wrapper for every piece of content.

Card rules:

- Typical padding: `12-16`
- Dense product cards should rarely exceed `20`
- Avoid large radii and heavy shadows on normal data surfaces
- If a card contains one form and no comparison context, challenge whether the card is needed

### 7.3 Radius Discipline

Default Rudder controls should use a compact radius.
The baseline should match the small shadcn control radius, not a pill or capsule shape.

Rules:

- Buttons, list items, search fields, segmented controls, and interactive chips should default to the same small control radius used by the base button
- Avoid `rounded-full` for normal controls, status pills, or selectable rows
- Reserve fully circular treatment for avatars, status dots, unread indicators, and other true circular affordances
- Avoid hardcoded large radii like `14px`, `16px`, or `18px` when a shared radius token already exists
- If an item reads like a compact operator control, it should look precise rather than soft or bubbly

### 7.4 Empty Space

External whitespace is more useful than internal dead space.
Prefer a smaller, tighter working surface with breathing room around it over a giant surface with empty interior.

### 7.5 Desktop Shell

Desktop Rudder should read like a compact tool window, not a page dropped into Electron.

Rules:

- The outer desktop shell is backdrop-only. It may exist for layout and clipping, but it must never read as a bordered, filled, or shadowed parent panel around the workspace cards.
- On macOS desktop shell surfaces, the outer shell backdrop must always carry a theme-appropriate tint. Do not ship the shell with a pure transparent backdrop that simply exposes the wallpaper color.
- Light and dark desktop shell modes must separate clearly at the shell layer itself. Dark mode should read as smoked glass; light mode should read as warm paper-glass. The difference must remain obvious even against the same wallpaper.
- Desktop translucency belongs to the non-card shell only. The actual work surfaces stay compact, readable, and paper-like.
- When tuning desktop translucency, adjust shell-owned layers first: app backdrop, workspace shell, primary rail, and modal backdrops. Do not push the glass treatment into the main work cards just to make the shell feel more present.
- In light mode, desktop workspace cards share the same paper token: `#f8f4ee`.
- Desktop workspace cards and their headers should remain materially more opaque than the shell around them. They are the paper surfaces where work happens, not part of the glass.
- Chat uses two explicit work cards after the primary rail: a conversation-list card and a main chat card.
- Agents, Issues, Projects, and Org workspaces use two explicit work cards after the primary rail: a middle context card and a main content card.
- The gap between the middle card and main card should stay minimal, the top inset should stay tight, and both cards should use a small radius.
- In light mode, pale or glass rails use dark neutral icon and text colors by default. Active emphasis should come from surface treatment, not white text on a pale background.
- In dark mode, the primary rail may stay translucent, but it should still read as a quiet structural surface rather than a bright wallpaper reveal.
- Desktop settings open as a compact modal tool window. In modal mode, do not render an org identity header, org selector, or a large “System settings” block above the nav.

## 8. Controls

Controls should be light enough that content remains primary.

Default sizing:

- Dense button or selector height: `28-32`
- Standard button or input height: `32-36`
- Large controls: reserved for onboarding, landing, or rare high-confidence CTA moments

Rules:

- Do not make every action button visually heavy.
- Use one clear primary CTA per surface.
- Secondary actions should visually recede.
- Inline selectors, chips, and filters should feel integrated, not like mini cards.
- Icon buttons should be small and quiet unless they are destructive or safety-critical.

## 9. Color and Emphasis

Rudder should be neutral-first.

Use color to communicate:

- status
- state changes
- warnings
- approval needs
- project identity where helpful

Do not use color just to make a surface feel more exciting.

Defaults:

- neutral surfaces
- low-contrast borders
- restrained accent usage
- semantic color for status only when it adds meaning
- semantic state surfaces must keep readable contrast in both light and dark themes
- in light mode, use dark readable semantic text on tinted surfaces; pale `100/200`-style semantic text belongs on dark tinted surfaces only

## 10. Copy Rules

Rudder copy should be direct and low-friction.

Prefer:

- short labels
- concrete placeholders
- concise empty states
- terse action text

Avoid:

- tutorial paragraphs inside active workflows
- repeated explanation of what the user is already doing
- verbose helper copy under every input

If extra explanation is necessary, prefer this order:

1. placeholder
2. tooltip via `i` or help icon
3. advanced panel
4. detail page

Default rule:
If the user can succeed without reading the explanation, hide it.

## 11. Dialog and Composer Rules

Dialogs are common in Rudder and must stay disciplined.

### 11.1 Purpose

Use dialogs for:

- quick creation
- focused edits
- lightweight review

Do not use dialogs for:

- full onboarding
- multi-stage teaching
- long configuration workflows that deserve a page

### 11.2 Size

For standard creation composers:

- preferred width: `820-980px`
- avoid full-screen treatment unless editing a substantial artifact
- keep vertical footprint controlled so the user still perceives context around the dialog

### 11.3 Structure

Preferred order:

1. title or title input
2. primary content field
3. minimal metadata controls
4. one primary CTA
5. advanced options behind a secondary affordance

### 11.4 Helper Copy

Inline instructional paragraphs are discouraged in create flows.
If guidance is helpful but not critical, use a help icon with hover or click tooltip.

### 11.5 Prompt and Textarea Surfaces

Large textareas are allowed when the text is the primary object, but they should not dominate by default.

Guidelines:

- normal minimum height: `160-240px`
- only go beyond `280px` when the content is expected to be long at creation time
- keep surrounding chrome minimal

## 12. Tables, Lists, and Operational Surfaces

Rudder is operational software. Lists and tables should be first-class, not treated as a fallback.

Rules:

- prefer scan efficiency over decorative spacing
- keep row height moderate
- expose status and ownership early in the row
- align actions consistently
- avoid wrapping simple fields into tall stacked cells unless necessary

## 13. Empty States

Empty states should orient and trigger action, nothing more.

Good empty states:

- state what is missing
- explain the immediate next action in one sentence
- provide one clear CTA

Bad empty states:

- long product education
- multiple parallel CTAs
- oversized illustrations or decorative blocks in dense operator contexts

## 14. Motion and Feedback

Motion should clarify state changes, not decorate them.

Prefer:

- quick fades
- subtle panel transitions
- immediate hover and press feedback
- state-change highlights for live runs, new rows, moved issues, and review decisions
- visible continuity when an object moves between known states or surfaces

Avoid:

- dramatic spring motion
- delayed reactions
- ornamental animation on operational surfaces
- continuous animation on anything that is not live, running, unread, or safety-critical

### 14.1 Motion V1 Defaults

Use motion only when it improves one of these jobs:

- confirms an operator action completed
- reveals that data changed while the user was watching
- preserves spatial continuity during navigation, resizing, drag, or expansion
- distinguishes live work from historical records
- calls attention to an approval, warning, or intervention need

Default timing:

- micro feedback: `100-160ms`
- list, row, and card entry: `180-240ms`
- panels, drawers, and modals: `220-360ms`
- continuous live indicators: slow enough to scan, usually `1400-2600ms`

Default easing:

- entering or settling: `cubic-bezier(0.16, 1, 0.3, 1)`
- normal state changes: `cubic-bezier(0.2, 0, 0, 1)`
- exiting: `cubic-bezier(0.4, 0, 0.2, 1)`

### 14.2 Product Placement

High-value Rudder motion belongs on:

- live agent runs and transcript updates
- issue board drag/drop, status changes, and active issue indicators
- middle-column active navigation indicators in three-column workspaces
- Organization Structure active-state and work-flow hints
- proposal, approval, and budget decision state changes
- toast and inline feedback after mutating actions

Low-value motion should be removed or avoided on:

- static metric cards
- normal hover states that already have color or border feedback
- background decoration
- dense tables where animation slows scanning

### 14.3 Accessibility

All non-essential motion must respect `prefers-reduced-motion`.
Reduced-motion mode may keep color, border, icon, and text feedback, but should
remove movement, pulsing, and repeated animation.

## 15. Review Rubric

Visible UI work should be reviewed against these six dimensions:

### 15.1 Surface Ratio

Is the surface appropriately sized for the task, or does it feel inflated?

### 15.2 Typography Hierarchy

Are title, body, metadata, and actions clearly distinguished without oversized text?

### 15.3 Control Weight

Do controls support the content, or do they compete with it?

### 15.4 Whitespace Distribution

Is whitespace improving scanability, or just making the UI feel big?

### 15.5 Progressive Disclosure

Is secondary guidance hidden until needed?

### 15.6 Layout Rhythm

Do spacing, alignment, and grouping repeat predictably?

### 15.7 Desktop Shell Integrity

For desktop shell changes, do dark and light mode each preserve a clear shell tint, with glass restricted to shell-owned layers and paper-like readability preserved inside the work cards?

If a surface fails two or more of these dimensions, it should be redesigned before polish work.

## 16. Practical Good vs Bad

### Good

- a medium-width create dialog with one title field, one prompt field, inline metadata chips, and one tooltip for optional guidance
- a dense table with clear ownership, status, and project columns
- a quiet review panel where the artifact is visually primary and controls are secondary

### Bad

- a create dialog that looks like a landing page section
- a giant card with one short form inside it
- helper paragraphs that permanently occupy the top of a workflow
- multiple visually heavy buttons competing for attention
- oversized headings on routine operator actions

## 17. Applying This Document

When making visible UI changes:

1. identify the surface type
2. apply the relevant rules from this document
3. review against the six-dimension rubric
4. verify the result visually in a browser or desktop shell

When a contributor wants to break one of these defaults, they should be able to explain why the product outcome is better, not just why the new version is more expressive.

### 17.1 Desktop Shell Review Checklist

For visible desktop shell changes, verify all of the following before hand-off:

- dark and light screenshots both show a clear shell tint difference; neither mode reads like raw wallpaper behind the product
- the outer shell still reads as backdrop-only rather than a giant parent card around the workspace
- middle and main work cards remain paper-like and readable, with glass treatment staying outside the cards
- primary-rail emphasis still comes from surface treatment and hierarchy rather than high-contrast decorative text treatment
- translucency adjustments were made in shell-owned layers first, not by making the work cards themselves too transparent

## 18. Sidebar Navigation

Sidebar sections should read as one system, not as a stack of unrelated widgets.

Rules:

- Section headers must share a common text baseline and left inset across static and collapsible sections.
- Collapse affordances such as chevrons must live in a fixed slot so showing or hiding them never moves the label.
- Header action buttons such as `+` belong to the far-right utility column and must not change the label position.
- Row density may vary between primary nav and compact lists, but section-label alignment should stay stable.
