---
title: Complete Plan for Rudder Native Chat Experience and Agent Run Execution Architecture
date: 2026-09-21
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - agent_run
  - runtime_session
  - side_chat
  - chat_transcript
---

# Complete Plan for Rudder Native Chat Experience and Agent Run Execution Architecture

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

**Change entry points.** Integrate through `packages/agent-runtimes/codex-local/src/server/app-server-chat.ts`, the App Server client, `execute.ts`, and tests. Split session/control/history mapping into small modules in the same package; do not continue piling the entire implementation into an existing large file.

**Creation and submission.** Complete initialize/initialized, start a persistent thread or resume using an explicit thread ID. Emit sessionBound early, then submit `turn/start` containing only new input and bind the turn ID as early as possible. Preserve managed CODEX_HOME, Workspace, model/effort, and existing approval policies. Use the native terminal state directly for ordinary replies; do not run sentinel repair.

**Controls.** Use `turn/steer` with expectedTurnId; use `turn/interrupt` for Stop. Route native requestUserInput, command approvals, file approvals, and other requests that require a response through the shared human-request layer. Preserve the distinction between unknown acceptance and a closed turn.

**Reading.** Use supported `thread/read` to read native history; use `thread/turns/list` and `thread/items/list` only after actual verification. Do not enable a storage mode that can list summaries but cannot read fully or resume. The scope of one Run is determined by its concrete turn ID; large histories require controlled Host reads and a rebuildable index.

**Side Chat.** Fork natively from the selected completed Turn. Preserve the child Thread and root-session identifier, and avoid operating on the parent Thread. Persist temporary Side Chats too. Before deletion, inspect spawned-descendant cascades and descendant retention references. Keep must not require a native Fork/delete/pin as a transaction precondition.

**Must test in a real environment.** Continuation beyond 12 messages; follow-up questions whose relevant information exists only in tool results; Rudder and Adapter restarts; complete tool details; questions and rejections; precise branching; Stop cutoff; no silent Session creation when a Session is lost; and safe cleanup of child resources.

### 8.2 Claude Code: SDK/Control Protocol and Complete Native History

**Protocol basis.** The current official interface supports resumption and Fork by explicit Session ID; resuming the most recent session in a directory has different semantics from resuming by explicit ID. `getSessionMessages` through the SessionStore path may expose only the compacted model-restoration chain; handle raw entries, Fork identity mapping, mirror integrity, and file checkpointing separately. [S2][S3]

**Change entry points.** Keep `claude-local`. Prefer the currently supported Agent SDK streaming/query/control or a formal control protocol compatible with the installed CLI. Do not build a new implementation on a removed experimental SDK interface; match the SDK to the actual executable version.

**Creation and submission.** Capture the native Session ID as early as possible from the init event, then explicitly resume on subsequent turns. Concurrent Chats must not use directory-level continue/latest. Preserve the native Code preset and add Rudder instructions incrementally. Verify that CLAUDE.md, settings sources, Skill, plugins, MCP, permissions, and project root match the authorized native environment; do not assume SDK defaults match CLI defaults.

**Controls.** Route interruption, permissions, AskUserQuestion, and similar requests through live query/control. Distinguish whether the SDK accepts new input as immediate guidance or queues it for later; do not label queued behavior native steer. Test multiple-choice, rejection, waiting, and cancellation.

**Reading.** For users inspecting old Runs, use a versioned native JSONL/SDK raw-entries Reader, filtering by UUID/parent chain and the sealed range. Keep the model-restoration chain separate from the complete-history Reader. When Fork rewrites IDs, establish native source mappings; do not continue querying child history by parent UUID.

**Side Chat.** Prefer a native no-inference Fork helper that supports exact boundaries. For versions that support only fork-on-query, manage the first real input and creation as one operation, persisting creation intent and acceptance state; empty dummy prompts are prohibited. Reach the assistant anchor through the installed version's native API or a legitimate helper; do not manually combine different Session files.

**Retention and cloud.** Use the native persistent volume first. If SessionStore/object mirroring is added, verify mirror failures, duplicate UUIDs, sub-agent subkeys, and recovery integrity; a mirror error must not be treated as a successful backup. When existing file checkpointing is enabled, do not use an incompatible combination or silently disable checkpoints. Retention must also account for native cleanup policy; do not alter borrowed user-global configuration without authorization.

**Must test in a real environment.** Explicit resumption, pre-compaction history, Fork ID rewriting, native configuration and interactions, checkpoint behavior, interrupted mirroring, and child-session recovery. Mirroring is an optional deployment capability, but if this path is used, its tests are a hard gate.

### 8.3 Hermes: Native Product Interaction Is a First-Class Deliverable

**Evidence boundary.** A prior audit of the Rudder Adapter found that it already uses Session/Run HTTP, but still has synthesized tool context and a workstream key derived per Run. Previously inspected fixed upstream source records native Session-backed Runs and richer request semantics; the native TUI uses the product Gateway. [R-HERMES][H-API][H-TUI] Rendered documentation differs from fixed source in version/cache behavior. Do not treat the deduplication window, resumption, or Fork capabilities described by either source as facts that apply to every installed version.

**Preserve one Hermes Runtime that users can understand.** Continue using `hermes_gateway`, with two explicit backends selected internally according to configuration and capabilities. `native_product_rpc` provides complete local product interaction; the managed Host connects to or starts the installed Hermes product Gateway under an authorized Profile. `native_runs_http` is for remote native Session-backed Runs. These are not two unrelated Agent types, and the backend must never switch silently after a runtime error.

**Local real acceptance.** Verify through the installed Hermes runtime and its configured AI provider under the authorized local Profile. Select `native_product_rpc` (or local ACP) for this verification; Hermes API Server authentication is required only for an explicitly selected remote `native_runs_http` backend and does not gate local-native product verification. A remote 401 is not a local-native verdict.

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

**Change entry points.** Split server lifecycle, API client, Session mapping, and Transcript projection in `opencode-local`. Start or connect to an explicitly owned native Server, defaulting to authenticated loopback; use a protected Host relay remotely. Do not connect to an arbitrary other user's server on a familiar port.

**Creation and input.** Calibrate fields against the installed instance's `/doc` or equivalent schema, and submit the current input parts to the corresponding Session. Preserve native config/providers/agents/plugins/MCP. Verify how the existing `--pure` affects loading behavior; do not blindly retain or remove it. Use native part types for media/attachments rather than flattening them into strings.

**Run boundaries and state.** Record the user message ID, causally related assistant messages, parts, and terminal state. Native acceptance of a client message ID does not guarantee persistent idempotency; test it. An idle session on a shared stream alone does not prove that a particular input has completed; associate the Run with its native messages and results.

**Interactions and reading.** Respond to permission/question requests according to the current schema, and handle tool results and file Diffs. The history Reader reads message/part ranges; isolate SSE by instance/Profile/Session and correctly handle multiline data and disconnection recovery. Invoke native commands through the command API and complete the Run after terminal-state reconciliation.

**Side Chat.** Check whether `messageID` in `/session/{id}/fork` includes or excludes the boundary, and whether the selected assistant message and its associated tool chain are included completely. If a completed-assistant prefix cannot be reached, add a helper at the native Session service layer; do not substitute the preceding user message. Do not implement chat branching through revert/file rollback.

**Must test in a real environment.** More than three consecutive turns; Fork at an exact message; questions/permissions/commands; accepted state after disconnection following a 204; isolation of shared SSE streams; complete details; and history after restart.

### 8.5 Pi: Native RPC and Session Tree

**Protocol basis.** Pi RPC distinguishes low-level agent_end from fully settled, and supports questions/extension UI, Steer, follow-up, and session-entry reading. Its regular fork targets historical user messages, while clone can copy the current branch; extensions can cancel a Fork. SessionManager branch extraction must work together with the higher-level extension lifecycle. [S6][S7]

**Change entry points.** Use `pi --mode rpc` or an equivalently supported SDK Host in `pi-local`, explicitly specifying the native Session file/resource and preserving existing managed extensions, MCP, Skills, model, and configuration. Do not enable no-session or generate unrelated files for every turn.

**Input and completion.** Map ordinary input, native steer, and follow_up according to the single-queue rule. An input RPC ID provides correlation only; do not infer deduplication by resending the same JSON when acceptance is unknown. Versions supporting agent_settled use that complete termination semantic; retries/compaction may still occur after a lower-level end. Older versions require verified native idle/retry/queue reconciliation; do not guess completion with a timer. If delegating to a native follow-up queue, maintain Run attribution for every distinct user input.

**Session tree and Reader.** Capture the native session header, stable entry ID, and current leaf. Locate a Run by an exclusive start, inclusive end, and leaf/ancestor revision. `get_entries` may include abandoned branches and pre-compaction records; filter by ancestry and execution range. `get_messages` is for the restoration view and does not replace complete history. Use a stable incremental cursor directly when supported by the installed version; for large responses, build a rebuildable index and bounded reads on the Host.

**Side Chat assistant boundary.** Do not pass an assistant entryId directly to a fork that accepts only historical user messages. For the current position, native clone may be used in an isolated branch context. Implement earlier assistant boundaries through SessionManager branch extraction supported by the installed version, such as the documented createBranchedSession capability, while still running valid higher-level validation/extension events.

Do not move the parent-session leaf, truncate source JSONL, fabricate a user message, or bypass session_before_fork. If the extension returns cancelled=true, treat the operation as canceled even when RPC success=true; do not automatically hand off to bypass the extension's decision. Identify any new helper as a Rudder integration; do not invent a standard navigate_tree RPC.

**Extensions and streams.** Support selection, confirmation, text input, cancellation, and portable extension cards. Provide an explicit path for terminal custom components that cannot be represented directly; do not silently ignore them. JSON framing uses only protocol LF; U+2028/U+2029 and UTF-8 split across chunks are not transport boundaries. Bound memory for incomplete frames.

**Must test in a real environment.** Continuation from native persistence; old assistant anchors; concurrent parent sessions; extension veto; complete ancestor history; retries after low-level completion; Unicode and extension UI; and incremental billing that does not recount the entire Session.

### 8.6 Cursor: ACP Native Integration and Genuine Capability Gaps

**Protocol basis.** Current official ACP documentation covers `agent acp`, session create/resume, input/update, permissions, and cancellation. Cursor's custom ask_question/create_plan operations are blocking requests; task, Todo, and image updates are notifications. The documentation also states differences in the scope of MCP support. [S8]

**Change entry points.** Preserve `cursor-local` and authentication/configuration compatibility. Use ACP on supported installed versions; do not treat the old print CLI as a permanent capability ceiling. After initialize/auth, use explicit session/new, session/load, session/prompt, session/update, session/cancel, and session/request_permission, verifying fields against the installed protocol.

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
| Chat calls | `server/src/services/chat-assistant.ts`, helpers | Surface assembly calls Run; native input does not replay history; remove ordinary-result repair on the native path |
| Run core | `server/src/services/runtime-kernel/`, `packages/shared/src/agent-run.ts` | Unify SessionIntent, leases, recovery, spans, and costs |
| Data model | `packages/db/src/schema/heartbeat_runs.ts`, chat schema and migrations | Add bindings/spans/references compatibly; do not rename throughout the repository |
| Runtime public boundary | `packages/agent-runtime-utils/` and existing shared types | Typed native input/events/capabilities and Reader |
| Six Adapters | `packages/agent-runtimes/{codex-local,claude-local,hermes-gateway,opencode-local,pi-local,cursor-local}` | Native transport/session/control/history for each |
| Side Chat | `server/src/services/side-chats.ts`, family/annotation helpers | First Send branching, in-place Keep, retention, independent cancellation |
| Controls and events | Successor modules for chats stream routes, chat-generation-protocol, run-events, etc. | Persist state reliably; do not duplicate raw deltas |
| UI | `ui/src/pages/Chat*`, `SideChatPanelView.tsx`, `RunTranscriptView*` | Same semantic projection, independent state, lazy loading, request/response round trips |
| Native Rust | Actual call paths through `native/crates/runtime-core`, `runtime-attempt-core`, `run-evidence-core`, etc. | Change contracts and bridges in the layers already migrated |

Paths come from prior audits and are navigation leads; locate them based on files present locally before implementation. A directory's existence does not mean it is wired into production; trace the actual Router → Service → bridge → runtime call chain.

### 10.3 Coordinate with the Ongoing Rust Migration

Modify state/persistence/evidence logic already owned by Rust in Rust, updating public protocols and TS call bridges. Modify Runtime I/O still managed by TypeScript at its current layer. Do not maintain two parallel Run state machines, or add Rust functions while the actual entry point continues to run old logic.

Protect other migrations in progress in the worktree: do not overwrite, reset, or pull unrelated refactors wholesale into this PR. Complete changes to schema/shared/server/ui/native together and preserve existing compatibility reads. Completion of this project does not depend on the repository-wide Rust migration being finished.

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

The October 1 convergence correction assigns one owner to each failing call chain. Obtain root-cause evidence before rerunning its targeted acceptance, and freeze reviewed runtime source before a real-provider replay. Keep provider readiness failures separate from implementation work. Integrate existing changes into buildable, bounded candidates before expanding scope; publish independent prerequisite slices through small PRs, and merge each only after its own review, acceptance, and required CI pass. The coordinator owns integration and reads every terminal verdict; parallel workers own disjoint implementation or verification scopes rather than competing retries of the same failure.

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
