---
title: Complete Plan for Rudder Native Chat Experience and Agent Run Execution Architecture
date: 2026-09-21
kind: implementation
status: in_progress
updated_at: 2026-10-21
area: agent_runtimes
entities:
  - agent_run
  - runtime_session
  - side_chat
  - chat_transcript
---

# Complete Plan for Rudder Native Chat Experience and Agent Run Execution Architecture

## October 17 Delivery Priority Correction

The user explicitly asked to stop the prolonged foundation-only work and first make **native Codex and Hermes usable**. The immediate delivery milestone is their real product path: the selected authorized runtime/profile accepts a first message, subsequent messages continue the same native session without replaying chat history, refresh/restart recovers accepted work without duplicate dispatch, and Stop reaches an honest terminal result. The backend business authority remains Rust. Verify the actual application launcher and installed runtimes, not only a builder-enabled synthetic fixture.

For this milestone, use the existing `hermes_local` Agent runtime identity already present on main for installed Hermes ACP. Keep `hermes_gateway` remote configurations working through their existing compatibility route. ACP uses exact `session/load` and new-input-only `session/prompt`; it must never silently switch to a new session when loading fails. The broader Hermes product-interaction contract in section 8.3 remains pending beyond this first usable local journey.

Do not make Pi, Claude, OpenCode, Cursor, a new policy framework, or all 97 final-plan scenarios prerequisites for this first usable milestone. Freeze their in-progress work and preserve it. The full six-runtime/storage/Reader/Side Chat scope below remains the eventual goal; delivery of the Codex/Hermes milestone must be named and bounded and must not be reported as completion of that full scope.

The delay came from coupling all runtime and storage work to extensive foundation and evidence machinery before proving the installed user journey. Correct the execution order: finish the real Codex/Hermes path, run the focused workflow and failure cases, resolve the necessary independent review findings, and publish a reviewable PR. Additional infrastructure must have a concrete dependency on that milestone.

### October 21 merge closure scope

PR #352 is narrowed to the Codex/Hermes milestone. Preserve the broader
all-runtime admission and span lifecycle candidate at `17e947736` for later
acceptance; do not include those changes in this merge. The immediate candidate
repairs Agent detail projection for external instruction configuration and known
historical managed roots without enabling external instruction reads or writes.
Invalid persisted workspace keys retain the existing generic 500 response and
transaction rollback. The Claude project-path encoding repair remains only to
clear the Windows baseline; it is not Claude runtime acceptance.

Operator-native Codex Profiles must inherit their own approval and sandbox
policies unless an operator explicitly requests bypass. Agent creation must not
silently inject bypass into an operator Profile configuration. Keep the existing
matching-policy check for an explicit bypass request, without editing the native
Profile or copying credentials.

Configuration state inventory: the current decision is which existing Codex
Profile to use; the visible Profile selector and bypass toggle remain together.
Operator Profile starts with bypass off. Switching an untouched selection to
Agent Profile restores its legacy default; an explicit toggle stays in the form
values across later Profile changes. Create remains the focal action. Existing
Back, Cancel, Close, reopen, and draft handling remain unchanged. No later-step
controls or new permission grants are introduced.

The Rust public-create path owns the persisted permission default, including
Node-prepared configuration. Node retains only its existing compatibility default
for legacy create, hire, and PATCH. Hermes session creation receives up to 30
seconds, bounded by the overall run deadline; other RPC limits and the prohibition
on replaying ambiguous effects are unchanged. Streamed Hermes turns have a
separate bounded update budget (8,192 updates and 8 MiB total), so normal token
streaming is not restricted to the instantaneous 256-message receive queue.
The per-frame 1 MiB and final-text 256 KiB limits remain enforced; exceeding a
limit remains unresolved and never permits prompt replay.

The Messenger composer no longer presents accepted-message Resume instructions
or a Resume button. The owning controller reconnects once per page and exact
organization/chat/mutation identity, preserving the newer draft, files, and
annotations. An already attached stream or pending Stop suppresses reconnection;
a failed reconnect requires an explicit Check again. Confirmed not-admitted
messages still require an explicit Retry. Reattachment must never allocate a new
mutation after the original identity settles. Side Chat recovery UI is outside
this screenshot correction's scope.

Codex acceptance exposed a process-host output relay failure before a later Stop
request reached the executor. The process-host mux and ownership transport keep
their existing bounded queue capacities, but brief consumer backlogs must apply
backpressure instead of immediately closing an otherwise valid stream. Queue
waits remain cancellable and have a local deadline so a permanently stalled
consumer cannot prevent owned-process cleanup. A relay error remains unresolved;
it must never be converted into provider completion or release an ambiguous
execution hold.

Stop may also arrive after durable claim but before the process owner launches.
Codex and Hermes must recognize that exact fenced Stop during prelaunch reads,
then obtain actual owned-process cleanup before the existing unsubmitted-input
finalizer closes the Run. A stopping-checkpoint read is limited to the same
unsubmitted execution and grants no effect permit; unrelated configuration,
permission, database, or ownership failures retain their original behavior.

Installed Hermes can end an active tool prompt with a correlated JSON-RPC
internal error after receiving `session/cancel`. Preserve that error as a
separate typed prompt-error receipt, never as a cancelled provider turn. Only
an exact durable operator Stop, the precommitted session/request/source/input
identity, and matching owned-process cleanup can use this receipt to close the
Run and release its admission hold. Record `providerStatus=error_response`, the
numeric error code, `cancelSent=true`, `providerCancelAcknowledged=false`, and
unknown usage; retain the frozen projection cutoff and validate the entire
committed progress ledger. Generic errors without an exact Stop, transport
loss, timeout, malformed responses, and mismatched identities remain held and
must not replay input. Do not modify the installed Hermes profile or sources.

The composer has one primary response control. An active response with no
queueable draft shows Stop; a queueable draft shows Send, using the existing
queue callback. Clearing the draft restores Stop. A pending Stop shows one
disabled Stopping control, and an idle empty composer shows disabled Send.
Regular files remain in the draft because the existing queue cannot accept them.
The queue endpoint is existing Node compatibility debt, not new Rust authority;
this presentation change neither expands that backend nor claims its migration.
Refresh and automatic stream reattachment must preserve the single-control rule.

Hermes live progress must come from the current prompt's public ACP
`session/update` notifications: bounded thought/reply text and tool titles/status,
without raw tool arguments, outputs, or private transcript-file reads. Persist
the normalized entries in Rust before projecting them to the existing transcript
UI, bound to the exact connection/session/prompt/source/owner. Coalesce progress
under a separate bounded budget without preventing the final answer. Refresh
must recover committed progress; Stop must freeze the accepted sequence and
reject subsequent progress from changing its visible result.

Before merge, run the unchanged Agent core public regression suite plus external
root no-traversal coverage. Freeze the candidate, then independently exercise
real locally configured Codex and Hermes through Rust public ingress: fresh
send, same-session continuation, runtime restart, persisted transcript readback,
Stop, and a native failure without Node business fallback. Reconcile the final
review and verifier receipts and require protected CI to pass. This milestone
does not complete the six-runtime, storage, or span lifecycle plan below.

### October 17 observed integration baseline

The refreshed integration branch now has a public Native Reader bridge for native
Chat message transcripts, with a real PostgreSQL test covering event projection,
bounded pagination, partial-to-sealed availability, organization fencing, and
actor membership. The installed Codex `app-server` probes passed without a model
call: initialization in an empty profile and an unknown-thread error remained
owned by the Rust transport. The installed Hermes ACP process also started and
completed initialization through the Rust process host, but its empty-home
`session/new` probe returned an ACP error before a session could be persisted;
this is recorded as an open Hermes installation/protocol compatibility issue, not
as successful native session acceptance. The first public bridge slice therefore
has stronger storage evidence, while the Codex/Hermes product milestone still
requires a real selected-profile browser journey, restart/recovery, and exact
Hermes session creation/resume proof.

## 1. Deliverable: Both Goals Must Be Completed Together

This change has two equally important, interdependent workstreams. Neither may be completed on its own, and the work must not be reduced to adding a Session ID to the database.

**Workstream A: Native Chat experience.** When a user chats with an Agent in Rudder, they are actually continuing to use that Agent Runtime's native session. Multi-turn context, tool calls, native compaction, tool results, interaction requests, controls, and branching use the Runtime's own mechanisms. Rudder adds its own instructions, business tools, and interaction UI; it does not reconstruct a lossy history and pass it off as a native session, nor silently suppress native features because the adapter lacks capability. Users can still inspect the process, tool details, file changes, sub-agent activity, and final answers that they are authorized to view.

**Workstream B: Agent Run execution and storage redesign.** Agent Run is the unified managed execution unit across surfaces and Runtimes. Chat, Side Chat, Issue, Review, Automation, and Heartbeat all use the same execution foundation. Each Run is bound to its own native execution span, while multiple consecutive Runs may share one native logical session. By default, the native Runtime persists the complete raw Transcript; Rudder stores locators, ownership, results, and necessary product data, and reads on demand through a unified Reader instead of duplicating the entire raw process in the business database and multiple logging pipelines.

Together, these two goals define completion. Native continuity without eliminating duplicate storage of all events is not complete; reducing storage while breaking history viewing or Side Chat is not complete either.

### 1.1 Scope That Must Be Preserved

Implement all six supported adapters: Codex, Claude Code, Hermes, OpenCode, Pi, and Cursor. “Other Runtimes continue using the old implementation” is not an acceptable final deliverable. The first five are first-class deliverables for full native session integration; Cursor must use its actually available native capabilities, and genuine gaps in history export, precise Fork, or Steer must be handled according to the rules below. The Gemini CLI Agent Runtime is removed and is not a supported adapter or acceptance target; Gemini model/provider support remains independent of Agent Runtime availability. Preserve existing data. Keep existing OpenClaw functionality working and run regression tests when connecting it to the shared foundation; do not use this work to rewrite unrelated capabilities.

Preserve Side Chat's temporary drafts, first send, creator permissions, source-reply anchors, expiration, close behavior, Move to Messenger, title, grouping, parent Chat state, and existing interactions. The fact that a native Runtime has no product feature for “turning a temporary chat into a permanent chat” is not a reason to remove that Rudder feature.

Preserve existing capabilities such as budgets, permissions, approvals, task claiming, workspace safety, attachments, feedback, annotations, learning, export, and review. Issue claiming and state rules apply only in their own business surface; they must not become prerequisites for Chat to start a Run.

September 29 local-preview corrections are part of acceptance: browser users must be able to preview authorized local workspace and Skill files without uploading them to a cloud service; normal Chat process disclosures must exclude echoed user inputs and injected structured prompts, and remain empty when no intermediate activity exists; streamed final replies must stay in the same assistant message position when finalized; Run Detail must distinguish reasoning, tool calls, and final responses; Metadata must expose the actual instruction snapshot used by that Run through a readable retained source rather than only a hash or the latest on-disk instructions. Repair the reported continuation failure after a completed turn without duplicating accepted input or discarding the existing native session. Browser access must respect browser file-permission boundaries or use the authorized local runtime's existing file-reading service; arbitrary filesystem access is not implied.

### 1.2 Precise Meaning of “Native Parity”

The comparison must use the same authorized Profile, model and configuration, working directory, and tool and skill scope. Compare session and control semantics; do not require model output to match word for word, or reproduce terminal pixels, keyboard shortcuts, or ANSI appearance. Every function executable in the native product must have an equivalent Rudder control or an authorized native-command entry point. When a terminal-only custom UI cannot be brought directly into the browser, provide an explicit bridge or equivalent interaction; do not silently ignore it.

Distinguish three kinds of information: native model-restoration state, persistable native history, and Rudder's user-visible projection. They need not be identical. Display only reasoning text or summaries that the Runtime exposes and permits for display; keep hidden or encrypted internal state opaque and do not attempt to reconstruct it from visible reasoning.

### 1.3 Baseline and Evidence Boundaries

This document consolidates the prior complete proposal, Side Chat contract, specifications for all six Runtimes, and review findings. What has been removed is extra progress templates, empty acceptance ledgers, and scattered files, not technical scope. This document is self-contained for implementation and does not depend on other files in an old archive.

Prior Rudder code audits covered `287b2cb156eac986ab8aa23f4095a2bd06f35980` and `c54001819ca38079b627994557db0a18ed278fc0`; these are only pointers to historical evidence and do not require the local worktree to be rolled back to those SHAs. This is a consolidation of the proposal; it does not claim a fresh audit of the current local repository or successful native-runtime tests. Public interface documentation is a protocol lead; actual methods, versions, retention policies, and behavior must be verified against the installed Runtime.

Issues identified in prior audits include: ordinary new Chat turns do not reuse native Sessions through the branch that resumes a Run; history is reassembled from recent messages in a prompt helper; process events and the next turn's model context are handled separately; ordinary results depend on text sentinels; and some native questions do not participate in a complete human-in-the-loop exchange. Before implementation, locate the successor modules for these paths in the current code. Do not miss them because files moved, and do not roll already-fixed code back to an old state.

## 2. Target Architecture and Responsibility Boundaries

```text
Main Chat / Side Chat / Issue / Review / Automation / Heartbeat
                         │
                  Surface-specific business validation
                         │
                         ▼
             Unified Agent Run execution entry point
   Permissions, budgets, admission, queues, Attempt, leases, recovery, terminal state
                         │
              Logical-session binding and native-execution locator
                         │
                         ▼
                Runtime-specific Driver
                         │
                         ▼
       Codex / Claude / Hermes / OpenCode / Pi / Cursor
                Native sessions, tools, compaction, history

Chat / Run Detail / Annotations / Feedback / Learning / Export
                         │
                         ▼
                Unified Transcript Reader
                         │
       Validate permissions → Resolve Run scope → Locate Host/native resource
                         │
             Native reads / legacy logs / necessary object supplements
                         │
                    Unified display projection
```

These are module boundaries, not a requirement to create microservices. Prefer extracting reusable modules within existing services and Adapters. Reuse the current authoritative TS/Rust implementations; do not write a second execution state machine or scheduler.

### 2.1 Rudder Responsibilities

Rudder is responsible for product Conversations, Agent identity and authorization, surfaces, work goals and associations, reliable submission of user input, Run/Attempt identity, budgets and concurrency, authorization of human actions, visible-output cutoffs, history-reading permissions, data-retention references, and UI state.

Regular Chat and Side Chat share send, control, event interpretation, and process-display capabilities, but retain independent drafts, attachments, scroll positions, selected branches, and active Generations. Do not merge their state by Agent ID in the name of component reuse.

### 2.2 Runtime Responsibilities

The Runtime is responsible for model execution, native tool loops, native session state, context compaction, native history, native branching mechanisms, and human-in-the-loop requests during execution. A Driver translates explicit Rudder operations into that Runtime's protocol and translates native results into unified events; it must not reduce every Runtime to the lowest common denominator of “giving the model one large string.”

Native tools, Memory, Skills, plugins, model configuration, and instruction files should continue to load within existing authorization boundaries. Inspect existing startup flags, post-execution cleanup, and managed-directory logic one by one: cleanup of one-time credentials or temporary input may remain, but do not clear provider memory every turn, disable plugins or built-in Skills without explanation, or change authentication methods. Rudder extensions must not inadvertently override native base system instructions, nor may a new global setting disable native capabilities while parity is still claimed.

### 2.3 Relationships Among Run, Session, Process, and Conversation

```text
Conversation C → Binding B → native Segment S1
User input M1 → Run R1 / Attempt A1 → execution span T1 in S1
User input M2 → Run R2 / Attempt A2 → execution span T2 in S1
User input M3 → Run R3 / Attempt A3 → execution span T3 in S1

If native compaction creates successor storage: Binding B → S2; S1 remains the source for old Runs
If the user Forks: create Binding B2; do not rewrite B's historical ownership
If the process restarts: restore the native state referenced by B; do not create a new Conversation as a result
```

One regular Chat input usually corresponds to one Run and one primary native execution span. Each model request in a native tool loop does not automatically create a new Rudder Run; one Run may contain multiple lower-level native turns. Resumption, retries, and native sub-agents may add spans, and each must retain its own source and cost attribution.

A Run that fails before startup may have no native span and retain only limited startup diagnostics. Mark a Run with unknown native acceptance as pending reconciliation; do not fill in a fake Session ID. Copying history does not copy the source Run's execution, costs, or approval authority. Product-only operations such as opening history or a side panel, or Keep, do not create a model Run.

## 3. Workstream A: Implementing Native Chat

### 3.1 First Send

First, validate the user, Conversation, Agent, model selection, attachments, Workspace, and budget under existing rules, and save the user input and idempotent submission identifier. Then call the unified Run entry point with the intent to “create a native session.” The foundation prepares the Profile, creates native state, and persists the binding as early as possible before native execution begins.

If a Runtime combines Fork and the first Query into one call, first save the creation intent and bind the native ID as early as possible from initialization events. Do not send an empty fake message to allocate a Session, and do not fabricate a successful Run before inference has started.

### 3.2 Second and Subsequent Sends

Continue the native session using the explicit binding for the current Conversation and send only the new content for this turn. Do not look up the Agent's most recent Run or the latest Session in a directory.

```text
Current-turn input = new user text + new attachments + user-selected citations + necessary business changes
Does not include = full replay of recentMessages / Rudder-synthesized complete Transcript /
                  manual concatenation of prior-turn reasoning and tool results
```

Enabling native reuse and stopping history replay must be part of the same change slice. Changing only the Session ID while leaving the Prompt unchanged will inject old history again; changing only the Prompt without resuming the Session will lose history.

The Runtime is responsible for compacting and selecting native model context. A separate Reader is responsible for letting users inspect much older Runs; the fact that the native model “can still answer” does not prove the full process history was preserved.

### 3.3 Instructions, Context, and Model Selection

Split Prompt assembly into three parts: stable extension instructions, current user input, and necessary business changes. Add stable instructions at a native-supported extension point and record their version, while preserving the native base harness. Provide project materials, external documents, logs, citations, and tool results according to their trust level; do not elevate them to high-priority instructions.

Submit only the business changes that need updating, such as Goal state, new user feedback, or current work constraints; do not attach all organization materials on every turn. Pass the current Run's tool authorization through trusted execution context; do not let the model declare its own Run ID to obtain permissions.

The stable-configuration fingerprint excludes per-turn values such as Run ID, timestamps, and temporary Tokens. Change the model, effort, and adjustable parameters in place when supported natively. Changes to Profile, organization, execution identity, authorization scope, or Runtime require explicit evaluation. Changing Runtime is usually a context handoff, not a lossless migration of the same native state.

Process queued inputs according to the currently implemented model/Agent snapshot rules; do not silently switch to “whatever the latest default is at execution time.” Changing the selected Agent does not redirect an executing Run or its Stop/approval controls.

### 3.4 Intermediate Process and Final Answer

Generate unified events directly from native structured events, then project them to the UI. Preserve text/commentary, reasoning permitted for display, tool inputs/results, commands and directories, Diffs, images/attachments, failures, human requests, native sub-agents, and extension activity.

Do not introduce a round trip in the native path of “structured notification → fake stdout JSONL → re-parse → write to database → parse again.” Retain the old parser only for genuine legacy execution modes or log imports.

Completion of an ordinary reply is determined by the native final message and execution terminal state; it no longer depends on `RUDDER_RESULT_BEGIN/END` or extra repair inference when a result is missing. Multiple commentary and final messages must not be naively collapsed into “the last piece of text is the answer.” When a Run fails or stops, do not upgrade reasoning or partial progress into a successful final answer.

Rudder-specific Issue proposals, business operations, visual results, and similar outputs continue to be validated through existing structured tools or result channels. Removing ordinary-text sentinels does not remove structured-result validation, user confirmation, or safe-display rules. Incomplete fragments of existing inline visuals must not leak directly into the body through the new event path.

### 3.5 Relationship Between User Actions and Runs

| User action | Run and native behavior | Error to avoid |
|---|---|---|
| Send while idle | A new Run continues the current binding | Creating a new Session with no history |
| Send the next message while executing | Rudder holds the queue; create a new Run when admitted | Sending once through native and once through Rudder |
| Steer | Send to the exact native execution for the current Run | Mistaking it for a new chat turn |
| Stop | Save the visible cutoff first, then request native stop | Releasing all execution responsibility upon receiving `stopping` |
| Retry | Reconcile prior acceptance/side effects, then use the correct resumption or new Attempt | Blindly resending after a timeout |
| Regenerate | Branch at a verifiable boundary before the original input, then resubmit that input | Leaving the answer being replaced in context |
| Edit an old message | Create a new visible branch; keep the old Run and source inspectable | Overwriting the old Run's original record in place |
| Fork / Side Chat | Fork precisely from the selected completed reply | Forking from the current latest head |
| Reply to a question/approval | Respond to the exact native request and keep it in the same Run | Turning a historical approval into an active request |
| Open history/refresh | Read and resubscribe | Calling the model again to generate history |

Preserve semantic distinctions among `accepted_current`, `queued_next`, `rejected_terminal`, `cancelled_by_extension`, `acceptance_unknown`, and other states. Do not treat every RPC success as proof that an operation took effect as intended. Existing fallback Steer may retain its explicit continue-execution semantics, but a cancel followed by rerun must not be labeled native steer.

### 3.6 Native Questions, Approvals, and Secret Input

Bind native requests to the Connection Epoch, Binding, Run, Attempt, native execution ID, request ID, and authorizing user. The UI displays structured content, and the response goes back to the same native request. Commands, file modifications, MCP trust, plan confirmation, clarification, multiple-choice prompts, and similar requests must handle acceptance, rejection, cancellation, and expiration correctly.

Old controls become invalid after a native request is withdrawn, times out, its connection becomes invalid, or its Attempt changes. Historical requests found after reconnect are evidence only; offer interaction again only for a native request confirmed to still be pending. Duplicate responses from multiple pages or devices must be idempotent; a one-time allow must not become a permanent allow.

Hermes sudo/secret and similar input must not enter the Transcript, product messages, event caches, exports, or telemetry bodies. Persist only operation state that contains no secret; send sensitive values through an authorized transient channel.

### 3.7 Native Commands and Environment

Inventory native-chat commands/slash, tools, Memory, Skills, plugins, attachments, sub-agent controls, and native configuration changes. Provide corresponding capabilities in the presentation layer; do not send slash commands to the model as ordinary user text and simulate execution. Distinguish UI-only commands, metadata commands, commands that affect subsequent configuration, and commands that actually invoke a model/tool; the latter are subject to budgets, approvals, and Run attribution.

When a native autonomous Goal/auto-continue mechanism exists, do not let it and the Rudder queue become two uncoordinated executors. Make clear which one accepts subsequent input. Native auto-execution must be costed and subject to budget and cancellation controls; it must not become a hidden task outside a Run.

## 4. Workstream B: Agent Run Data Model and Execution Contract

### 4.1 Reuse Existing Structures and Add Necessary Native Locators

The existing `heartbeat_runs` is a compatibility-preserving persistence table name; this work does not require renaming it throughout the repository. Reuse existing Run, Generation, Attempt, lease, control-command, approval, cost, terminal-effect, and resource-management structures. The following logical data must be represented; extend equivalent existing structures rather than creating duplicate tables.

| Logical structure | Required information |
|---|---|
| Runtime Binding | Organization, access principal, Agent, Runtime, Host, Profile, Workspace, stable configuration revision, continuity mode, parent branch and source boundary, current Segment |
| Native Segment | Binding association, concrete native identifier, optional root-session identifier, server-side resource locator, native format/version, branch leaf, predecessor, and transition reason |
| Run Span | Run, Attempt, Segment, span selector, ordinal, native execution/input association, primary/continuation/child execution relationship, state, completeness, stop cutoff, and necessary object references |
| Retention reference | Which Conversation/Run/annotation/descendant still needs which native resources, for what purpose, with what lifecycle revision and cleanup conditions |
| Historical source alias | The read-only source for a copied/displayed message, exact range, content digest, and authorization basis; does not copy execution-control authority |

Binding spans multiple turns; Segment handles physical-identifier changes and the native branch tree; Span provides precise attribution for one Run. Do not collapse these three concepts back into an ambiguous `sessionId`. Process connections and Host online status are observed separately: Host offline does not mean Session deleted.

### 4.2 Suggested Core Fields

```ts
// Proposed Rudder contracts; these are not provider API schemas.
interface RuntimeBinding {
  id: string;
  orgId: string;
  principalScopeRef: string;
  agentId: string;
  runtimeType: string;
  hostId: string;
  profileId: string;
  workspaceBindingId: string | null;
  instructionsRevision: string;
  capabilityRevision: string;
  continuity: "native" | "context_handoff" | "legacy";
  parentBindingId: string | null;
  sourceBoundaryRef: string | null;
  currentSegmentId: string | null;
}

interface RunRuntimeSpan {
  id: string;
  orgId: string;
  runId: string;
  attemptRef: string;
  segmentId: string;
  ordinal: number;
  relation: "primary" | "continuation" | "native_subagent";
  nativeExecutionRef: string | null;
  inputCorrelationRef: string | null;
  selector: NativeSpanSelector;
  sourceRevision: string | null;
  state: "open" | "sealed" | "unresolved";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
  visibilityCutoffRef: string | null;
  supplementalObjectRef: string | null;
}

type NativeSpanSelector =
  | { kind: "codex_turn"; threadId: string; turnId: string }
  | { kind: "claude_chain"; sessionId: string;
      startExclusiveUuid: string | null; throughInclusiveUuid: string | null;
      ancestryRevision: string }
  | { kind: "hermes_execution"; sessionRef: string;
      providerExecutionRef: string; sourceRangeRef: string | null }
  | { kind: "opencode_input"; sessionId: string; userMessageId: string;
      terminalMessageIds: string[] }
  | { kind: "pi_branch_range"; sessionResourceRef: string;
      fromExclusive: string | null; throughInclusive: string | null;
      leafId: string | null }
  | { kind: "cursor_execution"; sessionId: string;
      executionRef: string; nativeRangeRef: string | null };
```

These selectors are internal attribution data that each Driver must provide; they do not imply that every Runtime returns these fields unchanged. An unresolved range may temporarily be empty, but that is not a basis for enabling reference-only mode. When no stable native span exists, save the complete user-displayable record for that execution as an explicit object supplement; do not guess attribution from a time window.

Validate organization and permissions for every cross-object association. Index Run→Span, Binding→Segment, executions pending recovery, and resources eligible for cleanup. When one native file contains multiple branch leaves, uniqueness and locking must include branch semantics; do not incorrectly deduplicate by `nativeId` alone. If writes to the same physical file need additional serialization, lock by physical resource on the Host.

Public DTOs must not return arbitrarily accessible local paths, credentials, raw environment variables, or unrestricted Profile locators. The browser submits restricted internal references; the server/Host resolves them.

### 4.3 Historical Runs Must Not Grow With the Session

Seal a Run's source range when it completes. Continuing with R2 and R3 must not make R1's Transcript grow. After compaction or native rewriting, recover the original range through the retained source revision, native segment, or object supplement.

A Fork may rewrite message IDs, so the Driver returns a verifiable mapping from source to child branch. A copied message may have a new product message ID, but the original costs, Run, and approvals belong to the source execution and cannot be transferred.

Native sub-agent history must be associated with the actual parent tool call, execution, and range. Record late child results as an attached source/subsequent evidence; do not reopen a completed parent Run or attribute all later work in the child thread to the parent Run. Retain control, budget, and cleanup responsibility for explicitly authorized native background work; do not lose it when the main page closes.

### 4.4 Unified Submission Interface

```ts
// Build on the existing AgentRunOrigin and input/asset types.
type SessionIntent =
  | { mode: "create" }
  | { mode: "continue"; bindingId: string }
  | { mode: "branch"; sourceBindingId: string; boundary: NativeBoundary }
  | { mode: "context_handoff"; sourceRef: string };

interface NativeRunSubmission {
  origin: AgentRunOrigin;
  agentId: string;
  operationId: string;
  session: SessionIntent;
  newInput: RuntimeInput[];
  contextDelta: RuntimeContextDelta[];
}
```

The native submission type does not accept `messages[]` or `transcript[]`. Keep legacy history reconstruction in a separate compatibility type; do not let it enter the native path implicitly through an optional parameter.

Chat, Side Chat, Issue, Review, Automation, and Heartbeat all call the same entry point after their business validation. They select create, continue, or branch through session policy, but do not each spawn a Runtime independently. Using the Agent's most recent Session as a global default would let task B hijack chat A; this implementation is prohibited.

### 4.5 Driver Operations and Capabilities

Extend Drivers at the existing runtime-utils/Adapter public boundary. They must be able to express probe, create/resume, submit, reconcile execution, control, respond to human requests, read a Run span, read session history, branch at a boundary, inspect retention, and release resources. Keep concrete protocols and third-party types in their respective Adapters.

```text
probe(profile)                  → version, transport, and independent capability evidence
ensureSession(intent)           → binding-ready event; does not pretend execution has started
submit(binding, newInput)       → dispatch/acceptance state + native execution association
inspectExecution(attempt)       → current state and recoverable evidence
control(target, operation)      → semantics such as native/queued/rejected/unknown
respondToRequest(request, ...)  → response to the exact native human request
readSpan(selector, cursor)      → source page for that execution
readConversation(binding, ...)  → authorized session view
branchAt(boundary)              → achieved boundary, identity mapping, continuity level
inspectRetention / release      → resource dependencies and safe-release conditions
```

Record each capability as documented/observed/verified/unsupported/unknown, associated with the Runtime version, Adapter version, transport, Profile/storage configuration, and validation case. At minimum, distinguish native continuation, precise history, restart persistence, history across compaction, Fork at a completed-assistant boundary, editing at a user boundary, Steer, Stop, questions, approvals, native commands, plugin interactions, sub-agents, cleanup/export, and cost attribution. Do not enable every capability with one `supportsSessions=true` flag.

## 5. Run Execution, Concurrency, Recovery, and Process Management

### 5.1 Reliable Ordering for a New Run

```text
1. Validate actor, surface state, attachments, and input; deduplicate by operationId
2. Persist input intent and Run; use existing queue, budget, and admission rules
3. Establish/claim Attempt and acquire write ownership for the Binding and necessary physical resources
4. Prepare the authorized Profile, Workspace, tools, and credentials
5. Create or restore the exact native state; persist Binding/Segment as early as possible
6. Persist dispatch intent and call the native input interface
7. Associate native execution with the Run Span immediately upon acceptance/initialization information
8. Forward typed events and control visible output and human requests
9. After native execution actually ends, reconcile state, usage, source range, and persistence
10. Use existing terminal-effects mechanisms to complete product results, notifications, and cleanup responsibilities
```

Distinguish “submission accepted,” “executing,” “waiting for a human,” “stopping,” “execution terminated,” and “business terminal state pending commit.” Map these first to existing state fields and substates; do not casually invent a parallel Run state machine.

Handle startup failure, initialization failure, mid-model failure, cancellation, timeout, disconnection, and unreadable native history separately. A history-storage problem does not permit fabricating model success, nor should it discard a business result that has already completed. Express Run outcome separately from history availability/completeness.

### 5.2 Idempotency and Unknown Acceptance State

`operationId` uniquely identifies a user submission in Rudder, but is not automatically a provider idempotency key. For interfaces that support native idempotency, use their formal request field/header and verify scope, conflict behavior, and lifetime. For interfaces that support only request correlation, do not treat a correlation ID as a deduplication guarantee.

The connection may be interrupted after “the Runtime has executed, but Rudder has not received confirmation.” Mark the submission `acceptance_unknown` and reconcile it through native execution state, the original input identifier, or native idempotent replay. Do not simply generate a new key and execute it again. An operation that remains unknown does not automatically become safe to resend after the native idempotency window expires.

Session/Fork creation has the same cross-boundary problem. Persist a recoverable creation intent first. If native creation succeeds but the database commit fails, reconcile the result or safely clean up the orphan; do not repeat creation without limit. If the side-effect state cannot be proven, clearly show the blocking point and let the user make an informed decision.

### 5.3 Single Writer and Control Fencing

Reuse existing Run/Attempt ownership and complete write mutual exclusion at the Binding and shared physical native-resource layers. Mutual exclusion must cover every surface, not just lock Chat generations. Prevent incorrect sharing of a fixed session key, global Session reuse by Agent, or multiple Driver instances arbitrarily resuming the same Session concurrently.

Leases must include an execution owner/epoch. Control targets carry the expected Run, Attempt/Generation, Binding, and native execution identifier. Stop from an old page, a late Steer, or a terminal event from an old worker must not affect a new execution. An expired database lease does not mean the old Runtime has stopped; before taking over, confirm that the old executor has been fenced or exited safely.

When a user opens a native CLI that directly writes to the same Session, a Rudder database lock alone cannot protect it. Prefer a native single-writer/shared-service mechanism; otherwise, when borrowing a user's Session, require an explicit control handoff, read-only observation, or conflict detection that blocks concurrent writes. Do not pretend an in-process mutex can block an external CLI.

### 5.4 Queueing and Run Completion Boundaries

By default, Rudder holds future user messages, and each becomes its own Run after admission. Steer supplements input to the current Run. Delegate to a native queue only when each actual input in that queue can be mapped to an existing Run; two queues must not dispatch the same input twice.

Native automatic retries, tool loops, and continuation after compaction are usually part of the current Run/Attempt execution. A low-level native `turn_end` need not mean the product answer has ended. If the Runtime automatically drains a native follow-up queue, do not merge the results and costs of distinct user submissions into the first Run.

Each Driver must prove completion: execution for the original input has ended, that input will not be retried automatically, the necessary terminal state has been recorded, and usage is reconciled. Do not infer completion from “no tokens received for a few seconds.”

### 5.5 Usage and Budgets

Record the requested model and actual serving model for each Run; calculate cost using the actual serving model and natively verifiable usage. Compute deltas from native cumulative counters using causal ranges or reliable checkpoints; do not charge the entire Session cost again on every turn. Copied history in a Fork is not billed; failed Attempts and actual retries are charged for their real consumption.

For sub-agent usage, establish whether the native parent counter already includes child consumption. Do not add it again when included; when excluded, aggregate through confirmed child relationships. Record late-arriving costs as corrections/attached statistics; do not arbitrarily change a parent Run from completed back to running.

Preserve existing rules for budget hard-stop, organization auto-pause, and cancellation escalation. When a stop request has been accepted but execution is still underway, do not prematurely release execution responsibility or necessary concurrency reservations.

### 5.6 Long-Lived Processes and Per-Run Credentials

Session persistence and long-lived processes are separate deliverables. Codex/Claude may initially start once per turn and explicitly resume correctly; interactive Hosts such as Hermes/OpenCode/Pi may reuse a process, but execution lifetime must not be determined by browser-connection lifetime.

If `RUDDER_RUN_ID`, a temporary API Key, or an MCP Token in the existing implementation belongs to a particular Run, a long-lived process must not keep using the first turn's identity for later turns. A trusted Host associates native execution with the currently authorized Attempt, resolves tool permissions per request, or uses an isolated per-Run channel. Multiple concurrent Runs must not share one mutable global `currentRunId`.

Set active/idle limits, connection recycling, and resource limits for the Host. Recycling an idle process does not delete the session. A browser refresh, Side Chat Keep, or temporary network disconnection must not start a second session. If the Runtime has an orphan timeout, keep the Host connection alive and reconnect in a version-aware manner; do not solve this by disabling the global safety timeout.

## 6. Side Chat Specifics: Preserve Rudder's Product Semantics

### 6.1 Baseline for Protecting Existing Behavior

In the prior audit, Side Chat was managed by `server/src/services/side-chats.ts` and included a two-hour validity window, creator validation, anchoring to a completed assistant message, hidden state, and in-place `keepInMessenger`. Later revisions to session-family grouping superseded the grouping section in earlier documents. During implementation, use the current service, its callers, and tests as the source of truth, preserving title snapshots, model/effort override handling, grouping, failure retention, and UI transition details.

First run characterization tests to establish which actually-persisted messages trigger touch, how in-flight Runs are handled when expiration occurs, the close cleanup order, and Keep permissions. Do not infer that every event extends the TTL just because a touch function exists, and do not derive regular Chat lifecycle rules from Side Chat behavior.

### 6.2 Keep Four Lifetimes Independent

| Lifetime | What its end means | What it does not mean |
|---|---|---|
| Side Panel tab | The user is no longer viewing it; temporary close keeps its existing destruction behavior | All executions for the same Agent should stop |
| Side Chat send window | No new input may be admitted after expiration | Existing history must be deleted immediately or all native state canceled |
| Agent Run | This execution ended or was interrupted | The continuous conversation ended |
| Native-resource retention | The resource may be cleaned up after explicit conditions are met | The resource may be deleted unconditionally as soon as the TTL expires |

Temporary Side Chat uses persistent, recoverable native storage beginning with the first Send. Do not enable ephemeral, no-session, or in-memory-only Sessions because of the temporary label. Implement Rudder's temporary product state through retention policy, not by failing to save the underlying history.

### 6.3 First Send and Precise Branching

Opening `/side`, using the Side Chat action on an assistant reply, or entering through an empty panel creates only a local provisional draft; it does not create a native Session, Run, or model request. On first send, perform an idempotent creation keyed by organization, creator, sourceConversation, sourceMessage, selected answer variant, Agent, and clientMutationId.

Within the product transaction, create the hidden Conversation, copies of existing messages/annotations/attachments, the creation intent, and source retention. Freeze the source boundary at the selected completed assistant message; then perform the native branch and record the child identity before dispatching the first new input. Retrying the first message must not repeat the Fork or execution.

The parent Chat may be executing a later turn. The branch may contain only the historical prefix through the selected source; it must not include content appended later. Do not roll the parent session back to an earlier point before Forking, and do not use the preceding user message as the completed-assistant boundary and thereby omit the reply the user selected.

When the selected reply contains only a visible prefix up to Stop, while the native Runtime has already stored a tail the user did not see, choose a native branch that matches the visible boundary. If that is not possible, use an explicit visible-context handoff; do not silently send the hidden tail into the new session.

Use native branching when the Runtime and authorization are the same and an exact boundary is supported. For incompatible cases such as a different Runtime, lower permissions, or a legacy history source, use an explicit `context_handoff` that imports only authorized visible material, then continue in a new native session. This is not equivalent to a lossless native Fork. If a native extension rejects the operation, do not automatically switch to a handoff path to bypass that rejection.

### 6.4 Move to Messenger: Promote In Place

Keep must preserve the same Conversation ID, Binding, and existing Runs. It must not trigger a native Fork or Session create, resubmit user input, or restart a running Agent.

```text
Enter the existing Keep transaction
  → Lock and revalidate the creator, Side Chat state, and expiration
  → Return idempotently if already kept; reject an expired chat under existing rules
  → Verify source availability required by the current product
  → Update existing fields such as kept / messengerVisible / expiry / keptAt
  → Preserve current session-family grouping rules
  → Upgrade resource-retention references to long-term and increment the cleanup revision
  → Commit
The UI closes the original side-panel tab and opens regular Chat for the same Conversation
```

The transaction does not depend on a new native pin/Fork/copy RPC. When the Host is offline, metadata may still be promoted if the existing source and lifecycle conditions are satisfied; if native bytes have already been lost, say so clearly. Keep cannot repair missing data.

If Keep occurs while output is streaming or an approval is pending, the original Run, request, input queue, and current body remain valid. If native initialization has not completed, attach the retention reference to the creation intent first; later resources inherit long-term retention. The Runtime itself may compact concurrently; record its Segment changes. The prohibition is against Keep causing a rebuild, not against the Runtime evolving on its own.

On failure, preserve the side-panel window, draft, and attachments, and show the actual retryable error. Repeated Keep must not create duplicate groups or activity. Continue handling source deletion, expiration races, and similar cases under existing product rules; do not change their semantics incidentally as part of the storage redesign.

### 6.5 Expiration, Touch, and In-Flight Execution

Use server time to determine the window. Preserve the existing two-hour constant and refresh triggers confirmed by tests. Do not add tokens, tool progress, polling, page reads, history restoration, or title reads as touch sources.

A Run admitted before expiration may finish afterward under existing in-flight execution rules; recheck queued input that has not yet been admitted. A late callback must not revive a Conversation already committed as expired/deleted. Expiration of a native SSE buffer or an idle process exit is unrelated to product expiration.

### 6.6 Close, Destruction, and Safe Cleanup

Closing a provisional draft discards only the draft. Closing a hidden temporary Side Chat retains its destruction semantics, but first persist a recoverable, restricted cleanup intent, block new admission, and stop its own in-flight execution. Do not stop the parent Chat, sibling Side Chats, or other tasks for the same Agent.

Even if the product row is deleted first under existing behavior, retain the minimum references required for cancellation/reconciliation. Receiving `stopping` does not mean execution has stopped; do not delete files still needed by execution before the actual terminal state. Cleanup must be resumable across Rudder restarts.

After releasing the current Chat's retention reference, check Run evidence, descendants, annotations, copied sources, and native deletion cascades. Physically delete a resource only if there is no active execution, no valid retention reference, and the cleanup revision matches. Do not pin temporary data forever by requiring “all Runs permanently retain raw logs.” Release raw evidence for temporary Runs under the existing temporary policy; retain only restricted metadata needed for audit.

When Keep and Close race, there must be a clearly defined transactional winner. After Keep succeeds, late Close and stale GC must not delete data; after Close commits, Keep follows existing error handling. GC rereads owner/epoch rather than trusting an earlier scan or a potentially inaccurate cached reference count.

Native deletion may cascade to child threads, or descendants may still depend on parent history. When necessary, independently retain referenced resources using a valid native mechanism first. If they cannot be safely separated, defer physical deletion and record that accurately; do not claim erasure. Closing a chat also does not roll back real file changes, messages already sent by tools, or long-term memories already formed.

### 6.7 Copied History, Permissions, and Parent/Child Isolation

Preserve existing product-ID semantics for copied messages and attachments. When the source Process needs to be shown, add a read-only source alias; do not repopulate source Run/approval/chatTurn control fields. Validate source-message remapping, annotation attachment ownership, and selected-range digests.

Side Chat creator restrictions apply to listing, reading by ID, Run Detail, Reader, file details, export, query caches, and native session search. Another user knowing a native Session ID must not bypass authorization. If native Memory/session_search is shared across principals, address this through authorized Profiles and storage isolation; do not preserve superficial privacy by silently disabling Hermes Memory.

Reuse of an already-authorized native environment by the same creator may be preserved; sharing a parent must not expand cross-principal permissions. If a source is to be deleted while product semantics require copied content to remain, retain an independently authorized source or snapshot first. Existing product constraints determine the policy for revoked permissions and existing copies; a read alias must not bypass it.

## 7. Transcript Reader: Preserve User Visibility Without Duplicating Underlying Storage

### 7.1 Unified Read Path

```text
Request runId
  → Validate organization, actor, and Run visibility
  → Look up the Span description for that Run
  → Validate source aliases, stop cutoff, and permitted fields
  → Locate Host / Profile / native resource
  → Driver reads by stable source range
  → Normalize as unified Transcript items
  → Return paginated results and subscribe to subsequent state
```

Run Reader authorizes only the scope of that Run; a `runId` alone must not allow reading the entire Session. Conversation Reader independently aggregates its authorized history, and source Runs retain their original ownership; later parent-session messages are not mixed into a child session.

Prefer native APIs, followed by a read-only Host-format Reader constrained by version, with an object/legacy-log Reader as an explicit fallback policy when necessary. Business services and the browser do not parse Runtime-private databases directly. Direct native-file reads must support source-format versions, truncation/partial writes, concurrent appends, and index-invalidation detection. Do not edit native files arbitrarily.

### 7.2 Suggested Return Contract

```ts
interface TranscriptPage {
  items: TranscriptItem[];
  nextCursor: string | null;
  source: "native" | "native_plus_objects" | "legacy";
  revision: string;
  availability: "available" | "offline" | "missing" | "expired" | "incompatible";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
}
```

The client state expresses “not loaded”; an empty list loaded successfully is distinct from offline/missing. For unauthorized access, use the existing safe error without revealing whether the target exists. An incompatible source version must not appear as empty history; an old Run must not silently read a new branch after a protocol upgrade.

Bind pagination cursors to organization/principal, Run or Conversation scope, source revision, selector, and read policy; they cannot be reused for another history range. Do not use UI array indexes or timestamps as authoritative locators. The initial view, scrolling, opening an individual tool detail, and refreshing each load only their required scope.

Begin measurement with 50 items per page, about 256 KiB of visible body text, and detail blocks of about 2 MiB per request, then adjust. These are initial implementation limits, not existing product targets. For content beyond the limit, provide load-more behavior or a restricted object reference; do not disguise permanent truncation as complete content.

### 7.3 Separate Native Model-Restoration History from Complete History

The Runtime may replace old content with a summary in the model-restoration view, but users still need the original Run's tool results. Each Driver must prove that the complete-history Reader can read pre-compaction records and the correct ancestor branch. A convenient `get messages` interface does not inherently satisfy this condition.

Locate rewritten source IDs, branch changes, native compaction, and child-session appends through sealed Spans and revisions. Retain native-visible information that cannot be reconstructed in an explicit object supplement, or report history as partial; do not claim losslessness or fabricate provider-private reasoning.

### 7.4 Live Streams, Reconnection, and Backpressure

Keep a bounded Host/server ring buffer tagged with Connection Epoch, native execution, Item, and local event sequence. By default, do not persist token-level deltas in SQL. Persist small state changes, control acknowledgments, and terminal states.

Stream updates while the connection is healthy; recover a short disconnection from the buffer. If the buffer has expired, first establish a subscription/buffer new events, read a native snapshot, and then merge by stable Item identity and revision to fill gaps, avoiding dropped events or duplicate bodies between snapshot reading and subscription. An expired cursor returns a reset/reconcile signal; it must not be treated as requiring no update.

A delta and a later complete snapshot for the same Item are updates to one item, not two new messages. Select either the reasoning summary or another display stream for the same item according to a verified policy to prevent duplicate display. When native APIs provide only transient tokens, the recovery commitment is to restore persisted results and state, not to replay every transient notification forever.

A slow client must not cause unbounded memory growth or block Stop/approval. Body updates may be coalesced, rereading may be requested, and recoverable deltas may be dropped; unprocessed human-control requests may not be dropped. Parse multiline SSE `data` correctly. JSON-LF must correctly handle UTF-8 split across chunks and Unicode line separators inside strings. Set a frame-size limit and use restricted detail retrieval or an explicit error when exceeded.

### 7.5 Stop Cutoffs and Annotations

Save the visible prefix and source revision at the moment the user's Stop is accepted. A subsequent native tail may be retained as authorized diagnostics, but must not enter the ordinary final answer after refresh. A hash alone cannot restore a prefix overwritten natively; when necessary, save a small, exact Stop snapshot.

Annotations record the product source message, Run/Span, native Item, text range, and digest; the server rereads and validates the source. Short text actively quoted by the user is part of the feedback and may be persisted; do not retain an entire extra Transcript for one quote. Keep source IDs and attachment references synchronized when copying/Forking. Historical approvals are read-only; selecting an old Process must not grant execution authority.

### 7.6 Files, Attachments, Learning, and All Consumers

Command directories, file paths, skill identity, and Diff data come from structured native evidence. Continue resolving file previews through the authorized Workspace/assets; do not guess paths from rendered text. A cloud service cannot directly open an absolute path on another Runtime Host. Create authorized attachment references usable on the target Host and preserve media types; do not force all images into text descriptions.

Migrate main Chat, Side Chat, Run Detail, Run Feedback, annotations, Debug, learning/Skill optimization, export, and history summaries to the shared Reader. Learning reads must follow scope, retention, and permissions; do not copy entire Transcripts into a knowledge base for convenience. Search retains existing product messages and necessary indexes. If raw tool output needs to be searchable, use an authorized Host/object index; do not silently rebuild all raw history in the primary database.

## 8. Practical Adapter Plans for the Six Runtimes

Each adapter must deliver native continuation, complete history reading, Run spans, interactive controls, Side Chat branching/promotion, and restart recovery. Preserve compatibility with existing packages, configuration keys, authentication entry points, and user model choices as much as possible. Do not replace binaries, perform global upgrades, or switch models merely to match examples in documentation.

### 8.1 Codex: App Server Native Thread/Turn

**Protocol basis.** The official App Server exposes Thread/Turn, history reading, Fork, and controls. Keep the concrete `thread.id` distinct from the root `sessionId`; `lastTurnId` in `thread/fork` expresses a boundary that includes that completed Turn. Pagination methods are experimental and subject to storage-implementation limitations; verify against the installed version. [S1]

**Change entry points.** Extend `native/crates/codex-app-server`, `native/crates/native-chat-executor`, and their D1/Foundation callers. Keep protocol/session/control/history mapping in small Rust modules. The existing `packages/agent-runtimes/codex-local` implementation and tests are compatibility references; new backend behavior must not be added there.

**Creation and submission.** Complete initialize/initialized, start a persistent thread or resume using an explicit thread ID. Emit sessionBound early, then submit `turn/start` containing only new input and bind the turn ID as early as possible. Preserve managed CODEX_HOME, Workspace, model/effort, and existing approval policies. Use the native terminal state directly for ordinary replies; do not run sentinel repair.

**Controls.** Use `turn/steer` with expectedTurnId; use `turn/interrupt` for Stop. Route native requestUserInput, command approvals, file approvals, and other requests that require a response through the shared human-request layer. Preserve the distinction between unknown acceptance and a closed turn.

**Reading.** Use supported `thread/read` to read native history; use `thread/turns/list` and `thread/items/list` only after actual verification. Do not enable a storage mode that can list summaries but cannot read fully or resume. The scope of one Run is determined by its concrete turn ID; large histories require controlled Host reads and a rebuildable index.

**Side Chat.** Fork natively from the selected completed Turn. Preserve the child Thread and root-session identifier, and avoid operating on the parent Thread. Persist temporary Side Chats too. Before deletion, inspect spawned-descendant cascades and descendant retention references. Keep must not require a native Fork/delete/pin as a transaction precondition.

**Must test in a real environment.** Continuation beyond 12 messages; follow-up questions whose relevant information exists only in tool results; Rudder and Adapter restarts; complete tool details; questions and rejections; precise branching; Stop cutoff; no silent Session creation when a Session is lost; and safe cleanup of child resources.

### 8.2 Claude Code: SDK/Control Protocol and Complete Native History

**Protocol basis.** The current official interface supports resumption and Fork by explicit Session ID; resuming the most recent session in a directory has different semantics from resuming by explicit ID. `getSessionMessages` through the SessionStore path may expose only the compacted model-restoration chain; handle raw entries, Fork identity mapping, mirror integrity, and file checkpointing separately. [S2][S3]

**Change entry points.** Preserve the `claude_local` runtime identity and configuration, while implementing its native process transport and formal control protocol in Rust, wired to the shared Run/Attempt authority. Use the installed CLI and official protocol/SDK as behavior references; do not introduce a Node SDK backend or build against a removed experimental interface.

**Creation and submission.** Capture the native Session ID as early as possible from the init event, then explicitly resume on subsequent turns. Concurrent Chats must not use directory-level continue/latest. Preserve the native Code preset and add Rudder instructions incrementally. Verify that CLAUDE.md, settings sources, Skill, plugins, MCP, permissions, and project root match the authorized native environment; do not assume SDK defaults match CLI defaults.

**Controls.** Route interruption, permissions, AskUserQuestion, and similar requests through live query/control. Distinguish whether the SDK accepts new input as immediate guidance or queues it for later; do not label queued behavior native steer. Test multiple-choice, rejection, waiting, and cancellation.

**Reading.** For users inspecting old Runs, use a versioned native JSONL/SDK raw-entries Reader, filtering by UUID/parent chain and the sealed range. Keep the model-restoration chain separate from the complete-history Reader. When Fork rewrites IDs, establish native source mappings; do not continue querying child history by parent UUID.

**Side Chat.** Prefer a native no-inference Fork helper that supports exact boundaries. For versions that support only fork-on-query, manage the first real input and creation as one operation, persisting creation intent and acceptance state; empty dummy prompts are prohibited. Reach the assistant anchor through the installed version's native API or a legitimate helper; do not manually combine different Session files.

**Retention and cloud.** Use the native persistent volume first. If SessionStore/object mirroring is added, verify mirror failures, duplicate UUIDs, sub-agent subkeys, and recovery integrity; a mirror error must not be treated as a successful backup. When existing file checkpointing is enabled, do not use an incompatible combination or silently disable checkpoints. Retention must also account for native cleanup policy; do not alter borrowed user-global configuration without authorization.

**Must test in a real environment.** Explicit resumption, pre-compaction history, Fork ID rewriting, native configuration and interactions, checkpoint behavior, interrupted mirroring, and child-session recovery. Mirroring is an optional deployment capability, but if this path is used, its tests are a hard gate.

### 8.3 Hermes: Native Product Interaction Is a First-Class Deliverable

**Evidence boundary.** A prior audit of the Rudder Adapter found that it already uses Session/Run HTTP, but still has synthesized tool context and a workstream key derived per Run. Previously inspected fixed upstream source records native Session-backed Runs and richer request semantics; the native TUI uses the product Gateway. [R-HERMES][H-API][H-TUI] Rendered documentation differs from fixed source in version/cache behavior. Do not treat the deduplication window, resumption, or Fork capabilities described by either source as facts that apply to every installed version.

**Rust implementation boundary.** Implement both Hermes backends, their connection ownership, request/response correlation and history projection in Rust. Existing `hermes-gateway` TypeScript is a compatibility reference. A native Hermes Python integration helper may expose installed product APIs where required, but cannot own Rudder admission, authorization, queues, recovery, billing or terminal decisions.

**Preserve one Hermes Runtime that users can understand.** Continue using `hermes_gateway`, with two explicit backends selected internally according to configuration and capabilities. `native_product_rpc` provides complete local product interaction; the managed Host connects to or starts the installed Hermes product Gateway under an authorized Profile. `native_runs_http` is for remote native Session-backed Runs. These are not two unrelated Agent types, and the backend must never switch silently after a runtime error.

**Product RPC path.** Inspect the installed source's method registry/contracts and native UI call patterns. Reuse the actual methods it uses for create/resume, submit, session.branch/compress/interrupt, slash/command, and related operations. `python -m tui_gateway.entry` is a lead from previously inspected source; verify its availability before execution. For additional precise-history or boundary capabilities, write a small, versioned, testable native integration helper in the Rudder Host; do not invent an official RPC name.

**Native interactions.** Treat approval, clarify, sudo, secret, and similar operations as server requests that require responses with the same ID, not one-way notifications. Support request cancellation and one-time/session/long-term authorization scopes; sensitive values must not enter logs. Ordinary input while busy goes into one queue; Steer applies to the current execution, and Stop reflects the actual terminal state. Preserve equivalent interaction for native model selection, media input, commands, plugins, tools, Memory, Skills, Todo, sub-agent list/tail/steer/stop, and output attachments.

**HTTP path.** Probe `/v1/capabilities`, the authenticated Profile, and available interfaces. Use `/api/sessions` to create/read an explicit session. Once native history loading is verified, send only the current input, `session_id`, and necessary incremental instructions to `/v1/runs`; do not attach `conversation_history`, `previous_response_id`, or Rudder-synthesized tool context and pass it off as native resumption. By default, bind the workstream/memory key to the logical Conversation/Profile/principal; do not use a new Run key on every turn or a globally fixed key shared across principals.

Follow the installed protocol for formal idempotency. When the `Idempotency-Key` header is supported, use that header; do not treat JSON `idempotency_key` as equivalent. Persist Rudder operation mappings and test the same key/same payload, conflicting payload, restart, and expiration of the native deduplication window. Older source and rendered documentation disagree about the retention period, so test the actual contract and do not automatically resend after an unknown failure. [H-API][S4]

**State and complete tool process.** Use declared run status, events, stop, and approval endpoints. An SSE tool preview does not represent the complete tool result; obtain full details from the native SessionDB/product-history Reader and retain missing items in explicit object supplements. Display the actual provider/model result and distinguish the user-requested model from the model that actually served the request.

**Only one backend owns an in-flight execution.** Do not start an AIAgent through HTTP and then try to Steer it through a separate TUI process. Switch backends explicitly only at a safe terminal state and when persisted state is compatible. If HTTP lacks complete product questions/Steer, add a native product bridge; a successful ordinary text request does not mean Hermes is complete.

**Compaction, sub-agents, and retention.** Follow the native resolution mechanism from a logical Session to its compacted successor, preserving old Run spans rather than replacing every old ID on each poll. When a background child result arrives after the main SSE ends, retain its causal relationship so the next real user turn can obtain it from native history. Do not start a new model turn without authorization, reopen the parent Run, or bill twice.

**Side Chat.** A native Fork does not imply support for an arbitrary assistant anchor. Calibrate the exact payload and inclusion boundary. If the external interface cannot implement it, use a versioned branching helper from the same native SessionDB/product service; do not fork the latest head and pass it off as the selected history. Preserve Memory and Skills permissions and native pruning policy; long-term Keep resource references must cover all compaction/child-session dependencies.

**Must test in a real environment.** Compare Rudder with the native Hermes product under the same authorized Profile: multi-turn continuity of tool information, restart, compaction, complete tool details, approval/clarify/secret, input queueing/Steer, sub-agents, precise branching, in-place Side Chat Keep, promotion while offline, and retention guarantees after native automatic pruning. An HTTP adapter unit test alone is insufficient.

### 8.4 OpenCode: Managed Native Server

**Protocol basis.** OpenCode officially provides a native Server/OpenAPI, Session, Message/Part, events, asynchronous submission, Fork, Abort, and command interfaces. A 204 response to an asynchronous prompt means accepted, not completed. [S5]

**Change entry points.** Preserve `opencode_local` configuration and split server lifecycle, native HTTP/SSE client, Session mapping, and Transcript projection into Rust modules under the shared executor/Reader boundary. The old `opencode-local` package is a behavior reference. Start or connect to an explicitly owned native Server, defaulting to authenticated loopback; use a protected Host relay remotely. Do not connect to an arbitrary other user's server on a familiar port.

**Creation and input.** Calibrate fields against the installed instance's `/doc` or equivalent schema, and submit the current input parts to the corresponding Session. Preserve native config/providers/agents/plugins/MCP. Verify how the existing `--pure` affects loading behavior; do not blindly retain or remove it. Use native part types for media/attachments rather than flattening them into strings.

**Run boundaries and state.** Record the user message ID, causally related assistant messages, parts, and terminal state. Native acceptance of a client message ID does not guarantee persistent idempotency; test it. An idle session on a shared stream alone does not prove that a particular input has completed; associate the Run with its native messages and results.

**Interactions and reading.** Respond to permission/question requests according to the current schema, and handle tool results and file Diffs. The history Reader reads message/part ranges; isolate SSE by instance/Profile/Session and correctly handle multiline data and disconnection recovery. Invoke native commands through the command API and complete the Run after terminal-state reconciliation.

**Side Chat.** Check whether `messageID` in `/session/{id}/fork` includes or excludes the boundary, and whether the selected assistant message and its associated tool chain are included completely. If a completed-assistant prefix cannot be reached, add a helper at the native Session service layer; do not substitute the preceding user message. Do not implement chat branching through revert/file rollback.

**Must test in a real environment.** More than three consecutive turns; Fork at an exact message; questions/permissions/commands; accepted state after disconnection following a 204; isolation of shared SSE streams; complete details; and history after restart.

### 8.5 Pi: Native RPC and Session Tree

**Protocol basis.** Pi RPC distinguishes low-level agent_end from fully settled, and supports questions/extension UI, Steer, follow-up, and session-entry reading. Its regular fork targets historical user messages, while clone can copy the current branch; extensions can cancel a Fork. SessionManager branch extraction must work together with the higher-level extension lifecycle. [S6][S7]

**Change entry points.** Preserve `pi_local` configuration and drive `pi --mode rpc` from the Rust process owner, explicitly specifying the native Session file/resource and preserving existing managed extensions, MCP, Skills, model, and configuration. Any narrowly required provider-native integration helper must leave admission, authorization, recovery, billing and lifecycle authority in Rust; it cannot become a second Node backend. Do not enable no-session or generate unrelated files for every turn.

**Input and completion.** Map ordinary input, native steer, and follow_up according to the single-queue rule. An input RPC ID provides correlation only; do not infer deduplication by resending the same JSON when acceptance is unknown. Versions supporting agent_settled use that complete termination semantic; retries/compaction may still occur after a lower-level end. Older versions require verified native idle/retry/queue reconciliation; do not guess completion with a timer. If delegating to a native follow-up queue, maintain Run attribution for every distinct user input.

**Session tree and Reader.** Capture the native session header, stable entry ID, and current leaf. Locate a Run by an exclusive start, inclusive end, and leaf/ancestor revision. `get_entries` may include abandoned branches and pre-compaction records; filter by ancestry and execution range. `get_messages` is for the restoration view and does not replace complete history. Use a stable incremental cursor directly when supported by the installed version; for large responses, build a rebuildable index and bounded reads on the Host.

**Side Chat assistant boundary.** Do not pass an assistant entryId directly to a fork that accepts only historical user messages. For the current position, native clone may be used in an isolated branch context. Implement earlier assistant boundaries through SessionManager branch extraction supported by the installed version, such as the documented createBranchedSession capability, while still running valid higher-level validation/extension events.

Do not move the parent-session leaf, truncate source JSONL, fabricate a user message, or bypass session_before_fork. If the extension returns cancelled=true, treat the operation as canceled even when RPC success=true; do not automatically hand off to bypass the extension's decision. Identify any new helper as a Rudder integration; do not invent a standard navigate_tree RPC.

**Extensions and streams.** Support selection, confirmation, text input, cancellation, and portable extension cards. Provide an explicit path for terminal custom components that cannot be represented directly; do not silently ignore them. JSON framing uses only protocol LF; U+2028/U+2029 and UTF-8 split across chunks are not transport boundaries. Bound memory for incomplete frames.

**Must test in a real environment.** Continuation from native persistence; old assistant anchors; concurrent parent sessions; extension veto; complete ancestor history; retries after low-level completion; Unicode and extension UI; and incremental billing that does not recount the entire Session.

### 8.6 Cursor: ACP Native Integration and Genuine Capability Gaps

**Protocol basis.** Current official ACP documentation covers `agent acp`, session create/resume, input/update, permissions, and cancellation. Cursor's custom ask_question/create_plan operations are blocking requests; task, Todo, and image updates are notifications. The documentation also states differences in the scope of MCP support. [S8]

**Change entry points.** Preserve `cursor` / `cursor-local` authentication and configuration compatibility, with Rust owning ACP framing, connection lifecycle, requests and event projection. Use ACP on supported installed versions; do not treat the old print CLI as a permanent capability ceiling. After initialize/auth, use explicit session/new, session/load, session/prompt, session/update, session/cancel, and session/request_permission, verifying fields against the installed protocol.

**Interactions.** Respond to Cursor questions and plan approvals, preserving agent/plan/ask modes. Display notifications through a structured UI; do not omit information users need just because a notification requires no response. Preserve authorized project/user MCP and accurately state native transport limitations such as team-level support.

**Verify history and Fork independently.** The ability of session/load to restore a session does not imply that complete tool history can be read long-term. Verify completeness, pagination/bounded reads, and restart stability. If only continuation is guaranteed, continue using the native Session and save the user-displayable process for that execution in an object supplement; do not put it back into SQL.

**Cursor update-identity gap.** Two identical ACP `session/update` payloads may not have distinguishable stable IDs; `session/load` may replay only a subset as well. The current Reader can display repeated items separately within one replay, but an ID scoped to that replay cannot serve as an annotation anchor across partial replays; a content hash also cannot prove a unique occurrence. To make these updates persistently annotatable, capture a bounded object supplement during execution with an independent occurrence identity, and verify Run attribution, retention, refresh, and restart behavior. A simulated executionRef fixture does not prove the real ACP Run span for the installed Cursor; until verified, continue to fail closed and do not claim complete history.

Do not invent session/fork merely because ACP permits extensions. Probe the installed version for native precise branching and Steer. If they genuinely do not exist, use an explicit visible-context handoff for Side Chat while fully preserving its product lifecycle. This compatibility record must not claim lossless native branching or become a downgrade excuse for the other five Runtimes. Do not scrape a private IDE database as an unverified core contract.

**Must test in a real environment.** Restart recovery; questions/plans/permissions; complete history or object supplements; Side Chat lifecycle; and accurate display of capability differences. Older versions remain supported for compatibility, but an incomplete ACP path must not be marked as full native support.

## 9. Storage Optimization, Retention, and Cloud Deployment

### 9.1 Where Data Lives

| Data | Default storage policy | Reason |
|---|---|---|
| Run/Attempt state, costs, source associations | Small structured records in the business database | Reliable scheduling, audit, and business results |
| Binding/Segment/Span | Database references and boundaries | Know where to read and which range to read |
| User messages and final body | One product message; asset references for large attachments/artifacts | Lists, basic history, and search must not depend entirely on Host availability |
| Complete native tool/reasoning display process | Native persistent storage | Avoid full duplication in Rudder |
| Per-token/per-stdout notifications | Temporary buffer with time/size limits | Active streaming and short-disconnection recovery |
| Operation intents, approval decisions, submission receipts | Small persistent records | Prevent duplicate side effects and preserve control state |
| User annotations/Stop prefix | Necessary short, exact copies | Restore product state after native rewriting |
| Complete visible process missing from native storage | Explicit object/log supplement | Preserve functionality without pretending it is native-only |
| Legacy Run logs | Keep a compatibility Reader, following existing retention rules | Non-destructive migration |

### 9.2 Audit Every Write Path

Inspect Generation events, message transcript, Run events, raw run log, accumulated stdout/stderr, resultJson, contextSnapshot, recoveryCheckpoint, Fork copies, learning data, debug exports, and telemetry. Do not stop writes to one table while continuing to store all tool output in another JSON field.

Raw Run logs may already live in a separate Log Store, so measure SQL growth and independent-log growth separately before the redesign; do not conflate the two. Set reasonable limits for body previews, error summaries, and hashes; a hash cannot replace original text that must be restored. Also remove long-term retention of large full stdout strings, and bound server and browser caches by size/time/count.

### 9.3 Gate for Enabling Reference-Only Storage

For each Runtime/Profile/version, pass the following validations before disabling duplicate writes: native state can be durably restored; complete ranges for old Runs are readable; boundaries remain stable after compaction/Fork; permitted tool details include more than a preview; permissions and Stop cutoffs are consistent; existing retention policy will not erase permanent Chats; and Host and backup lifetimes meet deployment requirements.

The transition modes are: `legacy` → `native_mirrored` → `native_reference`; genuine gaps may use explicit `native_plus_objects`. Mirrored mode performs temporary dual writes and comparisons for the same execution; it must not run the model twice. Limit its validation scope and exit after acceptance. Staying in mirrored mode long-term or leaving the feature flag disabled does not meet the storage goal.

“The native model still remembers” does not mean “the user's complete history still exists.” When displayable data is missing, first add reliable reading/object storage, then disable the old copy. Do not lose functionality in order to claim native-only storage.

### 9.4 Host and Cloud Boundaries

```text
Local: UI → Rudder → local Runtime Host → native persistent volume
Cloud: UI → Rudder control service → authenticated Host connection → native persistent volume
Optional: native persistent volume/necessary process objects → permission-controlled object archive
```

The first Host is an internal code boundary and may run in the same process as Rudder; a complete cloud platform is not required up front. Keep local paths, reads, process control, Profiles, and resource location on the Host side so future remote deployment does not require replacing the interface.

The cloud business database does not store the complete raw Transcript, but native data still needs reliable storage. Ephemeral containers without persistent volumes may not enable a single-copy native-storage mode. If object-based recovery is used, verify versions, complete manifests, required Workspace/checkpoint dependencies, and child resources; restoring a model Session is not the same as restoring the filesystem.

When the Host is offline, display product content that has been saved and clearly indicate that the native process is unavailable; do not render an unreachable source as empty history. To guarantee complete process viewing offline on any device, an additional authorized copy/archive is required; this cannot be guaranteed while also requiring that no copy exist.

### 9.5 Retention, Cleanup, and Failures

Keep upgrades the resource claim to long-term retention. Before cleanup, recheck actual references, source ancestors, descendant dependencies, active Runs, cleanup epoch, and native deletion cascades. When the native Runtime prunes automatically, coordinate managed Profile configuration with claims; do not change global retention policy on a borrowed user Profile.

“Permanent Chat” means no product TTL; it does not mean data can be restored from the only disk copy after a user manually deletes it. Show missing data accurately. A successful mirror-upload message does not prove recoverability: validate the complete manifest/digests and confirm all child files and objects exist before considering deletion of the last local copy.

Test disk-full conditions, insufficient permissions, native-database locks, backup failures, partial writes, and protocol upgrades. When capacity is insufficient, block unreliable new execution or fall back to an explicitly configured reliable storage policy; do not silently discard process data. Do not copy the entire growing Session for every Run; archive using native increments, deduplicated objects, or controlled snapshots.

## 10. API, Code Locations, and the TS/Rust Boundary

### 10.1 Preserve Product APIs and Migrate the Underlying Implementation

Keep existing Chat/Side Chat send, control, Keep, and close URLs and UI behavior compatible. The underlying redesign does not require users to switch to a new page or callers to provide arbitrary native Session IDs directly.

Prefer adding capabilities to the existing Agent Run facade. If no equivalent capability exists, one may add interfaces equivalent to the following. These are suggested Rudder APIs, not existing paths or upstream Runtime URLs:

```text
POST /api/agent-runs                         Submit new input and SessionIntent
GET  /api/agent-runs/:runId/transcript        Paginated read of that Run
GET  /api/agent-runs/:runId/transcript/:itemId  Read restricted details
POST /api/agent-runs/:runId/control           Control with the expected Attempt
POST /api/agent-runs/:runId/requests/:id      Respond to a valid native human request
GET  /api/chats/:id/history                  Authorized session-read projection
```

Reuse an existing equivalent endpoint where available; do not provide duplicate public APIs just to match this document. Revalidate permissions through the Run/Conversation for every item access. All mutations use existing error formats, activity logs, and idempotency mechanisms.

### 10.2 Key Code Map

| Area | Known entry point or directory | Expected change |
|---|---|---|
| Chat calls | Legacy behavior: `server/src/services/chat-assistant.ts`, helpers | Rust owns surface validation and Run admission; TS transports typed input without history replay or ordinary-result repair |
| Run core | Legacy behavior: `server/src/services/runtime-kernel/`; wire types: `packages/shared/src/agent-run.ts` | Rust owns SessionIntent, leases, recovery, spans, and costs; TS is transport only |
| Data model | `packages/db/src/schema/heartbeat_runs.ts`, chat schema and migrations | Add bindings/spans/references compatibly; do not rename throughout the repository |
| Runtime public boundary | `packages/agent-runtime-utils/` and existing shared types | Typed native input/events/capabilities and Reader |
| Six Adapters | Rust provider protocol modules plus `native-chat-executor`, `runtime-core`, D1 and Foundation; legacy `packages/agent-runtimes/*` remain references | Rust owns native transport/session/control/history for all six; preserve public runtime keys and configuration |
| Side Chat | Legacy behavior: `server/src/services/side-chats.ts`, family/annotation helpers | Rust owns first Send branching, in-place Keep, retention, and independent cancellation; preserve existing UI contracts |
| Controls and events | Legacy behavior: chats stream routes, chat-generation-protocol, run-events | Rust owns ordered reduction, persistence, terminal state and replay; TS relays typed events without a second reducer |
| UI | `ui/src/pages/Chat*`, `SideChatPanelView.tsx`, `RunTranscriptView*` | Same semantic projection, independent state, lazy loading, request/response round trips |
| Native Rust | `native/crates/{d1-persistence,server-foundation,runtime-core,runtime-attempt-core,run-evidence-core}` | Own all new backend business behavior and wire the actual public call paths, not just private helper functions |

Paths come from prior audits and are navigation leads; locate them based on files present locally before implementation. A directory's existence does not mean it is wired into production; trace the actual Router → Service → bridge → runtime call chain.

### 10.3 Coordinate with the Ongoing Rust Migration

The October 16 backend policy supersedes the earlier incremental ownership allowance: all new Native Chat business authority belongs in Rust, including binding/segment/span persistence, conversation and turn lifecycle, authorization, ordered event reduction, replay/deduplication, cancellation, recovery, and terminal outcomes. Follow `doc/engineering/BACKEND_ARCHITECTURE.md`. Historical TypeScript implementations are behavior and test references, not an implementation that may be merged first and ported later.

New provider process/connection management and protocol framing also belong in Rust. Existing TypeScript adapters may remain temporarily as compatibility transport, alongside frontend presentation; do not add new Node routes, middleware, business services, or provider implementations. Each temporary adapter must identify its Rust owner, allowed transport responsibilities, authentication context, error contract, cutover criterion, and regression tests. It must not query business state, decide a terminal outcome, or write binding/session/run records. Rust failure must fail visibly without a hidden Node business fallback.

Legacy business services must also refuse Native-owned records during coexistence. Source-bound exclusion checks and the exact shared target lock may reduce their existing write domain; they must never authorize or execute Native work, mutate Native records, or provide a fallback. These retirement fences need explicit independent source review, a narrow ratchet classification and concurrent winner-order regressions; they do not grant a general permission to add Node queries or writers.

Resume from current main in verifiable slices: first Rust-owned binding/segment/span transactions and authorization; then Run admission, native event reduction and durable turn outcomes; then provider transport and shared Reader integration; finally all product consumers and per-runtime duplicate-write shutdown. Existing schemas and compatible UI/provider work should be reused selectively. Each slice must wire its real entrypoint and exercise durable readback, cross-organization denial, stale/duplicate input, and Rust-unavailable behavior before claiming acceptance. The full six-runtime and Side Chat scope below is unchanged.

#### Current adapter boundary inventory (October 16 implementation)

| Operation / public path | Transport and Rust owner | Remaining Node responsibility and cutover | Regression evidence |
| --- | --- | --- | --- |
| `GET /api/orgs/:orgId/chats/:chatId/runtime-binding`; `GET /api/orgs/:orgId/runtime-bindings/:bindingId` | Rust `server-foundation::public_ingress::runtime_bindings` / `d1-persistence::runtime_bindings` | No Node route or authorization adapter. API-key authentication retains the expected `last_used_at` telemetry touch; binding/business reads do not mutate state. The opt-in Rust public listener resolves persisted `pcp_` Board/Agent keys and revalidates credentials, membership, target ownership and projections in one repeatable-read transaction. Cookie, local JWT and implicit identities are not yet supported on these new reads and return 401. Node remains the default listener for existing unmigrated product workflows; these reads require the Rust listener. Unmatched methods/namespace variants never fall through to Node. | Real PostgreSQL source-binary public workflow: shared/owner access, foreign-org denial, private-field redaction, restart identity, unsupported credentials, and database-unavailable 503 with zero Node upstream calls. A stopped Rust listener means connection failure, not a Node-generated 503. These reads do not establish ordinary Chat send/control migration. |
| Private `runtime.binding.ensure` | `services/runtime-binding-bridge.ts` serializes the typed command; `d1-persistence::runtime_bindings` owns creation/idempotency/conflict and activity/outbox transaction | The binding authority is internal. Caller-supplied identity is not exposed as a public create endpoint; later Rust Run admission must derive the profile/workspace/revisions from authoritative configuration. First epoch only; no implicit rotation. | Concurrent ensure, identity conflict, audit uniqueness, rollback, org/owner denial and read-no-write tests. |
| Cursor native session locator transport | `packages/agent-runtimes/cursor-local/src/server/{parse,index,execute}.ts` | Existing provider process/protocol adapter preserves nonblank opaque identifiers byte-for-byte. It does not establish new lifecycle/persistence authority. Existing CLI execution is still legacy runtime debt until Rust admission and terminal authority are wired. | Cursor adapter/execute regression tests for padded and blank identifiers. These tests do not prove native ACP support or live-provider acceptance. |
| Disabled ordinary Chat admission | `d1-persistence::native_chat` owns the message, Generation, Run, initial Attempt and activity transaction; no public route calls it yet | No new Node writer. Native ownership, active/held uniqueness, exact input idempotency and first-Attempt identity are represented in the schema. Public activation still requires legacy-writer exclusions, durable runtime supervision, projection and recovery. | Disposable PostgreSQL admission tests; migration/schema constraints and independent review are required before accepting this slice. No provider execution claim. |
| Codex App Server wire and process access | `rudder-codex-app-server` decodes bounded frames and correlates exact pending request IDs; `rudder-process-host::run_host` exposes the existing Rust supervisor as a library | New process/protocol work is Rust. No Node process adapter is introduced. Neither a successful RPC nor a completed stdin write authorizes terminal state or resubmission; the durable Rust supervisor remains responsible for checkpoints and reconciliation. | Real-child integration plus an opt-in installed-Codex test exercise initialize, unknown-Thread error readback and owned-process Stop using an empty isolated profile, without auth or model calls. These prove transport only, not two-turn continuity or Chat acceptance. |

These entries describe the partial implementation, not completion of W00–W13. Native turn projection tests alone do not establish durable admission or public send/reconnect/cancel coverage.

The next private Rust execution layer resolves Codex configuration from the selected Agent, Conversation, exact Issue workspace and a host-constructed local context before claiming an admitted Run. The caller cannot deserialize host facts, execution fences or effect permits. Unsupported runtime settings fail explicitly rather than silently dropping tools, permissions or capabilities. Instruction bundle reads are bounded during traversal and reading, with descriptor-relative no-follow access on Linux/macOS; existing filesystem-backed bundles fail closed on unsupported platforms, including Windows, until an equivalent reader is implemented. This platform limit does not establish full Windows Native Chat support.

First claim establishes separate Run and Generation leases and paired admission holds. Checkpoint transitions compare the exact current phase and revision under both live fences. Only a newly committed indeterminate pre-effect transition returns a move-only dispatch permit; restoring a checkpoint does not authorize replay. Claim locks referenced Project, Workspace and Issue rows before the Conversation, revalidates those references, and rejects concurrent Agent/Run changes with 409 through narrowly scoped nonblocking row locks. Provider terminal observations still cannot complete a Run or release its hold.

The owned Rust Codex transport now combines bounded process output, request correlation and receipted UTF-8 stdin chunks. It forwards provider approval requests without answering them. Fatal receive deadlines close the connection; a separate nonfatal polling API preserves partial frames while the future supervisor renews leases and enforces its own deadlines. These APIs remain unconnected to public send, trusted Binding/Segment admission, terminal reconciliation and billing; they do not prove two-turn continuity or a usable Chat journey.

The private Rust admission entry now requires a host-constructed local context. Exact client-mutation replay is resolved before configuration validation, so an unchanged retry may return its original receipt after configuration changes. For new input, the authority locks and revalidates the Issue ancestry and Conversation, resolves current host/profile/workspace/instruction/capability identity independently of stored Binding values, and ensures the exact Binding and current Segment in the same transaction as message/Generation/Run/Attempt creation. Unsupported configuration or identity mismatch rejects the entire transaction without rotation or partial admission. Only a Binding with `continuity=native` is eligible; matching `legacy` or `context_handoff` bindings are rejected without rotation. A pending Segment without a locator starts fresh; an open, unsealed Segment resumes its exact opaque Thread. The first Attempt of each new Run still has `resume_source=fresh`; `same_session` is reserved for recovery within that Run. Rust-generated `context_snapshot.runtimeBindingId` and `context_snapshot.nativeSegmentId` record the durable association, which claim revalidates before granting execution ownership. These persistence APIs remain disconnected from public send and provider supervision; persisted continuation intent alone does not prove actual same-Thread execution. Existing Agent removal is not yet compatible with retained native bindings: the restrictive Agent foreign key prevents deletion and rolls its transaction back. Public activation requires Rust-owned removal to return an explicit conflict or implement retention-aware cleanup; tests must not hide this gap by deleting bindings directly.

The disabled Rust admission preflight checks all applicable active billed-cost hard-stop policies with positive limits. Calendar-month spend uses a UTC half-open window evaluated after conversation locking; lifetime spend includes all timestamps. Unknown active window kinds return 409 before mutation. Checking every policy and rejecting unknown windows are deliberate validation corrections to the legacy service, which selects an unordered first policy and treats unknown windows as all-time. This slice only checks observed spend: it does not reserve concurrent budget, settle costs, pause agents, or deliver cancellation effects.

The current durable Chat-to-Run association is `heartbeat_runs.context_snapshot.chatGenerationId`, supplied by the normal, queued and recovery call paths; it must be validated against the exact generation and conversation rather than inferred from the newest Run. Generation control and Run execution use separate owner tokens and epochs. The native event identity therefore includes both `generationAttemptEpoch` and `runAttemptEpoch`, plus organization, conversation, generation, binding, segment, Run, Attempt and connection epoch. Rust admission must create a real durable Attempt and populate its owner/epoch fields. The dedicated `chat-assistant.ts` path currently creates a Run and executes the adapter without writing `heartbeat_run_attempts`; the separate legacy heartbeat ledger leaves owner/epoch fields null. Neither path can satisfy the new span fence. Existing Rust Run, ChatScheduler and Attempt machines are pure state machines, not database admission authorities. The next slice must own Run/Attempt admission, budget checks, lease renewal and terminal transitions in Rust before wiring spans into Chat. Preserve fail-closed behavior until admission is migrated.

Provider events cannot assert execution completion. The Rust Attempt authority supplies terminal evidence separately; a provider final plus successful execution evidence is required for completion. Commit an indeterminate submission checkpoint under the live fences before the transport writes input. An unknown or indeterminate submission reconnects to existing events without submitting input again. Checkpoint storage must use an exact predecessor/version check so restoring a valid older snapshot cannot overwrite cancellation, terminal evidence or deduplication history.

Span/locator writes attach evidence to an already admitted Run. Side Chat expiry checks must distinguish new admission (reject expired or missing TTL) from a Run admitted before its expiry (may finish under its current execution fence). Neither history reads nor late callbacks refresh expiry or revive a committed expired/deleted conversation.

The first Rust execution slice targets Codex App Server JSON-RPC, not ACP. Only the first Run on a pending Binding may create a new Thread. Subsequent Runs must resume the exact authorized Thread on its current Segment and submit only newly accepted input; rebuilding a prompt from SQL conversation history is not native continuity. Acceptance requires two turns and a Rudder/App Server restart with the same Thread, one input per turn, and refreshed reply readback. Rust must also bind each Span to its exact Thread/Turn selector; a session locator alone is insufficient.

Rust-owned Run/Generation rows need a durable ownership discriminator before any live opt-in entrypoint is enabled. All legacy TypeScript recovery, reaper, Stop, cleanup and terminal-projection paths must exclude those rows or delegate to their Rust owner. A native failure must not dispatch the legacy path. Recovery must preserve historical Attempt/Span ownership: a new executor needs an explicit append-only reattach Attempt and continuation relation to the same provider Turn, with separate Run-attempt and connection epochs. Unknown provider acceptance stays unknown and must never cause resubmission. This transfer must first be proven by persisted race/restart tests; changing only the Run owner token is invalid.

The vertical slice also needs a Rust-owned final reply projection or an exact native Reader that the existing Chat refresh path can render. Run/Generation events alone do not prove a visible reply, and leaving the TypeScript finalizer active creates a second writer. Budget completion requires actual idempotent cost settlement, incident/activity and pause effects, plus a working durable consumer for any asynchronous cancellation; an outbox intent alone is not completion. Preserve the complete W00–W13 denominator while these execution, Reader, Side Chat and six-runtime gates remain open.

Native admission must atomically persist the user message, Generation and Run in Rust. TypeScript may relay the typed input and client idempotency identity, but cannot perform the message write before native admission. A later conversation turn resumes its exact Thread through the Run's SessionIntent; its first Attempt still has `resume_source=fresh`. Reserve `same_session` for recovery within the same Run. Unknown submission or surviving-process state must retain a durable conversation admission hold, including after a transport interruption, so another message cannot start a concurrent Turn. Release that hold only through an explicit fenced reconciliation. A provider terminal notification is separate from process quiescence: terminate and await the owned process tree before releasing its claim or rotating ownership. Usage alone is not billed cost; absent an authoritative configured billing source, fail closed where billing enforcement is required and leave cost/hard-stop acceptance open.

Codex readback must remain bounded as a Thread grows. The inspected local App Server schema supports metadata-only `thread/read`, `thread/resume` with `excludeTurns=true`, paged `thread/turns/list`, and `thread/items/list` filtered by exact `turnId`. Prefer these supported methods to hydrating full Thread history. Preserve opaque cursors and exact Thread/Turn identities, enforce page/byte limits, and return incomplete or reconciliation-required evidence if the selected Turn cannot be resolved within those bounds. Verify runtime capability before relying on these methods; an unsupported method does not authorize SQL history replay or unbounded full-history fallback.

Protect other migrations in progress in the worktree: do not overwrite, reset, or pull unrelated refactors wholesale into this PR. Complete changes to schema/shared/server/ui/native together and preserve existing compatibility reads. Completion of this project does not depend on the repository-wide Rust migration being finished.

### 10.4 Exact input and Thread association boundary

The private Rust execution API now loads only the admitted user message while its checkpoint is `input_pre_submission`. It verifies the original admission fingerprint as well as the message fingerprint, bounds the body before materializing it, and checks the current Run/Attempt and both leases. Edited input, foreign messages, and indeterminate submission states cannot supply a fresh payload. Reading the payload does not grant permission to dispatch it: the supervisor must consume the subsequent matching move-only submit permit exactly once.

Claim pins the exact Binding and Segment IDs inside its non-serializable execution fence. Every later fenced access reauthorizes organization access before reading Run hints and requires the Run snapshot to match those pins. Replacing a binding for the same Chat and rewriting its snapshot cannot redirect an existing execution. Recording a newly created provider Thread changes its pending Segment to open in the same transaction as the Attempt checkpoint, Run/Generation provider IDs and activity. A later CAS or audit failure rolls back the locator too. The existing target-advisory-first lock order is retained.

This boundary remains private and does not dispatch a provider turn or finish a Run. Its acceptance must cover exact input, post-admission edits, same-target binding replacement, stale owners and rollback of Thread persistence. Provider supervision, process-death recovery, final response projection, billing, public send/control, Reader and Side Chat remain open gates; no percentage or full-feature completion follows from these persistence checks.

### 10.5 External Rust process ownership

Actual dispatch must use an external Rust process host, not only an in-process host thread: a hard kill of the Rudder caller cannot run its destructors. The explicit host `--stdio-mux` mode preserves the existing command protocol and frames lifecycle, stdout and stderr on one bounded output channel. The legacy descriptor-based host interface remains available. Raw frames carry at most 8 KiB, envelopes at most 32 KiB, and the host writer queue holds at most 32 frames. A stalled or disconnected consumer causes host cleanup without an unbounded writer join.

The Codex transport validates envelope version, stream shape and lifecycle request/owner identity. It closes the sole command writer on caller loss and preserves receipted stdin/RPC ordering. Parent-SIGKILL acceptance must use a real separate caller and Rust host, then observe that its synthetic provider has been reaped. A lost or killed host itself remains an unresolved execution: EOF, helper exit, timeout or destructor completion never substitutes for an exact cleanup receipt, and none releases database admission holds. Restart/adoption requires durable process birth identity and reconciliation before activation.

Before a private one-turn executor dispatches input, bind its move-only permit to the full fence, exact Thread, original input fingerprint and current lease; reject stale permits immediately before writing. Persist typed provider terminal evidence separately from Run completion. Unsupported plan-mode configuration must reject before admission until an installed-protocol mapping is proven. Public claim must also normalize inaccessible Run identifiers so same-organization Agent requests cannot distinguish absent and unauthorized targets by error status.

### 10.6 Private Rust one-turn executor and configuration provenance

The next executor slice joins the persistence and external-host boundaries in Rust. It owns claim, initialize, exact Thread start/resume, loading the admitted input, indeterminate submission, response correlation, provider terminal observation and Stop. Only freshly committed effect permits can produce a short-lived move-only authorization. Authorization rechecks both owner leases, the exact checkpoint revision, Binding/Segment and original input fingerprint; its monotonic deadline includes database time and never exceeds two seconds. A synchronous consuming dispatch callback cannot be recreated by reading a checkpoint. This narrows the authority-to-enqueue interval; it does not make a database transaction atomic with an OS write.

An owned async entry delegates blocking transport work to a blocking worker, requests cancellation when its future is dropped, polls with bounded waits and renews both leases. Cancellation and operation deadlines are checked again immediately before effect dispatch. A provider approval request stops execution and retains the hold until governed interaction support exists; it is never auto-approved. A matching `turn/completed` observation does not finish the Run, release either hold, charge usage or establish a durable final response. EOF and failed cleanup remain indeterminate. Finalization, recovery and public activation remain required later work.

Configuration provenance is a dispatch gate. Rust provisions only an empty dedicated persistent profile, with an exact native marker and minimal regular config file; existing operator/Node profiles and credentials are neither copied nor overwritten. Authentication must be provisioned through a separate authorized flow. Child environment, HOME/USERPROFILE, CODEX_HOME and initial working directory are explicit. The installed Codex contract supports `--strict-config`, feature disabling and `config/read {cwd, includeLayers:true}`. Before Thread operations, reject unexpected or project config layers and effective policy drift. Explicit non-ephemeral Thread creation, exact model/effort/workspace and approval/sandbox policies are required. This restricted private slice is not native feature parity; unsupported skills, plugins, MCP, browser/computer/search and plan mode must remain explicit errors until their native scope and controls are mapped.

Exact input completeness is required before dispatch. Until native attachment/structured-input transport exists, reject attachment-bearing or structured source messages both before loading and at final authorization; never send only their text and report success. Integration acceptance must use the actual exported executor with disposable PostgreSQL, the external Rust host and a controlled RPC provider, including early terminal observations, approvals, expired ownership and ambiguous process loss. Real provider turns, public user journeys and all six runtime integrations remain separate completion gates.

For a later admitted Run, claim atomically mirrors the validated revision-zero Attempt Thread into the private Generation control fields before any fenced read or resume RPC. The private Attempt/checkpoint and Segment remain authoritative. Native Run `session_id_before` and `session_id_after` stay NULL because existing legacy Run readers publish those columns. This records the already selected native session privately; it does not assert provider acceptance. Resume must address that exact Thread with `excludeTurns=true`, preserve the existing Segment, and send only the current admitted message. A mismatched resume response cannot dispatch a Turn. The private executor still leaves Run and Generation lifecycle finalization to the next Rust owner; protocol terminal observation alone leaves the admission holds intact.

### 10.7 Rust single-turn finalization and unknown-cost disposition

First claim assigns the resolved model to the locked Attempt exactly once and captures it in the in-process execution fence. Every subsequent fenced operation compares that selected model with the Attempt row. The same immutable execution configuration supplies the provider request; a later Agent configuration edit cannot change the recorded model. Usage metadata labels this provenance with `modelSource=execution_config`: it identifies the selected/requested model, not an authoritative claim about the model an upstream alias actually served.

The next private slice consumes opaque, connection-bound Turn and cleanup receipts from the Rust transport. The receipts must match each other and the durable organization, Conversation, Generation, Run, Attempt, Binding, Segment, Thread, Turn, owner, and epoch fences. Provider terminal observation alone remains insufficient. Persist one supported final assistant message, the latest reported `tokenUsage.last` increment with model/source provenance when reported, a sealed primary Span, terminal Run/Generation/Attempt state, and ordered events/activity in one transaction. Do not promote commentary, tool output, or an empty successful response into a final answer. An unsupported final answer becomes a durable failed Run/Generation reconciliation outcome with admission holds retained and reason `native_provider_completed_without_projectable_answer`. An interrupted provider Turn maps to a cancelled Run, stopped Generation, and the existing supported `stopped` assistant-message status.

Open the primary Span in the initial claim transaction. Finalization uses the existing Conversation → Generation → Run → Attempt → Binding/Segment → Span lock order, checks both owner leases after all event/activity writes, and commits an idempotency fingerprint with its result. Exact retries reauthorize the current actor after acquiring target serialization and the Conversation row lock, including a fresh organization-access check after either wait. They return the existing result without requiring a now-retired lease or inserting duplicate messages/events. Historical read access remains distinct from permission to start another Turn. Deterministic regressions revoke membership while a retry waits on each lock and require denial with unchanged persisted results and counts. Conflicting receipts fail closed. Opaque receipts are in-process evidence, not a new restart/adoption authorization; restart reconciliation remains a separate gate.

Upstream Codex `TokenUsageInfo::append_last_usage` accumulates the latest increment into thread totals and replaces `last`; `last` is not the complete user Turn. Preserve changing correlated notifications as the latest increment, never sum duplicate observations or present a last response as Run usage. In this slice, persist `usage.status=unavailable`, `reason=run_total_not_established`, and nested `latestReportedIncrement` metadata with source, model and Rudder Attempt ID. Provider Thread/Turn locators remain in private Attempt/checkpoint/Span records and internal resume session-intent and never appear in persisted public result, usage, event, or activity payloads. Complete Run usage requires an exact pre-Turn baseline and final cumulative Thread total with reset/restart handling; thread cumulative usage cannot be attributed wholesale to a resumed Run. Sources: [Codex protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), [OpenAI Symphony accounting semantics](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md).

Cost is explicitly `unknown` when this Codex protocol does not report authoritative billing. Persist no invented zero and no `cost_events` row. Until settlement exists, an applicable billed-cents hard stop rejects claim and effect authorization. A shared per-organization database advisory lock, acquired by native operations before target/row locks and by a trigger on every budget-policy mutation, orders policy inserts and updates with finalization. If a policy appears during execution, persist the terminal answer and evidence but retain both admission holds with `budgetDisposition=reconciliation_required`. Removing the policy does not automatically clear an existing hold; a later explicit reconciliation authority is required. This private slice does not claim budget settlement or public readiness.

Extend the native-authority accidental-writer guards to Generation events, Run events, and cost rows, checking both old and new associations. Keep schema migrations append-only. Migration 0180 removes only native Run session mirrors after proving every existing locator has a private Attempt copy; it refuses an unbacked locator and preserves legacy Run values. A database trigger prevents even a marked native writer from reintroducing those public-column mirrors. Acceptance must cover exact retry, cross-connection receipt rejection, failed/interrupted/unprojectable terminal outcomes, a policy insertion racing finalization, persisted unknown-cost holds, mixed legacy/native writer exclusion, and continuation on the same exact Thread after an unbudgeted successful finalization. Public Chat/Reader activation, real provider turns, all six runtime integrations, Side Chat controls, restart recovery, and billing settlement remain open workstreams.

### 10.8 Rust browser authentication before public Chat activation

Implementation checkpoint (October 17): `server-foundation::browser_auth` now verifies current issuer cookies and Board API keys, and the standalone Rust public listener can own `GET /api/auth/get-session`. Activation is explicit through `PublicIngressConfig::with_browser_auth` or `RUDDER_NATIVE_BROWSER_AUTH_MODE=required` with `RUDDER_NATIVE_BROWSER_AUTH_SECRET` and explicit `RUDDER_NATIVE_BROWSER_AUTH_SECURE_COOKIE=true|false` and `RUDDER_NATIVE_BROWSER_AUTH_SESSION_POLICY=local_account|better_auth`. The policy preserves local-account fixed expiry and Better Auth's current seven-day lifetime / one-day renewal threshold, including its signed `dont_remember` cookie. Regression fixtures compare native expiry changes against the actual existing resolvers; this endpoint does not issue a new cookie. The secret is passed unchanged and must match the issuer; it is not inferred from a request or replaced by a development default. Environment-based activation rejects local-implicit mode: an independent environment marker cannot prove that the actual host has disabled local-account authentication. A future embedding may use the programmatic local-implicit constructor only with the same validated local-trusted, private, optional-auth startup facts and loopback listener that govern the rest of the app. Account-enabled hosts must use required mode. At this standalone checkpoint the Node launcher did not yet transport this configuration; it did not establish default Desktop activation. Without activation, existing session routing remains unchanged; any later enabled Native Chat route must require native auth configuration and fail closed instead of entering that compatibility path. Real-listener regression tests use cookies issued by the existing Better Auth and local-account services against disposable PostgreSQL. Independent standalone acceptance passed on commit `9b42176a495a8c2fb7d62f3f404cc1538b0a7f89` with the exact pinned binary: six actual issuer cookie variants, renewal parity, invalid/expired/deleted credentials, restart, alias/method guards, database failure, and a counting compatibility upstream with zero criterion requests. The full Rust baseline passed 800 tests (38 explicitly ignored), strict workspace Clippy, and repository TypeScript typechecking. The default-launcher cutover remains outstanding; the separate packaged Desktop verdict is still QUESTION because its required disk headroom is unavailable. Repository lint retains 20 unrelated pre-existing failures after the new fixture import-order fix; full Node tests and repository build have not been rerun for this checkpoint.

Launcher integration checkpoint (October 17, independently accepted at `77d0627a5f48cbacef2724e9b014533fb45466b2`): the constructed auth runtime now supplies an immutable issuer descriptor through `preparePublicIngressStartup` and the process bridge. Better Auth contributes its effective context secret, cookie names/security, and renewal policy; local-account auth contributes its exact existing session secret and secure-cookie policy. Rust rejects unknown fields, unsupported renewal policy, mismatched cookie names, or competing standalone environment settings without echoing secret-bearing input. Required-auth startup rejects a missing descriptor before acquiring resources and validates a native session-read-only, no-fallback receipt. Optional local-implicit startup remains unchanged.

This boundary transports configuration only. `native/crates/server-foundation/src/browser_auth` owns public `GET /api/auth/get-session` identity, storage lookup, response, expiry/renewal, and failure behavior. The six Node files in this slice are startup/configuration/receipt transport (`auth-runtime.ts`, `public-ingress-startup.ts`, `index.ts`, `rust-foundation-bridge.ts`), existing auth-route placement and startup guard (`create-http-app.ts`), and legacy authentication-log redaction (`middleware/logger.ts`). Existing Better Auth/local-account issuance, logout, other compatibility API authorization, and their data writes remain Node-owned migration debt and excluded from native authority claims. The route-order repair lets existing Better Auth credential handlers run after hostname/actor checks but before the ordinary account-session gate; exact session GET retains its explicit user check, and ordinary APIs retain that gate. Authentication request bodies are redacted before logging, including failures and rate limits. Retire these boundaries only when Rust owns issuer lifecycle and the remaining application startup/auth responsibilities.

Automated workflow coverage uses actual bootstrap components, a source-built Rust process, disposable PostgreSQL, six issuer-cookie variants, public sign-up/logout, restart, renewal, invalid Bearer precedence, anonymous ordinary-API denial, and foreign-origin denial with production issuer checks enabled. A Rust-only database transport outage preserves Node availability and must return 503 with zero session requests reaching Node. Independent launcher acceptance passed 221 assertions across six actual issuer variants, followed by final scoped reviewer ACCEPT. This receipt is separate from the prior standalone receipt. Packaged Desktop acceptance remains QUESTION pending its required disk headroom; this integration does not establish public Chat worker, cancellation/recovery, or full backend retirement.

The Rust browser-actor resolver and reserved public session-read route now exist. The ordinary launcher has independent acceptance; the remaining authentication deployment gate is packaged Desktop cutover; public Chat mutations additionally need native Origin/Referer enforcement and the supervised worker lifecycle below. Sign-in/sign-out issuance stays on the existing compatibility path in this bounded slice. The UI DTO keeps its synthetic `rudder:{source}:{userId}` identifier; the real database session identity stays internal for authorization and revocation. With required native browser auth enabled, Rust reserves the exact public session path and its aliases before compatibility forwarding. Node's duplicate exact GET remains on the loopback compatibility listener only and is never a native-failure fallback. With native ingress disabled, the legacy routing remains unmigrated behavior.

Pin and separately verify the installed Better Auth and local-account cookie names, signatures, encoding, and secure-cookie policy using cookies issued by the existing runtime; do not assume their formats are interchangeable. Require an explicitly configured secret. Resolve expiry, user identity, active organization membership, and instance-admin role in Rust, with requested-organization authorization revalidated in the operation's database snapshot. Derive local-implicit authority only from immutable startup configuration that requires loopback listening and private exposure; when local account authentication is enabled, require its session. Request headers and forwarded-host claims cannot grant local trust.

Reserve the migrated route and equivalent aliases before the compatibility proxy. Invalid credentials, database failure, and native authorization failure must not fall back to Node. Before public Chat mutations are enabled, apply a Rust Origin/Referer policy derived from configured trusted origins to cookie-session actors; preserve the explicit local-implicit and bearer actor distinctions. A successful session read alone does not enable sending. Public send/stop/reconnect additionally requires a Foundation-owned supervised worker, lease renewal, durable event replay, fenced cancellation, and restart reconciliation that retains holds and avoids resubmission while effects remain unknown.

Acceptance for the authentication prerequisite must exercise the real Rust listener and PostgreSQL with valid, expired, revoked, and tampered cookies issued by the existing auth runtime; active and revoked memberships; instance-admin behavior; local-implicit rejection outside the configured loopback/private mode; and zero Node fallback on native failure. Cover missing and foreign Origin rejection on the next cookie-authenticated mutation route before activating it. Existing tests that mock session resolution do not establish this acceptance. This prerequisite does not complete the public Chat workflow, Reader, Side Chat, six-runtime parity, or billing settlement.

### 10.9 Foundation-owned private Rust worker

The October 17 worker checkpoint adds a typed, process-owned Rust dispatch path for already admitted Codex attempts. Foundation owns one supervisor shared by its listeners, with two active workers and at most 64 retained observations. There is no queue or startup scan. Reserve identity and capacity before spawning the actual blocking executor; keep that exact join handle until it is joined. A dropped observation ticket does not cancel the worker. Duplicate starts receive the same generic refusal as unavailable capacity and never receive another caller's cached ticket. New executions still pass current D1 organization, target, ownership, and lease checks. After cache eviction or process restart, D1 remains the replay authority.

Containment and durable outcome are separate facts. The executor produces opaque failure evidence distinguishing no process launch, observed cleanup, and unresolved process liveness. Prelaunch failures may have ambiguous database outcomes, but cannot consume process capacity indefinitely. Post-launch failures release capacity only after matching cleanup evidence; they do not finalize the Run or release its hold. Missing cleanup or worker panic quarantines capacity. Successful execution passes matching opaque turn and cleanup receipts to the existing Rust finalizer. `FinalizationCommitted` means that transaction returned successfully; budget or projection holds may still remain. A finalization timeout remains unresolved and is not retried.

Shutdown closes the shared dispatch gate before either listener drains, requests worker cancellation, and bounds joining with one deadline. Handles stay owned even when shutdown is cancelled or called concurrently. Foundation returns an error for pending or quarantined workers, so the binary cannot emit a clean stopped receipt for them. This internal shutdown cancellation is not a durable user Stop operation.

Focused verification covers actual PostgreSQL admission, a separate Rust process host and synthetic Codex provider, dropped tickets, exact-once final projection, cache-eviction replay rejection, repeated prelaunch errors, provider failure with cleanup, cancellation with retained D1 holds, restart denial, missing process-owner cleanup, concurrency limits, and interrupted shutdown. Independent review and acceptance apply only to this private Rust API; no public send/stop/reconnect route or UI workflow is enabled by this checkpoint.

Remaining activation work includes transactional browser authorization plus admission, Origin/Referer enforcement, durable cancellation intent, ordered event persistence/replay, restart reconciliation, and host configuration wiring. A crash between admission and dispatch leaves an unresolved admitted attempt, not an automatic retry. Full Reader/Side Chat behavior, six-runtime parity, billing settlement, and packaged Desktop acceptance remain open. The preceding launcher-auth checkpoint `77d0627a5f48cbacef2724e9b014533fb45466b2` has independent PASS (221 assertions across six actual issuer variants) and final scoped review ACCEPT; its separate packaged acceptance remains QUESTION because required disk headroom is unavailable.

### 10.10 Private Rust Stop intent and bounded event reads

The control-ledger increment builds on the worker checkpoint after rebasing onto `e9bef3d6fc8b63ebe30d1ee283ca3441ea4def51`. That main update changes only release documentation; the previously accepted worker's Rust subtree is unchanged. The private `native_chat::control` API now records Stop intent in D1 without enabling a public route, dispatching cancellation, or claiming provider completion.

Stop serializes on the existing target advisory lock and Conversation → Generation → Run → Attempt order. It reauthorizes after lock waits, verifies the native generation and persisted Run association, and uses a stable action ID with exact parameter matching. A Rust provenance marker distinguishes its receipts from existing compatibility control rows. A new action writes the action, two ordered events, visible cutoff, generation control version, and activity in one transaction. Exact retries do not append duplicate events or activities. The response says `stop_intent_recorded`; it does not grant transport authority. Run/Attempt ownership, protocol checkpoints, costs, leases, and admission holds are unchanged.

Preserve rendered-checkpoint semantics: use a newer durable client checkpoint when present; otherwise verify the requested sequence/hash, falling back to an existing valid durable checkpoint only when the requested event has no usable hash. Reconstruct and hash the bounded projection before committing. Cutoff zero clears an existing later assistant body as well. The first implementation handles native text events and known body-neutral metadata. Transcript/structured projections and histories beyond 2,048 events or 512 KiB of source payload fail closed until their typed reducer is implemented. These bounds are an explicit private implementation limit, not complete streaming support.

A terminal result committed before Stop wins and retains its full answer. If Stop wins, ordinary finalization is rejected and both execution holds remain; a later owner-fenced cleanup/reconciliation path must resolve the execution. A real process-host test queues Stop and the existing finalizer behind the target lock in both orders using actual opaque turn/cleanup receipts from a synthetic provider.

The read-only event API uses one authorized repeatable snapshot, follows the historical Run Agent rather than the Chat's current selection, and returns only supported event payload fields. Pagination bounds the event count (1–100), encoded events array (1–256 KiB), and individual stored payload (64 KiB). Oversized or unsupported events are explicit errors, never silently skipped. The byte limits bound returned data and Rust allocations; PostgreSQL still evaluates JSONB encoded sizes, with a five-second statement timeout. Future typed ingestion must enforce payload bounds before persistence. No provider locator, owner token, arbitrary payload, or state mutation crosses this read boundary. Sequence order alone does not establish provider replay deduplication; future ingestion still needs stable source-event identity.

This increment remains subject to scoped independent review and acceptance. It does not complete public Stop/send/reconnect, client checkpoint writes, streaming ingestion, cancellation dispatch/receipt finalization, restart reconciliation, six-runtime parity, Reader/Side Chat, billing settlement, or packaged acceptance. Those remain required by the full plan.

### 10.11 Private pre-claim Stop terminalization

The control ledger passed scoped independent C1–C8 acceptance and final review at `5b4f254db30fab50cebcd0933ba0304d517eb0fa`. The next Rust-only increment adds a separate `finalize_unclaimed_stop` operation. Recording intent remains distinct from completing a Stop; an exact `request_stop` retry continues to return its original intent receipt.

New Stop actions pin the exact Run and Attempt IDs, index, Run/Generation/connection epochs, and domain-separated hashes of owner identity, persisted input context/session intent, and checkpoint. These private hashes carry no transport authority and are not returned by the event reader. Older unpinned actions fail closed in the new finalizer.

Pre-claim completion is restricted to a single initial Attempt at index/epoch/connection 1, a zero empty-body cutoff, no Generation owner/lease/hold, and no process, span, output, usage, cost, or provider-effect evidence. The admission-time Run owner must still match the pinned Attempt owner; its lease may have expired because this path never adopts an executor. A claimed worker or indeterminate checkpoint cannot use this path. Stop and claim serialize through the same target and Conversation/Generation/Run/Attempt locks. Binding and Segment checks use the admitted identity, preserving either a fresh pending Segment or the exact previously established Thread in an open Segment.

The transaction cancels Run/Attempt, commits a local execution-terminal checkpoint, stops the Generation, and appends one terminal event pair and audit record. It does not invent provider completion, process exit, an assistant answer, or zero usage/cost. `inputDisposition: not_submitted` is durable in the separate receipt, Run result, and safe terminal event projection. An exact finalization retry is read-only, including after a subsequent Send; a new Send uses a new mutation ID. Reusing the cancelled input's original mutation ID returns that original Run, and does not silently resubmit it.

The exact private candidate `ed307e009b6009e870fa4e192f28e3a496dcd264` passed independent P1–P8 acceptance on fresh disposable PostgreSQL and final scoped review. Public wiring must explicitly surface the difference between a saved input and provider-submitted input and provide a clear new-send/resubmit flow. Live-worker interruption, ambiguous provider submission, owner-fenced cleanup receipts, full event ingestion, public UI, six-runtime parity, and packaged acceptance remain required by the full plan.

### 10.12 Private live-worker Stop and connection-bound interruption

The next Rust-only increment joins durable Stop intent to the existing process-owned worker. Normal execution, submission, and finalization APIs retain their Active-only checks. A separate stopping path validates the exact action provenance, owner, Generation version and frozen cutoff, immutable execution pin, and both live leases under the existing target → Conversation → Generation → Run → Attempt → action → Binding/Segment lock order. It cannot prepare or authorize new Thread/input effects.

The worker checks durable Stop at 200 ms intervals between transport polls; database operations retain their bounded timeout. A late successful Thread/Turn response is accepted only with an opaque receipt proving the entire exact request frame and matching response were observed on the same owned connection. Its narrow persistence API records a bounded predecessor/successor checkpoint hash-and-revision chain without replacing the original Stop pin. A late Thread never permits a new Turn. Unreturned or ambiguous effect outcomes remain held.

For an exact known Turn, atomically reserve `not_sent → unverified`, then consume one short-lived interrupt permit on the original connection. Never resend after ambiguity or reconstruct a permit after restart. The wire request follows the [Codex App Server interrupt contract](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn), using the exact opaque Thread and Turn IDs. A successful RPC acknowledgement alone is not cancellation proof. The worker still requires a matching actual terminal event and a connection-bound cleanup receipt before finalization; local shutdown cancellation remains a different operation.

If Stop commits before terminal finalization, the operator outcome is Run/Attempt `cancelled` and Generation `stopped`, even if the provider reports `completed`. Preserve the actual provider status only in private evidence. Finalization validates and preserves the frozen assistant body, adds no provider-tail answer, and retains unknown-cost budget reconciliation holds when applicable. If normal finalization commits first, Stop observes that committed result. A definite owner-state conflict may route an already observed terminal to the Stop finalizer; a database error or timed-out commit must never trigger a blind retry.

This increment remains private and unaccepted until its source review, independent terminal acceptance, and final review complete. Claimed executions stopped before a known Turn still require a separate no-input/cleanup reconciliation capability; they remain held here rather than fabricating completion. Public HTTP/UI wiring, continuous projection ingestion, restart recovery, all six runtimes, real-provider acceptance, full repository checks, and packaged Desktop verification remain open parts of the full task.

### 10.13 Public Rust integration and actual Profile scope

The live-worker Stop candidate is `ca244c4be8371f9bc996063dff77f8c9cf269949`, based on main `e9bef3d6fc8b63ebe30d1ee283ca3441ea4def51`. Its default Rust workspace suite passed 826 tests with 48 ignored tests; independent L1-L8 acceptance and final review passed for this exact candidate. These are private execution results, not acceptance of the public Chat journey. Keep each scoped receipt tied to its source and fixture. Do not count a passing synthetic provider as real selected-Profile or six-runtime parity.

The next public integration reuses the single Foundation Supervisor and D1 admission, control, and execution authority. It must not create another scheduler or translate browser identity into a synthetic signed envelope. Existing sealed envelope callers remain supported. Rust browser handlers provide internal, non-serializable principal evidence, and D1 revalidates the exact session or board key and credential fingerprint, expiry, and organization access in the transaction after target-lock waits. Client request fields cannot supply principal authority. Session and local-implicit mutations require an explicitly trusted Origin or Referer; a request Host or forwarded Host never creates trust. An authenticated explicit board bearer can use the non-cookie path.

The public wire must match the existing UI: ChatMessage acknowledgement, NDJSON ChatStreamEvent values, a durable client acknowledgement endpoint, and Stop's existing response contract. A durable terminal event alone does not supply the final ChatMessage DTO. Native event ingestion must commit a typed visible projection with stable source identity before it can be replayed or acknowledged. A client acknowledgement can only advance to a stored visible text sequence and matching hash; it neither advances execution nor changes an accepted Stop cutoff. An unknown, malformed, or unsupported payload fails explicitly before admission writes. Native-owned paths and aliases are reserved before the Node proxy; a Native authorization, configuration, or execution error cannot silently fall through to Node.

The current managed Codex test profile is deliberately restricted and is not the selected provider Profile promised by this plan. Production resolution must bind an authorized, host-owned profile reference, effective configuration and capability provenance to the RuntimeBinding. Reuse the selected provider's authorized authentication path without copying or logging credentials, modifying global defaults, or silently disabling native features. Resolve selected Skills, plugins, MCP servers, Rudder tools, workspace layers and instruction revisions before claiming parity. The provider remains responsible for loading its native plugins, Skills and MCP configuration; Rust binds the authorized Profile and provenance instead of implementing a second provider extension engine. If a capability lacks a Rust owner, report that exact unsupported capability; do not activate a misleading fallback.

All six adapters remain required: Codex (`codex_local`), Claude Code (`claude_local`), Hermes (`hermes_gateway`, with explicit backend identity), OpenCode (`opencode_local`), Pi (`pi_local`), and Cursor (`cursor`). Each adapter supplies native session identity, create/resume certainty, visible events and permissions, cancellation/quiescence proof, terminal evidence and usage sources to the same Run/Attempt authority. The current Codex Thread/Turn receipt APIs must be generalized at that boundary without pretending the other providers share Codex's protocol. Keep OpenClaw regression coverage separate from this six-adapter count.

Before public activation, complete first-send atomic Conversation admission, Side Chat ownership/lifecycle, continuous projection, actual selected Profile, and restart reconciliation. A crash after durable admission must expose the held attempt and reconcile it without resending uncertain input. Browser disconnect is not Stop. Remaining storage-reader migration, native controls, all-runtime acceptance, full repository checks, packaged Desktop verification, and protected-PR handoff are still required by the complete plan.


The next working branch is `codex/native-chat-public-wiring-20261017`. A fresh fetch on October 17 confirmed that `e9bef3d6fc8b63ebe30d1ee283ca3441ea4def51` is still the remote main tip and is already included. This branch integrates no-input Stop finalization, request-scoped browser admission/control/read principals, and typed visible-output persistence. Focused database and process checks are progressing; the branch remains an unfrozen implementation candidate, not accepted public Chat behavior.

Visible output is bound to the exact connection claim, epoch, Thread/Turn, item and contiguous receipt ordinal. Persist each accepted observation before exposing it to a client, with replacement snapshots every 64 observations and a hard limit of 4096 visible observations per turn. This output-specific ceiling bounds durable event/audit growth without limiting tool or usage observations. Exceeding a bound retains execution holds and must not publish an unpersisted tail. Stop reconstructs the acknowledged prefix from the latest eligible snapshot and proves the assistant row against the exact Run's output ledger even at cutoff zero. Normal finalization must validate that same ledger provenance and terminalize the existing streaming row.

Browser controls revalidate exact credentials and organization grants after target serialization and before mutation commit. Bounded read-only snapshots use nonlocking authentication and recheck wall-clock expiry before return. The Rust message reader projects only explicit public fields; provider provenance and owner capabilities are excluded. These private APIs still need the public NDJSON and actual UI journeys wired and accepted.

Browser admission does not activate a worker through a cached expiring browser proof. Convert request authority into a separate D1-minted, exact-claim execution principal at successful claim; do not synthesize signed envelopes or let a worker capability perform a new admission. Cookie expiration after claim must not interrupt an already authorized task, while current membership/Agent revocation must still block subsequent governed effects. Public controls, worker delegation and dispatch ownership must be completed before routes are enabled. Restart recovery, actual selected Profiles, all six runtimes, Side Chat parity, storage-reader integration and packaged acceptance remain required for completion.

The accepted private production-source reference is published in [draft PR #323](https://github.com/Undertone0809/rudder/pull/323). Its current head is `586cf89ba46e9580298c42d5f47a3abceaf0d3b4`: migration compatibility declaration/test corrections, an equivalent relocation of existing startup exposure checks within the existing auth bootstrap module with refreshed authority inventory, behavior-equivalent fixed-size hex-decoder iterations in production and its mux test helper, and test-only PostgreSQL RESTRICT/mux scheduling compatibility corrections on top of accepted `ca244c4be8371f9bc996063dff77f8c9cf269949`. The original private acceptance receipt stays bound to `ca244c4`; it is not relabeled as full acceptance of the newer head. Compatibility tests passed 19 cases and real PostgreSQL migration tests passed four cases; the updated remote CI remains a separate gate. That PR contains the accumulated Rust foundation and live Stop implementation; it does not contain the newer dirty public-wiring candidate and is not merge-ready. Public wiring now includes explicit opt-in control/recovery HTTP handlers and a request-to-execution-principal transition. The application launcher has not enabled those handlers. Their existence is not a public Chat acceptance result.

The public stream contract needs a distinct `assistant_snapshot` event carrying replacement `body` and generation/epoch/sequence/hash provenance. Consumers must replace the draft body for that event and reject duplicate or stale provenance; appending a snapshot or treating it as final duplicates text or ends the turn too early. Stable send identity must survive an uncertain response, while a terminally completed send must settle durably so a later intentional identical message receives a new identity. If persistence cannot establish either pending or settled state, fail before another dispatch and require server reconciliation where local storage cannot disambiguate the state after reload.

Public control handlers must not slide a BetterAuth session before rejecting an untrusted Origin. Native Chat uses a credential-validating, no-refresh authentication path. Worker execution authority must also require the original user row to remain live, in addition to membership checks; a deleted user with a surviving polymorphic membership is not an active principal. Event replay bounds raw private payload transfer before JSON decoding, as well as the serialized public page.

Client-side idempotency needs cross-tab serialization, not only a per-page mutex. Store independent scope records and serialize prepare/settlement with Web Locks; unsupported locks or unconfirmed persistence must pause sending before dispatch. Keep unresolved identities and settled tombstones intact. Do not instruct users to clear site storage as recovery, since that can erase the only local association with an uncertain accepted request. These client changes remain an external draft pending independent review and real HTTP/UI verification.

If every storage write fails after acknowledgement, a reloaded page cannot distinguish the surviving pending record from an uncertain prior send. Before dispatching a recovered pending identity, perform a read-only server reconciliation. An already accepted mutation must recover its previous message and make clear that the new draft was not sent again; a fresh intentional repeat requires another explicit Send. Preserve draft continuity while reconciliation is pending. An unavailable reconciliation endpoint pauses that recovered send instead of silently collapsing two user intentions.

A durable acknowledgement means input was saved, not that execution completed. Retain the accepted mutation association until a verified terminal result. On nonterminal stream failure, offer an explicit Resume response action using the original identity/body while preserving the current composer draft; ordinary Send must not silently replay that identity. Stream errors carry an explicit terminal flag backed by the persisted exact-generation state.

Legacy Node background recovery and direct mutation entrypoints must explicitly exclude native-owned Run/Generation rows before public activation. The transaction-local SQL write marker remains an accidental-write backstop, not a security boundary; relying on its rejection lets native rows abort a legacy recovery pass and does not protect every queue side table. Rust-owned Stop and recovery must remain reachable without falling back to those legacy writers.

A request disconnect must not cancel the commit-to-worker handoff. Track the reserved admission task under the Foundation Supervisor and include it in shutdown accounting. If the first worker claim fails (including expired request credentials), expose a bounded nonterminal recovery-required result after the durable acknowledgement; keep the active Generation/Run exclusion and never redispatch on an exact retry. A future durable quarantine operation needs a separate D1-minted dispatch capability, not a manufactured actor or expired browser credential.

Current public-path verification (October 17): a disposable PostgreSQL and real HTTP/process fixture passed send, disconnect after acknowledgement, completed reply recovery through a fresh Foundation instance with neither dispatch configuration nor a Supervisor, exact mutation replay, read-only reconciliation, and origin/organization rejection. Replays preserve one source message, Generation, Run, Attempt and provider start. A terminal Generation retaining a historical owner token with no live lease now projects `executionOwnerLive=false`. This is synthetic Codex evidence, not selected-Profile or browser acceptance. The earlier failed retry fixture reused a SQL pool owned by terminated Actix workers; the restart case now creates the fresh pool of an actual new server instance.

The locally integrated UI recovery increment retains accepted/recoverable identities, discovers saved submissions on scope activation, and presents explicit Resume/Retry actions while preserving a newer draft. Its six affected UI/API suites passed 211 tests and the UI typecheck passed. Independent source review subsequently rejected the increment: ordinary Send is enabled during discovery, and Main Chat clears the new draft/files and creates an optimistic stream before preflight; recovery-only returns neither restore the draft nor remove that phantom stream. The prior Main Chat test file exercises helpers, not this page workflow. Corrections must gate discovery, defer composer/stream changes until a ready dispatch, and exercise the real rendered page harness. Ambiguous file/annotation/edit sends and edit-specific discovery also remain full-workflow blockers; preserve their exact identities and payloads instead of stripping content, disabling existing legacy capabilities globally, or allocating a new ID. Rendered inspection and the actual Rust-backed browser workflow remain separate pending gates. The dispatch-unavailable preclaim Stop proof matches the exact persisted audit association and a nonsecret producer field; ordinary no-marker retries remain idempotent. The current Rust workspace passed 906 tests with 67 explicitly ignored environment cases, and all-target Clippy passed. The three public HTTP environment cases also passed separately after the latest admission corrections. The published, older PR head now has 21 successful checks and one skipped check, including packaged smoke; its PostgreSQL 18 and mux test compatibility failures were corrected. These observations do not establish the complete product workflow or authorize public activation.

Queue authority cutover serializes legacy mutations and Native admission on the exact same canonical target advisory key before queue-row locks. Native admission rejects unresolved/unknown queue states, lingering leases, ambiguous cancellation and unresolved linked controls before configuration or writes; settled queue history remains unchanged. The integrated Node compatibility fences cover per-item and global claim/recovery paths, preserve same-chat head ordering, and allow other conversations to advance past a locked head. Parent verification passed 446 cases across four affected suites before the final generic-message fence; its author subsequently passed all 189 messenger cases including that correction. A negative SQL predicate alone is not the concurrency boundary.

Independent review exposed the separate legacy user-message/Generation commit gap and an unfenced failure-message insert. Rust now rejects every retained unresolved user input without an exact same-turn/variant terminal projection or an exact native source Generation. Legacy Generations intentionally have no source-message association, so the guard does not invent one. It also detects active or pending-effect legacy Runs linked through the scoped snapshot Generation when their direct conversation column is NULL. The legacy generic message writer now takes the target lock and rechecks Native ownership in its insert transaction. Nineteen real-database admission cases passed, including the commit-gap interleaving, an older orphan hidden behind 2,048 resolved turns, and legacy Run linkage with a terminal Generation. Fully resolved history remains unchanged. Separate source reviews accept the corrected Rust guards and the Node negative-fence slice; authority-policy and full public-workflow acceptance remain pending. Ambiguous historical turns remain blocked until a positive migration/reconciliation path can establish their state.

The authority ratchet still rejects the added compatibility reads and rehashed existing transaction callbacks. A source-bound policy draft passes 34 pure tooling tests but is not applied or accepted as the actual candidate policy; its exact records must cover the remaining narrow background PK-hint helpers without admitting arbitrary Node queries, business writes, routes, or workers. Local Rust checkpoint `497d390e2dbf90f56b6264acbb5d8da81d9e8c16` preserves the public implementation and subsequent framing/admission fixes without changing the live index or publishing those unaccepted changes. Public activation remains blocked until the integrated gates and complete plan pass.

The rolling full repository run found a task-induced public RuntimeBinding read regression: mutation authorization now retains membership/Agent row locks, and the existing read route reused it inside a `READ ONLY` transaction. The read-only functions now use nonlocking authorization in the same credential snapshot; the existing real Rust/HTTP/PostgreSQL integration passed all six cases after correction. Mutation locks remain in place. Separate baseline environment failures were resolved by using canonical `/private/tmp` paths, installing the task-owned Electron dependency, and pointing the workspace watcher test at its existing release binary. Desktop tests passed 1,045 cases with 22 skips, and the separately executed runtime packaging suite passed 18 cases. The full UI project exhausted its default 4 GiB worker heap; it still needs a bounded rerun after the pending UI correction. These scoped results do not turn the earlier failed rolling baseline into a final-candidate pass.

The reusable host boundary now lives in the Rust `rudder-native-process-transport` crate, with the existing Codex transport as its actual consumer. The common owner handles bounded queues, embedded/external process-host lifetime, strict mux decoding, one-use launch permits, connection identity and host-terminal cleanup proof. Codex retains its JSON-RPC, Thread/Turn, output, usage and effect parsing; its `codex-owned-cleanup-v1:` fingerprint remains compatible. Parent integration passed all 39 explicit executor workflows and three public HTTP cases after this extraction. This is shared process groundwork, not a wired Pi adapter or six-runtime acceptance. Independent source review accepted this extraction, and the integrated workspace run passed 906 tests with 67 environment cases ignored. These are scoped evidence; final product acceptance remains separate.

The next UI checking increment passed six targeted recovery cases and fifteen atomic-draft cases, but parent execution of the full rendered Main Chat harness exposed five Ask User attachment/selection failures. Independent review also rejected waiting for query invalidation before publishing completed recovery state, because a hung refetch can leave the composer disabled indefinitely. The corrective increment must gate Ask User submission while preserving attachment staging, gate all side-panel consumers, bound discovery, and refresh caches without withholding the recovered state. A `forceImmediateSend` exception must not bypass an unresolved mutation. A reproduced render loop in the Main Chat harness came from an unstable QueryClient mock; correcting that mock lets the harness reach assertions without increasing its heap limit. After the bounded checking correction, parent execution of the entire UI project passed all 3,444 tests in 342 files at the default heap with four workers; the UI typecheck also passed. The earlier failing run remains historical evidence. Parent rendered inspection through ego-browser also completed an actual existing-Chat send and reload with the real Rust fixture, preserving both messages. Recovery under uncertain disconnect, independent rendered review, and full feature acceptance are still separate gates.

A test-only Rust example, `native_chat_browser_fixture`, constructs the real Foundation runtime for the planned browser E2E. It requires a canonical task-owned temporary root, fixed loopback listeners/database, and an exact disposable-database marker before starting workers. The launcher also binds provider source bytes to the compiled synthetic fixture and labels its interpreter assumption explicitly. Check, strict Clippy, build, seven invalid-config rejection probes, and an independent source-stage review passed; the subsequent valid bootstrap passed actual health/session/Chat reads and a public Rust send through the owned synthetic provider, including durable acknowledgement and final reply. Its owned services were stopped cleanly and logs retained. The strict test-support typecheck also passed. The browser workflow still needs to run. It introduces no installed-server activation flag and provides no selected-Profile acceptance.

Atomic ordinary-Chat first-send now creates the Conversation and normal source/Generation/Run/Attempt admission in one D1 transaction. It stores an immutable first-draft proof separately from the canonical body fingerprint used by reconciliation and execution, and exact retry uses that proof after target-lock authorization checks. Parent verification passed eight real PostgreSQL cases and an explicit owned synthetic executor workflow proving one exact new input without transcript replay. The initial v2 patch export omitted its validation helper and failed parent compilation; the supplementary file was verified and included before those passing reruns. Local checkpoint `fde6572f2002fa9ab67d9c847431d93f219a19c6` records the complete D1 increment without changing the live index. Foundation first-send HTTP wiring is still external, independent stage review remains pending, and these results do not complete first-send UI, Side Chat, rich-input recovery, Reader, selected Profiles or the six-runtime plan.

### October 17 latest-main integration continuation

Remote `main` advanced to `d0410bab3f4a88af04351ebc4c447824b94e87e8`. The integration branch `codex/native-chat-main-refresh-integration-20261017` rebases the task source onto that tip, preserving the new Rust session authority, signed compatibility assertions, and WebSocket route restrictions. The original dirty source checkout and its index remain intact. Checkpoint `5760124cff041766b4ac6c1d17beba99f8e279d9` is local and is not a final accepted candidate.

The published main migration `0179_reflective_wallow` and its snapshot are immutable. The two unmerged Native Chat migrations move to `0181_native_chat_rust_admission` and `0182_native_chat_finalization_guards` without changing their SQL bytes. The journal retains main's first 180 entries exactly, and the merged snapshots include main's session index. The current catalog has 182 journal entries and 184 SQL files. The release-compatibility preflight passed eight historical fixtures; 14 migration-core tests and four real disposable-PostgreSQL migration-service workflows passed (bootstrap/upgrade, cancellation recovery, forbidden-SQL rollback, and advisory-lock exclusion). Nineteen compatibility tests and 66 bridge/auth tests passed, and the merged server typecheck passed after removing a duplicate type export. Foundation all-target compilation passed before the subsequent small compatibility-helper extraction; that extraction still requires its affected checks.

Full `pnpm db:generate` reports the existing main snapshot collision between historical 0140/0143 snapshots, which remain unchanged. An isolated Drizzle check against the latest merged snapshot and compiled schema reports no schema changes and generates no SQL. This is narrower evidence, not a pass for the full command or packaged migrations.

The actual Rust-backed browser recovery test now passes disconnect, reload, explicit Resume, and final-answer continuity with one source input. The live Stop-after-reload regression remains active and failing until the client obtains the exact current control fence. First-send API source review accepted its bounded slice, but actual new-Chat UI wiring still needs durable client mutation identity and a complete runtime descriptor in the acknowledgement; API acceptance does not close that journey. Rust Pi protocol/configuration work is in a separate overlay and is not yet integrated or accepted. All six runtimes, selected Profiles/extensions, Reader/storage, Side Chat, packaged checks, independent final acceptance, and Git publication remain required.

The refreshed candidate now reads an exact Stop target's authority without projecting its message body, so unsupported rich rendering cannot select a legacy path or prevent authority discovery. Only a positively authorized legacy target reaches the existing bounded compatibility transport, including main's signed session assertion; failed Native controls never fall back. The existing Node target fence remains responsible for excluding a race with Native admission. Foundation all-target compilation and all 19 Native Chat tests passed, including five real HTTP/database workflows. The new compatibility regression covers foreign organization/generation, Origin denial, expired sessions, failed Native controls, exact body forwarding, and verification of the request-bound session assertion. Six D1 projection tests passed after fixing the new fixture's hardcoded event-sequence collision by appending the client checkpoint after its seeded output events.

The Stop UI increment reads the current target before dispatch and rejects captured or refreshed attempt/control-version mismatches. On the refreshed source, 169 API/rendered-page harness tests, 96 stream-helper tests, and UI typecheck passed. The first integrated UI typecheck exposed omitted Native snapshot helper hunks in the earlier source capture; only those task-specific hunks were transferred, leaving the original dirty checkout and its index unchanged. The capability endpoint and actual reload-to-Stop browser workflow still require integration/verification; these tests are not rendered or independent final acceptance.

### 10.14 Installed runtime evidence for the next Rust adapters

The October 17 local inventory observed Codex `0.163.0-alpha.10.2`, Claude Code `2.1.216`, OpenCode `1.15.11`, Pi `0.76.0`, and Cursor agent `2026.06.19-20-24-33-653a7fb`. Hermes package metadata reports `0.21.0`; its CLI version probe timed out, so that metadata does not establish gateway readiness. These are local probe identities, not minimum supported versions or successful real-runtime acceptance. No global upgrade or default-model change is implied. Verify each installed protocol before implementing its Rust adapter, and preserve the authorized selected Profile and feature set. A subsequent isolated Pi `--mode rpc` probe returned a successful correlated `get_state` response and its session ID, streaming/compacting flags, model, and queue counters; the task-owned process was reaped. The probe used an empty task-owned HOME/agent directory and disabled discovery, sent no prompt, and accessed no operator credentials. It establishes RPC readiness only, not selected-Profile parity, native persistence, session-tree reading, or a wired Rust adapter.

### October 18 Pi boundary increment

The branch now contains a Rust-owned Pi RPC execution boundary and bounded
session-tree Reader. It validates the managed session file, distinguishes
`agent_end` from settled/idle state, preserves Pi session and leaf identities,
and proves cleanup through the shared process host. The shared Foundation worker
can carry a typed Pi observation and reports terminal-but-unprojectable or
unknown-cleanup states without coercing Pi IDs into Codex Thread/Turn columns.
Pi D1 configuration/claim reachability and Pi-native finalization projection
remain in progress; this increment is not Pi Chat acceptance and does not close
W09 or the six-runtime completion requirement.

### October 18 Codex and Hermes acceptance status

The exact pre-rebase candidate `820e7a75b` was exercised through the local Rust public
ingress at `127.0.0.1:3318` against the user's installed profiles and embedded
PostgreSQL. A fresh Codex Chat (`288a6933…`) completed its first turn and its
post-Node/Rust-restart continuation as `native_rust` Runs, with the same
provider Thread ID (`01a14c65…`) and two projected assistant replies. An older
Chat that showed a retry banner was traced to stale browser recovery state; it
had no third durable Run and is not used as Codex provider-failure evidence.

Hermes (`0.21.0`) completed a fresh first ACP turn, but the same-session
continuation after the runtime restart failed. The persisted Hermes session ID
was the same (`64bf6ba8…`), while the failed `native_rust` Run had no assistant
projection and the UI placed the conversation under Failed runs. The real
installed-runtime acceptance is therefore still open only for Hermes in this
two-runtime slice: its same-session continuation must succeed with a projected
assistant reply. Synthetic fixture passes remain supporting evidence only. This
milestone does not close the remaining four adapters, full product journeys,
independent final review, or required CI gates.

The branch was subsequently rebased onto the latest `origin/main`
(`9ba84ce6b`, agent runtime normalization) and force-updated through the PR.
The earlier execution receipt was captured before the Reader integration and
must not be reused as proof for a later merge candidate; every merge decision
must name the exact tested SHA.

### October 18 Hermes provider-route diagnosis

An additional real run on the rebase candidate used the same isolated instance,
installed Hermes `0.21.0`, Rust public ingress, and a fresh Chat. The first
turn projected an assistant reply. After stopping and restarting Node/Rust, the
same Chat and Hermes session failed with `native_chat_failed` and no assistant
projection. The Rust candidate was kept fail-closed; a temporary experiment
that skipped `session/set_model` when the load response looked equivalent did
not pass the real continuation and was removed before publication.

The installed Hermes ACP was then exercised directly against the same profile:
exact `session/load` followed by `session/prompt` succeeded, proving the durable
session UUID and ACP load path exist outside Rudder. Repeated restored sessions
in the installed `state.db` and request dumps show the failing class switching
to `https://api.kimi.com/coding/responses` with HTTP 404
`resource_not_found_error`; those rows persist the new user without an
assistant. Hermes' own resolver treats `api.kimi.com/coding` as an Anthropic
Messages endpoint, while ACP restore can pass a stale persisted
`api_mode=codex_responses` into the recreated agent. This is now the leading
provider/profile contract blocker. Rust must continue rejecting blank
`end_turn` and must not silently change provider mode, replay an indeterminate
prompt, or create a new session. The fix belongs in the installed Hermes ACP
restore contract or in a verified profile/relay route, followed by the same
real two-turn restart acceptance and independent verifier rebind.

### October 18 Hermes restore hardening follow-up

The Rust Hermes candidate now applies the selected profile as the restore
authority on every launch: the pinned ACP bootstrap clears persisted
`requested_provider`, `base_url`, and `api_mode` before recreating the agent,
including sessions with no extra Agent instruction, while preserving the
session UUID and model. The transport also accepts only Hermes' bounded
`available_commands_update` and `usage_update` metadata notifications while
waiting for load/model/prompt responses in every correlated request loop;
unknown notifications remain a hard protocol error. The ignored process-host
fixture emits both notifications before session/load and session/set_model
responses, covering the restore ordering. Focused Hermes tests pass (6 passed,
2 ignored), native-executor tests pass (15 passed, 2 ignored), Rust foundation
and process-host build, format, and Hermes clippy checks pass.

On the clean task-owned real instance `real-native-c`, using the installed
Hermes 0.21.0 venv entrypoint, Rust public ingress completed a first turn with
the assistant projection `HERMES_CANONICAL_FIRST_OK`. After stopping and
restarting the Node/Rust server, the same conversation/session completed a
second turn with `HERMES_CANONICAL_RESTART_OK`; the earlier stale Kimi route was
not used. This is the installed Hermes first-turn plus restart-continuity
evidence for that earlier execution candidate. Existing Codex first-turn and
restart-continuity evidence remains content-equivalent because that follow-up
changed only the Hermes launch path; rerun and bind both providers to the
current SHA before claiming merge readiness.

### October 18 exact candidate acceptance (`9e5aa4e0f62cdc993b6cd70d832bfb52e4a7bb28`)

The current integration candidate was exercised against a fresh task-owned
embedded PostgreSQL instance through the required Rust public ingress at
`127.0.0.1:3100`, using the installed Codex `0.163.0-alpha.10.2` and Hermes
`0.21.0` runtimes. Codex completed a first turn, a same-session continuation,
and a new-input continuation after a full Node/Rust server restart; all three
Runs were `native_rust` and succeeded, with projected final replies
`FINAL_9E5AA4E0F_CODEX_OK_3`, `CODEX_CURRENT_CONTINUATION_OK`, and
`CODEX_AFTER_RESTART_OK`. Hermes completed the corresponding first turn,
same-session continuation, and post-restart continuation with
`FINAL_9E5AA4E0F_HERMES_OK`, `HERMES_CURRENT_CONTINUATION_OK`, and
`HERMES_AFTER_RESTART_OK`; all three Runs were `native_rust` and succeeded.
The acceptance used a task-owned minimal Codex profile derived from the local
login, with uncontrolled MCP/config layers removed; no provider credentials
were changed. Receipts and NDJSON streams are retained under
`/tmp/native-chat-current-acceptance/` and are bound to this exact SHA.

### October 18 full-plan audit after Native Chat merge

The current `main` head is `03ddd217af22db2a68c3dfaeca997e73c7563ff3`. PR #324 merged the Rust Native Chat worker with provider dispatch branches for Codex, Hermes, Pi, Claude Code, Cursor, and OpenCode; PR #338 restored the durable Agent instruction-bundle reconciler; PR #339 corrected a stale authority fixture that still treated `claude_local` as a legacy runtime; PR #344 restored the installed OpenCode command payload contract for `variant`, `messageID`, and file-only `parts`; PR #346 merged the bounded Rust Side Chat message/transcript Reader, Pi host activation, legacy transcript compatibility, and historical no-Agent read support. The exact local Codex/Hermes acceptance remains the real installed-profile evidence under `/tmp/native-chat-current-acceptance/`; no equivalent installed-profile acceptance has been completed for Claude, OpenCode, Pi, or Cursor. The current-main Rust Run Reader also has a fresh local real-entry receipt: 18/18 tests passed against a disposable PostgreSQL and the built foundation binary (`9a127c500caa1f29b816069ce521097bf0b0c96cc03b1e446a25f6feb23bdde4`), covering list/overview/detail/events/workspace/active reads, redaction, organization and Side Chat owner boundaries, normal bootstrap, and Rust-unavailable no-fallback. This closes the core `/agent-runs` Run Reader evidence; the separate `run-intelligence` aggregation/log/trace routes remain Node-backed.

The OpenCode wire boundary now also exposes bounded SSE, Question/Permission, and Command methods, but they are still adapter-only and not connected to shared Run/Attempt interaction authority. The full-plan gates remain open. Main Chat and the bounded native Side Chat message/transcript routes now use the Rust Reader, while Side Chat lifecycle/consumer paths, Run Detail, annotations, work-manifest, Messenger, automation, Feishu, export/search, and several UI panels still have direct Node/Drizzle transcript consumers. Retention claims and aliases model lifecycle state, while no generic worker yet prunes provider sessions, native transcript objects, or ledger/detached history under cleanup epochs; database and workspace backups are separate from provider-native session backup/restore. Native runtime unit tests and synthetic PostgreSQL/HTTP fixtures are implementation evidence only. W06/W07/W08/W09/W10 real-profile acceptance, W11 consumer migration, W12 duplicate-writer shutdown and GC/backup drills, and W13 second independent review remain unverified.

A current audit must therefore report the bounded Codex/Hermes milestone as delivered while preserving the six-runtime, shared-Reader, retention/GC, backup/restore, product-consumer, and final-acceptance work as active scope.

### October 18 current-main real ingress recheck

The previous real Codex/Hermes receipts above remain bound to
`9e5aa4e0f62cdc993b6cd70d832bfb52e4a7bb28`. They are not current-main
acceptance: that SHA is not an ancestor of the current `origin/main`
`8a5d623f271316817863991969585e332ee01e87`.

I rebuilt the current `main` candidate in an isolated instance and started the
actual Rust public ingress with `RUDDER_RUST_PUBLIC_INGRESS_MODE=required`.
The foundation binary SHA-256 was
`cb9c3eb89b949d6b5308d18ddd53c27361b386ef5f0217dac7265f0b4b0951e7` and the
co-located process-host binary was
`27f437445d29be77f1d36d87c3eef61269353a1227f81545a041c5fdfefc0251`.
After adding the required process-host artifact, the public capability endpoint
reported `firstSend: true`. A real local Codex first-send request through the
public Rust listener, with the installed local Codex profile and a disposable
PostgreSQL instance, returned HTTP 503 `native_chat_unavailable` and produced
no assistant terminal receipt. This is a current-main real-environment
**FAIL**, not a provider success. The isolated run also exposed recurring
Node-side recovery queries with an empty SQL predicate (`where ( = $1 ...)`),
which is recorded as a separate current-main runtime defect.

Therefore Codex/Hermes are not accepted for the current `main` SHA, and no new
merge is authorized from this recheck. PR #324 is already merged into `main`;
the next fix must first make the current Rust worker admit and complete a real
Codex turn, then repeat the same current-SHA first/continuation/restart matrix
for Hermes before any additional merge claim.

## 11. Implementation Order: Progress Through Verifiable Feature Slices

Each work item includes implementation, call-path wiring, relevant tests, and fixes; adding interfaces or completing the plan is not completion. Make staged commits under current repository conventions and protect unrelated work. Never push directly to `main` or bypass branch protection; merge through a protected PR only after the same candidate passes independent review, real acceptance, and required CI. Deployment is not authorized by this plan. Do not add progress templates, status JSON, empty report directories, or a suite of management scripts; real tests, commits, PRs, and necessary plan updates are sufficient evidence.

### W00 — Confirm the Actual Baseline and Native Contracts

Read the current AGENTS, worktree, branch, and implementation. Trace the actual call chains from all six surfaces to execution processes and identify the authoritative TS/Rust modules. Locate all Session reconstruction, recentMessages/sentinel, Transcript read/write, and Sidebar/Side Chat callers. Record installed binaries, configuration/Profile, transport, native schema, and history-storage locations without changing user credentials or global defaults.

Also verify the evidence level for each Runtime's create, resume, complete history, precise assistant Fork, controls, retention, and usage. The output is a reliable starting point for subsequent code and a list of concrete differences. Do not write a pile of inventory files; use this Plan's implementation notes or PR records. Completion means knowing the active paths and unknowns, not listing directories that merely appear to exist.

### W01 — First Lock Down Existing Main Chat and Side Chat Behavior

Run and complete characterization tests for main/side chat, especially that parent drafts and current Runs remain unaffected; first Send is idempotent; annotations/attachments are copied correctly; expiration triggers, same-ID Keep, grouping, close, and permissions are preserved. Cover Keep/expiry/close concurrency, source-deletion failure, and promotion while approval is pending. Prove existing semantics before replacing the underlying driver to avoid treating product behavior changes as inevitable refactoring side effects.

Primary locations are `side-chats.ts`, current successor service/UI suites for main Chat and `SideChatPanelView`, and `tests/e2e/chat-side-chat.spec.ts`. Completion means the baseline and failure paths are explicit; small pure-mock tests cannot replace product lifecycle tests.

### W02 — Incrementally Add Binding, Segment, Span, and Retention Relationships

Add necessary references in existing DB/shared/native persistence layers while preserving compatibility with old fields. Support creation intents, sealed ranges, source revisions, native branches/ancestors, read-only history aliases, and cleanup epochs. Add organization/principal validation, association indexes, and single-writer uniqueness; do not impose an incorrect global unique constraint on Pi's shared session files.

The migration must support empty databases and databases with old Runs; do not delete real instances. First create small Fixtures for a fake linear Thread and tree-shaped Entries, proving that R1/R2/R3 can be precisely separated within one Session and that a change in native physical ID does not change old Runs. Completion means the structures can represent the full lifecycle; all Runtimes need not yet be connected. Depends on W00.

### W03 — Connect All Surfaces to the Unified Run/Driver

October 17 transport prerequisite: the existing Codex adapter now consumes a bounded, provider-neutral LF record decoder from `rudder-native-protocol`. The decoder accepts an adapter parser rather than assuming every native record is a Codex JSON-RPC envelope; malformed adapter records still poison the stream and discard their batch. Existing Codex wire/session/transport tests and non-RPC records with byte-split UTF-8 and Unicode separators cover this extraction. This is shared transport groundwork only: it does not add a Pi driver, generalize the durable Codex checkpoint, or establish any additional runtime capability.

Current Rust implementation note (October 18): Native Chat now has provider-specific Codex, Hermes, Pi, Claude Code, Cursor, and OpenCode configuration, admission guards, provider-native checkpoints, execution dispatch, host cleanup proofs, and terminal projection branches. Claude, Cursor, and OpenCode receipts preserve their native session/request identities and never populate Codex Thread/Turn fields. OpenCode Server is started and stopped by the Rust-owned process host; `/doc` readiness, completed assistant readback, and the terminal cleanup receipt are all required before finalization. The exact-candidate Codex/Hermes acceptance above passed through required Rust ingress. Main Chat Reader now has a Rust-owned array/envelope contract, stable cursor predicate, accepted-through transcript cutoff, transcript summaries, and ledger entries; native Side Chat message/transcript reads now use the same Rust projection, including copied annotations, attachments, approvals, and legacy/no-Agent compatibility, while Side Chat lifecycle and remaining consumers stay on the legacy projection until migrated. The shared Reader completion, legacy transcript retirement, Side Chat consumers, retention/GC/backup, and duplicate-writer shutdown remain open W04/W11/W12 gates, so this is the bounded Codex/Hermes delivery milestone rather than completion of the full six-runtime plan. Keep the provider-neutral fenced Run/Attempt authority separate from each provider's native session and execution selectors; existing TypeScript adapters remain behavior references, never a backend fallback.

Extend existing Agent Run submission and SessionIntent, and migrate native Chat calls to the shared foundation. Wire up admission, budgets, Attempt, session-writer fencing, unknown acceptance for create/submit, recovery, controls, human requests, and terminal state. Native submissions do not accept a complete history array; Task/Review-specific claiming runs only in its corresponding surface.

Add tests for interleaved surfaces, late old workers, lease expiration while the real process is still active, dual queues, and per-Run credentials. Pass at least both linear and tree-shaped Driver Fixtures; shared structures must not hide Codex-only assumptions. Completion means the real entry points are wired and there is no second scheduler. Depends on W02.

### W04 — Reader, Streaming, and Complete-History Comparison

Implement the shared Reader and legacy-log Reader, and integrate the native Reader contract. Support single-Run/Conversation scope, stable cursors, individual item details, Stop cutoffs, ID rewriting, and permissions. Send events directly to the semantic projection; make short-term buffering, reconnect snapshot merging, backpressure, and exceptional states testable.

Adversarially test the read path with large histories, Unicode split across chunks, multiple branches, pre-compaction records, missing sources, and old approval snapshots. Reading history must not move the currently executing native session/leaf or create a model execution. Completion means both old Runs and new Fixtures use the shared Reader without depending on a complete SQL transcript. Depends on W02/W03.

### W05 — Wire Codex Native Chat into Run

Modify the App Server as described in 8.1. Wire first-time binding, subsequent new-input-only sends, Turn ranges, ordinary native final, approvals/questions, Steer/Stop, precise Fork, and complete history into the main/side UI. Initially retain a temporary mirror for read/write comparison; do not delete old storage yet.

Run CD and shared RN/TR/SC/GC cases, and perform a small-scale real Codex validation. Completion means multiple turns and restart truly use the same logical session, with no replay or sentinel repair. Depends on W03/W04.

### W06 — Claude Code Native Controls and Raw History

Integrate the supported SDK/control as described in 8.2, preserving configuration, tools, and permissions, and use an explicit Session ID. Complete native human requests, Fork and UUID mapping, the pre-compaction Reader, and retention policy. If using SessionStore, handle mirroring and checkpoints separately; do not require a new persistence dependency.

Run CL cases and shared surface tests; distinguish real-session validation from mock results. Completion means this is more than adding a resume flag and is usable in main/side Chat and Run Detail. Depends on W03/W04.

### W07 — Hermes Product Interaction and Native Session-Backed Runs

As described in 8.3, establish explicit RPC/HTTP backends within one Adapter. First verify the native Profile, session loading, usage, and recoverable history, then remove synthesized context from the verified native path. Complete product-level human requests, Steer, Memory/Skills, sub-agents, compaction, and precise assistant branching. Independently accept the HTTP path's idempotency key, complete details, and real terminal state.

Compare the native Hermes product and Rudder under the same authorized configuration; pay particular attention to interactions that were previously easy to omit. Completion means HE and shared Side Chat cases pass; success with ordinary HTTP text is not a substitute. Depends on W03/W04; this is a required deliverable, not optional backlog after Codex is done.

### W08 — OpenCode Native Server

As described in 8.4, add a managed native Server, calibrate against installed OpenAPI, and implement Session/message/part ranges, SSE, questions/permissions, commands, Abort, and precise Fork. Preserve instance isolation and configuration loading. Distinguish asynchronous submission from completion, and global streams from current input.

Run OC cases and Side Chat/Fork/recovery tests. Completion means consecutive chat is no longer simulated with a series of full prompts, 204 is not misreported as completion, and history-read ranges are stable. Depends on W03/W04.

### W09 — Pi RPC/SDK and Assistant-Boundary Branching

As described in 8.5, preserve native persistent Sessions and extensions, and complete tree-shaped selectors, complete history, native controls, and settled-state determination. Implement a lifecycle-aware assistant-boundary branching helper and verify veto behavior and that the parent leaf remains unchanged. Reconcile incremental costs and Run attribution for native follow-up.

Run PI cases and Fixtures for concurrent parent/child execution, earlier assistant messages, compaction, and Unicode. Completion means Fork does not depend on fabricating user messages or manually editing JSONL. Depends on W03/W04.

### W10 — Cursor ACP

Integrate ACP as described in 8.6, supporting native questions, plans, permission requests, and notifications. Verify history/Fork/Steer in practice; do not guess capabilities. For installed versions that genuinely lack complete reading or precise Fork, use the described object supplement/`context_handoff` while preserving Side Chat and Keep for users.

Completion means CU cases and basic main/side Chat are wired; already-supported capabilities are not constrained by the old CLI ceiling; and limitations are clear, with no false-green status. Depends on W03/W04.

### W11 — Migrate All Product Consumers

Move main Chat, Side Chat, Run Detail, annotations, feedback, Debug, learning, search previews, export, and file/Skill details to the shared input/control/Reader. Continue reading old records through the legacy Reader. Connect in-place Keep retention and cleanup claims to real data; do not expose unnecessary underlying concepts in the UI.

Test that all paths continue to work when a new Run has no legacy transcript rows at all. Cover refresh, long lists, preserving scroll position, multiple windows, keyboard menus, narrow screens, retention on failure, and source permissions. Completion means there is no hidden dependency where “some corner still reads the old table directly.” Depends on W01/W04/W05–W10.

### W12 — Stop Duplicate Writes and Reclaim Safely After Verification

For each Runtime/Profile, after passing verification for native recovery, complete history, and retention, disable all duplicate raw-data writers and remove full stdout accumulation. Define an explicit policy for capability gaps that need object supplements; do not delete old data or bulk-reinject it into Sessions.

Run a unique-large-text-marker scan and tests for disk-full/mirror failure, native pruning, Keep/GC races, and deletion cascades. Under the same load, measure SQL, independent logs, Host/server/browser memory, and read latency before and after. Completion means duplicate data is genuinely reduced without losing complete user capabilities. Depends on W11.

### W13 — Two Independent Review Rounds, Integration Acceptance, and Delivery

Per the September 29 delivery correction, publish bounded implementation checkpoint commits to the draft PR promptly, with explicit unverified items. Keep implementation, targeted regression repair, and independent review in parallel with disjoint ownership. Reuse passing evidence when the relevant code and environment are unchanged; rerun checks only for changed behavior, known failures, or required final integration gates. Draft publication is not acceptance or merge readiness. Do not postpone saving development progress until every runtime has completed real-environment acceptance.

Run the first round after completing real slices of the shared foundation, Side Chat safeguards, and the two structurally different Runtimes, Codex and Pi; focus on attacking architecture assumptions and product regressions. Run the second round after all six Runtimes, all consumers, and duplicate-write shutdown/cleanup are complete; focus on omissions and real behavior. In each round, actual independent Reviewers and Verifiers inspect code/call chains and runtime behavior; fix findings and retest.

The Reviewer checks state and references, permissions, scope, dual queues, costs, native commands, and data retention. The Verifier black-box reproduces multi-turn conversations, side chats, expiration/Keep, restart, compaction, branching, disconnection, and cleanup through the UI/interfaces. Require concrete counterexamples and test evidence; an author summary is not a substitute for review. If spawning is genuinely unavailable, record that it was not performed; do not present self-review as an independent pass.

Stage commits and PRs need only summarize actual versions, test commands, necessary screenshots, performance results, migration/rollback, and unverified items; do not create an empty management bundle. Full delivery requires all scope to be actually wired, required validations to pass, and blocking issues to be closed. For external issues such as missing credentials, first complete other unaffected implementation, then accurately report validations that could not be completed instead of fabricating success or retrying indefinitely.

### 11.1 Parallelizable and Non-Parallelizable Work

One owner maintains the shared data model, scheduling state, and migrations. Once shared contracts are stable, work on the six Adapters may proceed in parallel within independent file scopes. Codex and Pi may form the first validation slices for two different structures while Claude/Hermes/OpenCode/Cursor progress in parallel; the other four must not be reduced to unwired stubs. Product integration and storage-write shutdown follow after their dependencies pass.

Do not artificially increase the number of PRs. Multiple verifiable commits on one work branch are sufficient, or use stacked PRs under current repository conventions. Continue to the next item after any slice completes; passing the first item does not mean the whole task is complete.

## 12. Migration, Rollout, and Rollback

An old Conversation may have used a different Session for each turn; do not assign the last turn's Session to the entire old chat. First inventory old data read-only. Add native references only to records whose native ID, execution range, permissions, and retention can all be verified; keep all others on the legacy Reader.

New eligible conversations use native bindings directly. When continuing an old chat, choose either verified native continuation from the terminal point or one explicit visible-context handoff; record the migration boundary. Do not manually merge multiple raw session files or describe migration as lossless restoration of all internal state.

Roll out by Runtime/Profile/version, not through one global switch. Fix the native execution mode for each Binding; do not sometimes send only deltas and sometimes replay the full history within the same session. If a native upgrade introduces incompatibility, pause affected new submissions and retain read/repair paths; do not automatically create a blank Session.

Rollback disables new admission; it does not delete newly created structures or Readers. Runs that already have native references remain readable; switch only after in-flight execution has safely converged. Keep early database changes incrementally compatible; rollback must not lose all new history. Legacy-log cleanup is a retention policy, not a default migration deletion step.

## 13. Acceptance Methods, Resource Metrics, and Completion Criteria

### 13.1 Verification Layers

Unit/contract tests check selectors, ordinals, idempotency, events, configuration, and sources. Integration tests check real DB transactions, Run/Attempt, resources, and failure recovery. E2E tests check main/side Chat user behavior. Real native tests verify Session persistence, compaction, branching, permissions, plugins, tools, and Profile consistency that mocks cannot prove. “The command executed successfully” is not a substitute for these layers.

The next section retains the original proposal's 97 acceptance IDs and substantive requirements directly in this document, without a separate JSON ledger. Conditional tests apply only when the corresponding feature is enabled, such as Claude object mirroring; state the condition explicitly rather than marking all five required native Adapters N/A. Passing a mock is not the same as native verified.

### 13.2 Resource-Test Workloads

Use deterministic tool/session Fixtures to construct the same before-and-after comparison: for example, 100 Conversations with 100 inputs each, tool results ranging from 1 KiB–1 MiB, 10,000 items in one session, 10 concurrently active sessions, slow clients and reconnect bursts, disk-full conditions, and object-storage failures. These values suggest a test shape; they do not claim measured performance or define new user quotas.

Measure SQL row count and write bytes, SQL growth, independent raw-log growth, control-service RSS, Host RSS, browser heap, initial history and detail-read latency, Stop/approval response time, and recovery latency. Include growth in native persistent volumes and object supplements; do not claim total storage has been eliminated merely because data moved out of the database.

Native continuous sessions do not guarantee smaller model context or lower model costs; do not equate reduced duplicate writes in Rudder with reduced model tokens. Long-lived processes may reduce startup latency while increasing idle memory; measure each separately and define a reclamation policy.

### 13.3 Check Commands and Real Environments

Use current local package scripts and AGENTS requirements; do not blindly run commands from an older version. Previous baseline checks included the following commands; use the current repository as the source of truth:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
# Run the affected current E2E suites and the repository's required CI checks.
# Run relevant cargo test/check/clippy when native crates/bridges change.
# Run pnpm desktop:verify when packaged startup, profiles, or migrations change.
```

Validate database migrations in an isolated instance. Do not reset a user instance or delete real Sessions for testing. Use Fixtures for large workloads, and validate real model calls at small scale within existing authorization and budget. A successful build does not replace browser/desktop execution; retain necessary screenshots of affected interfaces as acceptance evidence.

### 13.4 Definition of Done

At completion, main Chat truly continues along native sessions and displays/controls all required interactions; Agent Run is the shared foundation for all surfaces and each Run is precisely associated with its native span; no existing Side Chat lifecycle or parent/child interaction regresses; all six Adapters are actually wired and their real capabilities and limitations are verifiable; and history remains readable under the correct permissions after restart/compaction/branching.

Runtimes that meet the reference-only criteria have actually stopped duplicate raw-process writes, with clear scopes for necessary object supplements; all consumers use the shared Reader; retention, backups, GC, legacy records, and rollback are verified; costs, permissions, approvals, and user data are not compromised; and both independent review rounds are actually performed and closed out. Unverified items must not be concealed by green status, documentation, or a disabled feature flag.

Commits, PRs, and the final report accurately list implementation, actual tests, performance results, and remaining blockers. No additional project-management files are required, and filling out a template is not evidence of completion.

## 14. Inline Acceptance Checklist: 97 Concrete Scenarios

The following are requirements to execute, not results already passed in this change. Run each applicable scenario for the relevant Runtime; shared Reader/scheduling Fixtures complement a small number of real native validations.

### Side Chat Product Regressions

| ID | Conditions, actions, and required results |
|---|---|
| SC-01 | Draft entry points: Open from /side, an assistant action, or an empty panel. Before the first Send, do not create a server Conversation, native Session, Run, or model call; leave the parent draft unchanged. |
| SC-02 | First-send idempotency: Concurrent identical creation requests produce only one hidden child chat and one input. Reusing the same mutation ID with a different source or Agent must conflict; do not repeat the Fork. |
| SC-03 | Temporary-session recovery: The first turn's key information exists only in a tool result. After restarting Rudder and the Host, ask a follow-up within the expiration window; natively resume the same logical child session without replaying history. |
| SC-04 | Parent/child concurrency: While the parent Chat has an in-flight Run, an unsent draft, and attachments, operate, Steer, and Stop the child Chat. The parent draft, scroll position, variant, Transcript, and control handles remain unchanged. |
| SC-05 | Copied source: The source contains tool details, annotations, attachments, and an approved operation. The child Chat can read and cite authorized excerpts, but gains no source Run, cost, or approval authority; attachment ownership is correct. |
| SC-06 | Hidden state and creator: Another person in the same organization and a person in another organization each try listing, search, Chat/Run/native references, export, and asset reads. Only authorized principals can read; native IDs do not bypass authorization. |
| SC-07 | Read-only after expiration: After the server clock reaches the deadline, history remains readable and new unadmitted input is rejected; reaching the TTL does not invoke native deletion. |
| SC-08 | Close affects only child execution: Parent and child both have in-flight work. Close the temporary child Chat and restart during cleanup; only child execution stops, cleanup is recoverable, and the parent task continues. |
| SC-09 | In-place Keep: Repeat Move to Messenger when the child Chat has multiple Runs. Conversation, Binding, Run, and cost identities remain unchanged. Keep does not call native create/fork/start; native compaction is recorded separately. |
| SC-10 | Promotion while streaming/awaiting approval: Keep while output is streaming or a native request is pending, then continue responding in regular Chat. The same request and Attempt remain active, with no restart, lost request, or duplicate response. |
| SC-11 | Keep/Close/GC race: A cleanup task from an old epoch arrives late. Only one valid product state wins; stale work cannot delete a kept resource or revive a destroyed record. |
| SC-12 | Grouping compatibility: Keep and concurrently retry for no group, an existing group, nested Forks, and conflicting groups. Create/reuse once under current family rules; idempotent retries must not regroup unpredictably. |
| SC-13 | Keep while Host is offline: The resource or creation intent is durable, the source is valid, and the deadline has not passed. In-place promotion does not depend on provider RPC, and history status accurately shows offline. |
| SC-14 | Change Agent/Runtime: Select another Agent/Profile in the child Chat and send. Use native Fork when compatible and authorized; otherwise perform an explicit context handoff, then continue natively without claiming a lossless migration. |
| SC-15 | Composer/panel: Preserve existing behavior for files, images, citations, model/effort, plan mode, failure retry, scrolling, file/Skill viewing, and keyboard menus; show any gaps explicitly. |
| SC-16 | Title and override: Create/send under a long source title and non-default model, rename the source chat, then Keep. Snapshot/truncate the child title under existing rules; clearing an override must not be overwritten by a natively inherited model. |
| SC-17 | Long-term recovery after Keep: After promotion, a child conversation with multiple native Segments undergoes native pruning and restart. Preserve both old Runs and native restoration state; kept metadata alone is insufficient. |
| SC-18 | Keep after expiration: Preserve existing rejection rules exactly at the deadline, after the deadline, and after expired has been committed; do not create a permanent chat or perform native operations. |
| SC-19 | TTL refresh: Compare actual persisted messages with tokens, polling, reads, reconnection, and late callbacks. Only existing allowed activity refreshes the deadline; do not revive a committed expired state. |
| SC-20 | Source deletion: If the source disappears before the Keep transaction, roll back promotion and grouping together; retain the panel and draft and leave no partially promoted record. |
| SC-21 | Precise selection: The source has answer variants, later turns, and a stopped prefix. Create Side Chats from each selection; include only the selected authorized prefix, not another variant, later information, or an unseen tail. |
| SC-22 | Different close entry points: Closing an unsent draft creates no server-side work. Closing a kept panel only removes the view and does not delete the permanent chat. Inline, menu, and keyboard actions are consistent; preserve state on failure. |

### Agent Run and Unified Execution

| ID | Conditions, actions, and required results |
|---|---|
| RN-01 | Actual entry points: Trace Chat, Issue, Review, Automation, Heartbeat, and all six Adapters through current TS/Rust code. The shared foundation must actually be called; no newly created but unwired scheduler may remain. |
| RN-02 | Old Run does not grow: Run consecutive R1/R2/R3 under one Binding, then refresh and read R1. Return only R1's native range; do not merge its state or cost with other Runs. |
| RN-03 | Physical identity changes: Continue and read an old Run after native compaction successor or leaf changes. The logical binding remains consistent, and the old selector still locates the correct source without guessing by time. |
| RN-04 | Unknown acceptance: Native execution accepts an input with side effects but its response is lost; retry after restart. Reconcile first; if unresolved, it remains unknown and side effects are not repeated. |
| RN-05 | Old lease and controls: A lease expires while the old execution is still running; attempt takeover and send late Steer/Stop. No unfenced dual writes occur, and old controls cannot affect the new task. |
| RN-06 | Single queue ownership: Reconnect/replay a mutation while both Rudder follow-up and native guidance queues exist. Each new input has one Run and one submission; Steer remains in the current Run. |
| RN-07 | Long-lived credentials: The second turn has different credentials from the first, and a reused Host calls Rudder tools. Authorize each request against the exact current Attempt; do not reuse the first-turn Token or a global currentRunId. |
| RN-08 | External native writes: CLI/Desktop and Rudder use the same physical Session concurrently. Use provable native coordination or reject unsafe concurrency; do not treat a DB lock as an external fence. |
| RN-09 | Interleaving across surfaces: Run Chat A, Issue B, and Automation for the same Agent, then return to A. A is not hijacked; task claiming runs only in task surfaces, and budget/terminal-state rules are preserved. |

### Transcript and UI Reading

| ID | Conditions, actions, and required results |
|---|---|
| TR-01 | Model context is not history: Open an old Run when the convenient Reader has compacted old tool content. Read the complete authorized raw history/object supplement; do not label a summary as the complete process. |
| TR-02 | Read-only means no execution: Count native calls. Reading history, expanding, paginating, and refreshing must not trigger a model/tool/approval or change the leaf of an executing native session. |
| TR-03 | Large history: Load the initial view, details, and recover after disconnection with 10,000 items, pre-compaction entries, and large tool output. Host/server/browser resources are bounded; cursors are stable; empty/partial/offline/missing are distinguishable. |
| TR-04 | Stop prefix is monotonic: After Stop is accepted, native output continues; then refresh/provide feedback. The visible body remains the exact cutoff prefix, and the hidden tail does not become the final reply or model context for a new branch. |
| TR-05 | Late child result: The parent has ended before a child result arrives. Attach the causal evidence exactly once; do not reopen the parent terminal state or overwrite/double-count costs. |
| TR-06 | Historical requests are not replayed as controls: A snapshot contains old approvals/questions while a new live request exists. Historical records are read-only; do not auto-answer them or route them to the new request. |
| TR-07 | Stream framing: Handle UTF-8/JSON split across chunks, multiline SSE, duplicate frames, and reconnection beyond the buffer. No garbling, duplicate tool rows, or re-execution; snapshots reconcile correctly and parsing is bounded. |
| TR-08 | All consumers: A new native-reference Run has no legacy transcript rows at all. Main/side Chat, Run Detail, annotations, feedback, search, learning, and export still work through the Reader. |
| TR-09 | Unknown events/source disappears: Inspect Nice/Raw/details. Safely display unknown content without exposing more private data; report missing sources clearly, with no silent reconstruction or empty-success state. |

### Native Retention, Cleanup, and Backup

| ID | Conditions, actions, and required results |
|---|---|
| GC-01 | Ancestor retention: A kept branch depends on a parent Segment/child session when native pruning occurs. Preserve the dependency or first retain it independently through a valid mechanism; complete authorized history remains readable. |
| GC-02 | Deletion cascade: Deleting a temporary owner affects native descendants, one of which has a separate retention reference. Inspect the actual cascade scope; do not blindly delete by root ID. |
| GC-03 | Cleanup fencing: Replay GC while execution is still active or a claim has changed, including across promotion/restart. Revalidate epoch, owner, and actual terminal state; do not delete active/permanent resources. |
| GC-04 | Persistence prerequisite: Attempt native-reference mode with only an in-memory Session or an unbacked temporary worker disk. Reject it and explain the persistence conditions required. |
| GC-05 | Orphan creation: Native Fork succeeds but the DB commit fails; reconcile retries and cleanup. Adopt the same identity or safely reclaim it; do not repeat model execution or accumulate orphans indefinitely. |
| GC-06 | Backup integrity: A mirror is missing a sub-agent, checkpoint, or native entry, or reports failure; then attempt to delete the last local copy and restore on another Host. Do not treat this as a complete backup or permit deletion first. |

### Permissions, Secrets, and Source Isolation

| ID | Conditions, actions, and required results |
|---|---|
| SEC-01 | Same ID, different principals: Different users/Profiles have similar native IDs and cross-access cursors/objects/aliases/caches. No access crosses organizations, creators, or Profiles; reauthorize expansions and exports. |
| SEC-02 | Copying does not copy authority: A child Chat displays parent approvals/tool receipts; try responding with a copied ID or charging costs. Read-only sources gain neither original control authority nor source-consumption attribution. |
| SEC-03 | Credential recovery: The old Token has expired; after restarting and restoring the Profile, call with a new Run/old reference. Permit only current authorization; diagnostics/artifacts contain no secrets. |
| SEC-04 | Lower-privilege child branch: Fork/hand off from a higher-privilege source using fewer tools or a different principal. Validate content and permissions; copying native state must not expand authority. |
| SEC-05 | Native-search privacy: Another operator's Agent searches a private Side Chat's unique marker using session_search, a plugin, or Memory. It must also be unable to bypass authorization at the native search layer. |
| SEC-06 | Secret and revocation: Answer a secret question, cancel an approval, then replay a late browser response. Secrets do not enter the database/logs, and an old response cannot approve a subsequent action. |

### Codex

| ID | Conditions, actions, and required results |
|---|---|
| CD-01 | Codex continuity: After information unique to a tool result, run three turns and then more than twelve messages, restarting the process midway. Use the same concrete Thread and only new input; do not replay Rudder history. |
| CD-02 | Codex Fork from an old Turn: The parent has advanced; create a Side Chat from an earlier completed Turn. Use a new concrete Thread with the correct root relationship; do not disturb in-flight parent work, and include the exact boundary. |
| CD-03 | Codex controls: Round-trip native permission/user-input requests, and Steer/Stop a specified Turn with late callbacks. Do not answer empty, approve by default, or affect another Turn. |
| CD-04 | Codex Session missing/pagination unsupported: Read and follow up without silently calling thread/start. Display the actual source/capabilities and use only a verified bounded alternative Reader. |
| CD-05 | Codex native final: Commentary/tool/final without Rudder sentinels completes normally exactly once; no extra repair inference, and commentary is not passed off as final. |
| CD-06 | Codex descendant cleanup: An isolated test Thread has a retained descendant. Cleanup must reflect native cascades without deleting a kept child or otherwise-referenced evidence. |

### Claude Code

| ID | Conditions, actions, and required results |
|---|---|
| CL-01 | Claude explicit resumption: Two Sessions in the same cwd plus another Profile; restart and resume them interleaved. Always select the correct ID/configuration; do not use the directory's most recent session. |
| CL-02 | Claude pre-compaction reading: Open an early Run when getSessionMessages omits old entries; the raw Reader/supplement still provides the complete authorized source. |
| CL-03 | Claude Fork IDs: Fork at an assistant boundary, continue, and cite the source. The boundary and remapping are accurate; old UUIDs do not control the child Session. |
| CL-04 | Claude configuration and interaction: Compare instructions/Skills/MCP/model/questions between native Code and Rudder under the same authorization. Do not lose capabilities or expand permissions because of SDK defaults. |
| CL-05 | Claude checkpoint: With existing file checkpoints, configure the selected cloud mirror and branch/rewind. Do not enable an incompatible combination or silently disable checkpoints. |
| CL-06 | Claude mirror failure: Complete a Run and attempt recovery/cleanup after mirror error, missing listSubkeys, or missing child entries. Preserve the last local copy; do not mark incomplete child recovery as passed. |

### Hermes

| ID | Conditions, actions, and required results |
|---|---|
| HE-01 | Hermes native history: With existing tool results, send only new input using the Session ID, without caller history/response chain. Verify real native continuation and that synthesized context is no longer injected. |
| HE-02 | Hermes idempotency: When the formal Idempotency-Key is supported, retry/restart with the same payload, conflict on changed payload, and simulate expiration. Reuse the original Run within the contract; after expiry, do not blindly resend an operation with unknown side effects. |
| HE-03 | Hermes compaction successor: When native state moves to a successor Session, continue and read the old Span through the native resolver. Keep the logical binding stable and preserve the original identity/range. |
| HE-04 | Hermes complete details: Tool output exceeds the SSE preview; after the stream ends and the Host restarts, expand it. Complete authorized details remain available; do not label a preview lossless. |
| HE-05 | Hermes product controls: While approval/clarify/secret is pending, respond, cancel, queue, Steer, and interrupt. Use one native owner; secrets are transient; do not let separate HTTP/TUI processes misdirect controls. |
| HE-06 | Hermes Profile parity: Under an authorized configuration with Memory, Skills, selected tools, and model, compare native/Rudder multi-turn behavior and test another user. Do not prune the tool set and pass it off as native; search must not leak data. |
| HE-07 | Hermes late child result: Child execution outlives the parent SSE; wait for native delivery, read details, and send the next real input. Deliver once; do not reopen the parent Run, start spontaneous inference, or double-charge. |
| HE-08 | Hermes Gateway recovery/branching: Refresh the browser, reconnect the Host, then branch from an old assistant reply. Do not create a new Session on every refresh or branch from the latest head; pending-request behavior is accurate. |
| HE-09 | Hermes pruning and Keep: In an isolated configuration, perform actual pruning with old history/compaction ancestors and a permanent child chat. Claims/backups preserve reading and recovery; do not alter borrowed global settings. |

### OpenCode

| ID | Conditions, actions, and required results |
|---|---|
| OC-01 | OpenCode native server: Create, send consecutive inputs, and restart in an authenticated isolated instance. Session/Workspace are correct, message/part Run ranges are explicit, and history is not replayed as plain text. |
| OC-02 | OpenCode branch boundary: After a user/tool/assistant chain and a later input, Fork from the old assistant and compare ancestry. Prove whether the boundary is included; do not substitute the adjacent user boundary or revert the parent file. |
| OC-03 | OpenCode requests/commands: Handle plugin/MCP questions, permissions, native commands, and interruption. Use the installed schema; do not auto-approve or guess endpoints; preserve output. |
| OC-04 | OpenCode 204: Disconnect immediately after asynchronous acceptance while subsequent input is queued. The Run remains incomplete until its own native terminal state arrives; reconnection does not resubmit. |
| OC-05 | OpenCode shared SSE: Handle global events from two Sessions, a slow client, and restarting one instance. Project only each scope's events; bound buffers; do not dispose unrelated servers. |

### Pi

| ID | Conditions, actions, and required results |
|---|---|
| PI-01 | Pi explicit persistence: Use RPC input, restart, and send again in a Session with managed extensions. Use the correct file/Profile; do not use no-session or the directory's latest Session. |
| PI-02 | Pi assistant boundary: The parent is updating while an old assistant message is selected; call a valid lifecycle helper. The child ends exactly at that assistant message, the parent leaf is unchanged, and no fake RPC/user insertion occurs. |
| PI-03 | Pi extension veto: session_before_fork vetoes with RPC success=true/cancelled=true. Treat it as canceled; do not switch Fork/handoff paths to bypass the decision. |
| PI-04 | Pi tree-shaped Reader: The source contains abandoned branches and pre-compaction history; read old/new Runs separately. Return only the corresponding ancestor range; do not replay all entries as context. |
| PI-05 | Pi settled state: Retries/compaction continue after turn_end/agent_end. Do not complete the Run early or admit the next input twice; finish only at the verified complete terminal state. |
| PI-06 | Pi Unicode/extensions: A JSON string contains U+2028/U+2029 and an extension question; receive across chunks, then respond/cancel. LF framing is correct; interaction is not silently a no-op. |
| PI-07 | Pi costs: Cumulative stats already include history and compaction/tool consumption before another turn completes. Record only new causal usage; do not charge the cumulative total again to every Run. |

### Cursor

| ID | Conditions, actions, and required results |
|---|---|
| CU-01 | Cursor ACP continuation: The installed version supports ACP new/load. Create, continue, restart, and load by explicit ID; preserve native continuity and modes. |
| CU-02 | Cursor blocking extensions: Route ask_question/create_plan/permission through Rudder for user response or cancellation. Respond correctly; do not hang because an extension was ignored. |
| CU-03 | Cursor history: load replay may omit items. After restart, read an old Run and compare with natively visible information. Use native-reference only with sufficient evidence; otherwise use object supplements, without fabricating completeness or a full SQL copy. |
| CU-04 | Cursor without precise Fork: If the installed version does not support boundaries, create a Side Chat and Keep it. Preserve the lifecycle and make handoff explicit; do not label it a lossless Fork or guess at a private database. |
| CU-05 | Cursor capability detail: Check project/user/team MCP, modes, and task/plan/image notifications individually. Map supported features; do not let one green badge conceal real limitations. |

### Global Acceptance and Delivery

| ID | Conditions, actions, and required results |
|---|---|
| OP-01 | Capability evidence: A Runtime is documented but unavailable locally or lacks credentials. Configuration/reporting distinguish unknown/documented/observed/verified; missing evidence is not a pass, and all six scopes are explicit. |
| OP-02 | Duplicate-write scan: Emit a large unique marker from a deterministic tool and scan SQL, logs, result, recovery, and telemetry. It appears only in declared native-source/object exceptions; short annotations/Stop snapshots are counted separately. |
| OP-03 | Before/after performance: Under identical large-history, concurrency, and reconnect workloads, measure SQL/log/server/Host/browser resources and latency. Do not pass off full reads followed by browser slicing as an optimization. |
| OP-04 | Rollback with mixed history: Mix legacy/native-reference while native Chat is active, disable the new entry point, and restart. Old/new Readers remain usable; do not alternate replay/incremental modes or delete old data. |
| OP-05 | Other surfaces/Runtimes: Run existing suites for Task/Review/Automation/Heartbeat and OpenClaw. Budgets, admission, and execution do not regress; Chat gains no new Issue dependency. |
| OP-06 | Two real review rounds: Use available independent Reviewers/Verifiers and fix findings. Reports reflect actual identities/context and tests; accurately state what did not run and do not present self-review as independent approval. |
| OP-07 | Honest final delivery: If mocks pass but some native credentials/tests are missing, summarize that accurately. List real calls, versions, validations, screenshots, metrics, and blockers; dormant flags and legacy stubs do not count as completion. |

## 15. Evidence References for Implementation

The following are prior code baselines and official protocol references. They are for verification, not additional required reports, and do not mean that every capability has been validated on this machine. If online documentation conflicts with installed source, record the difference and implement against the actually verified version contract; do not silently expand or lower requirements.

[R-BASE] Prior Rudder code baseline: `https://github.com/Undertone0809/rudder/tree/c54001819ca38079b627994557db0a18ed278fc0`. Focus areas: `server/src/services/side-chats.ts`, `chat-assistant.ts`, `runtime-kernel/`, and the six `packages/agent-runtimes`. Prefer current local code; do not roll back to the SHA.

[R-SIDE] Side Chat code and subsequent family grouping: `server/src/services/side-chats.ts`, `doc/plans/2026-07-21-side-chat-title-and-fork-grouping.md`, and `server/src/__tests__/side-chats.test.ts` at the baseline above. An earlier July 19 document has grouping guidance superseded by later revisions and is not the current primary contract.

[R-HERMES] `packages/agent-runtimes/hermes-gateway/src/server/execute.ts` at the same Rudder baseline. Session mapping, synthesized tool context, HTTP submission, and controls were previously inspected; this does not claim that current local code remains unchanged.

[S1] Codex App Server: `https://developers.openai.com/codex/app-server`. The current entry point may redirect; inspect the native protocol/schema for the actual version. Do not assume the storage engine supports experimental pagination merely because it appears in the documentation.

[S2] Claude sessions: `https://code.claude.com/docs/en/agent-sdk/sessions`. Verify explicit Session resumption, Fork, and initialization identity; SDK/CLI versions must match.

[S3] Claude storage: `https://code.claude.com/docs/en/agent-sdk/session-storage`. Verify message-chain restoration, complete raw entries, mirroring/subresources, and checkpoint limitations separately; do not treat convenient reads as a guarantee of complete history.

[S4] Hermes API rendered docs: `https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/`. Includes Runs/Session/capabilities entry points; its cache/version differs from descriptions in fixed source. In particular, verify deduplication retention and native loading semantics against the installed version.

[H-API] Hermes fixed source previously inspected: `https://github.com/NousResearch/hermes-agent/blob/25d88ad0c44ccf0dcf8228f184b5a495c16b9f9f/website/docs/user-guide/features/api-server.md`. Its descriptions of native Session-backed Runs, idempotency, and child results are evidence for that version, not universal guarantees for all deployments.

[H-TUI] Hermes product bridge: `https://github.com/NousResearch/hermes-agent/blob/main/ui-tui/README.md` and the same version's `tui_gateway/`. `main` is a mutable reference; local implementation must pin the installed version and inspect its actual registry/contracts. Do not pass a new Rudder helper off as an upstream RPC.

[S5] OpenCode Server: `https://opencode.ai/docs/server/`. Calibrate implementation against the installed instance's `/doc` or corresponding OpenAPI, especially message boundaries and permission/question routing.

[S6] Pi RPC: `https://pi.dev/docs/latest/rpc`. Calibrate low-level/settled, queue, entry, fork/clone, and extension cancellation behavior. `latest` documentation does not replace checking the local version.

[S7] Pi Session format: `https://pi.dev/docs/latest/session-format`. The native tree/ancestry and valid branching API are foundational; calling only low-level file APIs does not prove that the extension lifecycle is preserved.

[S8] Cursor ACP: `https://cursor.com/docs/cli/acp`. Native Sessions, controls, extension requests, and specific limitations; do not invent unproven precise Fork/history capabilities by analogy.

---

**Delivery principle: Completion requires all five: continuity and complete interaction in native Chat; unified execution and precise attribution through Agent Run; no regression in Side Chat product behavior; real integrations for all six Runtimes; and verifiable storage optimization.**
