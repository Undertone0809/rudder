---
title: Chat Local File Links In The Side Panel
date: 2026-07-21
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - side_panel
  - runtime_file_preview
issue:
related_plans:
  - 2026-06-30-chat-side-panel.md
  - 2026-07-11-chat-transcript-local-file-preview.md
supersedes: []
related_code:
  - ui/src/components/MarkdownBody.tsx
  - ui/src/lib/local-file-targets.ts
  - ui/src/pages/Chat.tsx
commit_refs:
  - "feat(ui): preview local file links in side panel"
updated_at: 2026-07-21
---

# Chat Local File Links In The Side Panel

## Summary

Make explicit absolute local-file Markdown links render with file-type icons and
open through the current Chat Side Panel without replacing the conversation.
Reuse the Desktop read-only preview boundary introduced for structured run
transcript files and keep Library path semantics unchanged.

## Problem

Chat currently treats an absolute Markdown file link as an ordinary filesystem
launch target. A source-location suffix such as `:656` is also passed as part of
the filename, so Desktop cannot resolve the file and the operator leaves Rudder
instead of inspecting the reference beside the conversation.

## Scope

- Recognize explicit POSIX, Windows, UNC, and `file://` absolute targets.
- Decode safe URL-encoded paths and distinguish source locations from legal
  filenames ending in colon digits by checking the rendered link label.
- Render extension-appropriate code, image, document, spreadsheet, archive, or
  generic file icons.
- Open recognized links as ephemeral read-only `local_file` Side Panel targets.
- Add Product Logic Registry, unit, integration, E2E, and visual evidence.

Out of scope: editing local files, importing them into Library, persisting tabs,
or scrolling a preview to the source line.

## Implementation Plan

1. Extend the shared UI-local path resolver and lock ambiguous path behavior in
   focused tests.
2. Add the local-file icon grammar to read-only Markdown rendering.
3. Route plain Chat clicks into the current Side Panel context and render the
   existing Desktop preview component, with an explicit Web fallback.
4. Synchronize `CHAT.RICH.REFERENCE.RENDERING.001` and `CHAT.SIDE.PANEL.001`.
5. Verify the real workflow in Playwright, then run repository checks and
   independent review/verification.

## Design Notes

- Resolving a link never reads the filesystem; the Desktop preview bridge is
  invoked only after an explicit unmodified operator click.
- Source location removal requires the displayed basename to equal the basename
  preceding `:line[:column]`; otherwise the original filename is preserved.
- `local_file` targets have no full-page Rudder route and do not participate in
  Library organization authorization or editing.

## Success Criteria

- `[Chat.parts.tsx](/absolute/Chat.parts.tsx:656)` shows a code-file icon and
  opens the canonical file in the right Side Panel while the Chat URL remains.
- Unknown suffixes use a generic file icon.
- Encoded paths resolve, malformed encodings fail safely, and `report:2026`
  remains a valid filename.
- Web, missing, and inaccessible files show an actionable in-panel error.

## Validation

- Focused Vitest coverage for parsing, rendering, click routing, and preview.
- Side Panel Playwright coverage and final screenshot.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, and
  `pnpm product-logic:check`.
- Independent code review and real-environment black-box verification.

## Open Issues

None.
