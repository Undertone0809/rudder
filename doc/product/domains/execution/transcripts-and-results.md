---
title: Transcripts And Results
domain: execution
status: active
coverage: seed
contract_ids:
  - RUN.RESULT.001
related_code:
  - packages/agent-runtimes/codex-local/src/server/app-server-chat.ts
  - packages/agent-runtimes/codex-local/src/ui/parse-stdout.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/heartbeat-run-summary.ts
  - server/src/services/heartbeat-run-reference.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/chat-generation-protocol.ts
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
related_tests:
  - packages/agent-runtimes/codex-local/src/server/app-server-chat.test.ts
  - server/src/__tests__/heartbeat-run-summary.test.ts
  - server/src/__tests__/chat-routes.test.ts
  - server/src/services/chat-generation-protocol.test.ts
  - tests/e2e/run-transcript-detail.spec.ts
  - tests/e2e/chat-concurrent-streaming.spec.ts
  - ui/src/components/transcript/RunTranscriptView.test.tsx
  - tests/e2e/chat-transcript-internal-events.spec.ts
edit_policy: user_confirmed_only
---

# Transcripts And Results

## RUN.RESULT.001

Behavior:

- Run logs are written to the configured run log store and exposed through live
  log events with bounded chunk size.
- Stdout and stderr excerpts are persisted on the run.
- Adapter transcript parsing builds structured transcript entries when the
  adapter supplies a parser.
- When a provider exposes readable summary and raw streams for the same
  reasoning item, the adapter projects at most one representation for that
  item. Streaming fragments retain delta semantics, raw-only reasoning remains
  inspectable when no summary stream exists, and multiple summary parts retain
  readable boundaries.
- Adapter result summary, result JSON, usage, cost, provider/model, session
  IDs, exit code, signal, log digest, and terminal error fields are persisted.
- Adapter result summary is user-visible assistant output from a completed
  runtime turn. Incomplete, stopped, aborted, or failed streams may preserve
  transcript evidence, including thinking/reasoning entries, but must not
  promote provider reasoning, scratchpad text, or partial progress events into
  the final result summary.
- Chat-visible runtime output is admitted through the active generation's
  append-only ledger. Accepting Stop closes that admission boundary at a
  sequence and body hash. Later provider bytes, transcripts, or final results
  may remain diagnostic evidence, but cannot be projected into the assistant
  body or user-visible result summary.
- Skill usage can be inferred from transcript evidence and appended as run
  events.
- Chat's default process-details projection shows operator-meaningful thinking,
  tool activity, and failures without exposing empty provider lifecycle signals
  such as `reasoning started` / `reasoning completed` or Rudder's internal
  result-envelope delimiters. Those raw entries remain attached to the run for
  diagnostics and audit.
- Task sessions are updated or cleared after the run based on adapter result
  and session state.

Invariant:

- The operator must be able to inspect a run outcome without reading raw
  process logs only.
- Usage/session metadata must stay connected to the run that produced it.
- Transcript evidence and chat-visible assistant content are separate surfaces:
  reasoning/thinking evidence may be inspectable as transcript entries, but it
  must not become assistant message body text or a completed result summary.
- Internal lifecycle and result-protocol entries must not appear as user-facing
  Chat progress, and streamed protocol fragments must never be rendered as
  spaced or line-broken pseudo-content. Filtering the default projection must
  not delete the persisted raw evidence.
- A single provider reasoning item must not be duplicated merely because the
  provider emits both summary and raw notification streams. Stream selection
  remains item-scoped and deterministic across live and persisted transcript
  projection.
- Result projection must be monotonic with the accepted visible-output cutoff.
  Retries and recovery may fill missing terminal metadata, but cannot replace a
  stopped prefix with a later provider result.

Rationale:

- Rudder is a shared workspace. Agent execution is not trustworthy unless result,
  cost, transcript, and session evidence remain attached to the run.

Related code:

- `server/src/services/runtime-kernel/heartbeat.execute.ts`
- `server/src/services/heartbeat-run-summary.ts`
- `server/src/services/heartbeat-run-reference.ts`
- `server/src/routes/chats.stream-routes.ts`
- `server/src/services/chat-generation-protocol.ts`
- `ui/src/components/transcript/RunTranscriptView.chat.tsx`
- `packages/agent-runtimes/codex-local/src/server/app-server-chat.ts`
- `packages/agent-runtimes/codex-local/src/ui/parse-stdout.ts`
- `packages/agent-runtimes/codex-local/src/server/parse.ts`
- `packages/agent-runtimes/claude-local/src/server/parse.ts`

Related tests:

- `server/src/__tests__/heartbeat-run-summary.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `server/src/services/chat-generation-protocol.test.ts`
- `packages/agent-runtimes/codex-local/src/server/app-server-chat.test.ts`
- `packages/agent-runtimes/codex-local/src/server/parse.test.ts`
- `packages/agent-runtimes/claude-local/src/server/parse.test.ts`
- `tests/e2e/run-transcript-detail.spec.ts`
- `tests/e2e/chat-concurrent-streaming.spec.ts`
- `ui/src/components/transcript/RunTranscriptView.test.tsx`
- `tests/e2e/chat-transcript-internal-events.spec.ts`
