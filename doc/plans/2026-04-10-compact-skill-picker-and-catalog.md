# Compact Skill Picker And Catalog

Status: Implemented
Date: 2026-04-10
Owner: Codex

## Context

The current `Agent Skills` page technically supports enabling organization skills, batch actions, and adapter observation, but the surface does not behave like a compact operator tool.

Problems in the current implementation:

- each skill row carries too much default detail
- the primary selection model is unclear because rows expose both a selection checkbox and an enabled checkbox
- batch actions live in a disconnected overflow menu
- external adapter-discovered skills compete visually with the main managed list
- the page does not share a strong visual language with the organization skills catalog

This conflicts with Rudder's current design contract in `doc/DESIGN.md`:

- tool, not stage
- density with clarity
- progressive disclosure

## Goals

1. Make `Agent Skills` feel like a compact skill picker, not a verbose settings inspector.
2. Make `Organization Skills` feel like a compact skill catalog, not a mixed file browser first.
3. Increase visible information density without making rows cramped.
4. Move secondary explanation and file detail behind explicit disclosure.
5. Establish a shared visual language between:
   - organization skill library
   - agent enabled skill picker
   - read-only external skill observation

## Non-Goals

- changing the skills data model
- changing runtime skill sync semantics
- changing organization seeding or adapter isolation logic
- redesigning the full skill detail pane beyond what is needed for alignment

## Diagnosis

### Primary issue

The main issue is interaction and information architecture, not spacing alone.

The current `Agent Skills` page asks the user to simultaneously parse:

- row selection
- enabled state
- source badge
- full description
- detail link
- runtime status
- batch actions

That is too many jobs in one row.

### Secondary issue

The `Organization Skills` page and `Agent Skills` page do not read as related surfaces.

- `Organization Skills` is list plus file tree plus detail pane
- `Agent Skills` is longform checklist plus runtime summary

They should feel like two modes of the same skill system:

- library mode
- picker mode

## Proposed Interaction Model

## 1. Agent Skills = Compact Picker

### Top bar

Replace the current introductory block with a compact toolbar:

- left:
  - title `Skills`
  - small summary text such as `2 enabled · 5 available`
- center or full-width search input
- right:
  - filter chip or select for `All / Enabled / Bundled / Custom`
  - batch mode trigger
  - overflow menu only for secondary actions

Remove the inline `View organization skills library` text link from the primary heading block.
Keep navigation to the library as a subtle secondary action in the toolbar or section header.

### Primary list

Each managed organization skill row should become a compact row with:

- one primary enable switch or checkbox
- skill icon or source mark
- skill name
- one compact source badge
- one-line description preview
- optional trailing action:
  - `View`
  - expand chevron

Do not show the full description by default.

Row structure should read approximately as:

`[toggle] [icon] [name + source badge] [1-line summary] [view]`

### Batch mode

Do not show a second permanent checkbox column by default.

Instead:

- default mode:
  - only the enable toggle is visible
- batch mode:
  - rows gain a selection affordance
  - sticky inline batch bar appears above the list:
    - `3 selected`
    - `Enable`
    - `Disable`
    - `Select visible`
    - `Clear`

This makes batch selection explicit instead of always-on.

### Detail disclosure

Full skill description, path, origin notes, and runtime-specific messaging should move behind one of:

- right-side inline expander
- popover
- drawer

Preferred first iteration:

- inline compact expander under the row

Expanded content may show:

- full description
- source / location
- why it is bundled or external
- link to organization library detail

### External section

External / adapter-discovered skills should be visually lower priority:

- collapsed by default when non-empty
- compact count in header
- rows are read-only and lighter
- ignore obvious junk like `.DS_Store` if possible in presentation

The section should not compete with the managed library.

### Runtime summary

Move runtime summary into the toolbar summary or a compact footer strip.

Do not keep a separate four-row stats block if the values can be summarized in one line.

## 2. Organization Skills = Compact Catalog

### Library list

The left list should behave more like a catalog:

- denser rows
- clearer grouping by source when helpful
- name and short description preview
- source mark and lightweight metadata
- file tree hidden unless a skill is selected

The current expand-first file-tree interaction is too file-centric for the top-level list.

### Library browsing model

Use a two-step model:

1. browse skills as a compact catalog
2. inspect files only after selecting a skill

This means:

- skill list rows should optimize for scan, not file navigation
- file tree remains in the detail pane, not expanded inside the top-level list

### Shared item language

The catalog item and the picker item should share:

- icon placement
- title treatment
- source badge treatment
- summary truncation
- vertical rhythm

The picker can be slightly denser, but the language should match.

## 3. Component Direction

Introduce a shared presentation layer instead of duplicating row logic.

Suggested shared components:

- `SkillListToolbar`
- `SkillCatalogItem`
- `SkillPickerItem`
- `SkillSourceBadge`
- `SkillExpandedMeta`

Keep the organization detail pane and file viewer separate from these shared row components.

## 4. Implementation Plan

### Phase 1

Refactor `Agent Skills`:

- add search/filter state
- replace always-on dual-checkbox rows with:
  - single enable control in default mode
  - explicit batch mode
- truncate default descriptions
- collapse external section by default
- compress runtime summary

### Phase 2

Refactor `Organization Skills`:

- make the left list denser and catalog-oriented
- remove expanded file tree behavior from the top-level list
- keep file inspection in the detail pane only
- align badge, summary, and row spacing with `Agent Skills`

### Phase 3

Visual cleanup:

- ensure both pages hold 8-12 visible skills on desktop in common states
- reduce dead space and duplicated helper copy
- verify scan speed with real bundled and custom skills

## Acceptance Criteria

### Agent Skills

- default rows show one primary control, not two same-level checkboxes
- batch mode is explicit and discoverable
- descriptions are truncated by default
- external skills are lower emphasis than managed library skills
- at least 8 compact rows are visible in a common desktop viewport

### Organization Skills

- skill list reads as a catalog first, file browser second
- file trees are not expanded inline in the main list
- row language matches the agent picker

### Shared

- the two pages feel like different modes of one system
- helper copy is reduced and no longer competes with the list itself
- the result feels closer to Codex and WorkBuddy:
  - denser
  - more scannable
  - clearer primary action

## Verification

- targeted UI verification in browser
- update or add E2E coverage for:
  - enabling a skill
  - entering batch mode and enabling selected rows
  - filtering skills
  - organization skills catalog selection
- capture screenshots for both pages after implementation
