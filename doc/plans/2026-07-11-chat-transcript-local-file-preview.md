---
title: Chat Transcript Local File Preview
date: 2026-07-11
kind: proposal
status: in_progress
area: chat
entities:
  - messenger_chat
  - side_panel
  - runtime_file_preview
  - run_transcript
issue:
related_plans:
  - 2026-04-05-run-detail-transcript-v2.md
  - 2026-07-01-global-side-panel-workbench.md
  - 2026-07-07-messenger-side-panel-session-state.md
supersedes: []
related_code:
  - desktop/src/local-file-preview.ts
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - ui/src/components/transcript/RunTranscriptView.common.tsx
  - ui/src/components/transcript/RunTranscriptView.semantic.tsx
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
  - ui/src/lib/desktop-shell.ts
  - ui/src/lib/side-panel-targets.ts
  - ui/src/pages/Chat.local-file-preview.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/Chat.messages.tsx
  - ui/src/pages/Chat.tsx
  - tests/e2e/chat-side-panel.spec.ts
commit_refs: []
updated_at: 2026-07-11
---

# Chat Transcript Local File Preview

> **For agentic workers:** Use subagent-driven development or execute each task
> below in order. Every production-code step requires a failing test first.

**Goal:** Make Chat run activity scan like Codex by showing file basenames and
letting Desktop users open supported local runtime files in the existing Side
Panel without leaving the conversation.

**Architecture:** Transcript semantics retain structured file references while
Chat renders only the basename. A new `local_file` Side Panel target delegates
read-only file inspection to a narrow Electron IPC service that validates the
sender, canonical path, regular-file status, content family, and size before
returning a typed preview payload. Library files continue to use the existing
organization-scoped API and are not conflated with local runtime files.

**Tech Stack:** React, TypeScript, Electron IPC, Vitest, Playwright, MarkdownBody,
and `d3-dsv` for CSV parsing.

---

## Overview

The current Chat transcript formatter turns a structured path into one display
string such as `Read /Users/name/.rudder/runtimes/.../methodology.md`. That
leaks implementation detail into the scanning layer and leaves no structured
file target for a separate preview action. The whole row currently toggles tool
details, so file inspection and evidence inspection cannot be used independently.

This proposal keeps the existing global Side Panel workbench and adds one narrow
target class. A completed, structurally identified, absolute local file reference
renders as an action verb plus basename. The filename opens a read-only Side
Panel tab; the disclosure button continues to expand the full tool payload. The
full path remains available in the expanded evidence and the preview header.

## What Is The Problem?

Current state:

- `formatTargetAction` inserts the raw target into the operator summary.
- `TranscriptChatToolActionRow` renders that summary as text inside the same
  button that expands tool details.
- the Side Panel target union supports Library files but not local runtime files.
- Desktop exposes `openPath`, which launches the OS default application and is
  not a validated inline-preview boundary.

Impact:

- repeated read steps are slow to scan because directory prefixes dominate.
- users cannot inspect the file beside Chat as they can in the Codex reference.
- reusing Library APIs would violate organization-root path validation.
- reusing generic `openPath` would not enforce a Rudder-compatible type or size
  boundary.

## What Will Be Changed?

- Retain structured file references in transcript semantic information.
- Render basename-only file actions in the compact Chat presentation.
- Separate filename preview and tool-detail disclosure into independent controls.
- Add a `local_file` Side Panel target keyed by the local file path.
- Add a Desktop-only, read-only local-file preview bridge.
- Support Markdown, CSV, PDF, UTF-8 text/code/JSON, and common raster images.
- Render HTML and MDX as inert source text; never execute active document content.
- Preserve Library file behavior, editing rules, and path safety unchanged.
- Add product contracts, unit coverage, E2E coverage, and packaged Desktop proof.

## Success Criteria For Change

- `Read /long/path/methodology.md` displays `Read methodology.md` in Chat.
- the full path remains inspectable and copyable without occupying the activity row.
- clicking the filename opens a read-only Side Panel tab and does not expand the
  tool details or replace the Chat route.
- clicking the disclosure button expands the tool details and does not open a file.
- repeated references to the same path focus one existing Side Panel tab.
- unsupported, missing, non-regular, inaccessible, and oversized files produce a
  clear panel error without exposing a generic filesystem reader.
- Web and remote-only surfaces do not claim that a host path is previewable.
- required unit, E2E, visual, product-logic, and packaged Desktop checks pass.

## Out Of Scope

- Editing or saving local runtime files from the Side Panel.
- Automatically importing a local file into Library.
- Persisting local-file tabs across application restarts or devices.
- Reading arbitrary paths from assistant prose, thinking, stdout, or unstructured
  markdown text.
- Remote runtime artifact transport or historical file snapshots.
- Office documents, archives, executables, devices, directories, sockets, or FIFOs.
- Running HTML, SVG scripts, MDX components, macros, or executable content.

## Non-Functional Requirements

- **Security:** only the trusted Desktop renderer may invoke the preview IPC;
  the main process resolves the canonical path, accepts regular files only,
  validates content family and signature, and applies byte limits.
- **Privacy:** the absolute path is never sent to the Rudder HTTP server and is
  not displayed in the collapsed Chat activity row.
- **Performance:** text is capped and may be truncated; binary preview payloads
  have a strict maximum size; CSV rendering caps visible rows and columns.
- **Accessibility:** filename and disclosure are independent keyboard controls
  with specific accessible names and visible focus states.
- **Maintainability:** preview classification lives in one Desktop module and
  returns a typed payload; UI renderers switch on that payload rather than
  duplicating extension logic.

## User Experience Walkthrough

1. An agent completes a structured file-read action with one absolute path.
2. Chat renders `Read methodology.md`; duration and disclosure remain trailing.
3. Hover or keyboard focus exposes the full path, while expanded details retain
   the exact tool input and result.
4. The operator clicks `methodology.md`.
5. In Desktop, Rudder opens or focuses a `local_file` tab in the current
   Messenger item's Side Panel session without replacing the Chat route.
6. The panel shows `Current local file`, a compact path breadcrumb, copy/open
   actions, and the appropriate read-only renderer.
7. If the path cannot be previewed, the same tab shows a stable reason and keeps
   the full path available for recovery.
8. In a Web shell, the filename remains readable but is not presented as a
   working local-preview action.

## Product Logic Alignment

Affected contract IDs:

- `CHAT.SIDE.PANEL.001`: add the `local_file` target, Desktop-only loading flow,
  read-only behavior, tab deduplication, and failure states.
- `RUN.TRANSCRIPT.FILE.PREVIEW.001`: new detailed contract for basename
  presentation, eligible file references, operator actions, Desktop capability,
  current-file semantics, and persisted evidence boundaries.
- `RUN.RESULT.001`: remains the owning result/transcript contract and links to
  the new interaction contract; it does not turn transcript paths into durable
  artifacts.
- `LIBRARY.FILES.001`: unchanged. The new contract explicitly preserves its
  organization-root and protected-path boundary.

The current user explicitly authorized the concrete `doc/product/**` update in
the request that approved this proposal.

## Implementation

### Product Or Technical Architecture Changes

Add a narrow preview result shared structurally between Desktop and UI:

```ts
type DesktopLocalFilePreview = {
  canonicalPath: string;
  fileName: string;
  parentPath: string;
  contentType: string;
  previewKind: "markdown" | "csv" | "text" | "image" | "pdf";
  content: string | null;
  base64: string | null;
  sizeBytes: number;
  modifiedAt: string;
  truncated: boolean;
};
```

The transcript semantic layer adds structured references without changing raw
evidence:

```ts
type TranscriptFileReference = {
  path: string;
  displayName: string;
};

interface TranscriptToolSemanticInfo {
  fileAction?: "Read" | "Edited";
  fileReferences?: TranscriptFileReference[];
}
```

The Side Panel target stays ephemeral and read-only:

```ts
type LocalFileSidePanelTarget = {
  kind: "local_file";
  filePath: string;
  label: string;
};
```

### Breaking Change

None. Existing transcript payloads, Library routes, Side Panel target parsing,
and persisted database records remain compatible. The new target is in-memory.

### Design

Compact single-file action:

```text
[file icon] Read  methodology.md                     4 ms  >
                  preview file                            details
```

- the filename control opens the file preview.
- the disclosure control owns expansion.
- relative paths still use basename-only display but are not previewable unless
  a trustworthy absolute target is available.
- multi-file actions show `Read N files`; expanded details include one preview
  control per eligible file.
- tool errors keep their error treatment and do not expose preview actions.

### Security

- No new HTTP endpoint or remote dependency is introduced.
- `desktop:preview-local-file` is callable only from the main Rudder renderer.
- Input must be an absolute path or decoded absolute `file:` URL.
- The main process uses `realpath` and `stat`, accepts regular files only, and
  does not follow the request into directory enumeration.
- Text must be valid UTF-8 without binary NUL bytes. Markdown is rendered by the
  existing sanitized Markdown renderer. HTML and MDX use the inert text renderer.
- PDF requires a PDF signature. Raster images use an explicit safe type map.
- Text content is truncated at a documented byte limit. Binary payloads above
  the hard limit fail with a user-facing message.
- The bridge returns content only after an explicit click; hover and transcript
  rendering never read the file.

## Detailed Delivery Tasks

### Task 1: Desktop Local File Preview Boundary

**Files:**

- Create: `desktop/src/local-file-preview.ts`
- Create: `desktop/src/local-file-preview.test.ts`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/preload.ts`
- Modify: `ui/src/lib/desktop-shell.ts`

- [ ] Write failing tests for absolute-path validation, file URL decoding,
  canonical regular-file resolution, Markdown/CSV/text/PDF/image classification,
  UTF-8 rejection, non-file rejection, truncation, and hard size limits.
- [ ] Run `pnpm test:run desktop/src/local-file-preview.test.ts` and verify the
  tests fail because the module does not exist.
- [ ] Implement `previewLocalFile(targetPath)` in the new focused module and make
  the tests pass without exposing directory listing or write operations.
- [ ] Add failing preload/main contract tests or source assertions for the new
  `desktop:preview-local-file` channel and trusted-renderer guard.
- [ ] Expose the typed method through preload and `DesktopShellApi`, then rerun
  the Desktop tests and `pnpm --filter @rudderhq/desktop typecheck`.

### Task 2: Structured Transcript File References

**Files:**

- Modify: `ui/src/components/transcript/RunTranscriptView.common.tsx`
- Modify: `ui/src/components/transcript/RunTranscriptView.semantic.tsx`
- Modify: `ui/src/components/transcript/RunTranscriptView.chat.tsx`
- Modify: `ui/src/components/transcript/RunTranscriptView.tsx`
- Modify: `ui/src/components/transcript/RunTranscriptView.test.tsx`

- [ ] Add failing tests proving a long absolute path renders only its basename in
  Chat while semantic data retains the full path.
- [ ] Add failing tests proving filename click and disclosure click are separate,
  failed tools have no preview action, relative paths are display-only, and
  multi-file tools expose per-file preview controls after expansion.
- [ ] Run the focused transcript test and verify each new assertion fails for the
  intended missing behavior.
- [ ] Add structured file references to semantic results and implement the split
  row controls with keyboard and focus semantics.
- [ ] Rerun the focused test after each behavior turns green and keep non-Chat
  transcript presentations unchanged.

### Task 3: Local File Side Panel Target And Renderer

**Files:**

- Modify: `ui/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `ui/src/lib/side-panel-targets.ts`
- Modify: `ui/src/lib/side-panel-targets.test.ts`
- Create: `ui/src/pages/Chat.local-file-preview.tsx`
- Create: `ui/src/pages/Chat.local-file-preview.test.tsx`
- Modify: `ui/src/pages/Chat.side-panel.tsx`

- [ ] Add `d3-dsv` and its type package as direct UI dependencies.
- [ ] Add failing target tests for `local_file` keys, labels, and absence of a
  full-page Rudder route.
- [ ] Add failing renderer tests for Desktop unavailable, loading, Markdown,
  CSV quoted cells, truncated CSV, PDF, image, text, copy/open actions, and
  missing/unsupported file errors.
- [ ] Implement the target and a focused read-only renderer component. Use
  `MarkdownBody`, `csvParseRows`, safe data URLs, and the existing toast/control
  patterns.
- [ ] Dispatch `local_file` from `Chat.side-panel.tsx` without invoking any
  organization Library query.
- [ ] Run the focused target and renderer tests until green.

### Task 4: Chat Integration

**Files:**

- Modify: `ui/src/pages/Chat.messages.tsx`
- Modify: `ui/src/pages/Chat.tsx`
- Modify: `ui/src/pages/Chat.attachment-preview.test.tsx`

- [ ] Add a failing Chat test with an absolute external Markdown transcript path.
  Assert basename-only text, independent file/detail controls, a `local_file`
  Side Panel tab, unchanged Chat route, and read-only rendered content.
- [ ] Verify the test fails because transcript rows do not yet forward a preview
  callback or open a Side Panel target.
- [ ] Pass the callback through `StreamTranscriptItem` and open the target through
  the current Messenger context using `openTargetForContext`.
- [ ] Keep existing attachment and Markdown-link `openPath` behavior separate.
- [ ] Rerun the focused Chat tests and fix only regressions caused by this slice.

### Task 5: Product Contracts And Traceability

**Files:**

- Modify: `doc/product/domains/collaboration/chat-messenger-im.md`
- Modify: `doc/product/domains/execution/transcripts-and-results.md`
- Modify: `doc/product/registry.yml`
- Modify: `doc/plans/2026-07-11-chat-transcript-local-file-preview.md`

- [ ] Add the approved `CHAT.SIDE.PANEL.001` delta.
- [ ] Add `RUN.TRANSCRIPT.FILE.PREVIEW.001` with actors, flow, decision cases,
  operator output, persisted evidence, invariants, canonical scenarios, and
  traceability.
- [ ] Register the new contract with `spec_depth: logic_contract`, related code,
  tests, and this plan.
- [ ] Run `pnpm product-logic:check` and fix structural contract failures.

### Task 6: E2E, Visual, Packaged, And Review Gates

**Files:**

- Modify: `tests/e2e/chat-side-panel.spec.ts`
- Modify: `desktop/scripts/smoke.mjs` only if packaged Desktop cannot otherwise
  exercise the local preview bridge.
- Modify: `doc/plans/2026-07-11-chat-transcript-local-file-preview.md`

- [ ] Add E2E coverage for an external Markdown file, basename-only activity,
  Side Panel route stability, repeated-tab focus, unsupported type, and missing
  file recovery.
- [ ] Run focused unit tests, UI/Desktop typechecks, lint, product-logic check,
  the relevant E2E suite, full test/build gates, and `pnpm desktop:verify`.
- [ ] Start the local app and capture desktop-width plus narrow-width screenshots
  under `/tmp`; verify filename, disclosure, tab, breadcrumb, content, and errors.
- [ ] Spawn a read-only product verifier for the Desktop operator journey.
- [ ] After verifier PASS, spawn functional, adversarial, and heuristic reviewers.
- [ ] Reconcile every blocker, rerun changed evidence, update this plan's actual
  QA results and `commit_refs`, then commit and push the scoped branch.

## What Is Your Testing Plan (QA)?

### Goal

Prove that the compact transcript is easier to scan, the two actions do not
conflict, local preview stays inside its security boundary, and existing Library
and transcript behavior does not regress.

### Prerequisites

- Rudder Desktop development and packaged shells.
- A disposable external Markdown file, CSV file with quoted/multiline cells,
  small PDF, raster image, binary file, oversized file, and deleted path.
- A disposable Chat transcript fixture containing structured file tool calls.

### Test Scenarios / Cases

- single absolute path, relative path, duplicate path, same basename/different
  paths, multi-file action, running action, failed action.
- Markdown rendered/source behavior, CSV parsing and truncation, PDF/image/text.
- unsupported binary, directory, missing file, permission error, and oversized
  file.
- Desktop available versus Web/unavailable bridge.
- Side Panel open/focus/close/session behavior and unchanged Chat route.
- keyboard focus, Enter/Space activation, and disclosure accessible names.

### Expected Results

Every supported Desktop case opens a read-only local-file tab with basename-first
presentation and full-path recovery. Every unsupported or unavailable case is
explicit and non-destructive. Library behavior and raw transcript evidence remain
unchanged.

### Pass / Fail

Baseline before implementation: PASS on 2026-07-11 for 140 tests across
`RunTranscriptView.test.tsx`, `Chat.attachment-preview.test.tsx`, and
`desktop/src/ide-opener.test.ts`. Final results will replace this paragraph after
the implementation and independent gates run.

## Documentation Changes

- Update `CHAT.SIDE.PANEL.001`.
- Add and register `RUN.TRANSCRIPT.FILE.PREVIEW.001`.
- Record final validation and commit references in this proposal.
- Update contributor-facing Desktop docs only if the bridge changes documented
  Desktop capabilities or commands.

## Open Issues

- Historical run snapshots remain intentionally separate from current-file
  preview. The panel must label the content `Current local file`.
- Relative-path resolution is deferred until transcript/run metadata provides a
  trustworthy working directory at the presentation boundary.
- A future explicit `Add to Library` command may promote a local file into a
  durable artifact, but this proposal must not perform that promotion implicitly.
