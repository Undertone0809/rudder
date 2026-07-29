---
title: Side Panel text file editing and annotations
date: 2026-07-29
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - response_annotations
  - library_files
  - local_files
issue:
related_plans:
  - 2026-07-01-global-side-panel-workbench.md
  - 2026-07-23-chat-response-annotations.md
supersedes: []
related_code:
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/components/workbench/LibraryLiveSurface.tsx
  - ui/src/components/transcript/TranscriptLocalFilePreview.tsx
  - ui/src/pages/Chat.tsx
  - packages/shared/src/types/chat.ts
  - server/src/services/chat-inline-annotation-validation.ts
  - desktop/src/local-file-preview.ts
  - tests/e2e/chat-side-panel.spec.ts
  - tests/e2e/chat-response-annotations.spec.ts
commit_refs: []
updated_at: 2026-07-29
---

# Side Panel Text File Editing And Annotations

## Outcome

An operator reviewing a text file in the Messenger Side Panel can edit the
file and attach an exact saved excerpt to the current Chat. The workflow covers
eligible organization Library files and Desktop local files already admitted
by Rudder's guarded preview bridge.

The selection action creates a Chat annotation, not an independent file comment
thread. Its optional comment and attachments belong to the owning user message.

## Scope

- Expand the existing Side Panel conditional autosave editor from Markdown to
  every eligible, non-truncated text presentation, including plain text, source
  code, HTML source, and CSV source.
- Preserve preview/source controls for HTML and CSV. Their preview remains
  read-only; their source view is editable.
- Add a Desktop conditional-write bridge for eligible local text previews.
  The bridge writes only the same canonical regular file that was previewed,
  rejects symlinks, binary content, oversized/truncated files, and stale
  expected content, and returns a fresh canonical preview.
- Add `workspace_file` and `local_file` Chat annotation provenance without
  fabricating an assistant source message.
- Add the existing `Add to chat` and `Ask in side chat` selection actions to
  saved text content. The selection action is unavailable while a save is
  pending, failed, or conflicted.
- Persist an immutable selected-text snapshot, source hash, exact offsets,
  bounded context, and a normalized source identity.
- Reopen the corresponding Side Panel target from sent evidence. If the current
  source no longer matches, retain the sent snapshot and show a clear changed
  or unavailable state rather than fuzzy-reanchoring to unrelated text.

## Product Decisions

- The annotation belongs to the current Chat message. V1 does not add file-wide
  comment threads, replies, resolve state, mentions, or unread aggregation.
- `Edit` remains a file-level control/state and is not added to the selection
  toolbar.
- Binary, image, PDF, audio, video, truncated, protected, or otherwise
  ineligible files remain read-only.
- Organization Library sources are validated by the server against normalized
  organization-relative paths.
- Desktop local-file mutation remains a trusted Desktop capability. It is not
  exposed in Web/server-only surfaces and must preserve the preview bridge's
  bounded UTF-8 eligibility.
- Sent annotations remain readable when a file changes or disappears.

## Contract Delta

The user explicitly authorized synchronizing `doc/product/**` for this change.

- `LIBRARY.FILES.001`: expand Side Panel direct editing from Markdown to all
  eligible non-truncated text/source presentations while preserving conditional
  save, draft recovery, and conflict handling.
- `CHAT.SIDE.PANEL.001`: make eligible Library and guarded Desktop local text
  files editable and eligible for current-Chat selection actions.
- `CHAT.RESPONSE.ANNOTATION.001`: add organization workspace and guarded local
  text-file sources, their provenance, validation, navigation, and stale-source
  behavior.
- `CHAT.LIFECYCLE.001`, `CHAT.SIDE.CHAT.001`, and `CHAT.FORK.001`: preserve the
  new source kinds through annotation-only Send, Queue, Steer, draft recovery,
  Side Chat, edit/retry, and Fork without message-source remapping.
- `RUN.CHAT.AGENT.001`: render file excerpts as bounded, explicitly
  user-selected, untrusted context without promoting them to manifest outputs or
  logging their text.

## Verification

- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- `pnpm product-logic:check` passed with 79 contracts.
- 123 focused shared, server, UI, Live Surface, and Desktop tests passed in the
  initial feature sweep. The final 59-test regression subset also passed after
  tightening capability lifetime and exact-source restoration.
- Markdown range regression coverage includes cross-block selection,
  frontmatter exclusion, decoded entities, repeated visible text, duplicate
  text inside inline/reference link and image destinations, inline code, and
  list-to-paragraph exact restoration.
- Three focused Chromium E2E paths passed together: Desktop local Markdown
  editing, organization code editing plus annotation, and organization Markdown
  editing plus annotation.
- The organization code path was rerun after the final restoration changes and
  confirmed that `Show source` restores the exact persisted CodeMirror
  selection.
- The existing organization Markdown editor E2E also passed its save failure
  retry, conditional-write conflict, keep-mine/use-latest, mobile layout, and
  native open-target coverage.
- Final Chromium screenshots cover the local-file saved state and the code and
  Markdown annotation editors.
- Full `pnpm lint` is blocked only by the pre-existing import order in
  `tests/e2e/chat-work-manifest-subagents.spec.ts`, which this change does not
  modify.
- Full `pnpm test:run` was attempted but the already heavily loaded machine
  exhausted concurrent embedded PostgreSQL test processes; unrelated heartbeat,
  issue lifecycle, and OpenCode tests timed out or lost their temporary
  databases. All feature-focused suites passed after the attempt.
- `pnpm desktop:verify` reached the real Desktop smoke workflow and passed
  startup recovery, clean boot, Browser parity, reload, menus, Library
  navigation, settings, persistence, and Browser profile coverage before an
  unrelated Local Apps selected-tab locator timed out.
- `pnpm desktop:dist` and packaged server-package verification passed. The
  separately launched packaged smoke passed packaged boot, embedded PostgreSQL
  handoff, CLI, Browser parity, reload, menus, and issue navigation before the
  same pre-existing Library navigation locator timed out.
- The feature-specific Desktop bridge suite passed all 35 tests, including
  admission enforcement, symlink/inode checks, conditional writes, and
  concurrent stale-write rejection.
