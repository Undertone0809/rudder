---
title: Transcripts And Results
domain: execution
status: active
coverage: seed
contract_ids:
  - RUN.RESULT.001
related_code:
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/heartbeat-run-summary.ts
  - server/src/services/heartbeat-run-reference.ts
  - ui/src/components/transcript/RunTranscriptView.normalize.tsx
  - ui/src/components/transcript/RunTranscriptView.blocks.tsx
related_tests:
  - server/src/__tests__/heartbeat-run-summary.test.ts
  - tests/e2e/run-transcript-detail.spec.ts
  - ui/src/components/transcript/RunTranscriptView.test.tsx
  - ui/src/components/transcript/RunTranscriptView.blocks.test.tsx
  - tests/e2e/ui-lab.spec.ts
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
- In the operator-friendly transcript presentation, a file-change start marker
  followed directly by its completed or failed evidence in the same turn is
  presented as one lifecycle row. A start marker without terminal evidence
  remains visible as running, and an unrelated intervening transcript block
  prevents the later event from being merged into that stale activity.
- A completed file-change row shows the operation and target summary first and
  keeps the raw event evidence available through disclosure.
- Adapter result summary, result JSON, usage, cost, provider/model, session
  IDs, exit code, signal, log digest, and terminal error fields are persisted.
- Adapter result summary is user-visible assistant output from a completed
  runtime turn. Incomplete, stopped, aborted, or failed streams may preserve
  transcript evidence, including thinking/reasoning entries, but must not
  promote provider reasoning, scratchpad text, or partial progress events into
  the final result summary.
- Skill usage can be inferred from transcript evidence and appended as run
  events.
- Task sessions are updated or cleared after the run based on adapter result
  and session state.

Invariant:

- The operator must be able to inspect a run outcome without reading raw
  process logs only.
- Usage/session metadata must stay connected to the run that produced it.
- Transcript evidence and chat-visible assistant content are separate surfaces:
  reasoning/thinking evidence may be inspectable as transcript entries, but it
  must not become assistant message body text or a completed result summary.
- Once terminal file-change evidence exists, the same lifecycle must not remain
  visible as separate running and completed rows. Unmatched running activity
  must not be erased or reordered to achieve that deduplication.

Rationale:

- Rudder is a control plane. Agent execution is not trustworthy unless result,
  cost, transcript, and session evidence remain attached to the run.
- Lifecycle coalescing prevents operators from double-counting one action while
  preserving both live progress and inspectable evidence.

Related code:

- `server/src/services/runtime-kernel/heartbeat.execute.ts`
- `server/src/services/heartbeat-run-summary.ts`
- `server/src/services/heartbeat-run-reference.ts`
- `packages/agent-runtimes/codex-local/src/server/parse.ts`
- `packages/agent-runtimes/claude-local/src/server/parse.ts`
- `packages/agent-runtimes/codex-local/src/ui/parse-stdout.ts`
- `ui/src/components/transcript/RunTranscriptView.normalize.tsx`
- `ui/src/components/transcript/RunTranscriptView.blocks.tsx`

Related tests:

- `server/src/__tests__/heartbeat-run-summary.test.ts`
- `packages/agent-runtimes/codex-local/src/server/parse.test.ts`
- `packages/agent-runtimes/claude-local/src/server/parse.test.ts`
- `tests/e2e/run-transcript-detail.spec.ts`
- `ui/src/components/transcript/RunTranscriptView.test.tsx`
- `ui/src/components/transcript/RunTranscriptView.blocks.test.tsx`
- `tests/e2e/ui-lab.spec.ts`
