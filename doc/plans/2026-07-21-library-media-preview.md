---
title: Shared Library media preview
date: 2026-07-21
kind: implementation
status: completed
area: workspace
entities:
  - library_workspace
  - media_preview
  - side_panel
issue: R6-20
related_plans:
  - 2026-06-30-chat-side-panel.md
  - 2026-07-15-isolated-library-website-preview.md
  - 2026-07-20-library-unsupported-file-launcher.md
supersedes: []
related_code:
  - server/src/services/organization-workspace-browser.ts
  - server/src/routes/orgs.ts
  - ui/src/components/WorkspaceMediaPreview.tsx
  - ui/src/components/WorkspaceFilePreview.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - tests/e2e/library-media-preview.spec.ts
commit_refs: []
updated_at: 2026-07-21
---

# Shared Library Media Preview

## Summary

Add one browser-native audio/video renderer for existing organization Library
files and reuse it in the full Library work surface and Messenger Side Panel.
Recognized media receives an organization-scoped, seekable content URL; codec
failures retain the selected file/tab and expose Download plus contextual Open
actions instead of falling through to the generic binary-file message.

Affected Product Logic contracts:

- `LIBRARY.FILES.001`
- `CHAT.SIDE.PANEL.001`

The accepted R6-20 proposal explicitly authorizes the corresponding guarded
`doc/product/**` delta and registry traceability update.

## Problem

The workspace classifier currently knows text, image, PDF, and generic binary
files. Its content route reads image/PDF files fully into memory, rejects audio
and video, and cannot answer byte ranges. The full Library has separate
image/PDF terminal branches while Messenger delegates through
`WorkspaceFilePreview`, so adding media independently would create inconsistent
players, failure states, and recovery actions.

## Scope

In scope:

- Recognize MP4/M4V, MOV, WebM, Ogg Video, AVI, MKV, MP3, M4A/AAC, WAV,
  Ogg/OGA/Opus, and FLAC with explicit MIME mappings.
- Classify recognized files as `video` or `audio` and expose their existing
  organization-scoped content path.
- Stream full, HEAD, open-ended, suffix, and bounded single-range responses
  with correct `200`, `206`, and `416` headers.
- Add a shared native media component with controls, `preload="metadata"`,
  no autoplay, responsive sizing, per-file state reset, and codec recovery.
- Reuse the component in full Library and Messenger while preserving each
  surface's contextual Open capabilities and route/tab state.
- Add media-specific Library file icons, focused tests, E2E playback/range
  coverage, and wide/narrow screenshots.

Out of scope:

- Upload policy or Chat/issue attachment changes.
- Transcoding, codec probing, media editing, playlists, captions, or schemas.
- Promising browser decode support for every recognized container.
- Weakening organization access, protected-path, symlink, or Desktop launcher
  boundaries.

## Implementation Plan

1. Extend the shared file-detail type, extension/MIME classifier, and service
   tests. Resolve recognized media without loading the entire file into memory.
2. Add a validated content-file descriptor and stream it from the existing
   organization route. Preserve inline disposition, private caching, `nosniff`,
   SVG CSP, and authorization while adding HEAD and single byte ranges.
3. Build `WorkspaceMediaPreview` as the only audio/video player and failure
   renderer. Inject surface-owned Open actions and keep Download same-origin.
4. Integrate the component into `WorkspaceFilePreview` and full Library's
   terminal presentation order before the unsupported-file launcher.
5. Update media file icons and focused component/integration tests.
6. Exercise MP4/WAV playback, seeking/range delivery, surface switching, and an
   undecodable MOV in Playwright; capture Library and docked Side Panel evidence.
7. Synchronize `LIBRARY.FILES.001`, `CHAT.SIDE.PANEL.001`, and registry
   traceability, then run Product Logic and repository validation.

## Design Notes

- `.ogg` is classified as audio; `.ogv` is the explicit Ogg Video extension.
- AVI/MKV are recognized as video so decode failure reaches media recovery, but
  browser support is not promised.
- Range parsing accepts exactly one `bytes` range. Malformed, multiple, empty,
  reversed, zero-length suffix, and out-of-bounds ranges return `416` with
  `Content-Range: bytes */<size>`.
- The native controls own play, pause, volume, timeline, and seek interaction.
  Rudder never starts playback itself.
- The content service may carry an absolute resolved path internally after
  lexical and canonical root validation; escaping symlinks are rejected before
  streaming. Responses expose only the relative Library URL and safe filename.

## Success Criteria

- The same file uses the same player/fallback component in Library and Side
  Panel.
- Supported MP4 and WAV fixtures load, play, and seek with native controls.
- Recognized media never reaches the generic binary renderer.
- An undecodable MOV shows the same compatibility message, Download, and
  available Open actions without losing Library selection or Messenger tab.
- Content delivery is streamed and range-aware without weakening authorization
  or path safety.

## Validation

- Service matrix for every media extension, MIME type, preview kind, content
  path, and unknown binary fallback.
- Route tests for full/HEAD/ranged responses, invalid ranges, headers,
  unsupported content types, and cross-organization authorization.
- Shared component tests for native attributes, accessible names, error
  recovery, contextual actions, and file switching.
- Full Library and `WorkspaceFilePreview` integration tests.
- Playwright coverage for Library and Messenger, playback, seeking/range,
  codec failure, route/tab preservation, and screenshots.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`,
  `pnpm product-logic:check`, and focused E2E.

Completed validation includes 110 focused tests, the isolated media E2E,
monorepo typecheck, production build, lint, Product Logic, diff hygiene, and
independent review. The full Vitest run was also exercised; its remaining
failures are outside this slice and come from inherited Rudder runtime paths,
shared dependency symlinks in the temporary worktree, PostgreSQL fixture
contention, and pre-existing Chat layout work.

## Open Issues

None. Browser codec support remains intentionally runtime-dependent and is
handled by the explicit recovery state.
