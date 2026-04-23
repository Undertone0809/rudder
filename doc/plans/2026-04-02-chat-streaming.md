# Chat Streaming Plan

## Goal

Convert chat message generation from a request/response flow into a streamed turn model with real cancellation, while keeping the existing synchronous endpoint compatible.

## Scope

1. Add a streamed chat endpoint at `POST /api/chats/:id/messages/stream`.
2. Introduce assistant message statuses:
   - `completed`
   - `stopped`
   - `failed`
3. Make request aborts cancel the underlying runtime execution.
4. Persist partial assistant output when generation is stopped or fails after producing visible text.
5. Implement a shared chat streaming path in `chat-assistant` that:
   - emits visible assistant deltas from runtime stdout parsers
   - hides the structured result envelope from the UI
   - finalizes into the existing `ChatAssistantResult` shape
6. Update the chat UI to:
   - render in-flight streamed assistant text
   - replace `Send` with `Stop generating`
   - merge final persisted messages back into query state
7. Add automated coverage for the new streamed flow, with `codex_local` as the primary runtime to validate.

## Architecture Notes

- The assistant prompt uses a sentinel-delimited result envelope:
  - visible Markdown first
  - sentinel token
  - JSON result payload
- Runtime-specific parsing stays in adapter-owned stdout parsers.
- Chat streaming only consumes `assistant` transcript entries; tool/thinking output remains internal.
- Final persistence rules stay route-owned so proposal approval and auto-create logic remain centralized.
- One active generation is allowed per conversation at a time.

## Verification

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- relevant E2E chat coverage
