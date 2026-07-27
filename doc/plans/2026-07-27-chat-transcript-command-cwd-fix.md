---
title: Chat Transcript Command Working Directory Fix
date: 2026-07-27
kind: fix-plan
status: completed
area: agent_runtimes
entities:
  - messenger_chat
  - run_transcript
  - runtime_file_preview
issue: R6Z-29
related_plans:
  - 2026-07-11-chat-transcript-local-file-preview.md
  - 2026-07-21-chat-local-file-side-panel.md
supersedes: []
related_code:
  - packages/agent-runtimes/codex-local/src/server/app-server-chat.ts
  - packages/agent-runtimes/codex-local/src/ui/parse-stdout.ts
  - ui/src/components/transcript/RunTranscriptView.semantic.tsx
  - ui/src/components/transcript/TranscriptLocalFilePreview.tsx
  - tests/e2e/chat-side-panel.spec.ts
commit_refs: []
updated_at: 2026-07-27
---

# Chat Transcript Command Working Directory Fix

## Summary

Preserve a Codex command item's trustworthy execution directory when projecting
App Server `command_execution` events. Fall back to the run working directory
only when the command item does not provide its own directory, and keep invalid
or dynamic command directories from becoming openable local-file targets.

## Failure

`executeCodexAppServerChat` currently replaces every normalized command item's
`cwd` with the run-level `options.cwd`. When Codex executes a command in a
different per-command directory, the transcript remains structurally valid but
points relative file actions at the wrong workspace. The UI then follows the
documented `RUN.RESULT.001` rule and resolves the relative file against incorrect
upstream evidence, so Desktop correctly rejects the nonexistent target at
`realpath`.

The persisted and live views consume the same emitted JSONL, so the incorrect
normalization affects both surfaces.

## Contract And Compatibility

This is a regression restoration for `RUN.RESULT.001`, not a product-behavior
change. The existing contract already requires:

- absolute local targets, or relative targets with a recorded trusted absolute
  execution root;
- no path inference from rendered prose;
- identical semantic actions from live and persisted transcript evidence;
- bounded Desktop validation through absolute-path, `realpath`, regular-file,
  type, and size checks.

No `doc/product/**` change is required.

Historical command entries do not carry enough provenance to distinguish a
correct run-level fallback from a previously overwritten per-command directory.
This fix will not scan the filesystem or guess by filename. A missing recorded
target keeps the existing bounded Desktop failure path, while the Side Panel
translates `ENOENT` into an explicit unresolved-recorded-location message.

## Implementation

1. Normalize command execution directories in the Codex App Server adapter.
   Prefer the first explicit command `workdir` or `cwd` only when it is a
   non-dynamic absolute path. If an explicit command directory is present but
   invalid, omit the execution root rather than falling back.
2. When no command directory is provided, use the run `cwd` only if it is also a
   trustworthy absolute path.
3. Cache the selected directory by command item id so `item/started` and
   `item/completed` emit identical directory evidence.
4. Keep the parser and UI contract unchanged: only the normalized canonical
   `cwd` is projected into command tool input.
5. Add an explicit Side Panel message for missing recorded local-file targets.

## Verification

- Codex App Server unit coverage:
  - command `workdir` differs from run `cwd`;
  - command `cwd` differs from run `cwd`;
  - absent command directory falls back to run `cwd`;
  - relative and dynamic command directories do not become trusted roots;
  - started and completed events retain the same selected directory.
- Transcript renderer coverage for openable and non-openable relative files.
- Side Panel component coverage for a stable historical/missing-file error.
- Playwright coverage for Chat transcript activity opening a relative Markdown
  file through the Side Panel with the resolved command directory.
- Targeted runtime, UI, Desktop, typecheck, product-logic, and E2E checks.
- Real Rudder Desktop verification with a command reading `doc/README.md` from
  the Rudder source workspace, including screenshot evidence.

## Safety

- No new filesystem API or HTTP endpoint.
- No directory enumeration, basename search, or candidate guessing.
- Invalid command directories are stripped from normalized structured evidence.
- Desktop remains the authority for canonicalization, file type, access, and
  preview-size enforcement.
