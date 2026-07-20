---
title: Reliable Chat Steer And Immediate Stop
date: 2026-07-15
kind: proposal
status: in_progress
area: chat
entities:
  - messenger_chat
  - chat_steer
  - runtime_control
  - running_queue
issue:
related_plans:
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-05-07-chat-run-progress-recovery.md
supersedes:
  - 2026-06-01-chat-running-queue-steer.md
related_code:
  - packages/agent-runtime-utils/src/types.ts
  - packages/agent-runtime-utils/src/server-utils.cli.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/chat-generation-locks.ts
  - server/src/services/chats.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - ui/src/pages/Chat.tsx
  - tests/e2e/chat-concurrent-streaming.spec.ts
commit_refs: []
updated_at: 2026-07-15
---

# Reliable Chat Steer And Immediate Stop

## Overview

Rudder must treat Steer and Stop as first-class controls over an active agent
turn, not as UI labels over a fire-and-forget CLI process.

This proposal replaces the completed June 1 design that deliberately made
Steer unsupported and parked queued input after Stop. That behavior conflicts
with the interaction the UI advertises and with the operator's need to correct
running work before it spends more time or causes more side effects.

The selected design introduces one server-owned control path for each active
chat generation:

- native mid-turn steer when the runtime supports it;
- an automatic interrupt-and-continue fallback when it does not;
- an immediate, persisted output cutoff when Stop is accepted;
- server-owned continuation delivery with exactly-once claims where provider
  receipt is known, plus an explicit non-duplicating ambiguity state where it
  is not;
- terminal events that replace client timers and browser-owned queue draining.

Codex chat turns will use Codex App Server rather than `codex exec --json` so
Rudder can call the documented `turn/steer` and `turn/interrupt` methods. Issue
and heartbeat execution may continue using `codex exec` because they do not
need an interactive turn control channel.

## What Is The Problem?

### 1. The Steer affordance cannot steer

The Steer route currently returns `unsupported` without contacting the active
runtime. The runtime adapter contract exposes execution and an abort signal but
does not expose a control handle, provider thread id, turn id, or runtime
capability. Codex chat runs use the non-interactive `codex exec --json` surface,
whose stdin is closed after the initial prompt.

The resulting product behavior is internally contradictory:

- the UI shows a Steer action only while a run is active;
- clicking it produces a warning that the runtime cannot accept steering;
- the input returns to `Still queued` even though the operator explicitly
  asked for it to affect current work;
- the current E2E test treats this failure as the expected result.

The official Codex App Server contract provides the missing semantics:
`turn/steer` appends input to the active in-flight turn, requires a matching
`expectedTurnId`, and returns that same turn id without starting a new turn.

### 2. Stop does not establish a visible-output boundary

Stop currently changes the durable generation status before the runtime owner,
child process, message stream, and run have reached one terminal state. Output
callbacks can continue to append and persist content during process shutdown.
The chat assistant then flushes accumulated progress as one `assistant_delta`
after the process exits. Distinct progress messages are concatenated without
separators.

The UI optimistically hides the stream, aborts its reader, waits a fixed 400 ms,
and reloads the message. It therefore replaces the ordered progress view with
one large stopped assistant bubble containing previously separate progress
entries. This is the observed post-stop response scramble.

Legacy CLI termination also waits a long grace period before force-killing the
child, continues consuming stdout after abort, and waits for queued log writes.
That is a separate source of worst-case stop latency even when the HTTP stop
request itself is fast.

### 3. Submitted operator intent can be stranded

Queue execution is owned by a React effect in the open browser page. The server
explicitly refuses to claim queued work after a stopped or failed generation.
Closing the page, navigating away, stopping after steering, or losing a race
between the DB generation state and the in-memory lock can leave input queued
forever.

One live incident demonstrated all three failures in the same conversation:
the steer item had two delivery attempts, both marked `unsupported`, stayed
queued, and the stopped assistant bubble was replaced with concatenated prior
progress.

### Root diagnosis

This is primarily an engineering architecture and correctness failure, with a
secondary interaction-contract failure. Rudder has an execution API but no
linearizable control protocol for an active turn. Local UI patches cannot make
Steer truthful or make Stop deterministic while runtime control, output
admission, persistence, and queue delivery have different owners.

## First-Principles Contract

The implementation must preserve these invariants:

1. **Operator intent is never silently stranded or duplicated.** Every
   submitted feedback item reaches a durable disposition: provider-confirmed
   current-turn receipt, a durably scheduled continuation, or an actionable
   `acceptance_unknown` state when Rudder cannot prove whether a native provider
   accepted it. Ambiguity must never trigger a blind duplicate continuation.
2. **Steer is semantic, not provider-specific.** Clicking Steer means "apply
   this feedback to the work now." Native runtimes inject it into the active
   turn. Other runtimes interrupt and automatically continue with the feedback.
3. **Stop has a linearization point.** Once Stop is accepted, the visible reply
   has an immutable prefix. Later provider bytes cannot change the chat body,
   result summary, or chat-visible narration. Real files and side effects remain
   inspectable as explicitly flagged post-stop production evidence.
4. **The server owns active-turn control.** A browser may render state and send
   commands, but it does not own queue execution or terminal reconciliation.
5. **One active owner per conversation.** A continuation cannot start until the
   prior runtime control handle is terminal and disposed.
6. **Every control outcome is honest.** The API reports `delivered_current`,
   `scheduled_next`, `acceptance_unknown`, or an actionable terminal failure.
   Provider receipt is not described as model compliance, and success is never
   inferred only from transcript text or a queued row.
7. **Progress keeps its structure.** Commentary, tool activity, and raw output
   remain ordered transcript entries. Stop never promotes them wholesale into
   an assistant message body.
8. **Runtime differences remain explicit.** Native steer/interrupt capability
   is bound to the actual active runtime attempt, including fallback attempts,
   rather than inferred from the configured primary adapter.

## Options Considered

### Option A: UI and callback patch only

Suppress the terminal bulk delta, ignore callbacks after `abortSignal.aborted`,
and remove the warning toast.

This would reduce the visible scramble quickly, but Steer would remain fake,
queue delivery would still depend on the browser, and stop/steer races would
still lose or duplicate intent. Rejected as an incomplete local fix.

### Option B: Keep `codex exec` and restart on every Steer

Treat all Steer actions as Stop followed by a new `codex exec resume` call.

This can approximate feedback for Codex but discards Codex's actual active-turn
control API, increases interruption and context-rebuild cost, and cannot prove
that feedback joined the same turn. It remains the fallback behavior for
non-steerable adapters, not the primary Codex design.

### Option C: Server-owned generation actor with native runtime controls

Give the server one generation actor/control mailbox, expose a runtime control
handle, use Codex App Server for interactive chat turns, establish an output
cutoff, and move continuation delivery to the server.

This is the selected option. It changes the upstream ownership model that
causes all three failures and makes the user-visible claims testable.

## What Will Be Changed?

### Runtime control contract

Extend the runtime execution context so the active attempt can register a
`RuntimeControlHandle`:

```ts
type RuntimeControlHandle = {
  runtimeType: string;
  providerThreadId?: string;
  providerTurnId?: string;
  capabilities: {
    steer: "native" | "interrupt_continue";
    interrupt: "native" | "process" | "remote";
  };
  steer(input: RuntimeControlInput): Promise<RuntimeSteerResult>;
  interrupt(reason: "operator_stop" | "steer_fallback"): Promise<
    "acknowledged" | "waiting_safe_boundary" | "unverified"
  >;
  dispose(): Promise<void>;
};
```

Registration returns an attempt-bound lease identified by
`generationId + attemptEpoch + ownerToken`. Control operations validate the
lease before and after awaiting provider I/O. Starting a runtime-chain fallback
atomically invalidates and idempotently disposes the prior lease before
publishing the next one, so a late provider acknowledgement cannot steer or
terminalize a newer attempt. Steer received while no handle is ready remains
durably pending. Restarted servers mark orphaned leases `control_lost` and
reconcile them rather than reconstructing an in-memory capability claim.

The generation owner installs a startup abort/process-group disposer before
spawn begins, so Stop works during command resolution, process spawn,
`initialize`, `thread/start`, and `turn/start`, before a provider turn id exists.
Control-handle publication is a fenced compare-and-set against the still-active
generation/attempt; a handle that becomes ready after cutoff is rejected and
disposed before it can emit or accept control. Barrier tests stop at every
startup phase and prove no late lease publication or output crosses the cutoff.

### Codex interactive chat transport

For chat scene execution, the Codex adapter will:

1. launch and initialize a Codex App Server connection;
2. start or resume the provider thread associated with the Rudder chat session;
3. call `turn/start` with the current chat prompt;
4. retain `threadId` and `turnId` in the active control handle;
5. translate App Server notifications into the existing normalized log and
   transcript events;
6. call `turn/steer` with `expectedTurnId` for native steer;
7. call `turn/interrupt` for Stop;
8. wait for `turn/completed`, then dispose the connection deterministically.

Existing `codex exec` execution remains available for non-chat runs.

App Server is a bidirectional JSON-RPC protocol, not a stdout event feed. The
client therefore needs a pending-request registry and an exhaustive
server-request handler matrix before it can carry production chat traffic:

| Generated App Server method | Rudder handling, including Stop |
| --- | --- |
| `item/commandExecution/requestApproval` | apply current Rudder command policy; explicitly reject/cancel if Stop wins |
| `item/fileChange/requestApproval` | apply current Rudder file policy; explicitly reject/cancel if Stop wins |
| `item/tool/requestUserInput` | persist/surface chat ask-user; cancel the prompt if Stop wins |
| `mcpServer/elicitation/request` | use governed elicitation or explicit unsupported rejection; cancel on Stop |
| `item/permissions/requestApproval` | route through permission policy and explicit decision; reject on Stop |
| `item/tool/call` | dispatch only through the attempt's registered managed tool surface; fence/cancel on Stop |
| `account/chatgptAuthTokens/refresh` | use isolated runtime credentials or fail actionably; abort refresh wait on Stop |
| `attestation/generate` | keep capability disabled until an attestation implementation and Stop semantics exist |
| `applyPatchApproval` | support the legacy approval method explicitly or reject; never silently ignore; reject on Stop |
| `execCommandApproval` | support the legacy approval method explicitly or reject; never silently ignore; reject on Stop |
| unknown generated/runtime method | return JSON-RPC `-32601`, close the capability gate, and fail the attempt |

The generated `ServerRequest` union is consumed through a compile-time
exhaustive switch; schema-version CI fails when a new member lacks a handler.
Every inbound request has a bounded timeout and exactly one response. Stop first
settles pending requests through their defined cancellation or rejection path,
then sends `turn/interrupt`. Interrupt RPC acknowledgement,
`turn/completed(interrupted)`, provider process exit, and handle disposal are
four distinct milestones and must not be collapsed into one `stopped` boolean.

The transport stays behind an internal capability gate until it passes this
parity matrix against the existing `codex exec` chat path:

| Concern | Required App Server parity |
| --- | --- |
| isolated operator and agent homes | launch with the same derived `HOME`, `CODEX_HOME`, credential shims, and protected-env filtering |
| workspace and Git identity | preserve resolved cwd, repo safety check, author/committer env, and session cwd guard |
| model and effort | map the resolved model and reasoning effort into generated thread/turn protocol fields |
| access and approvals | map normal approval policy and `read-only` / `workspace-write`; map bypass only to `never` plus `danger-full-access` |
| Rudder MCP, JWT, Browser, and dynamic tools | install the same isolated managed config and prove each tool surface through protocol tests |
| instructions and skills | preserve the assembled instruction, skill-boundary, bootstrap, handoff, and chat prompt ordering |
| attachments and search | preserve image attachment transport and the resolved web-search setting, or keep the gate closed with an explicit unsupported reason |
| custom command and extra arguments | map every supported semantic option; reject command/argument combinations that App Server cannot represent instead of silently dropping them |
| timeout and interrupt grace | retain normal timeout behavior while applying the separate bounded operator-interrupt deadline |
| session and usage | persist provider thread id before starting a turn; calculate per-turn usage from a baseline rather than cumulative thread totals |
| transcript and result | normalize agent message, reasoning, command, file change, MCP/tool, approval, user-input, usage, and terminal events without mixing attempts or replaying provider items |
| billing metadata | preserve input, cached-input, output, reasoning usage plus provider, biller, billing type, estimated cost, and fallback/resume accounting |

Unknown provider threads, cwd mismatch, or an unavailable resume target use the
same explicit fresh-thread fallback contract as the existing adapter. Each
attempt has its own accumulator and usage baseline, so partial output or
cumulative tokens from a failed primary attempt cannot leak into a fallback
attempt's final result.

Normalized reducer identity includes provider thread id, turn id, item id,
channel, source ordinal/offset, generation id, and attempt epoch. Deltas are
deduplicated by identity/offset. A later `item/completed` full snapshot
reconciles the existing item projection; it is never appended as new text.
Duplicate, reordered, delta-plus-completed, and reconnect replay notifications
must converge to the same body and transcript hash.

### Generation actor and control mailbox

Replace the abort-controller-only lock entry with a generation actor keyed by
generation id. It owns:

- the current runtime control handle;
- lifecycle state (`starting`, `running`, `stopping`, `terminal`);
- a serialized command mailbox for Steer and Stop;
- a monotonic visible event sequence;
- the accepted output cutoff;
- terminal acknowledgement;
- continuation handoff.

The actor is one fenced reducer, not a mutex held across provider calls. Stop,
Steer, runtime output, provider steer acknowledgement, `turn/completed`,
process exit, and terminal projector acknowledgement all carry
`generationId + attemptEpoch + ownerToken` and must pass the same reducer before
changing state. A Stop transaction cannot wait behind an in-flight steer RPC;
it records its local linearization point and launches interrupt as an async
effect.

`chat_control_actions` durably stores one organization-scoped row per
`controlActionId` with expected generation/attempt, control version, requested
action, local disposition, provider evidence, and timestamps. The reducer locks
the generation row (`FOR UPDATE` or equivalent compare-and-set), advances
`controlVersion`, and appends events before scheduling effects. Stop and Steer
are idempotent inside Rudder; provider idempotency is not assumed. Commands for
a stale generation do not retarget or drop input: Steer is reconciled against
durable provider evidence before it can transfer to a continuation; Stop
returns the already-known action outcome.

A steer acknowledgement that arrives after Stop is resolved by evidence, not
arrival order: positive same-turn receipt becomes `accepted_current`, explicit
provider rejection becomes `continuation_pending`, and an unknowable outcome
becomes `acceptance_unknown`. Late callbacks from an invalid lease may append
marked diagnostic evidence but cannot update the active projection or terminal
state.

### Output cutoff and persistence

Every chat-visible runtime event receives a monotonically increasing
`generationSeq`. The mandatory source is an append-only
`chat_generation_events` ledger with a unique
`(generation_id, generation_seq)` key, attempt epoch, event kind, normalized
payload, body offset/length where applicable, and links to the assistant
message and Agent Run. An event is committed before it is emitted to SSE. The
current assistant body and transcript are projections of this ledger, not the
only copy of mutable full JSON. Bounded checkpoints accelerate reconstruction;
ordered ledger deltas remain the correctness source.

The Stop request includes `controlActionId`, `expectedGenerationId`,
`expectedAttemptEpoch`, the last DOM-committed render sequence, and the hash of
the rendered raw Markdown. React advances the committed render sequence from a
post-commit `useLayoutEffect`, not when a network event is parsed. In one
generation-locked transaction the server validates the attempt, reconstructs
and verifies the prefix, compare-and-sets the control version, persists the
control action, cutoff, frozen projection, and `stop_requested` event, then
closes chat-visible output admission. Only after that commit does it signal the
runtime. Missing proof uses the last durable client checkpoint. A stale
generation/attempt is never retargeted to the latest run. Fallback Steer uses
this identical cutoff protocol.

After each post-commit render, the client sends a bounded/debounced checkpoint
acknowledgement containing `generationId`, `attemptEpoch`, sequence, and raw
Markdown hash. The server monotonic-CAS persists it against the expected
generation/attempt, rejects a hash/payload mismatch, and returns the accepted
checkpoint. Stop synchronously carries the newest checkpoint so it does not
wait for the debounce. Lost or stale acknowledgement never retargets another
generation and only reduces the fallback to the prior server-acknowledged
checkpoint.

After the cutoff:

- callbacks may append bounded raw diagnostic evidence only;
- no callback may update assistant body, visible transcript narration, or
  result summary, and only the serialized generation actor may reconcile
  message/run/generation terminal state;
- files, external effects, and other durable production evidence discovered
  after the cutoff remain inspectable in the Work manifest with
  `observedAfterStop` evidence; freezing narration must not erase real effects;
- `lateEventsDropped` and `lateBytes` are recorded for diagnostics;
- terminal reconciliation cannot flush accumulated commentary as a final
  assistant delta.

The durable generation records the cutoff sequence, stop request time, frozen
body hash, last client-acknowledged checkpoint, and terminal timestamps.
Transcript persistence should append or
batch events rather than rewrite the complete multi-megabyte transcript for
every callback; this performance change may be staged, but the stop path must
not wait on an unbounded transcript write backlog.

### Steer state machine

Queue items retain the operator's delivery intent and transition with compare-
and-swap semantics:

```text
queued
  -> steer_pending
      -> accepted_current -> delivered
      -> acceptance_unknown -> reconciled_current | continuation_pending | failed_actionable
      -> continuation_pending -> running_next -> delivered
      -> failed_actionable
  -> cancelled
```

For a native-steer runtime, the server calls the active handle with a persisted
provider client message id and marks the item `accepted_current` only after the
provider acknowledges the same thread and turn id. The queue row remains as
durable evidence and the operator intervention remains inspectable in the chat
and run transcript, including if a later Stop interrupts the turn. The UI says
`Delivered to current run`, not `Applied`, because receipt does not prove model
compliance.

If the request times out or the connection drops after send, the item becomes
`acceptance_unknown`. Reconciliation uses `thread/read(includeTurns)` and the
provider thread/turn/client message ids to look for the corresponding user
item. Rudder schedules a continuation only when it can prove the native message
was not accepted. If the installed provider version cannot make that proof, the
state remains actionable and no automatic duplicate is sent. A version-pinned
conformance test is required before claiming provider-level idempotency.

For an adapter without native steer, or when the native turn is provably already
closing, the server atomically marks `continuation_pending`, applies the output
cutoff, requests an interrupt with reason `steer_fallback`, and starts the
continuation after the old owner is terminal. The same queue item id is the
Rudder claim/idempotency key; it is not assumed to be a provider deduplication
key.

Fallback interruption has a side-effect safety gate. If a governed or
non-idempotent external action is in flight, the handle may return
`waiting_safe_boundary` and the UI reports that state. If termination or action
outcome is `unverified`, the old run becomes `interrupted_unverified`, the
continuation does not blindly replay, and Rudder requires reconciliation or an
operator decision. Tests must prove that an external mutation cannot execute
twice across fallback Steer.

### Stop/Steer race rule

The generation actor serializes both commands. Only two outcomes are legal:

- Steer linearizes first and the active provider acknowledges it: the item is
  `accepted_current`; a later Stop may interrupt that turn.
- Stop or turn closure linearizes first: the item is
  `continuation_pending` and runs exactly once after terminal cleanup.

If provider receipt cannot be proven, `acceptance_unknown` is the third honest
Rudder disposition. It is not a delivery outcome and cannot be silently
converted into a continuation.

`unsupported`, `stale_generation`, and `closing` are internal routing facts,
not user-visible failures and not terminal queue states.

### Server-owned continuation

Terminal generation reconciliation will claim the next eligible continuation
on the server. It is organization-scoped, conversation-scoped, FIFO within the
same priority, lease-based, and idempotent. The existing React auto-dequeue
effect will be removed.

The lease is fenced by token, epoch, and owner, not only an expiry timestamp.
Renewal, continuation binding, provider start, and terminal updates all compare
and swap the current fence so a reclaimed old worker cannot keep acting. One
conversation-scoped transaction uniquely binds the source queue item,
continuation user message, and continuation generation before any provider I/O.
Database uniqueness prevents a second binding for the same source item or more
than one nonterminal generation for the conversation. Provider-start ambiguity
becomes `acceptance_unknown`; it is never blindly retried.

Steer continuations have explicit priority over ordinary `Up next` queue items;
FIFO applies within each intent class. This priority cannot reorder ordinary
queue items relative to one another.

Closing the page, changing chats, losing the network connection, or restarting
the Desktop shell must not strand accepted input. On server startup, a bounded
reconciler repairs expired claims and advances `continuation_pending` items
whose prior generation is terminal.

Continuation and projector workers also run continuously. They claim work with
token/epoch fencing (and `SKIP LOCKED` where supported), renew leases, retry
with bounded exponential backoff, and periodically sweep expired claims during
normal uptime as well as startup. Exhausted retries become durable
`failed_actionable`; a worker exception never leaves silent parked work until
the next restart.

Terminal eligibility is explicit:

| Prior terminal reason | Ordinary Queue | Targeted Steer continuation |
| --- | --- | --- |
| `completed` | eligible in FIFO order | eligible, with the targeted continuation first |
| `steer_fallback` | retained behind the targeted steer item | eligible only after verified old-owner termination |
| `operator_stop` | retained and editable | an already committed continuation remains visible and cancellable; it does not start without its recorded steer-fallback disposition |
| `failed` or `unknown` | retained and editable | `failed_actionable` unless reconciliation proves it safe |
| `interrupted_unverified` | retained and editable | blocked pending side-effect/runtime reconciliation |

The two-second continuation SLO applies only to an eligible
`continuation_pending` steer item. It never causes Stop to start ordinary queued
work.

### Terminal projector and outbox

The generation row plus append-only event ledger are the authoritative terminal
source. A versioned, idempotent terminal projector consumes the outbox and
converges the assistant message, Agent Run, generation, queue/control item, and
terminal notification. The projector owns the transition
`stop_requested -> stopping -> stopped`; route handlers and late provider
callbacks do not independently terminalize linked records.

Every terminal projection stores the linked ids and expected versions, can be
replayed after a crash, and emits a versioned terminal event only after durable
projection. Clients use that event for the fast path and query the authoritative
projection after reconnect. `control_lost`, `acceptance_unknown`, and
`cancellation_unverified` remain distinct durable states until reconciled.
The authoritative event/state transition and its outbox enqueue occur in the
same database transaction, eliminating a crash gap between terminal truth and
projector discovery.

### UI behavior

- The composer remains usable during an active reply.
- Sending normally creates `Up next`; choosing Steer creates
  `Applying feedback` without a warning toast.
- Native acknowledgement resolves to `Delivered to current run`; the
  intervention stays inspectable even after leaving the actionable queue.
- Fallback shows `Restarting with feedback`, then
  `Running feedback continuation`. The old run is labeled
  `Interrupted for feedback`, distinct from an operator Stop.
- Stop is labeled `Stop current reply`, synchronously freezes the currently
  rendered prefix, and progresses through `Output frozen; stopping runtime` to
  a terminal state. When a continuation is pending, an explicit cancel action
  such as `Stop all` is available rather than overloading Stop.
- A failed or unverifiable termination remains honest: `Stop not confirmed -
  retry` or `Runtime termination unverified`. The frozen output never reopens,
  but Rudder does not claim `Stopped` without terminal proof.
- Before network I/O, the renderer durably stores a bounded, conversation-scoped
  pending Stop record with `controlActionId`, generation/attempt, raw Markdown
  snapshot, DOM-committed sequence, and hash. On reload/reconnect it renders
  that frozen snapshot first and replays the same idempotent Stop action before
  admitting later output for that generation. The record clears only after a
  durable server disposition or an explicit operator resolution. Storage uses
  the same local privacy boundary as existing chat drafts and is removed after
  reconciliation.
- The composer becomes ready from that terminal event, not a 400 ms timer.
- Stop affects the current reply only. It does not delete submitted follow-ups.
  Queue-item deletion remains an explicit separate action.
- The stopped reply preserves the same ordered content before and after reload;
  commentary remains commentary rather than becoming one giant bubble.

## Success Criteria For Change

### Correctness

- A Codex Steer is delivered to the same active provider turn and returns the
  same turn id; no warning toast is shown and the UI does not claim the model
  already acted on it.
- A non-native Steer automatically interrupts and continues exactly once.
- No eligible `continuation_pending` steer item with no active owner remains
  unclaimed for more than two seconds unless it is explicitly cancelled,
  `acceptance_unknown`, `interrupted_unverified`, or `failed_actionable`.
- Stop, reload, and Desktop restart preserve the exact same assistant body
  prefix and ordered transcript entries.
- User-visible events admitted after the stop cutoff: exactly zero.
- Duplicate or reordered steer/continuation delivery: exactly zero in every
  state where provider receipt is known; ambiguous receipt must stop in
  `acceptance_unknown` rather than risk a duplicate.

### Latency service levels

Measure on the supported local Desktop reference machine with at least 100
measured runs per p99 scenario after warm-up. Record Desktop build, OS,
hardware, runtime, and Codex version, and record each boundary separately:

- click to DOM freeze after Stop: hard ceiling 100 ms;
- server receipt to durable cutoff disposition: p95 at most 250 ms, p99 at most
  500 ms;
- interrupt request to native provider acknowledgement: p95 at most 500 ms;
- interrupt request to local process-tree death: p95 at most one second, hard
  ceiling two seconds;
- server receipt to terminal stopped state visible and persisted: p95 at most
  750 ms, p99 at
  most 1.5 seconds;
- server receipt to durable Steer disposition: p95 at most 300 ms, p99 at most
  750 ms;
- provider request to native receipt: p95 at most 500 ms;
- verified terminal cleanup to eligible continuation claim: hard ceiling 500
  ms, and to continuation start p95 at most one second.

Zero post-cutoff user-visible events and the two-second local process-tree
deadline are hard correctness ceilings, not percentile targets.

## Out Of Scope

- Converting issue or heartbeat runs to Codex App Server.
- Claiming native steer parity for providers without a verified interactive API.
- A general distributed job queue for all Rudder work types.
- Redesigning the full transcript storage model beyond the batching/bounding
  needed to keep control actions responsive.
- Deleting queued follow-ups as an implicit side effect of Stop.
- Inferring whether ordinary queued text should be Steer; the user action stays
  explicit.

## Non-Functional Requirements

### Performance

Control commands must bypass transcript write backlogs and must not wait for a
provider process to exit before the visible cutoff is acknowledged. Large
production-shaped transcripts (250 entries and 5-10 MB) must meet the same
visible control SLOs.

### Reliability

Control commands are idempotent. Generation, message, run, queue item, and
provider turn terminal transitions must converge after client disconnect or
server restart.

### Security

Control routes keep the existing organization and local-mutation checks. A
control handle is addressable only through its owning conversation and
generation. Provider ids are evidence, not authorization. App Server launches
inside the same workspace, sandbox, approval, and managed-home boundaries as
the existing Codex adapter.

### Maintainability

Provider protocol translation remains inside the runtime adapter. Generic chat
services depend only on the runtime control interface and normalized events.
The state machine and race outcomes must be expressed in types and tests rather
than inferred from UI timing.

### Observability

Structured control telemetry records `controlActionId`, generation id, run id,
queue item id, provider thread/turn ids, event sequence, and:

- `stopReceivedAt`, `cutoffSeq`, `interruptSentAt`, `interruptAckAt`,
  `childExitAt`;
- `messageTerminalAt`, `runTerminalAt`, `generationTerminalAt`;
- `steerReceivedAt`, `steerPendingAt`, `steerAckAt`,
  `fallbackScheduledAt`;
- `lateEventsDropped`, `lateBytes`, transcript bytes/entry count, persistence
  duration, and log backlog depth.

Client telemetry records click, HTTP acknowledgement, terminal event, and
composer-ready timestamps using the same control action id.

## User Experience Walkthrough

### Native Codex steer

1. The agent is working and progress remains visible.
2. The operator types corrective feedback and clicks Steer.
3. The row shows `Delivering feedback` while Rudder calls `turn/steer`.
4. Codex acknowledges the existing turn id.
5. The row resolves to `Delivered to current run` without an error. The
   intervention stays inspectable; whether the model changes direction is
   verified behavior, not status copy.

### Fallback steer

1. The active adapter cannot inject mid-turn input.
2. The operator clicks Steer.
3. Rudder records the feedback, freezes/interrupts the current reply, waits for
   its owner to terminate, and automatically starts the continuation.
4. The old run reads `Interrupted for feedback`; the row shows
   `Restarting with feedback`, then `Running feedback continuation`.
5. The operator never has to resend the message or keep the page open.

### Stop

1. The operator clicks Stop during text, tool activity, or a long-running child
   process.
2. The visible reply freezes in the same frame and the control shows
   `Output frozen; stopping runtime`.
3. The server persists the cutoff and interrupts the provider/process.
4. Verified terminal evidence changes the label to `Stopped` and re-enables the
   normal composer state. A failed or unverifiable termination instead shows a
   retryable/unverified state without reopening the frozen output.
5. Reloading shows the same prefix and ordering. Pending follow-ups remain
   available and are not silently deleted.

## Implementation

### Delivery slices

1. **Cutoff correctness first.** Add generation sequencing/checkpoints, output
   admission guard, immediate UI freeze, terminal event, bulk-delta suppression,
   and real bounded process-group termination.
2. **Protocol client without production cutover.** Build the generic App Server
   bidirectional client, exhaustive server-request matrix, generated-schema
   version checks, and deterministic fake-server tests.
3. **Guarded Codex chat transport.** Add App Server chat execution behind an
   internal capability gate and close every `codex exec` parity item for
   transcript, usage, session, approvals, sandbox, homes, MCP, Browser, tools,
   and skills.
4. **Attempt-bound native controls.** Add control-handle leases, native
   `turn/steer` / `turn/interrupt`, safe-boundary handling, and honest receipt
   states. Keep the capability gate closed until the full slice passes.
5. **Durable continuation and ambiguity reconciliation.** Persist delivery
   intent, `acceptance_unknown`, provider evidence, leases, server-owned
   continuation, side-effect reconciliation, and restart repair; remove
   browser-owned auto-dequeue.
6. **Product/UI cutover and proof.** Update UI copy/states and guarded Product
   Logic Registry, then complete parity tests, real E2E, Desktop black-box
   verification, screenshots, reviewer/verifier passes, and telemetry proof.
   Opening the native capability gate is the final action after all proof passes.

Each slice must keep the repository buildable and cannot reintroduce an
`unsupported + parked` user contract as an intermediate shipped state.

### Data changes

The final schema adds only the durable fields needed for recovery and audit,
but the event/action/fence structures below are mandatory rather than optional
implementation details:

- generation: `stop_requested_at`, `accepted_through_seq`,
  `last_client_checkpoint_seq`, `frozen_body_hash`, `runtime_terminal_at`,
  `control_version`, `attempt_epoch`, `provider_thread_id`, and
  `provider_turn_id`;
- queued item: `delivery_intent`, `control_action_id`,
  `provider_client_message_id`, `provider_thread_id`, `provider_turn_id`,
  `attempt_epoch`, `continuation_generation_id`,
  `delivery_lease_expires_at`, and an ambiguity/reconciliation reason;
- message/transcript event sequence where no existing durable sequence can be
  reused.
- `chat_generation_events`: append-only event ledger with unique generation
  sequence, attempt epoch, event kind/payload/body offsets, projection links,
  and durable-before-emit timestamps;
- `chat_control_actions`: unique organization/action id, expected
  generation/attempt, action kind, control version, local/provider disposition,
  evidence, and timestamps;
- continuation fencing: lease token/epoch/owner plus unique source queue item,
  continuation message, and continuation generation bindings;
- terminal outbox/projector version and replay state.

Database constraints must enforce one nonterminal generation per conversation,
one continuation binding per source queue item, and one event per generation
sequence. Application-level checks alone are insufficient.

The implementation must verify existing schema capabilities before adding a
migration and must update DB, shared types/validators, server, and UI together.

### Breaking change

This intentionally changes the user-visible and API behavior of Steer and
post-Stop queue delivery. Existing internal clients that expect
`result: "unsupported"` or permanent parked rows must update. Normal send,
queue edit/delete, organization scoping, and external-bound read-only behavior
remain compatible.

## What Is Your Testing Plan (QA)?

### Goal

Prove the control protocol under real concurrency and production-shaped data,
not only happy-path endpoint responses.

### Test scenarios

1. **Native same-turn steer:** after the first delta, Steer changes the same
   active Codex/App Server turn, preserves generation/turn ids, and shows no
   warning.
2. **Unsupported adapter fallback:** Steer becomes a continuation, interrupts
   the old owner, and executes exactly once.
3. **Both Stop/Steer linearization orders:** deterministic current-turn or
   next-continuation outcome with no 409, loss, or duplicate.
4. **Stop cutoff:** a stub emits `before-stop`, acknowledges interrupt, then
   emits late delta/final/reasoning events and creates a real artifact. DB, UI,
   and reload retain only the pre-cutoff chat/result prefix, while the Work
   manifest reports the artifact as `observedAfterStop` production evidence.
5. **Progress structure:** multiple commentary entries before Stop remain
   separate and ordered; no terminal concatenation bubble appears.
6. **Stubborn process tree:** parent and grandchild ignore SIGTERM and emit
   output after abort. Visual freeze is immediate, the full group dies within
   two seconds, and post-cutoff side effects are bounded and reported.
7. **Close page after submission:** the server still starts the continuation.
8. **Restart recovery:** persisted `steer_pending`, `continuation_pending`, and
   `stop_requested` states converge without duplicate delivery.
9. **Multi-tab stale generation:** stale controls resolve to the same durable
   action outcome instead of losing intent.
10. **Large transcript:** 250 entries and 5-10 MB of tool evidence do not block
    control SLOs or reorder the stopped view.
11. **Protocol framing edge:** split UTF-8 and JSON lines at the cutoff cannot
    leak partial content or corrupt the next event.
12. **Terminal stability:** body hash and final event sequence remain unchanged
    after Stop acknowledgement, runtime exit, reload, and Desktop restart.
13. **Native receipt ambiguity:** crash or disconnect after provider receipt but
    before Rudder commit resolves through `thread/read` or remains
    `acceptance_unknown`; it never launches a blind duplicate continuation.
14. **External mutation safety:** fallback Steer during a non-idempotent tool
    action waits for a safe/reconciled boundary and proves the side effect count
    remains one.
15. **Attempt fencing:** model/runtime fallback invalidates the old handle; late
    output, steer acknowledgement, exit, and terminal events cannot affect the
    newer attempt.
16. **Continuation fencing:** two workers, lease expiry/reclaim, and crash during
    bind/start still create one user message, one generation, and at most one
    provider start.
17. **Stop failures:** cutoff API failure, disconnect before acknowledgement,
    and remote unverified cancellation render the honest nonterminal states and
    never reopen frozen output.
18. **Stop before control readiness:** deterministic barriers at resolution,
    spawn, initialize, thread start, and turn start prove the startup disposer
    works and a late handle cannot publish after cutoff.
19. **Provider item convergence:** duplicate/reordered deltas, a completed full
    snapshot, and reconnect replay for the same provider item converge to one
    body/transcript hash without append duplication.
20. **Checkpoint persistence:** post-commit ACK loss/staleness and hash mismatch
    preserve the last acknowledged prefix and never retarget a newer attempt.
21. **Request never reaches server:** late provider output persists, Desktop is
    reloaded, and the local pending Stop record renders the frozen/unconfirmed
    snapshot before replaying the same action id.
22. **Live worker recovery:** continuation/projector worker exceptions, lease
    loss, periodic sweep, bounded retry, and retry exhaustion converge without
    waiting for server restart.

### Test levels

- runtime protocol unit tests for App Server request/notification correlation;
- a deterministic fake App Server with barriers and per-method RPC counters for
  every bidirectional server-request class;
- server state-machine and route integration tests with deterministic barriers;
- process-runner tests for process-group termination and late output;
- UI tests for freeze, status copy, terminal reconciliation, and no warning;
- real browser E2E for native steer, fallback continuation, stop cutoff, page
  close, multi-tab, restart, and large transcript;
- a local Desktop black-box run with screenshots and persisted-state inspection.

Crash injection must cover event commit/emit, cutoff commit/projection, steer
send/ack/Rudder commit, continuation claim/bind/provider start, and terminal
outbox/projector windows. Restart tests kill and restart the real server against
the same database, then assert provider call count, generation event sequence,
body hash, and transcript hash. A real Codex run is a protocol smoke and receipt
check; deterministic proof that the model changed direction belongs to the fake
fixture plus a bounded black-box behavioral check.

The 250-entry, 5-10 MB case must exercise real database persistence backlog and
prove the implementation no longer rewrites full transcript JSON per callback.

### Pass / fail

Pass requires all correctness invariants, the relevant latency ceilings, a
reviewer code pass, and an independent black-box verifier pass. Any stranded
intent, post-cutoff visible mutation, duplicate continuation, or false native
steer acknowledgement is a release blocker.

## Documentation Changes

The user explicitly authorized synchronizing the guarded Product Logic
Registry. Implementation must update:

- `CHAT.LIFECYCLE.001`: native/fallback Steer, no-stranded-intent, Stop scope,
  server-owned continuation, and removal of unsupported/parked semantics;
- `CHAT.THREAD.MANIFEST.001`: freeze narration/result promotion while retaining
  real post-cutoff artifacts and external effects as `observedAfterStop`;
- `RUN.CHAT.AGENT.001`: attempt-bound controls, cutoff, post-cutoff suppression,
  and run/message/generation terminal convergence;
- `RUN.RESULT.001`: post-cutoff bytes are diagnostic evidence only and cannot
  become result summary or chat-visible transcript content;
- `AGENT.RUNTIME.ADAPTERS.001`: explicit interactive control capabilities and
  honest runtime-specific fallback behavior;
- `doc/product/registry.yml` traceability links and changed E2E evidence;
- relevant public/operator docs only if user-facing setup or commands change.

Run `pnpm product-logic:check` before hand-off.

## Adversarial Review Record

### Round 1: root-cause challenge

Three independent reviewers examined runtime/protocol lifecycle, product/UX
semantics, and concurrency/persistence/black-box proof. All requested changes
and agreed on the same upstream diagnosis:

- Steer had no successful runtime path and was a false affordance.
- Stop had no output cutoff, signalled only the direct process, and admitted
  output during a long grace period.
- steer intent was deliberately collapsed back to ordinary queue state and then
  rejected after Stop.
- browser-owned dequeue and split in-memory/database state made recovery
  nondeterministic.

The proposal was revised from a local patch into an attempt-bound runtime
control actor with native Codex control, truthful interrupt-and-continue
fallback, immutable output cutoff, and server-owned continuation.

### Round 2: protocol and failure challenge

The same perspectives attacked the revised design. Their P0 findings and
resolutions are:

| Finding | Resolution in this proposal |
| --- | --- |
| native provider receipt is not an exactly-once guarantee | `acceptance_unknown`, provider evidence reconciliation, and no blind fallback |
| App Server is bidirectional and can block on server requests | exhaustive request matrix, bounded pending registry, explicit unknown-method failure |
| App Server could regress approval/sandbox/tool/session behavior | explicit parity gate and field-by-field test matrix before cutover |
| old fallback attempts can acknowledge into new attempts | generation/attempt/owner lease validation before and after every provider await |
| Stop could start ordinary Queue work | explicit terminal eligibility matrix and steer-only continuation SLO |
| fallback Steer hides cancellation and side-effect uncertainty | honest `Interrupted/Restarting` copy plus safe-boundary and unverified states |
| provider receipt was mislabeled as model compliance | `Delivered to current run` and persistent inspectable intervention evidence |
| server-latest output can exceed the prefix painted at click | post-commit client sequence/hash proof backed by append-only durable events |
| lease expiry alone permits stale workers | token/epoch/owner fencing and atomic queue/message/generation binding |
| sequential terminal updates can diverge after crash | authoritative event ledger plus replayable terminal outbox/projector |
| Stop can arrive before a provider handle exists | pre-spawn startup disposer and fenced late-registration rejection |
| rendered checkpoints existed only in React memory | post-commit checkpoint ACK with monotonic server CAS plus synchronous Stop payload |
| a Stop request may never reach the server | durable local pending Stop snapshot and idempotent replay before output readmission |
| provider deltas/snapshots/replay can duplicate text | provider item/channel/offset identity and snapshot reconciliation semantics |
| outbox enqueue or idle worker failure can strand work | same-transaction outbox plus continuous fenced workers, sweep, retry, and actionable exhaustion |

No P0 is intentionally deferred. Final reviewer acceptance is required before
the capability gate can open.

### Final closure

After the second-round amendments, all three independent reviewers returned
`PASS` for runtime/protocol, product/UX, and concurrency/persistence. The
proposal is approved for implementation. The native capability gate remains
closed until the slice-6 proof listed above passes.

## Residual Open Issues

- Generated App Server schemas and the minimum supported Codex version must be
  pinned during implementation; protocol drift closes the native capability
  gate rather than silently falling back mid-turn.
- OpenClaw and other remote runtimes require a verified remote cancellation
  primitive. Until proven, their UI terminal state remains
  `Runtime termination unverified` and continuation is side-effect gated.
- Post-cutoff diagnostic retention needs a bounded byte/age policy. This is an
  observability/storage choice and cannot weaken the chat-visible cutoff.
