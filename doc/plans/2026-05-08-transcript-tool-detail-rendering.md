---
title: Transcript tool detail rendering
date: 2026-05-08
kind: implementation
status: completed
area: ui
entities:
  - run_transcript
  - tool_detail_rendering
issue: ZST-63
related_plans:
  - 2026-04-05-run-detail-transcript-v2.md
supersedes: []
related_code:
  - ui/src/components/transcript/RunTranscriptView.tsx
commit_refs: []
updated_at: 2026-05-08
---

# Transcript Tool Detail Rendering

## Problem

The transcript UI currently hides useful operator context for non-shell tool
calls. Web search entries should expose the actual search keywords, and MCP
tool entries should show concrete server/tool/request information instead of a
generic opaque row.

## Approach

1. Inspect the transcript parser and renderer to identify how Codex web search
   and MCP calls are represented in the normalized block model.
2. Add conservative detail extraction for web-search keywords and MCP metadata
   without changing persisted transcript data.
3. Render those details in the collapsed summary and keep full structured
   request/response payloads available in the expanded body.
4. Add focused UI coverage for the new rendering paths.

## Validation

- Passed `pnpm --filter @rudderhq/ui exec vitest run src/components/transcript/RunTranscriptView.test.tsx src/agent-runtimes/transcript.test.ts`.
- Passed `pnpm test:e2e -- run-transcript-detail.spec.ts`; rendered transcript screenshot written to `/tmp/rudder-run-transcript-detail-expanded.png`.
- Passed `pnpm -r typecheck` after rerun.
- Passed `pnpm build`.
- `pnpm test:run` still has unrelated failures in `server/src/__tests__/costs-service.test.ts` and `server/src/__tests__/instance-settings-routes.test.ts`.
