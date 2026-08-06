---
title: Transcript Artifact Inspection
date: 2026-07-24
kind: implementation
status: completed
area: ui
entities:
  - run_transcript
  - messenger_chat
  - side_panel
  - runtime_file_preview
issue:
related_plans:
  - 2026-04-05-run-detail-transcript-v2.md
  - 2026-05-08-transcript-tool-detail-rendering.md
  - 2026-07-11-chat-transcript-local-file-preview.md
supersedes: []
related_code:
  - packages/agent-runtimes/codex-local/src/ui/parse-stdout.ts
  - ui/src/components/transcript/RunTranscriptView.tsx
  - ui/src/components/transcript/RunTranscriptView.semantic.tsx
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
  - ui/src/components/transcript/TranscriptLocalFilePreview.tsx
  - ui/src/pages/AgentDetail.run-log.tsx
  - ui/src/pages/Chat.tsx
  - tests/e2e/run-transcript-detail.spec.ts
  - tests/e2e/chat-transcript-codex-activity.spec.ts
commit_refs: []
updated_at: 2026-07-24
---

# Transcript Artifact Inspection

## Goal

Make files, skills, images, and historical edits in Agent Runs and Messenger
transcripts as easy to inspect as their Codex equivalents while preserving the
runtime evidence that produced each row.

## Product Contract Alignment

This implementation is constrained by the existing guarded product contracts:

- `RUN.RESULT.001`: summaries, expanded rows, and artifact actions must derive
  from the same structured execution evidence.
- `CHAT.SIDE.PANEL.001`: transcript file inspection uses the existing
  `local_file` Side Panel target without replacing the active Messenger route
  or workbench context.

No semantic edit to `doc/product/**` is authorized or required by this plan.
Any explanatory Product Logic Registry delta will be proposed separately after
implementation.

## Architecture

Codex `imageView` and `fileChange` items remain within the existing
`tool_call`/`tool_result` transcript transport. The adapter preserves image
paths and immutable per-file change evidence instead of reducing those events
to prose. File-change payloads are bounded to 100 files and 256 KiB; explicit
metadata records any truncation.

The shared transcript semantic layer exposes operator-facing labels and typed
artifact actions. Read files and skill definitions open the existing
`local_file` Side Panel. Images load only after their activity group is
expanded, then reuse the existing local preview bridge and
`InspectableImage`. Historical unified diffs expand inline and never fall back
to the current workspace file.

## Implementation Tasks

### 1. Preserve runtime evidence

- Convert Codex `imageView` into paired transcript tool events that retain the
  local image path and render as `Viewed an image`.
- Preserve file path, operation, optional move path, unified diff, item status,
  and truncation metadata for every Codex `fileChange`.
- Accept current object-form and legacy string-form change kinds.
- Keep legacy system-text file-change transcripts readable without inventing
  image paths or historical diffs that were never recorded.

### 2. Upgrade transcript semantics and rows

- Keep compact summaries such as `Read 2 files`, `Used 2 skills`,
  `Viewed an image`, and `Edited 2 files`.
- Render one expanded row per target using only the basename or skill slug.
- Keep full paths in the tooltip, Raw mode, and original invocation details.
- Give file/skill inspection and raw-detail disclosure separate controls.
- Keep disclosure controls hidden until hover, keyboard focus, or a
  coarse-pointer/touch environment.

### 3. Add artifact inspection

- Open Read targets and skill `SKILL.md` files in the global `local_file` Side
  Panel from both Agent Runs and Messenger.
- Close the full-screen Agent Run transcript dialog before opening its Side
  Panel.
- Load image thumbnails only after explicit transcript expansion and reuse the
  existing large-image preview, Copy, Download, and Escape behavior.
- Expand recorded unified diffs inline with per-file counts, hunk headers,
  old/new line numbers, safe text rendering, Copy, and clear unavailable,
  binary, failed, or truncated states.
- Preserve separate diff records when the same file was edited more than once.

### 4. Refine the Side Panel header

- Show only the filename in the Side Panel tab and preview title.
- Remove the parent directory as a permanently visible subtitle while retaining
  the full path in contextual details where needed.
- While a Side Panel is docked on an Agent detail route, temporarily animate
  the Agent context column closed without overwriting the operator's saved
  sidebar preference; restore it when the panel closes.
- Make Agent detail actions, tabs, Run filters, the run rail, summary facts,
  metrics, and transcript content respond to their remaining container width
  instead of relying only on viewport breakpoints.
- Preserve Messenger route, draft, scroll position, and Side Panel session
  context.

### 5. Verify

- Add focused unit coverage for adapter preservation and bounds, semantic
  targets, disclosure behavior, images, and unified-diff rendering.
- Add Agent Run and Messenger E2E coverage for Side Panel file/skill opening,
  inline image inspection, independent repeated diffs, and unavailable
  evidence.
- Capture idle, hover, Side Panel, image, and diff screenshots from a real local
  Rudder environment.
- Run focused tests, relevant E2E tests, `pnpm lint`,
  `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`,
  `pnpm product-logic:check`, and `pnpm desktop:verify`.
- Complete an adversarial reviewer pass and a separate black-box verifier pass.

## Compatibility and Safety

- No database, REST API, or migration changes.
- No new `TranscriptEntry` or `ChatStreamTranscriptEntry` variant.
- No new Side Panel target.
- Missing or legacy evidence remains unavailable rather than being guessed.
- Existing unrelated Messenger Saved View worktree changes remain untouched and
  outside the task commit.
- Validation ends at a pushed review-ready commit; no release or deployment is
  authorized.
