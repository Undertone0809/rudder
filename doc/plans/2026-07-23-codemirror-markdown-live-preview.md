---
title: CodeMirror source-backed Markdown live preview
date: 2026-07-23
kind: implementation
status: completed
area: ui
entities:
  - markdown_editor
  - library_documents
  - rich_references
  - website_metadata
issue:
related_plans:
  - 2026-05-19-milkdown-markdown-editor-proposal.md
supersedes: []
related_code:
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/MilkdownMarkdownEditor.tsx
  - server/src/services/website-metadata.ts
commit_refs: []
updated_at: 2026-07-24
---

# CodeMirror source-backed Markdown live preview

## Summary

Add an explicitly selected CodeMirror editor engine for durable Markdown
documents. The Markdown string remains the only source of truth. Inactive
reveal units render as readable CommonMark/GFM, while the unit intersecting
the cursor or selection exposes the exact editable source.

The first rollout covers Library Markdown bodies, Issue descriptions, and
Automation instructions. Goal and Project descriptions follow after the core
surface E2E suite passes. Chat and Issue comment composers, runtime/source
configuration editors, and Library frontmatter retain their current behavior.

## Editor contract

- Extend `MarkdownEditor` and `InlineEditor` with an explicit `codemirror`
  engine. `plainText` remains the highest-priority routing decision so Chat
  cannot accidentally opt into live preview.
- Implement the new engine in focused modules for lifecycle and controlled
  state, live-preview decorations, Rudder reference tokens, smart paste, and
  shared website metadata.
- Preserve the existing imperative editor API and add source-line reveal for
  the Library outline.
- Render the common GFM set in inactive blocks. A normal line reveals its exact
  source; fenced code, tables, and other inseparable multiline constructs reveal
  the complete block. Unknown syntax and raw HTML remain inert source.
- Rudder canonical rich-reference tokens remain atomic UI in every state.
  Entity tokens created through `@`, existing `$skill` tokens, and previously
  persisted canonical links keep their current data format. Document surfaces
  navigate on plain click without revealing the token source.
- Normal links and images enter source mode on plain click. Existing open
  behavior remains available through the modifier-key or keyboard path.

## Smart links and website metadata

- Pasting one HTTP(S) URL over selected text creates a Markdown link
  synchronously. Pasting without a selection inserts a site-name/hostname link
  immediately, then enriches the label with the page title only if the inserted
  range remains unchanged. Title enrichment is folded into existing editor
  history, so it never creates a standalone undo step.
- Add an additive website metadata purpose (`preview` or `authoring`) and
  `pageTitle`. Preview requests preserve the known-icon no-fetch invariant;
  authoring requests may fetch a public page title through the existing
  server-side SSRF protections.
- Share the known-icon, inflight, cache, proxy, and fallback behavior between
  read-only Markdown and the CodeMirror widget layer. Decorations never mutate
  the Markdown value.

## Persistence and rollout

- Treat `trim()` as an emptiness check only. Store non-empty Markdown exactly,
  including delimiter choice, indentation, escapes, and boundary newlines.
- Preserve Library conditional writes and conflicts, Issue autosave, Automation
  save queues, and controlled-value history.
- Roll out explicitly to all full and side-panel variants of the named
  surfaces, and provide the state-preserving `LibraryLiveSurface` adapter used
  by the related Main Workbench plan. Main Workbench routing, promotion, and
  host-level E2E remain owned by that plan. Then migrate Goal and Project
  descriptions.
- Keep Chat, Issue comments, Agent prompt/capabilities, Organization Skill
  source, and Library YAML frontmatter out of the live-preview engine.

## Product logic delta

Add `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001` as the cross-surface owner of
source-backed authoring, active-block behavior, smart link paste, atomic Rudder
references, and composer/source exclusions.

Make bounded references or additions to:

- `ISSUE.SURFACE.001`
- `LIBRARY.FILES.001`
- `AUTOMATION.DEFINITION.001`
- `ORG.GOAL.001`
- `ORG.PROJECT.001`
- `CHAT.RICH.REFERENCE.RENDERING.001`
- `CHAT.WEBSITE.LINK.ICON.001`
- `CHAT.SIDE.PANEL.001`

`ISSUE.COMMENTS.001` and `ROUTING.COMMENT.WAKE.001` remain unchanged and are
covered as non-regression dependencies.

## Verification

- Unit and component tests cover source fidelity, active block calculation,
  decorations, history, controlled updates, IME, token boundaries, smart paste,
  title races, caching, and SSRF behavior.
- E2E covers every directly migrated surface, full API round trips, Library
  conflicts and outline navigation, website icon source/preview switching,
  and negative regression coverage for Chat and Issue comments. Main
  Workbench activation of `LibraryLiveSurface` is verified with the related
  Workbench runtime rather than making this foundational editor commit depend
  on an uncommitted host.
- An independent reviewer performs adversarial review. An independent verifier
  exercises Library, Issue, Automation, Goal/Project, and Chat in a real local
  runtime and captures screenshots.
- Run product-logic, lint, typecheck, unit/integration, build, architecture
  audit, and relevant/full E2E gates before staging only task-owned hunks,
  committing, and pushing the current branch.
