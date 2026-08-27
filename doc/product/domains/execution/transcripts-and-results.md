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
  - server/src/services/chats.ts
  - server/src/services/chats.helpers.ts
  - server/src/services/postgres-json.ts
  - server/src/services/run-events.ts
  - server/src/services/chat-inline-annotations.ts
  - packages/shared/src/chat-transcript-provenance.ts
  - ui/src/components/transcript/RunTranscriptView.common.tsx
  - ui/src/components/transcript/RunTranscriptView.normalize.tsx
  - ui/src/components/transcript/RunTranscriptView.tsx
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
  - ui/src/components/transcript/RunTranscriptView.semantic.tsx
  - ui/src/components/transcript/RunTranscriptView.rudder-mcp.tsx
  - ui/src/lib/transcript-skill-targets.ts
  - ui/src/lib/side-panel-targets.ts
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/Chat.tsx
related_tests:
  - packages/agent-runtimes/codex-local/src/server/app-server-chat.test.ts
  - server/src/__tests__/heartbeat-run-summary.test.ts
  - server/src/__tests__/chat-routes.test.ts
  - server/src/services/chat-generation-protocol.test.ts
  - server/src/services/postgres-json.test.ts
  - server/src/services/chat-inline-annotations.test.ts
  - packages/shared/src/chat-transcript-provenance.test.ts
  - tests/e2e/run-transcript-detail.spec.ts
  - tests/e2e/chat-concurrent-streaming.spec.ts
  - tests/e2e/chat-streaming.spec.ts
  - ui/src/components/transcript/RunTranscriptView.test.tsx
  - ui/src/components/transcript/RunTranscriptView.rudder-mcp.test.tsx
  - ui/src/components/transcript/RunTranscriptView.rudder-mcp.interaction.test.tsx
  - ui/src/lib/transcript-skill-targets.test.ts
  - ui/src/lib/side-panel-targets.test.ts
  - ui/src/pages/Chat.side-panel.skill-file.test.tsx
  - tests/e2e/chat-transcript-internal-events.spec.ts
related_plans:
  - doc/plans/2026-08-03-openclaw-hermes-runtime-compatibility-refresh.md
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
- Before transcript-derived structured evidence is persisted as generation
  events, Agent Run events, or message transcript state, Rudder
  deterministically replaces NUL characters with visible replacement
  characters. A provider tool result that contains NUL must not turn an
  otherwise valid run into a persistence failure, and normalization must retain
  colliding object fields instead of silently overwriting evidence.
- When a provider exposes readable summary and raw streams for the same
  reasoning item, the adapter projects at most one representation for that
  item. Streaming fragments retain delta semantics, raw-only reasoning remains
  inspectable when no summary stream exists, and multiple summary parts retain
  readable boundaries.
- Adapter result summary, result JSON, usage, cost, provider/model, session
  IDs, exit code, signal, log digest, and terminal error fields are persisted.
- External-runtime results additionally normalize the upstream runtime and
  version, Rudder adapter version, transport, negotiated protocol, capability
  snapshot hash, ownership/workspace binding, and opaque provider Run/session
  identifiers. A missing or unverified upstream version remains explicit in
  the result evidence and cannot be rendered as Supported.
- Provider tool, tool-result, approval-request, approval-decision, lifecycle,
  and cancellation events remain structured Run evidence. Cancellation records
  requested time, exact target, transport, provider acknowledgement, terminal
  state, timeout/fallback, and whether the visible-output cutoff preceded the
  request.
- Continuity evidence records `native_session` or
  `synthetic_tool_continuity`, the projection version, source transcript hash,
  event/token/byte bounds, redaction and deterministic compaction metadata,
  plus the final sanitized projection digest, immutable source-event versions,
  ordered inclusion/omission ranges, compaction outputs, and any `session_reset`
  or verified `provider_session_rebound` marker.
  Hermes's canonical Rudder transcript is authoritative for Rudder-originated
  work; a provider session ID alone is correlation evidence, not proof of
  history continuity. V1's synthetic projection bounds are 200 events, 64 KiB
  UTF-8 per event, 512 KiB UTF-8 aggregate, and a 32,000-token estimate.
- Event completeness is explicit: `complete`, `partial`, or `terminal_only`.
  An SSE disconnect, expired replay window, or unreconciled intermediate gap
  may preserve terminal status and final output while marking the event
  evidence `partial`; it must not be presented as lossless replay.
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
- For recognized built-in Rudder MCP tools with a registered presenter, Nice
  mode replaces the generic input/response disclosure with a typed semantic
  presenter derived only from structured result evidence. Presenter links must
  use structured identifiers,
  never reparsed display text. Collection presenters may reveal bounded local
  batches from the already-returned result without making another API or MCP
  request. Secret material is excluded from Nice presenters, malformed payloads
  fail closed to an unavailable state, and mutation receipts must not imply a
  stronger state transition than the structured response confirms. Raw mode,
  persisted evidence, and unsupported-tool presentation remain unchanged.
- Under `CHAT.RESPONSE.ANNOTATION.001`, an operator may deliberately quote
  already-loaded, visible assistant/thinking prose from a terminal generation.
  The quote retains its generation id plus inclusive generation-event sequence
  range. It becomes user-authored message context only through that explicit
  annotation action; the selected Process text remains Run evidence and is not
  promoted into assistant body or result summary.
- Under `CHAT.RESPONSE.ANNOTATION.001`, terminal Nice Transcript entries on an
  Agent Run may be staged as `agent_run_transcript` annotations. Admission
  revalidates organization, Agent, terminal Run status, visible source members,
  selected text, and source hash; synthetic client block labels are accepted
  only when they resolve unambiguously to persisted Run evidence.
- Consecutive completed tool activity is summarized as a compact semantic digest
  such as skills used, files read or edited, searches performed, and commands
  run. Expanding the digest reveals the individual structured actions and keeps
  command/tool request and response evidence available behind its own disclosure.
- Read and edit actions retain structured file targets from provider tool input.
  An absolute local target, or a relative target resolved against a recorded
  absolute `workdir` / `cwd`, is directly openable from the activity row. A
  relative target without that trusted execution root remains readable but is
  not treated as an openable file.
- Skill-use actions retain structured skill identities and trusted `SKILL.md`
  targets from the same provider evidence. When the identity resolves uniquely
  to the current organization Skill Library, the operator can open its
  `SKILL.md` read-only in the current Chat Side Panel; an exact trusted local
  path may use the Desktop local-file preview. Ambiguous or unresolved skill
  identities remain readable but are not guessed into an action.
- Hidden lifecycle entries still delimit adjacent streamed text groups in the
  readable projection. The projection preserves readable boundaries between a
  completed message and a later delta group, and its display limit counts
  visible entries rather than hidden lifecycle evidence.
- Task sessions are updated or cleared after the run based on adapter result
  and session state.

Invariant:

- The operator must be able to inspect a run outcome without reading raw
  process logs only.
- Usage/session metadata must stay connected to the run that produced it.
- External Run evidence must identify the exact upstream attempt and capability
  snapshot used, without exposing endpoint secrets, provider credentials, raw
  local paths, or unrestricted launch environment data.
- A provider acknowledgement of Stop is not a terminal cancellation, and a
  managed-process fallback is not provider-native cancellation. Result fields
  must preserve that distinction through restarts and reconciliation.
- `synthetic_tool_continuity` must never be labeled native or lossless. The
  source transcript hash, final sanitized projection digest, immutable source
  event versions, ordered inclusion/omission ranges, and compaction outputs
  must let an operator determine exactly what history was supplied to a later
  Hermes turn without exposing unredacted provider payloads.
- NUL characters in structured transcript evidence must not break run
  completion or detach transcript evidence. The normalized generation ledger,
  Agent Run event, and message transcript must remain attributable to the same
  run and conversation.
- Transcript evidence and chat-visible assistant content are separate surfaces:
  reasoning/thinking evidence may be inspectable as transcript entries, but it
  must not become assistant message body text or a completed result summary.
- Internal lifecycle and result-protocol entries must not appear as user-facing
  Chat progress, and streamed protocol fragments must never be rendered as
  spaced or line-broken pseudo-content. Filtering the default projection must
  not delete the persisted raw evidence.
- Removing lifecycle evidence from the readable projection must not collapse
  independently emitted assistant messages or consume the visible-entry limit.
- A single provider reasoning item must not be duplicated merely because the
  provider emits both summary and raw notification streams. Stream selection
  remains item-scoped and deterministic across live and persisted transcript
  projection.
- Result projection must be monotonic with the accepted visible-output cutoff.
  Retries and recovery may fill missing terminal metadata, but cannot replace a
  stopped prefix with a later provider result.
- Readable activity summaries, expanded rows, and file actions must be derived
  from the same structured transcript evidence; rendered prose must never be
  reparsed to guess a path. Live and persisted transcripts must project the same
  semantic actions.
- Skill Side Panel actions must be derived from structured skill identity or
  trusted path evidence, never from reparsing the rendered `Use … skill` label,
  and inspection must not grant edit authority or change skill selection.
- A Process annotation may address only one visible prose block. It cannot use
  transcript-array index or timestamp as identity, cross hidden/tool/lifecycle
  evidence, or make otherwise hidden reasoning visible. Provenance survives
  normalization by merging only compatible contiguous generation-event ranges.

Rationale:

- Rudder is a shared workspace. Agent execution is not trustworthy unless result,
  cost, transcript, and session evidence remain attached to the run.

Related code:

- `server/src/services/runtime-kernel/heartbeat.execute.ts`
- `server/src/services/heartbeat-run-summary.ts`
- `server/src/services/heartbeat-run-reference.ts`
- `server/src/routes/chats.stream-routes.ts`
- `server/src/services/chat-generation-protocol.ts`
- `server/src/services/chats.ts`
- `server/src/services/chats.helpers.ts`
- `server/src/services/postgres-json.ts`
- `server/src/services/run-events.ts`
- `server/src/services/chat-inline-annotations.ts`
- `packages/shared/src/chat-transcript-provenance.ts`
- `ui/src/components/transcript/RunTranscriptView.common.tsx`
- `ui/src/components/transcript/RunTranscriptView.normalize.tsx`
- `ui/src/components/transcript/RunTranscriptView.tsx`
- `ui/src/components/transcript/RunTranscriptView.chat.tsx`
- `ui/src/components/transcript/RunTranscriptView.semantic.tsx`
- `ui/src/lib/transcript-skill-targets.ts`
- `ui/src/lib/side-panel-targets.ts`
- `ui/src/pages/Chat.side-panel.tsx`
- `ui/src/pages/Chat.tsx`
- `packages/agent-runtimes/codex-local/src/server/app-server-chat.ts`
- `packages/agent-runtimes/codex-local/src/ui/parse-stdout.ts`
- `packages/agent-runtimes/codex-local/src/server/parse.ts`
- `packages/agent-runtimes/claude-local/src/server/parse.ts`

Related tests:

- `server/src/__tests__/heartbeat-run-summary.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `server/src/services/chat-generation-protocol.test.ts`
- `server/src/services/postgres-json.test.ts`
- `server/src/services/chat-inline-annotations.test.ts`
- `packages/shared/src/chat-transcript-provenance.test.ts`
- `packages/agent-runtimes/codex-local/src/server/app-server-chat.test.ts`
- `packages/agent-runtimes/codex-local/src/server/parse.test.ts`
- `packages/agent-runtimes/claude-local/src/server/parse.test.ts`
- `tests/e2e/run-transcript-detail.spec.ts`
- `tests/e2e/chat-concurrent-streaming.spec.ts`
- `tests/e2e/chat-streaming.spec.ts`
- `ui/src/components/transcript/RunTranscriptView.test.tsx`
- `ui/src/lib/transcript-skill-targets.test.ts`
- `ui/src/lib/side-panel-targets.test.ts`
- `ui/src/pages/Chat.side-panel.skill-file.test.tsx`
- `ui/src/components/transcript/TranscriptLocalFilePreview.test.tsx`
- `tests/e2e/chat-transcript-internal-events.spec.ts`
- `tests/e2e/chat-response-annotations.spec.ts`

External-runtime result E2E must also prove capability/version evidence,
provider Run/session and approval/cancellation normalization, SSE-gap
`partial` marking, Hermes canonical transcript hashes, bounded
`RUDDER_TOOL_CONTEXT_V1` projection, redaction, and refusal of unsafe or
over-budget continuity input.
