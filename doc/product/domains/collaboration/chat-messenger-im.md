---
title: Chat Messenger And IM Integration
domain: collaboration
status: active
coverage: detailed
contract_ids:
  - CHAT.LIFECYCLE.001
  - CHAT.INLINE.VISUAL.001
  - CHAT.TITLE.GENERATION.001
  - CHAT.FORK.001
  - CHAT.SIDE.CHAT.001
  - CHAT.RICH.REFERENCE.RENDERING.001
  - CHAT.WEBSITE.LINK.ICON.001
  - CHAT.THREAD.MANIFEST.001
  - CHAT.SIDE.PANEL.001
  - MESSENGER.ATTENTION.001
  - MESSENGER.THREAD.PREVIEW.001
  - MESSENGER.CUSTOM.GROUPS.001
  - MESSENGER.SAVED.VIEWS.001
  - IM.FEISHU.001
related_code:
  - desktop/src/browser-ipc.ts
  - desktop/src/browser-profile.ts
  - desktop/src/browser-webview-policy.ts
  - desktop/src/browser-shortcuts.ts
  - desktop/src/side-panel-close-shortcut.ts
  - desktop/src/preload.ts
  - packages/agent-runtimes/codex-local/src/server/app-server-chat.ts
  - packages/agent-runtimes/codex-local/src/ui/parse-stdout.ts
  - packages/agent-runtime-utils/src/types.ts
  - packages/db/src/schema/chat_conversations.ts
  - packages/db/src/schema/chat_messages.ts
  - packages/db/src/schema/chat_generations.ts
  - packages/db/src/schema/chat_work_manifest_items.ts
  - packages/db/src/schema/agent_integrations.ts
  - packages/shared/src/constants.ts
  - packages/shared/src/types/chat.ts
  - packages/shared/src/project-mentions.ts
  - packages/shared/src/chat-work-manifest.ts
  - packages/shared/src/browser-shortcuts.ts
  - packages/shared/src/website-icons.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/product-intelligence.ts
  - server/src/services/chats.ts
  - server/src/services/chat-work-manifest.ts
  - server/src/services/chat-agent-runs.ts
  - server/src/services/chat-steer-messages.ts
  - server/src/services/side-chats.ts
  - server/src/services/messenger.ts
  - server/src/services/organization-intelligence-profiles.ts
  - server/src/routes/integrations.ts
  - server/src/services/integrations/agent-integrations.ts
  - server/src/services/integrations/feishu/inbound-dispatcher.ts
  - server/src/services/integrations/feishu/inbound-dispatcher-db.ts
  - server/src/services/integrations/feishu/inbound-normalizer.ts
  - server/src/services/integrations/feishu/event-verifier.ts
  - ui/src/index.css
  - ui/src/components/MarkdownBody.tsx
  - ui/src/api/websiteMetadata.ts
  - ui/src/lib/source-badge.ts
  - ui/src/lib/browser-side-panel.ts
  - ui/src/lib/desktop-browser-link-router.ts
  - ui/src/lib/side-panel-targets.ts
  - ui/src/lib/side-chat.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/context/ChatGenerationContext.tsx
  - ui/src/components/Layout.tsx
  - ui/src/components/MilkdownMarkdownEditor.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/components/side-panel/SideChatPanelView.tsx
  - ui/src/components/WorkspaceFilePreview.tsx
  - ui/src/components/WorkspacePdfPreview.tsx
  - ui/src/motion.css
  - ui/src/pages/Chat.parts.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/Chat.work-manifest.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/agent-runtimes/transcript.ts
  - ui/src/lib/chat-stream-state.ts
  - ui/src/pages/ProjectDetail.tsx
  - ui/src/lib/messenger-thread-organization.ts
  - ui/src/pages/Chat.messages.tsx
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
  - ui/src/components/transcript/RunTranscriptView.blocks.tsx
  - ui/src/components/transcript/RunTranscriptView.common.tsx
  - ui/src/components/transcript/RunTranscriptView.normalize.tsx
  - ui/src/pages/Messenger.tsx
  - ui/src/pages/AgentDetail.runs.tsx
  - server/src/routes/website-metadata.ts
  - server/src/services/website-metadata.ts
  - ui/src/pages/AgentDetail.integrations.tsx
related_tests:
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-profile.test.ts
  - desktop/src/browser-webview-policy.test.ts
  - desktop/src/browser-shortcuts.test.ts
  - desktop/src/side-panel-close-shortcut.test.ts
  - packages/agent-runtimes/codex-local/src/server/app-server-chat.test.ts
  - ui/src/lib/browser-side-panel.test.ts
  - ui/src/lib/desktop-browser-link-router.test.ts
  - server/src/__tests__/chat-routes.test.ts
  - server/src/__tests__/chat-work-manifest.test.ts
  - server/src/__tests__/chat-assistant.test.ts
  - server/src/__tests__/messenger-service.test.ts
  - server/src/__tests__/product-intelligence.test.ts
  - server/src/__tests__/organization-intelligence-profiles.test.ts
  - ui/src/components/MessengerContextSidebar.actions.test.tsx
  - server/src/__tests__/agent-integration-routes.test.ts
  - server/src/__tests__/agent-integration-inbound-dispatcher.test.ts
  - server/src/__tests__/agent-integration-feishu-db-dispatcher.test.ts
  - server/src/__tests__/agent-integration-feishu-inbound-normalizer.test.ts
  - ui/src/lib/index-css.test.ts
  - ui/src/lib/source-badge.test.ts
  - packages/shared/src/browser-shortcuts.test.ts
  - ui/src/components/MilkdownMarkdownEditor.test.ts
  - ui/src/components/MarkdownBody.test.tsx
  - ui/src/lib/side-panel-targets.test.ts
  - ui/src/lib/side-chat.test.ts
  - ui/src/context/SidePanelContext.test.tsx
  - ui/src/components/Layout.test.ts
  - ui/src/components/WorkspaceFilePreview.test.tsx
  - ui/src/components/WorkspacePdfPreview.test.tsx
  - ui/src/pages/AgentDetail.runs.test.ts
  - ui/src/pages/Chat.test.tsx
  - ui/src/lib/messenger-thread-organization.test.ts
  - ui/src/pages/Chat.empty-state.test.tsx
  - ui/src/context/ChatGenerationContext.test.tsx
  - ui/src/lib/motion-css.test.ts
  - ui/src/lib/chat-stream-state.test.ts
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - ui/src/pages/Chat.messages.test.tsx
  - ui/src/components/MarkdownEditor.test.tsx
  - ui/src/components/transcript/RunTranscriptView.test.tsx
  - server/src/__tests__/website-metadata.test.ts
  - server/src/__tests__/website-metadata-routes.test.ts
  - packages/shared/src/website-icons.test.ts
  - tests/e2e/markdown-website-link-rendering.spec.ts
  - tests/e2e/messenger-contract.spec.ts
  - tests/e2e/messenger-hover-preview.spec.ts
  - tests/e2e/chat-streaming.spec.ts
  - tests/e2e/chat-edit-stream-layout.spec.ts
  - tests/e2e/chat-concurrent-streaming.spec.ts
  - tests/e2e/chat-options-menu.spec.ts
  - tests/e2e/chat-prompt-starters.spec.ts
  - tests/e2e/chat-fork.spec.ts
  - tests/e2e/chat-side-chat.spec.ts
  - tests/e2e/chat-rich-references.spec.ts
  - tests/e2e/chat-side-panel.spec.ts
  - tests/e2e/built-in-browser.spec.ts
  - tests/e2e/chat-work-manifest.spec.ts
  - tests/e2e/chat-composer-at-mentions.spec.ts
  - tests/e2e/chat-transcript-internal-events.spec.ts
  - tests/e2e/agent-detail-feishu-integration.spec.ts
  - tests/e2e/feishu-source-badges.spec.ts
  - desktop/scripts/smoke.mjs
edit_policy: user_confirmed_only
---

# Chat Messenger And IM Integration

## CHAT.LIFECYCLE.001

Why:

- Chat is a conversation-driven task execution surface. Humans can clarify,
  execute, refine, and complete real work in Chat without first converting the
  conversation into an issue.
- Issue proposal drafting is operator-intent gated. A chat assistant may draft
  an issue proposal only when the latest operator-authored user request
  explicitly asks to create an issue, convert the chat to an issue, or draft an
  issue proposal.

Product model:

- A chat conversation belongs to an organization and may link to issues,
  projects, resources, approvals, or automation runs.
- Every locally created native chat has a preferred agent. The create API uses
  the caller's selected organization agent when supplied and otherwise assigns
  the organization's first available agent; it rejects creation before
  persistence when the organization has no available agent.
- Entry points that only establish context, such as Project `Chat`, open an
  unpersisted new-chat draft. They must not create an empty conversation merely
  because the operator opened the composer.
- No Chat may persist without at least one durable message or structured system
  event. The first accepted message is the atomic creation boundary across UI,
  API, CLI, MCP, automation, and IM entry points.
- Messages have role, status, body, attachments, rich references, structured
  payloads, and optional run attribution.
- Completed assistant messages may own scriptless inline visual presentation
  under `CHAT.INLINE.VISUAL.001`. Its backing asset and trusted placement mapping
  are internal message state, not a normal attachment, Library artifact, or work
  Output.
- A conversation Work manifest reconciles inspectable Outputs, Sources, and
  References from the active visible message branch and durable production
  evidence under `CHAT.THREAD.MANIFEST.001`.
- Chat-native assistant turns that invoke runtimes are Agent Runs under
  `RUN.CHAT.AGENT.001`.
- The conversation menu exposes its newest linked Agent Run. Agent Runs
  navigation collapses matching runs with the same normalized conversation
  identity into one entry, while individual attempts remain available through
  the run detail's `Chat Replies` evidence.
- Chat and issues are parallel ways to move tasks forward. Chat organizes work
  through an ongoing conversation; issues add explicit status, ownership,
  priority, dependencies, and review structure.
- A completed assistant answer may be refreshed as another variant of the same
  chat turn. The visible branch controls let the operator compare prior and
  refreshed variants without creating a new conversation.
- If a newer turn variant is actively streaming, existing branch controls for
  that turn remain visible and clickable. Branch navigation during streaming is
  a local transcript preview only; it must not stop, restart, or mutate the
  active generation.
- Assistant message bodies contain user-visible assistant output only. Runtime
  transcript evidence such as thinking/reasoning entries, scratchpad text, tool
  logs, and incomplete adapter summaries remain run evidence, not chat bubble
  body content.
- Chat process details expose meaningful thinking and tool activity, not raw
  provider lifecycle bookkeeping. Empty lifecycle events such as
  `reasoning started` / `reasoning completed` and Rudder result-envelope
  delimiters are hidden from the default Chat projection even when they arrive
  as fragmented streaming deltas.
- Completed process activity uses progressive disclosure: the resting row is a
  human-readable semantic digest with one stable icon, while its disclosure
  indicator appears on hover or keyboard focus and stays available on coarse or
  no-hover input. The control remains keyboard operable, and all-failure groups
  remain expanded so actionable failure evidence is not hidden.
- Expanded process activity exposes structured file reads and edits as direct
  file actions when the transcript provides an absolute target or a relative
  target plus a trusted absolute execution root. Unresolvable relative paths
  remain text, and Chat does not infer file actions from assistant prose.
- The process transcript presents each provider reasoning item once. Readable
  summary and raw streams for the same item are alternative representations,
  not separate progress events; streamed fragments coalesce and multiple
  summary parts keep readable boundaries.
- The live Work Transcript presents each accepted assistant or thinking delta
  once. Client-side fragment coalescing must not mutate transcript state that
  has already been published to the UI; React updater replay, remounts, or
  equivalent render retries must not append the same fragment a second time.
  The live projection and persisted replay preserve the same fragment order and
  duplicate-free visible text.
- When a user sends a local chat follow-up while that conversation already has
  an active assistant generation, Rudder parks the follow-up in a visible
  running queue instead of starting a second concurrent reply in the same chat.
- Editing or retrying a historical user message is not a queued follow-up. If
  the conversation still has an active assistant generation, the operator must
  Stop that response first; the edit or retry must never be converted into a
  Queue row or presented as Steer feedback.
- Queued follow-ups preserve the queued body and composer context until they are
  delivered. Operators can edit or delete ordinary queued follow-ups while they
  remain queued. The server, rather than the open browser, owns claiming and
  delivering eligible follow-ups.
- Steer is a durable operator command, not an optimistic queue label. If the
  active runtime attempt supports native steering, Rudder submits the feedback
  to that same provider turn. Otherwise Rudder interrupts the current attempt
  and automatically starts a feedback continuation after the old owner reaches
  a safe terminal boundary.
- Once Rudder accepts Steer as a durable control action, its feedback becomes
  one durable visible operator message immediately. Native same-turn delivery
  and fallback continuation reuse that persisted message, so the operator's
  input remains visible after the queue row leaves, across reloads, and without
  duplicate bubbles on retry.
- Native same-turn Steer is presented as a dedicated operator interjection in
  the owning generation's Work Transcript, at the durable generation-event
  boundary where the operator sent it. Runtime evidence emitted before Steer
  stays before it, later reasoning and tools stay after it, and the final
  assistant response follows the Work Transcript. The live, completed, and
  reloaded projections must preserve that same ordering and message identity.
- Steer that is scheduled as a fallback continuation did not enter the old
  provider turn. It remains the same durable message but is presented between
  the old run and the new continuation, never inside the old Work Transcript.
- Every Steer reaches an inspectable disposition: delivered to the current
  provider turn, scheduled as the next continuation, provider acceptance
  unknown, or actionable failure. Provider receipt does not claim that the
  model complied with the feedback, and an ambiguous receipt must not trigger a
  blind duplicate continuation.
- Chat-native work remains inspectable through the conversation, Agent Runs,
  Work manifest, and linked outputs. Creating or linking an issue is optional
  structured coordination, not a prerequisite for real or durable work.
- When a new Chat has recent conversations for its selected Project, the empty
  state offers `Use cases` and `Chats` in one header aligned with the Project
  label. Recent-conversation rows keep full-width straight separators at rest;
  pointer hover alone insets the active row and adds the shared control radius
  and quiet surface emphasis without changing conversation order or content.
- A new Chat's `Use cases` page begins with four compact task-category rows.
  Selecting one writes only that category's short trigger into the composer,
  preserves selected Skill, Project, and Agent context, and moves to a second
  page of four complete editable prompt suggestions. Selecting a suggestion
  replaces the trigger with the full prompt but does not create a conversation
  or submit work until the operator sends it.
- A selected Project is always identifiable in the Chat composer by its Project
  icon, including after the conversation starts and Project context becomes
  locked. Before the first turn, hovering or focusing the selected Project chip
  replaces that icon in place with the clear action; the label and chip geometry
  stay fixed. Locked Project context keeps the icon visible and exposes no clear
  action.
- When Plan mode is active, the composer chip shows the Plan icon at rest and
  replaces it in the same fixed-size slot with the dismiss icon only while
  hovered; the label and chip geometry remain fixed.
- Conversations with more than five visible user messages show a compact
  message map for jumping to earlier user turns. The map samples at most 64
  markers and previews the user turn plus the following assistant reply without
  loading or rendering additional transcript evidence.

Flow:

1. User opens a new-chat draft or an existing chat. Context-only entry points
   preserve their selected Project without persisting a conversation.
2. On an empty new Chat, the operator may select a compact task category and
   then a complete prompt suggestion before editing or sending the draft.
3. Composer includes a selected agent and may include attachments, mentions,
   rich references, selected skills, and structured proposal payloads.
4. Before the first send, the server performs a side-effect-free preflight for
   organization access, Agent/runtime/model support, context ownership, and
   attachment validity. A failure keeps the complete unpersisted draft.
5. On the first accepted send, the server atomically persists the agent-backed
   conversation, context links, first message, title, and activity before
   acknowledging the turn. Direct create callers must supply a non-empty first
   message; the server derives its role from the authenticated actor.
6. If assistant startup or generation fails after acceptance, Rudder retains
   the accepted user message and durable, visible failure evidence.
7. If a runtime assistant is invoked, Rudder creates a chat Agent Run and
   streams/persists assistant messages.
8. The operator can open the conversation menu to inspect its newest linked
   Agent Run, then use `Chat Replies` to move between distinct attempts without
   expanding duplicate conversation entries in the Agent Runs navigation.
9. Chat can continue executing the task conversationally or create/link an
   issue, automation, or approval when the operator asks for that additional
   structure. The assistant must not emit an issue proposal merely because the
   work is large, durable, assignable, or issue-shaped.
10. When the operator refreshes a completed assistant answer, Rudder reuses the
   original turn context, creates a new turn variant, and surfaces branch
   controls for moving between variants.
11. While the refreshed or edited variant is still streaming, the operator may
   switch the visible turn branch back to an earlier variant to inspect prior
   user and assistant content. The current stream continues in the background,
   generation controls remain available, and returning to the active/latest
   variant shows the live stream draft again.
12. If the operator sends another local follow-up while the selected chat has an
   active generation, Rudder creates a queued follow-up with the current draft,
   attachments, selected project, skills, model/effort, access mode, and
   expected active generation id.
13. The queue renders beside the composer with stable ordering. The first queued
   item is marked as next, later items show their queue position, and editable
   queued items expose edit/delete controls.
14. When the operator chooses Steer, Rudder atomically persists the durable
   control action, one normal user message, their queue linkage, and message
   activity evidence before attempting provider delivery. The message records
   its target generation and exact Work Transcript boundary. It stays in the
   conversation whether delivery is native, deferred, unknown, or actionable
   failure; delivery status remains separate evidence. Pending, provider-
   acceptance-unknown, and accepted native delivery use that one anchored
   interjection. Continuation delivery keeps the message outside the old run.
15. When the current reply completes, a server-owned worker claims the next
   eligible queued follow-up, sends it as the next chat turn, and hides the
   queued row after it is linked to the delivered user message. The row leaves
   the composer as soon as that user message is visible, even while the new
   assistant reply is still running. Delivery does not depend on the
   originating page remaining open.
16. If the current reply is stopped, fails, or is otherwise not completed,
   ordinary queued follow-ups stay parked and are not silently flushed. The
   operator may explicitly Steer retained feedback; Rudder then persists a
   continuation, waits for the prior owner to terminate, and starts that
   continuation without requiring the feedback to be resent.

Invariants:

- Chat messages must remain tied to their conversation and organization.
- A Chat transaction must not commit a conversation before its first message or
  structured system event. Preflight, validation, permission, context,
  attachment-preparation, Agent, runtime, and model failures are side-effect
  free and must not add Messenger rows, activities, or bindings.
- After the first message is accepted, runtime startup and generation failures
  are real work evidence: the Chat, accepted message, and durable visible error
  remain inspectable.
- Production code may create `chat_conversations` only through approved
  lifecycle services. Automation and IM bindings must share the atomic first
  event transaction; Fork and Side Chat must copy history or add a system event
  before commit.
- A locally created native conversation must not persist without a preferred
  organization agent, and an existing native conversation cannot clear that
  assignment through the Chat update API. Agent-organized Messenger views must
  not present `No agent` as a valid chat state. Legacy or externally sourced
  records that cannot resolve an agent remain visible as `Agent unavailable`;
  legitimately unassigned split issues remain distinct as `Unassigned`.
- Chat proposals/structured payloads must not be confused with plain user
  instructions or automation run input.
- Assistant-created issue proposals must be grounded in an explicit latest
  operator-authored request for issue creation, chat-to-issue conversion, or
  issue-proposal drafting.
- A task becoming executable, long-running, expensive, reviewable, or worth
  revisiting must not by itself force Chat to create an issue. Policy may still
  require structured issue fields for governed team workflows.
- When an assistant turn is stopped before completion, the chat may show only
  already streamed user-visible assistant text as a partial reply. It must not
  fill the bubble from provider reasoning/thinking events or incomplete runtime
  summaries.
- Internal provider lifecycle events and Rudder result-envelope markers must
  not render as Chat progress rows, assistant progress text, or fragmented
  pseudo-content. The underlying transcript remains run evidence available to
  diagnostic/raw views.
- Reasoning evidence must remain inspectable without repeated words or rows when
  a provider emits parallel summary and raw streams. Providers that emit only
  raw reasoning must retain that evidence through stopped, interrupted, or
  failed turns.
- Accepting Stop establishes a durable output cutoff for the active generation.
  The visible assistant reply is the accepted prefix at that cutoff; provider
  deltas, final messages, reasoning, and summary data arriving afterward must
  not mutate the chat body, reorder progress, or replace the prefix after
  reload.
- Once a generation is already `stop_requested` or `stopping`, a repeated Stop
  may request the local interrupt again but must remain in progress. A server
  instance without the runtime owner must not synthesize
  `interrupted_unverified` terminal evidence that can race the owning
  instance's later verified `stopped` result.
- Refreshing an assistant answer is allowed only for completed assistant
  messages in locally mutable chats. External-bound conversations that require a
  fork-to-continue path must not expose direct refresh.
- Refresh variants must remain scoped to the original chat turn. They must not
  erase the earlier answer or make the prior variant unreachable.
- Branch preview during an active stream must be display-only. It must not abort
  the active stream, alter the active draft's persisted turn variant, or switch
  the runtime context used by the in-flight assistant turn.
- When an operator previews an older branch of the same turn during an active
  stream, Rudder hides the newer active stream draft from the visible
  transcript until the operator returns to the active/latest branch. The stop
  control for the active generation remains available.
- Queued follow-ups must remain scoped to one conversation and organization.
  Queue creation, editing, cancellation, claiming, release, and steering
  endpoints must enforce the same conversation access and local mutation rules
  as normal chat sends.
- Queue ordering must be deterministic by stored position and creation time.
  Idempotency keys must not allow the same queued item id to be reused with a
  different payload.
- An ordinary queued follow-up must not become a visible user message until it
  is claimed and delivered through the normal chat send path. Explicit Steer is
  the exception: accepting its durable control action must materialize exactly
  one normal user message immediately, and native delivery, continuation,
  retries, and reloads must reuse that same message. A visible Steer message
  records operator input; it does not by itself claim provider compliance.
  Delivered or running queued rows are hidden from the running-queue UI once
  linked to a user message. In particular, linked `dequeue_claimed` and
  `running_next` rows must not remain in the composer after their user message
  is visible. A recovery back to `queued` or `failed_actionable` remains visible
  even when linkage metadata is retained, so editable or actionable work is not
  silently hidden.
- For native same-turn Steer, the visible Work Timeline is runtime transcript
  evidence before the durable Steer boundary, the anchored operator
  interjection, runtime evidence after it, then the final assistant response.
  Replacing the live draft with its final persisted reply, reconciling provider
  acknowledgement, editing a historical message, collapsing/loading process
  details, or reloading must not move, hide, duplicate, or reorder that Steer.
  Ordering is anchored by generation sequence / transcript-entry count, not by
  client or message wall-clock timestamps.
- Stopped or failed replies leave ordinary queued follow-ups parked. Rudder
  must not silently flush old queued work after an interrupted run. A retained
  row changes this rule only when the operator explicitly chooses Steer.
- Steering is fenced to the expected generation, runtime attempt, and control
  version. A stale request resolves through its durable action identity; it
  must not steer a newer attempt, lose feedback, or create a duplicate
  continuation.
- Native steering is offered only by the active attempt that registered that
  capability. Attempts without native support use interrupt-and-continue, and
  retained feedback after Stop remains steerable as a server-owned
  continuation.
- External-bound Feishu conversations are read-only locally. They must reject
  queued follow-up mutations through the same fork-to-continue boundary as
  normal local chat mutation APIs.
- Agent attribution is visible enough to navigate from message to run/agent.
- Conversation-to-run navigation chooses the newest linked assistant attempt;
  per-conversation grouping in the run rail must not collapse the underlying
  run records or their evidence.
- When Chat merges organization-wide mention candidates with the selected
  agent's enabled skill candidates, one canonical skill target appears only
  once. The selected-agent candidate wins so the composer preserves the
  agent-specific enabled-skill boundary and metadata.
- Work-manifest reconciliation must not read hidden reasoning, transcript tool
  payloads, stdout, or stderr as user-visible Sources or References.
- Project-scoped recent-conversation rows must remain visually scan-friendly at
  rest: separators span the list width and rows do not carry rounded corners or
  inset margins until the operator hovers that row.
- Prompt suggestions must remain inert while the category-to-suggestions page
  transition is running; reduced-motion mode moves directly to the same usable
  state. Hidden prompt pages remain mounted so focus, dimensions, and exit
  animation do not depend on remounting the list.
- The message map excludes superseded, empty, assistant, system, and proposal
  rows from its user-turn count. Preview excerpts remain bounded and must not
  cut through a Markdown link or inline-code token.

Evidence:

- Atomic first-turn route/UI tests cover side-effect-free preflight, required
  initial bodies, multipart context normalization, no pre-ack navigation or
  clearing, one ack-created Chat, and durable startup-failure evidence.
- Automation, Feishu, lifecycle architecture, and migration tests cover atomic
  internal first events, prohibited direct conversation inserts, orphan
  deletion, bound-row recovery, Messenger hiding, and IM binding invalidation.
- Chat E2E covers rich references, skill picker, duplicate-free agent-enabled
  skill mentions, attachments, draft persistence, and attribution navigation.
- Chat menu and Agent Runs E2E cover opening the newest conversation run,
  rendering one conversation navigation entry, and switching to an older run
  through `Chat Replies` without reintroducing duplicates.
- Chat scroll-map focused tests cover the visible-message filter, the 64-marker
  production-sized ceiling, Markdown-safe bounded previews, assistant context,
  and jump delegation.
- Chat assistant tests cover runtime-backed turns.
- Chat assistant tests cover stopped runtime turns that keep reasoning out of
  partial assistant bodies.
- Transcript component tests and Messenger E2E cover hiding internal reasoning
  lifecycle rows and fragmented Rudder result protocol markers while keeping
  meaningful tool activity visible.
- Chat stream state tests and streaming E2E cover immutable live-delta
  coalescing under updater replay and verify the active Work Transcript renders
  each assistant fragment once before the final response is persisted.
- Codex App Server adapter tests and concurrent-streaming E2E cover dual-stream
  reasoning deduplication, raw-only interrupted turns, multipart summary
  boundaries, and the completed Messenger process transcript.
- Chat refresh E2E covers refreshing a completed assistant answer as a second
  turn variant and navigating back to the first variant.
- Chat edit streaming E2E covers switching between prior and active turn
  branches while the replacement branch is still streaming, with the active
  generation still stoppable.
- Chat route tests cover rejecting edit/retry admission into Queue while a reply
  is active and keeping cross-instance repeated Stop requests in `stopping`
  without manufacturing terminal evidence.
- Chat concurrent-streaming E2E covers queueing a follow-up during an active
  stream, editing the queued body, native same-turn Codex Steer, fallback
  continuation, immediate Stop, server-owned Stop-then-Steer delivery, retained
  ordinary follow-ups after a stopped reply, removal of the linked Queue row
  while its delivered turn is still running, and one durable native-Steer
  interjection that survives reload without duplication. Focused UI tests
  distinguish linked in-flight rows from linked rows recovered to `queued` or
  `failed_actionable`. The focused UI tests and native-Steer E2E also verify the
  production-shaped ordering `reasoning A -> Steer -> reasoning/tool B -> final
  response` while streaming, after final persistence, during historical message
  edit replacement, and after reload; fallback continuation remains outside the
  old run.
- Chat route and UI tests cover queue snapshots, active-generation reporting,
  queued follow-up editing/cancellation/claiming, hidden delivered rows,
  retained parked rows, and Feishu-bound queue mutation rejection.
- Chat empty-state UI and E2E coverage verify aligned tabs/Project context,
  the selected Project icon/clear-action swap, the locked-conversation icon,
  full-width square resting rows, and inset rounded hover emphasis for recent
  Project conversations.
- Chat prompt-flow UI, motion-contract, and E2E coverage verify compact starters,
  the two-page transition lock, reduced-motion behavior, context preservation,
  editable prompt completion, retained hidden DOM, and the existing-chat boundary.

## CHAT.INLINE.VISUAL.001

## Contract Summary

Rudder Chat may render a bounded, declarative HTML/SVG/CSS fragment inside a
completed assistant message. The fragment is message-owned presentation state:
it is not a normal attachment, Library file, Chat Work manifest item, or
provider-runtime file contract. Every conforming Agent Runtime uses the same v1
Rudder message envelope and Server-owned canonical placement.

## Intent / User Job

An operator can ask any configured Chat Agent Runtime for a chart, comparison,
timeline, scenario view, or compact visual and inspect it in the answer without
seeing an implementation `.html` file in Work or Library.

## Why / Design Reasoning

Provider-specific visualization directories and directives couple a Rudder
message feature to one runtime and misclassify presentation internals as work
Outputs. A Rudder-owned message protocol preserves runtime neutrality while a
scriptless sandbox keeps visual explanation separate from arbitrary web-app
execution. The Agent authors a fragment; Rudder owns trust, persistence,
placement, sanitization, iframe creation, and lifecycle.

## Actors / Objects / State

- Runtime Agent: emits a complete v1 envelope in the final ordinary Chat result.
- Chat assistant service: suppresses fragment bytes from streaming surfaces,
  validates the envelope, and normalizes it to a canonical placement.
- Assistant message: owns the placement and reserved `inlineVisualsV1` mapping.
- Internal Chat attachment/asset: stores accepted fragment bytes under the same
  organization and message.
- Chat renderer: resolves only a matching trusted mapping and renders a
  scriptless, no-network iframe.

## Entry Points / Inputs

- The always-enabled `visualize` skill under `AGENT.SKILLS.001`.
- An ordinary successful Chat result containing exact own-line
  `:::rudder-inline-visual:v1` and `:::rudder-inline-visual:end` markers.
- Historical and in-flight legacy `::codex-inline-vis{file="..."}` messages,
  which enter only through the compatibility parser/capture path.

## Product Logic Flow

1. Rudder supplies the same v1 authoring contract through an authoritative
   common Chat prompt projection of the always-enabled `visualize` policy for
   every registered Chat runtime. Runtimes with native skill discovery may also
   receive the full skill package; runtimes without it need no provider-specific
   skill directory.
2. The streaming admission path recognizes a live opening marker across
   arbitrary chunk boundaries before transcript projection, run-result summary
   persistence, client event broadcast, or stopped-draft recovery. It buffers
   through the closing marker and never exposes fragment source.
3. After a successful complete final result, Rudder parses exact block-depth-zero
   markers. LF and CRLF are valid; indentation, trailing text, nested markers,
   empty or unterminated blocks, and markers inside CommonMark code/quotes do not
   publish a visual.
4. A message may contain at most three visuals, each at most 64 KiB UTF-8, at
   most 128 KiB total fragment bytes, and at most 256 KiB for a final reply that
   contains a live visual marker.
5. Rudder validates the scriptless fragment contract, creates an internal
   organization/message-scoped HTML attachment, replaces source with
   `::rudder-inline-vis{slot="n"}`, and writes a reserved Server-only v1 mapping
   containing slot, attachment id, MIME, byte size, hash, status, and filename.
6. Public Chat/API input, model structured output, repair output, and imports
   cannot write the reserved mapping. Persistence revalidates the same message,
   organization, replying Agent provenance, MIME, filename, size, and hash.
7. The renderer resolves the same-message mapping, sanitizes HTML/SVG/CSS, and
   creates the restrictive iframe. Scripts, event handlers, forms, active
   controls, links, external resources, storage, network, parent bridge, nested
   frames, and credential access remain unavailable. Native `<details>` is the
   only stateful interaction.
8. Failed, stopped, timed-out, malformed, excessive, or incomplete publication
   discards private fragment bytes and shows only an unavailable presentation;
   no internal source download is offered.
9. Attachment/object/message failures use compensating cleanup, and normal Chat
   deletion releases unreferenced backing assets.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Valid v1 visual | Successful ordinary reply, exact envelope, safe bounded fragment | Inline visual renders at the message placement | Raw HTML, normal attachment row, Work item, or Library file | Parser, route, UI, manifest, E2E |
| Non-Codex runtime | Adapter passes prompt/skill/final-result conformance | Same v1 result and renderer | Provider-named path or directive | Adapter conformance and real-runtime E2E |
| Stop/failure mid-fragment | Opening marker observed without successful completed result | Private buffer discarded; safe stopped/failed body only | Fragment bytes in transcript, event, run summary, or draft | Chunk-boundary and Stop/failure tests |
| Forged mapping | Model/API supplies attachment id or cross-message/cross-organization metadata | Reserved key stripped or mapping becomes unavailable | Rendering another message's asset | Validator/service tests |
| Ordinary Agent HTML | HTML attachment has no trusted same-message visual mapping | Normal Chat attachment and Work Output | Hidden merely because it is HTML | Manifest tests |
| Legacy Codex message | Valid historical directive and managed capture mapping | Continues rendering through compatibility path | New canonical skill output depends on Codex storage | Legacy tests |

## Actor-Visible Input

The Agent sees the v1 Rudder envelope contract and scriptless fragment rules.
The operator asks for a visual normally; no runtime path, filename, iframe, or
attachment-management step is required.

## Operator-Visible Output

The completed answer shows surrounding Markdown and the inline visual. The raw
envelope, canonical placement, backing attachment, and source download remain
hidden. An unavailable visual shows a compact non-download fallback.

## Persisted Evidence

- Canonical placement in the completed assistant message body.
- Reserved Server-owned `inlineVisualsV1` mapping in the same message.
- Same-message Chat attachment and organization-scoped asset for accepted bytes.
- Run result contains normalized message output, never raw fragment source.
- No Library row or Chat Work manifest item exists for the backing asset.

## Canonical Scenarios

1. Runtime-neutral capacity comparison:
   - Trigger: a non-Codex Chat Agent emits one safe v1 envelope.
   - Expected state/action: one internal attachment and trusted mapping persist.
   - Visible output: the visual renders after reload and in a fork.
   - Evidence: adapter conformance, Chat E2E, manifest and fork tests.
2. Interrupted generation:
   - Trigger: Stop occurs inside the opening marker, body, or closing marker.
   - Expected state/action: buffered source is discarded and no mapping publishes.
   - Visible output: stopped prose only; no raw HTML.
   - Evidence: exhaustive chunk-boundary and Stop tests.
3. Ordinary HTML artifact:
   - Trigger: an Agent creates `report.html` without the trusted protocol.
   - Expected state/action: normal attachment/Output behavior remains.
   - Visible output: file appears through existing attachment and Work surfaces.
   - Evidence: manifest regression test.

## Invariants / Non-Goals

- The protocol is Rudder-owned and provider-neutral. Adapter-specific feature
  flags do not gate it: runtime transport tests prove prompt/result integrity,
  while the one common Chat admission path proves source suppression and
  publication safety for all registered Chat runtimes.
- Only a Server-owned same-message mapping authorizes hiding and rendering.
- The backing HTML is neither Library content nor work production evidence.
- Arbitrary JavaScript web apps, network access, and iframe authoring are not
  supported by this contract.
- Legacy Codex capture is compatibility input, not the canonical authoring path.

## Drift Boundaries

Changing marker grammar, limits, mapping trust, supported active behavior,
sandbox permissions, manifest classification, fork ownership, or adapter
conformance requires updating this contract. Sanitizer implementation details
may change without a contract delta when these boundaries remain equivalent.

## Traceability

Related plans:

- `doc/plans/2026-07-21-runtime-neutral-chat-inline-visuals.md`

Related code:

- `packages/shared/src/chat-inline-visuals.ts`
- `server/resources/bundled-skills/visualize/SKILL.md`
- `server/src/services/chat-assistant.ts`
- `server/src/services/chat-assistant.helpers.ts`
- `server/src/services/chat-assistant.inline-visuals.ts`
- `server/src/services/chats.inline-visual-persistence.ts`
- `server/src/services/chats.ts`
- `server/src/services/chat-work-manifest.ts`
- `server/src/routes/chats.ts`
- `ui/src/pages/ChatInlineVisual.tsx`

Related tests:

- `packages/shared/src/chat-inline-visuals.test.ts`
- `server/src/services/chat-assistant.inline-visuals.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `server/src/__tests__/chat-work-manifest.test.ts`
- `server/src/__tests__/generic-chat-runtime-adapters.test.ts`
- `ui/src/pages/ChatInlineVisual.test.tsx`
- `tests/e2e/chat-inline-visual.spec.ts`

## CHAT.TITLE.GENERATION.001

## Contract Summary

Rudder non-fork chat titles use a deterministic first-user-message fallback
plus the organization's `lightweight` Product Intelligence profile, surfaced
as Fast Intelligence, for automatic generation and manual regeneration. Forked
chats keep the source-family numbering defined by `CHAT.FORK.001` and do not
enter automatic first-message title generation. Side Chats likewise keep the
source-title snapshot defined by `CHAT.SIDE.CHAT.001`. The title pipeline must
keep Messenger scannable without blocking chat replies, obscuring lineage, or
overwriting workflow or operator naming.

## Intent / User Job

Operators need Messenger rows to become readable immediately after a chat
starts, and they need a low-friction way to improve vague titles later. They
also need confidence that a late AI title will not erase a title they typed by
hand and that chat send/assistant reply remains reliable when Fast Intelligence
is not configured.

## Why / Design Reasoning

Chat titles need to become useful as soon as a conversation starts so Messenger
stays scannable even before a human renames the thread. AI-generated titles are
a convenience layer over a deterministic fallback, not a dependency that can
block chat replies or erase explicit operator naming.

The key tradeoff is progressive enhancement. Rudder first records a useful
local fallback title, then lets organization-scoped Fast Intelligence improve
that title when available. This keeps the first chat path fast and resilient
while preserving the organization's configured model preference for small
product intelligence tasks.

Fork numbering is already a meaningful title chosen by the fork workflow. It
must remain stable when the child receives its first new message; otherwise a
late fallback or Fast Intelligence result would erase the visible relationship
between branches. Operators may still explicitly rename or manually regenerate
a fork title when they want to replace that relationship-oriented default.
The Side Chat source-title snapshot is the equivalent workflow title for an
ephemeral branch and follows the same automatic-generation exclusion.

## Actors / Objects / State

- Board operator: the user who sends chat messages, renames chats, or chooses
  `Regenerate title`.
- Chat conversation: `chat_conversations.id`, `orgId`, `title`, and updated
  timestamp.
- Fork lineage: `forkedFromConversationId` and `forkRootConversationId`
  distinguish numbered fork titles from default-titled chats eligible for
  automatic generation.
- Chat messages: the persisted first user message used for automatic generation
  and the latest five eligible user messages used for manual regeneration.
- Organization intelligence profile: the organization-scoped `lightweight`
  profile configured under `ORG.SETTINGS.001`.
- Product Intelligence invocation: runtime execution with
  `purpose: "lightweight"` and `feature: "chat_title"`.
- Messenger row/cache state: chat thread title shown in the Messenger sidebar
  and chat detail surfaces.
- Activity record: successful manual regeneration writes
  `chat.title_regenerated` with previous and new title details.

## Entry Points / Inputs

- `POST /api/chats/:id/messages` for non-streaming user messages.
- `POST /api/chats/:id/messages/stream` for streaming user messages.
- `POST /api/chats/:id/fork`, which creates the stable family-numbered title
  governed by `CHAT.FORK.001`.
- `POST /api/chats/:sourceId/side-chats`, which creates the source-title snapshot
  governed by `CHAT.SIDE.CHAT.001` on first Send.
- `POST /api/chats/:id/title/regenerate` for manual title regeneration.
- Messenger chat actions menu, which exposes `Regenerate title` only when the
  selected organization has a configured `lightweight` intelligence profile.
- The first non-empty user message for automatic generation.
- The latest five non-empty, non-superseded ordinary user messages for manual
  regeneration, ordered oldest to newest within that selected window.

## Product Logic Flow

1. User sends the first non-empty message in a chat whose title is still
   `New chat`.
2. Rudder persists the user message and immediately starts the assistant
   response path when requested.
3. Rudder stores the first user message as the visible fallback title without
   waiting for Fast Intelligence.
4. In the background, Rudder asks Product Intelligence with
   `purpose: "lightweight"` and `feature: "chat_title"` for a title.
5. If Fast Intelligence returns a usable title, Rudder replaces the fallback
   only while the stored title is still the expected fallback or `New chat`.
6. If Fast Intelligence is missing, disabled, invalid, unavailable, fails, or
   returns unusable output, Rudder keeps the fallback title and logs the
   failure without failing the chat send.
7. When a conversation is created by the fork workflow, Rudder keeps its
   family-numbered title when new user messages arrive and does not invoke
   automatic fallback or Fast Intelligence title generation for that child.
   A Side Chat similarly keeps its `Side chat from: {direct source title}`
   workflow title.
8. When the operator chooses `Regenerate title` from Messenger chat actions,
   Rudder reads at most the latest five eligible user messages, restores their
   chronological order, builds a bounded prompt, calls Fast Intelligence,
   persists the returned title, refreshes chat and Messenger rows, and records
   `chat.title_regenerated` activity.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| First message, Fast Intelligence configured | Chat title is `New chat`; first user message is non-empty; `lightweight` profile is configured and returns usable output | User message persists, assistant flow continues, fallback title is stored, then usable Fast title replaces fallback | Chat send or assistant reply must not wait on title generation | `server/src/__tests__/chat-routes.test.ts` automatic title cases |
| First message, Fast Intelligence unavailable | Chat title is `New chat`; first user message is non-empty; profile missing/disabled/failing/unusable | Fallback from first user message remains visible; send succeeds; warning may be logged | Chat title must not remain `New chat` when a fallback can be derived | Chat route fallback tests |
| First new message in a fork | Conversation has `forkedFromConversationId`; title is the family-numbered fork title; Fast Intelligence may be configured or unavailable | Message and assistant flow continue while the numbered title remains unchanged; no automatic title runtime is invoked | First-message fallback or Fast Intelligence must not replace the fork title | Chat title service/route tests and chat fork E2E |
| First message in a Side Chat | Conversation is created by the Side Chat first-Send flow with a bounded source-title snapshot | Message and assistant flow continue while `Side chat from: {direct source title}` remains unchanged; no automatic title runtime is invoked | First-message fallback or Fast Intelligence must not replace the Side Chat workflow title | Side Chat service and E2E tests |
| Manual rename races async generation | Operator changes title after fallback but before async generation finishes | Late generated title is ignored unless current title is still fallback or `New chat` | Explicit operator title must not be overwritten | `server/src/__tests__/messenger-service.test.ts` manual rename guard |
| Manual regeneration succeeds | Board operator triggers regenerate; chat has eligible source messages; Fast Intelligence returns usable title | Existing title is replaced, Messenger/chat caches refresh, activity records previous and new title | Regeneration must not create a new conversation or message | Chat route regeneration tests and E2E |
| Manual regeneration lacks source | Chat has no eligible user messages | Request returns 422 and title is unchanged | Runtime must not be called with an empty prompt | Chat route missing-source test |
| Manual regeneration unauthorized | Actor is not board access | Request is rejected before loading chat/product-intelligence state | Agent-auth actor must not regenerate chat title through board route | Chat route authorization test |
| Messenger action visibility | Selected organization has no configured `lightweight` profile | `Regenerate title` action is hidden | UI must not offer an action that predictably fails due to missing Fast Intelligence | Messenger sidebar unit/E2E tests |
| Long input/excerpt | First message or one or more recent user messages are large | The complete prompt is at most 1,500 `o200k_base` tokens; each truncated message keeps its beginning and end around ` ... ` | Title generation must not send unbounded chat history or discard every message ending | Chat title helper and route prompt-bound tests |

## Actor-Visible Input

For automatic generation, the operator-visible input is the first non-empty
message they send in a default-titled chat. Rudder does not ask the operator for
extra title input and does not block the chat composer while generation runs.
Sending a new message in a fork or Side Chat is not automatic title input; the
child already has a stable title from its workflow.

For manual regeneration, the operator sees a `Regenerate title` menu item in
the Messenger chat actions menu only when Fast Intelligence is configured for
the selected organization. The server uses the latest five eligible user
messages. Assistant, system-event, superseded, empty, transcript, and attachment
content is not part of the title prompt contract.

Product Intelligence receives a concise prompt instructing it to return only a
title, with no quotes, markdown, or trailing punctuation. Rudder measures the
complete prompt, including instructions, labels, separators, and message bodies,
with `o200k_base` and keeps it at or below 1,500 tokens. Short messages release
unused budget to longer messages; a message that still exceeds its share keeps
both ends around ` ... `.

## Operator-Visible Output

The operator sees the chat title update in the chat surface and Messenger row:

- On first send, the title changes from `New chat` to a readable fallback
  derived from the first user message.
- If Fast Intelligence later returns a usable title, the fallback may be
  replaced by the generated title.
- If Fast Intelligence fails, the fallback stays visible and the chat send path
  still succeeds.
- A fork keeps its family-numbered title after the first new user message,
  regardless of Fast Intelligence availability.
- On manual regeneration success, the existing title changes to the generated
  title.
- While manual regeneration is in flight, Messenger shows a title-generation
  motion state on the chat row so the operator can distinguish title work from
  a reply-generation spinner.
- On manual regeneration failure, the existing title remains unchanged and the
  API error is surfaced through the normal mutation failure path.

## Persisted Evidence

- `chat_conversations.title` stores the fallback, generated title, manual
  rename, or regenerated title.
- `chat_conversations.forkedFromConversationId` and
  `forkRootConversationId` persist why a numbered fork title is excluded from
  automatic generation.
- `chat_messages` stores the user messages that form the title source material;
  regeneration queries only the latest five eligible rows.
- Successful manual regeneration writes `chat.title_regenerated` activity with
  `previousTitle` and `title`.
- Product Intelligence runtime execution uses organization-scoped
  configuration and runtime metadata with `purpose: "lightweight"` and
  `feature: "chat_title"`; the chat title contract relies on the profile
  contract in `ORG.SETTINGS.001` for setup and validity.
- Background automatic generation failures are logged with conversation and
  organization identifiers for diagnosis.

## Canonical Scenarios

1. First user message gets a fallback title:
   - Trigger: operator sends `Plan the release checklist from this chat` in a
     default-titled chat.
   - Expected state/action: Rudder persists that message and updates the title
     from `New chat` to the fallback.
   - Visible output: Messenger row no longer shows `New chat`.
   - Evidence: `chat_conversations.title` and Messenger E2E.

2. Fast Intelligence improves the fallback:
   - Trigger: configured `lightweight` profile returns `Release Checklist`.
   - Expected state/action: Rudder replaces the fallback only if the current
     title is still the expected fallback or `New chat`.
   - Visible output: chat row title becomes `Release Checklist`.
   - Evidence: chat route automatic generation tests.

3. Operator manually renames before async generation finishes:
   - Trigger: fallback is stored, then operator renames the chat before Fast
     Intelligence returns.
   - Expected state/action: late generated title is ignored.
   - Visible output: operator's explicit title remains visible.
   - Evidence: Messenger service manual-rename guard test.

4. Regenerate is hidden until Fast Intelligence is configured:
   - Trigger: operator opens chat actions in an organization without a
     configured `lightweight` profile.
   - Expected state/action: `Regenerate title` is absent.
   - Visible output: no regenerate menu item.
   - Evidence: Messenger sidebar unit and E2E tests.

5. Fork title survives its first new message:
   - Trigger: operator sends a new message in `Release Checklist (2)`.
   - Expected state/action: Rudder persists the message and starts the assistant
     path without invoking automatic title generation.
   - Visible output: the chat and Messenger row remain
     `Release Checklist (2)`.
   - Evidence: chat title service/route tests and chat fork E2E with configured
     and unavailable Fast Intelligence.

## Invariants / Non-Goals

- Automatic title generation must not block message persistence or assistant
  reply streaming/non-streaming.
- Automatic generation only applies to default-titled, non-fork chats.
  Explicitly titled chats, forked chats, and manually renamed chats must not be
  overwritten by late asynchronous generation.
- The deterministic fallback must remain available when Fast Intelligence is
  not configured or fails.
- Manual regeneration is board-only, organization-scoped, and must reject chats
  without usable title-generation source messages.
- The Messenger `Regenerate title` action is only shown when the selected
  organization has a configured `lightweight` intelligence profile.
- Generated titles are sanitized for display: no markdown fences, heading/list
  prefixes, wrapping quotes, or trailing punctuation; titles are bounded to the
  chat title length limit.
- Every automatic or manual Chat title prompt must be at most 1,500
  `o200k_base` tokens in full. Automatic generation uses only the first user
  message. Manual regeneration uses only the latest five eligible user messages,
  and long selected messages preserve both beginning and end around ` ... `.
- Regeneration failure must not mutate the existing chat title or write a
  successful regeneration activity record.
- This contract does not own intelligence-profile setup, provider selection,
  secret resolution, or model fallback behavior; those belong to organization
  settings and runtime execution contracts.
- This contract does not promise semantic perfection of generated titles. It
  protects fallback, safety, visibility, and non-destructive behavior.

## Drift Boundaries

Update this contract when changing:

- when automatic title generation starts or whether it blocks chat sends
- fallback title semantics or title overwrite guards
- fork eligibility for automatic title generation or the title handoff from
  `CHAT.FORK.001`
- Fast Intelligence purpose/feature routing for chat titles
- board/API permissions for regeneration
- Messenger visibility rules for the regenerate action
- prompt bounds, source-message eligibility, sanitization, or title length
  behavior
- persisted activity/evidence for manual regeneration

Code-only refactors that preserve these semantics do not require a product
contract update.

## Traceability

Related plans:

- `doc/plans/2026-07-21-chat-title-generation-token-budget.md`
- `doc/plans/2026-06-18-chat-title-defaults.md`
- `doc/plans/2026-05-22-organization-intelligence-profiles.md`

Related code:

- `packages/db/src/schema/chat_conversations.ts`
- `server/src/routes/chats.ts`
- `server/src/services/chat-title-generation.ts`
- `server/src/services/chats.ts`
- `server/src/services/product-intelligence.ts`
- `server/src/services/organization-intelligence-profiles.ts`
- `ui/src/api/chats.ts`
- `ui/src/components/MessengerContextSidebar.tsx`

Related tests:

- Chat route tests cover non-blocking automatic title generation, deterministic
  fallback when Fast Intelligence is unavailable, unusable generated output,
  bounded prompts, streaming sends, board-only regeneration, missing-source
  rejection, `chat.title_regenerated` activity, and numbered forks that skip
  automatic generation.
- Chat title generation service tests cover the fork exclusion, latest-five
  user-only selection, `o200k_base` prompt limit, and middle truncation.
- Messenger service tests cover the manual-rename guard that prevents late
  asynchronous generated titles from replacing an explicit operator title, and
  the bounded recent-user-message query.
- Messenger sidebar tests and E2E cover hiding/showing `Regenerate title` based
  on configured Fast Intelligence and updating the visible Messenger row after
  regeneration.
- Product Intelligence tests cover resolving organization-scoped lightweight
  profiles, purpose metadata, and configured/disabled/missing provider failure
  cases.
- Chat fork E2E covers stable numbered titles with Fast Intelligence configured
  and unavailable.

Known gaps:

- Automatic title generation currently logs background failures but does not
  expose a per-chat visible failure state, because the deterministic fallback is
  the user-facing resilience path.

## CHAT.FORK.001

Why:

- Operators often need to explore the same topic from multiple angles without
  contaminating the active thread's runtime context.
- A fork must remain visibly related to the source conversation so the operator
  can compare branches and return to the shared topic family.

Product model:

- A chat conversation may be forked from another conversation, optionally from
  a specific source assistant response.
- The fork records direct lineage with `forkedFromConversationId` and optional
  `forkedFromMessageId`.
- The fork records family lineage with `forkRootConversationId`; nested forks
  reuse the original root conversation.
- Without an explicit title input, the first fork receives the source-family
  base title with suffix `(2)`. Later direct or nested forks receive the next
  available family suffix `(3)`, `(4)`, and so on; numbering is allocated
  uniquely even when fork requests arrive concurrently.
- A nested fork recognizes an existing family suffix only when the surrounding
  family sequence proves it was allocated by Rudder. An isolated manually
  renamed title such as `Plan (2026)`, with no preceding `Plan (2025)` in the
  family sequence, remains literal and forks as `Plan (2026) (2)` instead of
  being collapsed into the `Plan` sequence.
- Numbered titles stay within the chat title length limit. Truncation preserves
  a stable family sequence across suffix-width changes such as `(9)` to `(10)`.
- An explicit fork title remains unchanged. Operators may rename or manually
  regenerate a numbered fork later, but automatic first-message title
  generation must not replace the fork workflow's title.
- Forking automatically ensures one Messenger custom group for the fork family.
  New fork-family groups use the default 🌿 icon. The group contains the
  root/source family and its forks. Nested forks reuse the same group instead of
  creating a new group per child. Because Messenger custom group membership is
  unique per thread, if the root conversation is already in a custom group for
  the operator, Rudder reuses that group as the fork-family group and appends
  the forked conversations to it without overwriting that group's existing
  icon.
- If the source conversation is bound to an external IM provider such as
  Feishu, the fork keeps Rudder lineage but does not inherit the provider chat
  binding. The child is a normal Rudder chat that can be continued locally.
- Refreshing a completed assistant answer is not a conversation fork. It creates
  another variant inside the same chat turn, while `Fork` / `Fork from here`
  create separate conversations with lineage.

Flow:

1. The operator chooses `Fork` from a chat or `Fork from here` on a persisted
   assistant response.
2. Rudder serializes title allocation for the source family and creates a new
   active conversation in the same organization. Without an explicit title,
   the child receives the next available family-numbered title beginning at
   `(2)`.
3. Rudder copies context links and messages up to the requested fork point. If
   no source message is supplied, it copies through the latest eligible message.
4. Rudder writes a system message in the child conversation naming the fork
   source.
5. When the source is Feishu-bound, Rudder leaves the Feishu binding on the
   source conversation only. The fork has no provider source metadata or
   outbound Feishu binding.
6. Rudder ensures the fork-family Messenger custom group contains the root and
   forked conversations, then navigates the operator to the child conversation.

Invariants:

- Forking is board-operator only and organization-scoped.
- Forking the latest state is rejected while the source conversation has an
  active generation.
- Message-level forking remains allowed during later active generation when the
  source message is an already-persisted assistant response, because the forked
  conversation is truncated at that response.
- Forked conversations must not share mutable runtime context with the source
  conversation.
- Turn variants created by assistant-answer refresh must not be treated as
  forked conversations and must not create fork-family Messenger groups.
- Forked conversations must not inherit external provider bindings from the
  source conversation. A fork from a Feishu-bound conversation is locally
  mutable in Rudder and must not send its future messages back to Feishu.
- A message-level fork must not copy messages after the selected assistant
  response.
- User messages must not expose or accept message-level fork actions.
- Ordinary attachments are not copied by the initial fork contract; their
  original source messages remain available in the source conversation.
  Server-owned inline visual presentation is the narrow exception: the copied
  child message receives its own attachment row and trusted mapping to the
  governed immutable asset, without Run or Work Output provenance.
- Nested forks must not produce duplicate fork-family custom groups.
- Forking must not attempt to put the root conversation in multiple custom
  groups; preexisting root group membership is the fork-family grouping anchor.
- Concurrent direct or nested forks in one family must not receive duplicate
  numbered titles.
- Nested numbering must continue the root family sequence rather than append a
  new `(2)` to a Rudder-generated suffix.
- A numeric-looking suffix that is not supported by the surrounding allocated
  sequence is part of the operator's literal title.
- Numbered fork titles must stay within the normal chat title length limit and
  remain sequential when the base is truncated.
- Automatic first-message title generation must not replace a fork's numbered
  title. Explicit rename and manual regeneration remain allowed.

Evidence:

- Chat route tests cover authorization, active-generation rejection, and
  activity logging.
- Messenger service tests cover message-level copy bounds and nested fork group
  reuse, concurrent and nested title allocation, manual numeric suffixes, and
  the title-length boundary.
- Chat message/UI tests cover the message-level fork action.
- Chat fork E2E covers the visible fork workflow, copied-message boundary,
  `(2)` naming, and numbered-title stability with Fast Intelligence configured
  and unavailable.
- Feishu source badge E2E covers that a fork from a Feishu-bound conversation
  returns a normal Rudder chat with no Feishu outbound rows.
- Chat refresh E2E covers that a refreshed assistant answer appears as a chat
  branch/variant rather than as a forked conversation.

## CHAT.SIDE.CHAT.001

### Contract Summary

Side Chat is an operator-owned, ephemeral branch from a completed assistant
answer. It runs in the global Side Panel, uses the ordinary Chat runtime path,
and preserves the parent Chat's transcript, draft, scroll position, and active
generation. It is hidden from ordinary Chat and Messenger discovery until the
operator explicitly moves it into Messenger.

### Intent / User Job

The operator can ask a focused follow-up about an assistant answer without
changing the main conversation or committing a new durable Messenger thread
before the exploration proves useful.

### Why / Design Reasoning

- A full Chat fork is durable and discoverable immediately. That is too much
  structure for a short clarification or tangent.
- A transient client-only prompt would lose runtime evidence and would bypass
  the normal Chat execution, budget, and audit paths.
- Side Chat therefore delays persistence until first Send and keeps the thread
  out of ordinary lists unless the operator promotes it.
- Temporary means disposable: closing the Side Chat tab destroys its client
  draft or hidden persisted conversation. The operator promotes useful work
  with `Move to Messenger` from its tab menu before closing it.

### Actors / Objects / State

- The board operator is the only Side Chat actor. Access is scoped to both the
  organization and the creating user.
- A provisional `side_chat` Side Panel target contains the source conversation,
  optional completed assistant-message anchor, source preview, and an
  owner-scoped client mutation id. It has no persisted conversation id before
  the first Send.
- A persisted Side Chat is a `chat_conversations` row with
  `conversationKind=side_chat`, source lineage, `messengerVisible`, lifecycle
  state, expiry/keep timestamps, the client mutation id, and a bounded
  `Side chat from: {direct source title}` title captured when the row is
  created. The legacy `completed` enum/value remains schema-compatible but is
  not produced by the current Side Chat workflow.
- Current lifecycle states are `active`, `expired`, and `kept`.
- `active` is hidden and mutable until its two-hour send window expires.
  `expired` is hidden and read-only. `kept` is durable, Messenger-visible, and
  mutable through the ordinary Chat path.

### Entry Points / Inputs

- Type `/side` in a normal Rudder Chat composer and select the composer command.
- Choose `Open Side Chat` on a completed assistant message.
- Choose `Side Chat` from the Side Panel empty/add-target surface.
- First Send posts the exact source assistant message plus the provisional
  mutation id to `POST /api/chats/:sourceId/side-chats`, then uses the normal
  Chat message stream route.
- Closing a persisted Side Chat posts to `DELETE /api/chats/:id/side-chat`.
- `Move to Messenger` in the Side Chat tab context menu posts to the
  compatibility endpoint `/api/chats/:id/side-chat/keep`.

### Product Logic Flow

1. All three entry points open the same provisional Side Panel workflow. The
   assistant-message action uses that exact message; `/side` and the empty
   Side Panel target resolve the latest completed assistant answer.
2. Opening the provisional target does not create a server record. The parent
   Chat stays mounted and its draft, transcript, scroll, and active generation
   remain untouched.
3. On first Send, the server validates organization access, operator ownership,
   and a completed assistant-message anchor. Creation is idempotent for the
   organization, owner, and client mutation id. The persisted title snapshots
   the direct source title with the `Side chat from: ` prefix and stays within
   the 200-character Chat title limit.
4. The server copies source context links, messages, and message attachments
   through the anchor. Copied messages do not acquire new run, approval, turn,
   or output ownership. A boundary system event records the Side Chat source.
5. The user message and assistant response run through the normal Chat runtime
   and Agent Run evidence path. Each persisted send while `active` refreshes
   the two-hour send window.
6. Hidden Side Chats are excluded from ordinary Chat lists, Messenger threads,
   recent chats, search results, and custom groups.
7. Closing a provisional tab discards the unsent client draft. Closing a
   persisted temporary tab cancels any active generation, deletes the hidden
   Side Chat and its owned rows, and closes the tab. Close failures stay visible
   and do not silently remove the tab. Move and Close are mutually exclusive for
   the same tab: every close ingress is disabled while Move is pending. If a
   prior close response was lost, a later `not found` closes the stale local tab;
   if Move committed but its response was lost, the kept conversation remains
   intact and a later close conflict only reconciles the stale tab into
   Messenger.
8. `Move to Messenger` changes an `active` Side Chat to `kept`, preserves the
   same conversation id, removes expiry, and makes it visible. It reuses the
   root conversation's existing custom group when present; otherwise it creates
   the same default-leaf family group used by Fork. The family root, direct
   source, and kept Side Chat are ensured in that group without overwriting an
   existing group name or icon. The visibility transition and grouping commit
   atomically. If the direct source no longer exists, Move fails and the Side
   Chat remains hidden and `active`. The Side Panel tab closes only after a
   successful Move, then that same id opens as an ordinary Messenger Chat with
   the ordinary Chat UI.
9. When the send window elapses, the open Side Chat becomes locally read-only
   immediately. The first server mutation at or after expiry atomically marks
   it `expired` and rejects the mutation without creating a message or run.
10. When a kept Side Chat is open as an ordinary Messenger conversation, the
    source title in its `side_chat_started` boundary event navigates directly
    to the source Chat's main Messenger route. It does not open the source Chat
    as a Side Panel target.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Provisional open | Valid normal Chat; completed assistant anchor available | Open one unsaved Side Panel target | Create a conversation before first Send or change parent state | Side Chat E2E entry screenshots |
| First Send | Owner and organization match; anchor is completed; mutation id is new or an identical retry | Create exactly one hidden active Side Chat with the bounded direct-source title snapshot and start the ordinary Chat runtime flow | Duplicate records, copy messages after the anchor, expose the thread in Messenger, or run automatic title generation | Service, route, and E2E tests |
| Active follow-up | Owner matches and expiry is in the future | Persist the message and refresh expiry to two hours | Let another user send or silently retain the old expiry | Service and route tests |
| Close provisional | No persisted conversation id | Discard the client draft and close the tab | Create or retain a server record | UI and E2E tests |
| Close persisted | Hidden Side Chat belongs to operator | Cancel any live generation, delete the temporary conversation, and close the tab | Leave a hidden recoverable thread or delete a kept Messenger Chat | Service, route, and E2E tests |
| Expire | Active send window has elapsed | Transition to expired and reject mutation | Create a user message, generation, or other mutation side effect | Service and route tests |
| Move to Messenger | State is active and the direct source exists | Preserve id, transition to kept, expose in Messenger, and atomically create or reuse the Fork-style family group | Create a replacement Chat, expose a half-grouped conversation, duplicate the family group, or move a completed/expired/orphaned Side Chat | Service, route, and E2E tests |
| Unauthorized access | Wrong organization, non-board actor, or different user | Return not found/denied without revealing the record | Leak Side Chat existence or content | Service and route tests |

### Actor-Visible Input

- The `/side` command appears in the same upward-opening composer menu grammar
  as mentions and the Project, Agent, and Skills menus. It shows the Side Chat
  label, a short explanation, and Enter as the keyboard action.
- The assistant-message action is available only on completed assistant
  responses. The Side Panel empty state offers Side Chat only when a source
  Chat context exists.
- Every Side Chat entry point and header uses the circle-plus Side icon. The
  sparkle icon is not the Side Chat identity.
- Apart from its source-answer preview and expiry state, the Side Chat
  transcript and composer use the normal Chat visual and interaction grammar:
  normal user messages, assistant attribution, process transcript, streaming
  answer, editor, send affordance, and visible Project, Agent, and Skills chips.
- The Side Chat composer does not show the redundant `Enter to send ·
  Shift+Enter for a new line` helper, and there is no Done action.
- The Side Chat tab context menu shows `Move to Messenger`, a separator, and
  `Close`. The Move item is enabled only for a persisted, unexpired `active`
  Side Chat whose lifecycle has finished loading. It remains focusable with
  `aria-disabled` in every other state so its tooltip can explain the result:
  `Send a message first to create this Side Chat.` for a provisional draft,
  `Checking whether this Side Chat can be moved…` while loading,
  `Make this Side Chat a regular Messenger chat. This tab will close.` while
  enabled, and `This Side Chat can no longer be moved. Close it instead.` for
  expired or otherwise unavailable records.

### Operator-Visible Output

- Before first Send, the operator sees an independent provisional composer.
- While active, the operator sees user/assistant turns and a remaining-time
  label without any new row in Messenger.
- Expiry replaces the composer with a read-only explanation.
- Move closes the Side Chat tab, makes the same conversation available in the
  normal Messenger list under its automatic family group and source-title
  snapshot, and opens it with the normal Chat UI.
- In the kept conversation, the Side Chat source boundary is a direct return
  link to the source Chat rather than an adjacent Side Panel preview.
- Send, close, and move failures surface as visible errors or toasts; they are
  not silently ignored. A failed Move retains the Side Chat tab for retry.

### Persisted Evidence

- The Side Chat conversation stores organization, creator, source conversation
  and message lineage, lifecycle state, visibility, expiry/keep timestamps,
  legacy-compatible completion fields, idempotency key, and the bounded direct
  source-title snapshot.
- Copied source messages and attachments preserve the bounded context through
  the anchor. The `side_chat_started` system event records the source boundary.
- Normal `chat_messages`, `chat_generations`, Agent Runs, transcripts, and cost
  evidence record executed follow-ups.
- Activity entries record `chat.side_chat_created`,
  `chat.side_chat_destroyed`, and `chat.side_chat_kept`.

### Canonical Scenarios

1. Focused clarification and discard:
   - Trigger: Open Side Chat on a completed assistant answer, send a follow-up,
     wait for the streaming reply, then close the tab.
   - Expected state/action: The parent draft remains unchanged; the hidden Side
     Chat is destroyed.
   - Visible output: Normal Chat transcript/streaming inside the panel, then the
     unchanged parent Chat with no recoverable hidden thread.
   - Evidence: `tests/e2e/chat-side-chat.spec.ts` close/destroy flow.
2. Useful tangent promoted to Messenger:
   - Trigger: Type `/side`, enter through the composer menu, send, then choose
     `Move to Messenger` from the Side Chat tab menu.
   - Expected state/action: The hidden record becomes `kept` with the same id
     and joins the existing Fork-style family group or creates one when absent.
   - Visible output: The Side Panel tab closes and the same id opens as a normal
     editable Messenger Chat titled `Side chat from: Main strategy chat` inside
     the source family group.
   - Evidence: Side Chat service, route, and E2E keep tests.
3. Expired hidden exploration:
   - Trigger: Attempt another send after the active two-hour window.
   - Expected state/action: Mark expired and reject the send with no new message
     or generation.
   - Visible output: Expired read-only state/error when next inspected.
   - Evidence: Side Chat service and route expiry tests.
4. Invalid anchor or different operator:
   - Trigger: Create from a user/incomplete message or access another user's
     Side Chat.
   - Expected state/action: Reject without creating or exposing a record.
   - Visible output: Validation/not-found response.
   - Evidence: Side Chat service and route authorization tests.

### Invariants / Non-Goals

- A Side Chat never mutates the parent Chat's draft, transcript, scroll,
  selected branch, or active generation.
- A hidden Side Chat never appears in ordinary Chat or Messenger discovery,
  unread counts, recent results, search, or custom groups.
- Expiry is terminal and read-only. An expired temporary Side Chat can only be
  closed/destroyed, not promoted.
- Temporary Side Chat records are disposable and are destroyed through the
  Side Chat close endpoint. The normal Chat delete path accepts kept Side Chats
  because they are ordinary Messenger Chats after promotion.
- Moving preserves the same conversation id and creates or reuses exactly one
  Fork-style family group for new promotions. Existing kept Side Chats are not
  retroactively regrouped by this behavior change.
- Side Chat does not promise a history/archive UI or cross-device recovery of
  an unsent provisional draft.

### Drift Boundaries

- Changes to entry points, anchoring, persistence timing, source-title snapshot,
  owner scope, copied context, TTL, lifecycle transitions, close/destruction,
  visibility, promotion grouping, source return navigation, immutability, or audit
  retention require updating this contract.
- Pure visual tuning that preserves the shared composer-menu grammar and the
  interaction outcomes does not require a product-contract change.

### Traceability

Related plans:

- `doc/plans/2026-07-19-side-chat.md`

Related code:

- `packages/db/src/schema/chat_conversations.ts`
- `packages/shared/src/types/chat.ts`
- `server/src/services/side-chats.ts`
- `server/src/routes/chats.ts`
- `server/src/routes/chats.stream-routes.ts`
- `ui/src/api/chats.ts`
- `ui/src/lib/side-chat.ts`
- `ui/src/lib/side-panel-targets.ts`
- `ui/src/components/side-panel/SideChatPanelView.tsx`
- `ui/src/pages/Chat.tsx`
- `ui/src/pages/Chat.side-panel.tsx`

Related tests:

- `server/src/__tests__/chat-routes.test.ts`
- `ui/src/lib/side-chat.test.ts`
- `ui/src/lib/side-panel-targets.test.ts`
- `ui/src/pages/Chat.messages.test.tsx`
- `tests/e2e/chat-side-chat.spec.ts`

Known gaps:

- None for the current temporary lifecycle contract.

## CHAT.RICH.REFERENCE.RENDERING.001

Why:

- Chat and issue work rely on compact markdown tokens for issue, automation,
  project, library, and skill references. Operators scan these tokens inline
  while drafting, reviewing comments, reading descriptions, and inspecting
  documents.
- Small vertical shifts make references feel broken even when the link target
  is correct. The stable product contract is a shared baseline and icon rhythm,
  not repeated per-surface nudging.

Product model:

- Rich references render as text-first inline tokens with a compact leading
  icon, canonical title/code text, and normal inline wrapping behavior.
- Explicit absolute local-file Markdown links use the same inline grammar and
  show an extension-appropriate code, image, document, spreadsheet, archive,
  or generic file icon. Resolving the icon does not read the local filesystem.
- Composer/editor surfaces and read-only markdown surfaces share the same
  visual grammar for the same reference type.
- In a `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001` surface, canonical Rudder entity
  references inserted through `@`, existing `$skill` references, and previously
  persisted canonical references remain atomic tokens in active and inactive
  blocks. An unmodified click navigates directly instead of exposing the
  underlying Markdown link.
- Issue references that carry status metadata show the issue status icon inline,
  whether they appear in assistant messages, user messages, comments, or other
  read-only markdown bodies.
- Composer tokens may use single-line truncation for very long labels, but
  short or ordinary labels remain visible without unnecessary abbreviation.

Flow:

1. A user inserts or views a markdown reference in chat, an issue comment
   editor, issue description, rendered issue/comment body, or Library document.
2. The renderer chooses the reference type icon and label from the resolved
   entity, preferring human titles over opaque ids when available.
3. The token is displayed inline with the surrounding text and remains
   selectable/copyable as part of the editor or rendered body.
4. When a rendered link is an explicit absolute local-file target, the renderer
   classifies its icon from the normalized path and leaves filesystem access to
   an explicit operator action under `CHAT.SIDE.PANEL.001`.
5. In document live preview, copy, deletion, undo, and persistence continue to
   operate on the canonical Markdown representation even though the reference
   remains an atomic visible token.

Invariants:

- Rich-reference icons and labels must share a stable text baseline across
  composer, issue comment editor, issue description, rendered markdown, and
  Library document surfaces.
- Chat user-message rendering and assistant/read-only markdown rendering must
  not diverge for issue reference status icons or line-height rhythm. The same
  reference type with the same status metadata should look like the same object
  on both sides of a conversation.
- Do not add one-off vertical offsets for a single surface unless visual proof
  shows the shared token contract is wrong for that whole class of tokens.
- New reference kinds must join the same token grammar instead of inventing
  separate pill, badge, or icon alignment behavior.
- Unknown local-file suffixes use the generic file icon. File icons are
  decorative and must not duplicate the accessible link label.
- Human-readable entity labels take precedence over raw ids in user-facing
  tokens. Raw ids are acceptable only as fallback or secondary disambiguation.
- Truncation in editors is only for labels long enough to threaten the current
  line; ordinary labels should not be shortened.
- Atomic document tokens must not flash or expand into raw link syntax when
  their block becomes active. This direct-click rule does not change Chat,
  Side Chat, decision-note, message-edit, or Issue comment composer behavior.

Evidence:

- CSS contract tests lock the composer token icon alignment and truncation
  behavior.
- Markdown editor/body tests cover special markdown rendering consistency.
- Local-file resolver and Markdown body tests cover encoded paths, source
  locations, ambiguous colon-digit filenames, icon families, and fallback.
- Chat message tests cover user-message issue reference status icons and their
  parity with assistant markdown rendering.
- Chat rich-reference E2E covers real chat insertion and rendering behavior.

## CHAT.WEBSITE.LINK.ICON.001

Why:

- Operators often paste external website links into chat and issue text. The
  link should feel like the linked website, using real site icons where Rudder
  can resolve them safely and quickly.
- Website icon rendering must degrade predictably when a site has no discoverable
  icon or the metadata fetch fails.

Product model:

- External `http` and `https` links render as ordinary inline text links with a
  compact leading website icon.
- In a `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001` surface, an external link shows that
  icon only while its logical block is inactive. Activating the block removes
  the icon projection and exposes the exact Markdown link source.
- Rudder may resolve common public or first-party sites from an embedded
  known-icon cache that stores real website favicon/logo image assets as data
  URLs. This avoids repeated public-page fetches for frequently pasted sites
  such as ChatGPT, OpenAI, Anthropic, Reddit, Medium, Hacker News, Linux.do,
  Feishu, and Rudder-owned domains.
- Known-icon entries may intentionally cover subdomains when one brand owns the
  full hostname family, such as `learn.chatgpt.com`, `platform.openai.com`, and
  `docs.anthropic.com`. Matching must still require the exact hostname or a dot
  boundary before the registered hostname.
- When no embedded known icon matches, Rudder discovers the website icon from
  the target page metadata, preferring declared favicon links such as
  `rel="icon"` or `rel="shortcut icon"`.
- The browser receives the discovered icon through a Rudder proxy URL instead
  of relying on cross-origin image fetch behavior. Embedded known icons are
  already data URLs and do not need proxying.
- Rudder caches metadata lookups briefly so repeated rendering of the same link
  does not repeatedly fetch the same external page during normal reading.
- Website metadata requests distinguish preview from authoring. Preview keeps
  the known-icon no-fetch optimization. Authoring may fetch a public page title
  for smart-link paste through the same URL validation, redirect revalidation,
  response bounds, cache, and SSRF protections.
- Rudder falls back to the generic website icon when metadata discovery returns
  no valid image icon, fails, or the proxied image cannot be rendered.

Flow:

1. A user or agent writes an external website link in chat, issue/comment
   markdown, or another rendered markdown surface.
2. If the link hostname matches an embedded known-icon entry, the renderer uses
   that real image data URL immediately and does not call metadata discovery.
3. Otherwise, the renderer initially shows a generic website icon so the
   message remains readable immediately.
4. Rudder fetches the target page metadata server-side and resolves the best
   site-declared icon.
5. When an icon is found, the renderer swaps the generic icon for the proxied
   website icon while keeping the link label/copy text unchanged.
6. If no icon is found, the generic website icon remains visible.
7. When document authoring pastes one HTTP(S) URL without selected text, Rudder
   inserts a site-name or hostname label immediately and may request the public
   page title.
8. A returned page title replaces only the unchanged fallback link inserted by
   that paste. If the operator edits its label or destination first, Rudder
   leaves the operator's source untouched.

Invariants:

- Embedded known icons must use real image assets for the represented website or
  product, not generated letter or abbreviation placeholders.
- Known-icon hostname matching must stay explicit and narrow enough to avoid
  accidentally branding unrelated provider subdomains.
- The embedded set is an optimization for common sites, not an exhaustive
  website directory. Unlisted public sites continue through metadata discovery
  and generic-icon fallback instead of requiring a bundled asset.
- Preview resolution for a known icon must not fetch the public page. An
  explicit authoring-purpose title request is the only live-preview exception
  and remains subject to the same network-safety boundary.
- Same-origin Rudder app links remain internal navigation links and do not use
  website metadata discovery.
- Unsafe or non-HTTP schemes are not fetched for metadata.
- Metadata and icon fetches must not carry user credentials, cookies, or board
  secrets to the external site.
- Private, loopback, link-local, and otherwise internal network targets must be
  rejected before fetch; redirects must be revalidated before they are followed.
- The icon is decorative; icon resolution must not change selectable/copyable
  link text. Conditional authoring title enrichment is a source edit governed
  by `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001`, not an icon side effect.

Evidence:

- Website metadata service tests cover known-icon no-fetch behavior, favicon
  discovery, no-icon fallback, invalid declared icon fallback, and
  redirect-to-private rejection.
- Shared resolver, Markdown/body, and chat message tests cover common embedded
  website icons, subdomain matching, metadata icon rendering, generic fallback,
  image-load failure fallback, safe external-link attributes, and unchanged
  link text.
- Website-link E2E covers real issue-page rendering for embedded common-site
  icons without metadata requests, favicon-provider fallback, inline wrapping,
  and internal-link no-fetch behavior.

## CHAT.THREAD.MANIFEST.001

## Contract Summary

Messenger Chat exposes a compact, conversation-scoped manifest that keeps the
current thread's inspectable Outputs, Sources, and References visible without
requiring the operator to search the transcript. Work from other
conversations linked to the same Project is intentionally omitted from this
surface and remains available from Project-level surfaces.

## Intent / User Job

An operator returning to a long or active Chat needs to answer three questions
quickly: what this thread produced, what input it used, which external sites the
visible conversation cited. The manifest is an index into durable work and
provenance, not a second chat transcript or a generic bookmark manager.

## Why / Design Reasoning

The manifest is a typed, durable projection rather than a client-only Markdown
scan. A client-only list cannot reliably distinguish an Agent-created artifact
from a recommended website, becomes inconsistent after edits and refreshed
answers, and cannot enforce organization or Project boundaries. Project
membership must not pull work from other conversations into the current Chat
because that creates noise and obscures which thread actually produced or used
an object.

Output classification is intentionally strict. An arbitrary assistant URL is a
Reference, not an Output. An Output requires structured production evidence so
Rudder does not overclaim work completion. References remain informational and
do not become Project Context Resources until the operator explicitly admits
them through `CONTEXT.RESOURCES.001`.

## Actors / Objects / State

- Board operator: reads the manifest, opens an item, jumps to its source
  message, or opens Project-level surfaces for broader Project work. New files
  and links enter through normal Chat composer flows, not a manifest add action.
- Chat conversation: organization-scoped thread and optional Project context.
- Chat message: active, non-superseded user or assistant visible body, optional
  Run id, replying Agent id, and attachments.
- Manifest item: category, target type/key, title, URL or internal locator,
  status, source role, message/Run/Agent/user provenance, Project id, metadata,
  and timestamps.
- Output: Agent-created ordinary Chat attachment or Run-backed assistant Library
  artifact under the guarded `artifacts/...` output namespace. A trusted
  same-message inline visual backing attachment under `CHAT.INLINE.VISUAL.001`
  is presentation state and is excluded.
- Source: user attachment, user-provided URL or Library reference, or a Project
  Context Resource eligible for a project-scoped Chat Run.
- Reference: deduplicated external HTTP(S) website in a visible user or assistant
  message that is not promoted by the category precedence rules.

## Entry Points / Inputs

- `GET /api/chats/:id/work-manifest` for the selected Chat.
- User message bodies and user-created Chat attachments.
- Completed assistant message bodies, Run attribution, replying Agent identity,
  and Agent-created Chat attachments.
- `library-entry://` and `library-file://` references in visible message bodies.
- The Chat's explicit Project context and that Project's attached resources.
- Chat edit, refresh/variant, fork, attachment, and message supersession state.

## Product Logic Flow

1. The operator opens a Chat and Rudder requests its conversation manifest.
2. Rudder verifies Chat access through the same organization boundary as normal
   Chat reads.
3. Reconciliation reads active, non-superseded user and assistant messages and
   their attachments. Transcript entries, reasoning, tool results, stdout, and
   stderr are excluded.
4. User attachments, user Library references, and user HTTP(S) links become
   Source candidates. Agent-created ordinary attachments become Output
   candidates. Before classification, Rudder validates and excludes only
   attachment ids named by the producing message's Server-owned inline visual
   mapping; MIME, filename, size, hash, organization, message, and Agent
   provenance must agree.
5. An assistant Library reference becomes an Output only when it has a producing
   Run id and resolves under `artifacts/...`; other assistant HTTP(S) links are
   Reference candidates.
6. When the Chat has explicit Project context and a project-scoped assistant Run,
   attached Project Context Resources become Source candidates because they were
   eligible for that run.
7. Rudder canonicalizes target keys, removes URL fragments/default ports,
   deduplicates candidates, and applies `output > source > reference` so one
   target appears once in its strongest supported category.
8. Reconciliation removes stale derived Sources/References from superseded or
   edited visible messages, but it does not silently delete a durable Output
   merely because the message that announced it was refreshed. A historical row
   now proven to be trusted inline visual presentation is removed because it was
   never production evidence.
9. The API returns the current Chat sections. It may continue returning a
   Project id/count as compatibility metadata, but Chat does not render it or
   include it in the visible category count.
10. When at least one current-thread item exists, wide Chat renders the compact
    shelf. Its fixed top row renders the first non-empty category in
    `Outputs > Sources > References` order as a normal category header, with
    the same icon, label, count, height, background, and typography used by
    every later category header. The fixed placement must not promote that
    category into a parent or a visually stronger panel title, and the label is
    not repeated above its rows. The shelf has no add/create action. A header
    icon animates the shelf between open and collapsed states; narrow Chat
    exposes the same data from a compact category/count trigger. A project-only
    or otherwise empty current-thread manifest renders no control or shelf.
    Opening an internal target reuses Side Panel behavior from
    `CHAT.SIDE.PANEL.001`. Wide and compact panels cap their expanded height at
    `32rem` (512 CSS pixels) on normal viewports, shrink to the available
    viewport allowance when necessary, and keep longer lists internally
    scrollable.
11. Opening an image attachment uses the application-level image preview shared
    with Chat message and Markdown images. The overlay exposes an explicit close
    control plus copy/download actions, closes on `Escape`, and does not create a
    Browser Side Panel tab. Non-image attachments keep their normal file-open
    behavior. Switching to another Chat closes the current image preview so an
    attachment from the previous conversation cannot remain over the new one.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| User supplies a file or website | Active user message attachment or visible HTTP(S) URL | One Source with user/message provenance | The input must not be labeled as Agent Output | Service tests and Chat Work Manifest E2E |
| Agent creates a Chat attachment | Assistant attachment has Agent creator provenance | One Output with Agent/message/Run provenance where available | It must not be downgraded to a Reference | Service tests and E2E |
| Agent creates a trusted inline visual | Same completed assistant message owns a validated Server mapping and matching internal HTML attachment | Render in the message; no manifest row | Backing `.html` must not appear as Output, Source, or Reference | Inline visual manifest and E2E tests |
| Agent creates ordinary HTML | No valid trusted same-message inline visual mapping | One normal Output | HTML extension alone must not hide the artifact | Manifest regression tests |
| Agent links a produced Library artifact | Assistant message has a Run id and `artifacts/...` Library target | One Output that opens through Library Side Panel | A normal external link must not satisfy this rule | Extraction/service tests |
| Agent recommends a website | Visible assistant HTTP(S) link with no production evidence | One Reference | Rudder must not claim the website was created by the Run | Extraction/service tests |
| Link appears in tool history only | URL exists only in transcript, reasoning, stdout, or stderr | No manifest item | Tool exploration must not pollute the visible manifest | Service tests |
| Answer is refreshed or edited | Prior message becomes superseded | Stale derived References disappear; durable Outputs remain inspectable | Refresh must not erase a real artifact | Service tests |
| Chat is forked | Copied historical assistant rows have no producing Run id | Sources can be re-derived; copied rows do not gain Output ownership | Fork must not claim the source thread's Outputs as newly produced | Fork/service tests |
| Chat has a linked Project | Other Project conversations contain manifest rows | Current rows stay unchanged; other-conversation rows are omitted from Chat | Project membership must not import other conversations into the current Chat manifest | API and E2E |
| Long manifest is expanded | Current-thread rows exceed the compact panel allowance | Panel stops growing at `32rem` (512 CSS pixels) on normal viewports, uses the smaller viewport allowance on short screens, and scrolls internally | The panel must not grow to near-full-screen height or overlap the composer | Component and Chat Work Manifest E2E |
| No current-thread items exist | Reconciliation returns no current-thread candidates, even if compatibility metadata reports Project items | No manifest control or empty shelf is rendered | UI must not reserve space or invent Create Site/Browser capability | Component/E2E tests |
| Manifest request fails | Current manifest state cannot be confirmed | Show a compact, category-neutral files-and-links error state instead of treating the result as empty | Operators must be able to distinguish retrieval failure from confirmed absence | Component/E2E tests |
| Operator opens an image attachment | Attachment has an image content type, or a known image extension when content type is absent | Open the shared image preview with close, copy, and download actions | The attachment must not be routed into the built-in Browser or leave the operator without an exit | Image preview component tests and Chat Work Manifest E2E |

## Actor-Visible Input

The operator sees the selected Chat, its normal transcript/composer, and a
category-led files-and-links shelf containing only the current thread's
Outputs, Sources, and References. Each row exposes a readable title and type
icon. Website rows expose the normalized URL and website icon instead of a
generic link icon or redundant `From Agent` origin label.

## Operator-Visible Output

- Wide desktop: a compact top-right shelf whose first non-empty category header
  stays fixed above bounded rows, plus a header icon that collapses or restores
  the shelf with a short transition. Expanded height is capped at `32rem` (512
  CSS pixels) on normal viewports; short viewports use the smaller available
  allowance and long lists scroll inside the shelf.
- Category hierarchy: Outputs, Sources, and References are peer sections. Every
  visible category uses the same icon/label/count header treatment; fixed
  placement for the first section must not imply a higher level.
- Actions: the shelf provides open and source-message navigation, but no add or
  create icon.
- Empty state: no shelf, count, trigger, or reserved rail is rendered.
- Error state: a compact, category-neutral files-and-links error remains visible
  so retrieval failure is not mistaken for confirmed absence.
- Narrow desktop/mobile: a compact first-category count trigger opens the same
  list under the same `32rem` maximum and short-viewport fallback.
- Chat scrolling: the message scrollbar remains attached to the outer right
  edge of the Chat workspace while content spacing keeps messages and the
  composer clear of an open manifest shelf.
- Internal Library targets: existing Side Panel preview behavior.
- Image attachments: the shared application-level image preview with explicit
  close, copy, and download controls; `Escape` returns to the same Chat.
- External websites: normalized URL text and website icon/fallback behavior from
  `CHAT.WEBSITE.LINK.ICON.001`, with safe link routing under
  `CHAT.SIDE.PANEL.001`.
- Provenance action: jump to the source message when a message id exists.
- Side Panel open: the compact shelf yields to the workbench and returns when
  the panel is hidden.

## Persisted Evidence

`chat_work_manifest_items` stores organization/conversation/Project scope,
category, target identity, title/URL, status, source role, message id, Run id,
Agent/user provenance, metadata, and timestamps. Chat messages, attachments,
context links, and Project resource attachments remain the source evidence used
to reconcile the projection.

## Canonical Scenarios

1. Research Chat with report and citations:
   - Trigger: user uploads screenshots and asks an Agent to produce a report.
   - Expected state/action: screenshots are Sources, the Run-backed report is an
     Output, and visible final-answer websites are References.
   - Visible output: three sections with no duplicate URLs; website rows show
     their URL and website icon.
   - Evidence: manifest rows, message/attachment ids, producing Run id, E2E.
2. Project-scoped Chat:
   - Trigger: Chat selects a Project whose resources are injected into a Run.
   - Expected state/action: eligible Project resources appear as Sources; other
     Project thread items do not appear in the current Chat manifest.
   - Visible output: current Chat sections only. Broader Project work remains
     available from Project-level surfaces.
   - Evidence: context link, project resource attachments, manifest rows.
3. Recommendation without production:
   - Trigger: assistant final answer links an external product website.
   - Expected state/action: the site appears as a Reference.
   - Visible output: site title, normalized URL, and website icon.
   - Evidence: visible assistant body and normalized manifest row.
4. Hidden exploration link:
   - Trigger: a tool result or reasoning entry contains a URL absent from visible
     user/assistant bodies.
   - Expected state/action: no manifest item is created.
   - Visible output: no change to the manifest shelf.
   - Evidence: exclusion test.

## Invariants / Non-Goals

- Organization access is enforced before reconciliation or listing.
- Project membership does not import work from other conversations into the
  current Chat manifest.
- One target appears once per conversation under its strongest supported
  category.
- Outputs require structured production evidence and persist across answer
  refreshes unless explicitly hidden/archived by a future governed flow.
- Manifest References are not automatically attached to Project Context.
- Image attachment inspection is an application overlay, not Browser
  navigation. Closing it preserves the Chat route, manifest shelf, and Side Panel
  state.
- The shelf itself does not offer an add/create action; files and links enter
  through normal Chat input and agent output flows.
- V1 does not aggregate Browser sessions, crawl tool history, implement generic
  bookmarks, create Sites/documents, or replace Library/Issue work products.

## Drift Boundaries

Update this contract when categories, production evidence, reconciliation,
Project membership isolation, provenance, visible category hierarchy,
responsive visibility, or item-open behavior changes. Parser implementation,
row-limit constants, icon choices, compatibility metadata, and query batching
may change without a contract edit when the visible semantics and invariants
remain intact.

## Traceability

Related plans:

- `doc/plans/2026-07-12-chat-work-manifest.md`

Related code:

- `packages/db/src/schema/chat_work_manifest_items.ts`
- `packages/shared/src/chat-work-manifest.ts`
- `server/src/services/chat-work-manifest.ts`
- `server/src/routes/chats.ts`
- `ui/src/pages/Chat.work-manifest.tsx`
- `ui/src/pages/Chat.tsx`
- `ui/src/context/ImagePreviewContext.tsx`
- `ui/src/components/ImagePreviewDialog.tsx`
- `ui/src/components/InspectableImage.tsx`

Related tests:

- `packages/shared/src/chat-work-manifest.test.ts`
- `server/src/__tests__/chat-work-manifest.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `ui/src/pages/Chat.work-manifest.test.tsx`
- `ui/src/context/ImagePreviewContext.test.tsx`
- `ui/src/lib/image-actions.test.ts`
- `tests/e2e/chat-work-manifest.spec.ts`
- `tests/e2e/chat-work-manifest-image-preview.spec.ts`

Known gaps:

- Browser-session aggregation and direct document/Site creation are explicitly
  excluded from V1.

## CHAT.SIDE.PANEL.001

Why:

- Operators often need to inspect or lightly operate on a referenced issue,
  automation, Library file, directory, chat, or browser-like target while keeping
  their current work surface in view.
- Chat remains a task execution and coordination surface, but references should not
  force route replacement when the user's job is quick context inspection or a
  small adjacent edit.

Product model:

- The Side Panel is a global board workbench mounted in the shared organization
  layout, not a Chat-only drawer.
- Supported internal references can open or focus tabs in the Side Panel without
  replacing the current route on ordinary clicks. Modifier-click and unsupported
  links preserve normal navigation behavior.
- The `side_chat_started` boundary event is an explicit exception: its source
  Chat title is return navigation, so an ordinary click replaces the current
  route with the source Chat's main Messenger route instead of opening a Chat
  target in the Side Panel.
- Chat Work manifest internal targets use the same typed Side Panel target model;
  the manifest is an index and does not create a second preview drawer.
- Chat and Work manifest image attachments are intentionally not Side Panel
  Browser targets. They use the shared image preview overlay so image inspection
  has one consistent toolbar and exit path across Chat surfaces.
- Side Panel targets are typed objects: issue, automation, Library file,
  Library directory, structured transcript local file, chat, browser tab, and
  explicit placeholders for target classes that need a link/search before
  loading a concrete object.
- An ordinary click on an openable transcript file action opens or focuses a
  local-file tab in the current Chat's Side Panel context without replacing the
  Chat route. Desktop loads the target through the bounded local-file preview
  bridge; Web and preview failures render an explicit in-panel fallback.
- Issue targets render as a compact issue-detail workbench inside the panel,
  not as a read-only preview with a separate edit mode. The title and
  description are directly editable in place, and issue properties such as
  status, priority, labels, assignee, reviewer, project, goal, and parent issue
  use the same readable/editable issue-property controls as Issue Detail where
  the panel has enough context to expose them.
- When an issue Side Panel tab is expanded beyond the default docked width, it
  renders the Issue Detail content body inside the panel. The Issue Detail page
  header is omitted because the Side Panel shell already owns panel-level
  navigation, tab, resize, and close controls.
- The panel owns tab state, active target, add-tab affordances, empty-state
  choices, width/resizer behavior, and close/focus behavior. It does not become
  the owning domain for issue workflow, automation dispatch, Library path safety,
  Messenger attention, or chat lifecycle.
- On desktop, the docked and expanded states use one stable, right-anchored
  panel host. Opening the panel moves its left boundary toward the workspace
  center while the current work surface narrows; expanding continues that same
  boundary toward the workspace left edge. Restore and close reverse the same
  geometry instead of replacing or reparenting the panel content.
- When Chat gives up space reserved for its Work manifest, that release stays on
  the same shared duration and easing token as the Side Panel width change,
  beginning in the same rendered frame. The transcript and composer widths must
  change monotonically; they must not first become narrower and then expand
  while the outer Chat surface is shrinking.
- These right-anchored geometry rules apply to the desktop adjacent-work layout.
  The compact mobile Side Panel keeps its separate nonmodal overlay layout: the
  underlying Chat stays mounted and is not made inert, while the overlay
  receives its own enter/exit treatment and explicit close control.
- On desktop pointer surfaces, operators can drag a Side Panel tab label before
  or after another tab to reorder the current context's tab strip without
  changing the active target. The close affordance stays visually quiet until
  its tab is hovered or receives keyboard focus, while its reserved width keeps
  tab labels from shifting when the affordance appears.
- Every Side Panel tab exposes a context menu through right-click,
  `Shift+F10`/Menu, and touch long-press. The menu always includes `Close`,
  which invokes the same target-aware close behavior as the existing inline
  close affordance and active-tab keyboard shortcut. Opening a non-active tab's
  menu must not activate it or replace the current panel body. Menu handling
  must not regress tab drag reorder.
- In Messenger, panel tab state is session-scoped to the active work item when
  the item has a stable chat or issue identity. Chat conversations and concrete
  issue threads each keep their own in-memory Side Panel tabs and active tab
  until the app session ends.
- Hiding the Side Panel is a visibility action, not a tab-destruction action.
  The operator must explicitly close a tab to remove it from the current item.
- Side Chat is the lifecycle exception to generic close behavior: explicitly
  closing its tab also discards the provisional draft or destroys the persisted
  hidden temporary chat. Merely hiding the Side Panel does not destroy it.
- Closing the final tab removes that tab and closes the Side Panel. The empty
  picker remains available when the operator explicitly opens an empty panel or
  uses the add-tab affordance, but is not left behind as a side effect of closing
  the final tab.
- When the Side Panel has an active tab, the close-tab keyboard shortcut
  (`Command+W` on macOS, `Ctrl+W` on non-macOS shells) closes that active tab
  before the shell or browser can treat the shortcut as a window/tab close. The
  shortcut must not close the whole Desktop window, replace the main route, or
  merely hide the panel while leaving the active tab intact.
- When the active target is Browser and keyboard focus is inside the Side Panel
  Browser surface, Desktop routes the fixed browser mappings for reload, hard
  reload, new tab, location, back/forward, and page zoom to that active Browser
  tab. Browser visibility without focus is insufficient; focusing Chat,
  Library, a dialog, or another Rudder surface releases these mappings. This
  narrower rule does not change the cross-target close-tab shortcut above.
- Browser Side Panel tabs reserve a stable `12.5rem` tab width and truncate the
  title inside it, including during reload title changes. The close affordance,
  add button, and right-side panel controls must not jump horizontally when a
  page reports a different title.
- Switching Messenger to another item with no Side Panel history must not carry
  over the prior item's tabs. If the panel is open and the next item has no
  saved session panel state, Rudder closes the panel by default instead of
  showing an empty panel over unrelated work.
- The add-tab affordance opens the empty `Open a panel` picker directly. It must
  not automatically open a target-type menu; target choice belongs in the picker
  page so the operator can choose Browser, Library, Issue, or another supported
  target from the panel body.
- In Rudder Desktop, the operator Built-in Browser loads typed URLs and search
  queries inside Side Panel Browser tabs on the dedicated instance profile,
  independently of Agent Browser access.
  Explicit address-bar input may bootstrap a canonical local absolute
  `file:///` URL with an empty authority and non-UNC decoded path. Remote
  authorities (including `localhost`), UNC or UNC-equivalent paths (including
  encoded leading slash or backslash separators), and relative `file:` forms
  are treated as search input instead of file navigation.
  Ordinary external HTTP(S) links use that target by default without replacing
  the current Rudder route. Unsupported shells or unavailable Browser
  capability must not perform an unsafe remote fetch by themselves.
- When a Browser tab's main-frame navigation fails, the panel replaces the
  failed page with an actionable browser-style failure state while preserving
  the address bar, tab, and embedded Browser guest. The state identifies the
  attempted host and Chromium error code, offers relevant connection/address
  checks, can reveal the exact failed URL, and exposes Reload as the primary
  recovery action.
- Library file targets render supported inline previews inside the Side Panel,
  including PDFs. Truncated Library breadcrumbs reveal the complete
  Library-relative path on hover, and the file `Open` menu offers `Open in
  Library` alongside any Desktop app, IDE, file-browser, or terminal targets.
- Library audio/video targets reuse the same `LIBRARY.FILES.001` media renderer
  as the full Library work surface. Native playback never autoplays; a
  codec/load failure keeps the Side Panel tab active and shows the shared
  compatibility state with Download plus the Side Panel's `Open` menu.
- An explicit absolute local-file link in a visible Chat message opens a
  read-only `local_file` target in that Chat's Side Panel context after an
  unmodified operator click. Desktop loads it through the guarded local preview
  bridge; Web and preview failures remain visible in the panel.
- Markdown Library targets render as directly editable documents with autosave,
  undo/redo, visible save state, and explicit stale-write conflict resolution.
  The Side Panel preserves the operator's draft until a conditional write
  succeeds or the operator chooses the latest server version.
- Side Panel Issue descriptions, Automation instructions, and Library Markdown
  bodies use the same `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001` behavior as their
  full surfaces. Docking, expanding, hiding, or switching tabs must not change
  the Markdown source or create a save by itself.
- Eligible Browser, automation, Library document, Library entry, Library file,
  and Library directory targets can be added to Messenger Saved Views. Adding a
  target is a persistence action only: it must not navigate, close or hide the
  panel, change tab order, or switch the active Side Panel tab.

Flow:

1. The operator opens the Side Panel from the global right-edge trigger, the
   panel add-tab affordance, or a supported internal reference in
   Chat/Messenger. Side Chat source-boundary links bypass this flow and navigate
   directly to their source Chat.
2. The side-panel target parser normalizes the object into a stable tab key. For
   an explicit absolute local-file Markdown target, URL-encoded path characters
   are decoded safely and a trailing `:line[:column]` is removed only when the
   displayed label confirms the basename before that suffix.
3. If the target is already open, Rudder focuses the existing tab instead of
   duplicating it.
4. Domain targets load through their existing organization-scoped APIs. An
   ephemeral `local_file` target instead loads only through the guarded Desktop
   preview bridge and never through a Rudder HTTP API.
5. The panel renders the object in a compact workbench view at the default
   docked width and keeps the current board route stable. On desktop, its right
   edge stays attached to the workspace while the divider and panel left edge
   move left and the current work surface narrows continuously.
6. If an issue target is expanded to the wide Side Panel state, Rudder swaps the
   compact issue workbench for the embedded Issue Detail body so the operator
   can use the same issue content sections without leaving the current route.
   The same panel host continues expanding from right to left; it does not jump
   to the workspace left edge and then grow toward the right.
7. When the operator clicks the add-tab affordance while a target is already
   open, Rudder keeps existing tabs available but sets the active panel content
   to the empty `Open a panel` picker instead of showing a dropdown menu.
8. Lightweight mutations exposed in the panel, such as issue title,
   description, status, priority, assignee, reviewer, project, goal, parent, or
   automation status edits, call the same domain APIs and show errors in the
   panel instead of silently ignoring failures.
9. On desktop pointer surfaces, dragging a tab label onto the left or right half
   of another tab moves it before or after that tab. Reordering changes only the
   current Side Panel context's in-memory tab order and preserves the active tab.
10. Closing a tab focuses a neighboring tab. Closing the final tab removes it and
    closes the Side Panel instead of leaving an empty picker open.
11. Pressing the close-tab keyboard shortcut while an active Side Panel tab is
   present follows the same close behavior as the tab's close button and
   prevents the host window from handling that shortcut.
12. When the operator hides the panel and reopens it in the same Messenger chat
   or issue context, Rudder restores that context's tabs and active tab.
13. When the operator switches from one Messenger item to another, Rudder
   switches the Side Panel to the destination item's session state. If that
   destination has no session state, the panel stays or becomes closed by
   default.
14. App restart may clear all Side Panel tab/session state; this contract does
   not require server persistence, cross-device sync, or localStorage recovery
   for tabs.
15. Browser tabs normalize address-bar input into a web URL, an explicit
    canonical local absolute `file:///` bootstrap, or search-query navigation;
    keep back/forward/reload state scoped to the embedded browser; and can open
    the current page externally as a secondary action. Only the address-bar
    path receives the local-file bootstrap exception. Renderer links and page
    popup, redirect, in-page, and frame navigation remain HTTP(S)-only. Allowed
    HTTP(S) popup requests route into another Browser tab instead of an
    unrestricted guest window while the Browser tab and popup limits permit it.
    While the Browser surface owns focus, standard Desktop browser shortcuts
    operate on only the active tab. Each tab keeps independent in-memory page
    zoom from 25% through 500%, reports non-default zoom in its title row, and
    resets to 100% without scaling the Rudder shell.
16. When a main-frame Browser navigation fails for a reason other than an
    intentional abort, Rudder keeps the attempted URL visible and renders the
    Browser failure state over the existing guest. `Details` reveals the failed
    URL. `Reload` retries that same guest and keeps the failure state visible
    until a new load actually starts; subframe failures do not replace the
    main-frame view. Missing local files follow this same path, expose the
    Chromium file error, and preserve the current Rudder route.
17. Desktop routes ordinary external HTTP(S) links to a Browser Side Panel tab
    when its instance preference is `built_in`, independently of Agent Browser
    access. The `default_browser` preference and explicit `Open externally`
    action use the operating-system browser instead.
18. From a Library file tab, `Open in Library` navigates to the full Library
    work surface with the same organization-scoped file selected.
19. A recognized Library audio/video tab delegates playback, file switching,
    and codec recovery to the shared media renderer. Native seek requests use
    the organization-scoped byte-range content path without changing the
    Messenger route or Side Panel tab identity.
20. Markdown autosave supplies the last confirmed content as a write
    precondition. When the server reports a conflict, the panel pauses autosave,
    keeps the draft visible, and offers `Keep mine` or `Use latest`; an older
    in-flight response must not override the operator's conflict decision.
21. When the operator adds an eligible active target to Saved Views, Rudder
    persists its typed descriptor under `MESSENGER.SAVED.VIEWS.001` and confirms
    the mutation in place without changing the current route, panel visibility,
    tabs, or active target.
22. Selecting `/messenger/saved-views/:id` asks the shared Side Panel controller
    to open or focus the saved target. A saved Browser target reuses the original
    live guest only while that guest exists; after restart, reset, or explicit
    tab close it opens a new Browser target from the last persisted URL.
23. Selecting a structured transcript file action opens or focuses a local-file
    tab keyed by its resolved absolute path. Desktop canonicalizes and validates
    the target through its preview bridge before returning bounded text or binary
    preview data; unsupported, missing, oversized, or Web-only targets fail in
    the panel without changing the current Chat route.

Invariants:

- The Side Panel must not infer cross-organization access from a link string; all
  target loads and mutations remain enforced by existing organization-scoped
  APIs.
- Side Panel issue views must preserve `ISSUE.SURFACE.001`,
  `ISSUE.STATE.001`, assignment, reviewer, run, and routing semantics.
- Side Panel issue views must remain readable at the docked panel width. They
  may use a wider two-column issue-detail layout when the panel is expanded,
  but the default docked view must not let viewport breakpoints squeeze the
  issue title, description, activity, or properties into unreadable columns.
- At the default docked width, an issue Side Panel tab must keep issue
  properties, description, sub-issues, and Activity in one issue-level scroll
  flow. It must not split the workbench into separate upper/lower scrolling
  panes.
- The issue Activity comment composer in that single-scroll flow must remain
  pinned to the bottom of the issue panel's scroll viewport with enough bottom
  padding to remain fully visible. It must not be pushed to the end of long
  issue content, hidden below the visible panel edge, or require a second
  timeline scroller to stay usable.
- Expanded Side Panel issue views must match the Issue Detail page body rather
  than maintaining a separate issue-detail variant. The embedded body should
  expose the same issue content sections, such as editable title and
  description, sub-issues, attachments, activity, and issue properties, while
  omitting only the Issue Detail page header and route-level effects that belong
  to the standalone page.
- Issue title and description editing must be direct and discoverable in the
  rendered issue view. The panel must not require a generic `Edit issue` button
  before those fields can be changed.
- Side Panel automation views must preserve automation definition, trigger,
  output, run-history, and dispatch semantics from `AUTOMATION.*`.
- Side Panel Library views must preserve `LIBRARY.FILES.001` path safety,
  protected paths, previews, and stable reference behavior.
- Side Panel live preview must preserve the owning Issue, Automation, or Library
  save and conflict semantics. The Issue Activity comment composer remains a
  separate composer and does not inherit document live preview.
- Transcript local-file tabs are not Library files and must not reinterpret a
  project-relative transcript path as an organization Library path. They accept
  only structured absolute targets resolved by `RUN.RESULT.001`, use the Desktop
  preview boundary, and do not weaken Library organization scoping or protected
  path rules.
- A Chat Markdown `local_file` target is ephemeral local Desktop state, not a
  Library file. Rendering its link must not read the file; loading begins only
  after an explicit operator click and stays behind the Desktop preview bridge.
  It must not weaken Library organization scoping or protected-path rules.
- Opening a Chat Markdown `local_file` target must preserve the current Chat
  route, transcript, draft, scroll context, and Side Panel session. Web,
  missing-file, inaccessible, unsupported, and malformed targets show a stable
  in-panel error instead of navigating externally or failing silently.
- Side Panel Markdown editing must preserve `LIBRARY.FILES.001` conditional
  write semantics. External updates visible to the server's guarded comparison,
  failed responses, and overlapping in-process saves must not silently discard
  or overwrite a dirty draft. Arbitrary filesystem writes retain the narrow
  cross-process commit boundary defined by `LIBRARY.FILES.001`.
- Side Panel PDF previews must use the organization-scoped inline workspace
  content endpoint. Full-path hover text and full-Library navigation must use
  the Library-relative path rather than exposing an absolute filesystem root.
- Side Panel media previews must reuse the shared full-Library player and codec
  failure semantics. They must retain the current Messenger route and active
  tab, never autoplay, and must not fall through to the generic binary-file
  message when the browser rejects a known container or codec.
- Side Panel chat views must preserve chat lifecycle and Messenger attention
  semantics; opening a chat target in the panel is not a read-state or routing
  rewrite unless the owning Messenger/chat code performs that action.
- A Side Chat source-boundary link must not create or focus a Side Panel Chat
  target; it is direct navigation owned by the Side Chat lifecycle contract.
- Side Panel Browser navigation must not grant file, organization, or
  application privileges beyond the embedded browser shell. Local non-control-
  plane web apps may be navigated, but Rudder board/API origins stay in the
  Rudder renderer and are rejected by the Browser profile.
- Canonical local absolute `file:///` navigation is allowed only when the
  operator explicitly submits it through the Browser address bar. The target
  must have an empty authority and an absolute decoded non-UNC path; remote
  authority, `localhost`, UNC and encoded-separator equivalents, and relative
  forms must become searches rather than file navigations.
- Renderer links, Browser-page popups, redirects, in-page/frame navigation, and
  Agent Browser open/navigate calls remain HTTP(S)-only. None may inherit or
  replay the operator address-bar local-file bootstrap exception.
- A Browser main-frame failure must remain distinguishable from an intentional
  aborted navigation or a subframe failure. The error copy must describe the
  reported failure rather than always claiming connection refusal, and recovery
  must reuse the current Browser guest instead of creating a replacement tab.
- Browser guest clicks, redirects, and in-page navigation update the visible
  address and tab label without rewriting the guest's explicit source
  attribute. Rudder must not replay navigation, duplicate history, or resubmit
  a request merely to synchronize Side Panel state.
- Application-owned asset image URLs must not be promoted to Browser tabs merely
  because they are opened from Work. The shared image preview owns those URLs
  and closing it must preserve the existing Side Panel tabs and Browser guest.
- Browser tabs must use the dedicated persistent Browser partition and its
  sandbox, protocol, popup, permission, and download policy. They must not share
  the Rudder UI/API session partition or gain Node/application privileges.
- Each Side Panel context may hold at most eight Browser tabs. At capacity, an
  ordinary Rudder link reuses the active Browser tab or the first Browser tab;
  explicit new-tab and popup requests are discarded. Desktop also accepts at
  most eight Browser popup requests in a rolling ten-second window.
- Browser profile data is shared across organizations in one local instance,
  but Side Panel tab/session state continues to follow this contract's active
  work-item rules. Disabling Agent Browser access preserves operator Browser
  targets; clearing Browser data closes those targets without deleting unrelated
  Side Panel tabs.
- On desktop and web shells, the Side Panel docks directly against the main
  workspace with only a narrow resize affordance between them. It must not leave
  a broad blank gutter that visually separates the panel from the current work
  surface.
- Desktop Side Panel geometry must preserve a fixed right edge while opening,
  expanding, restoring, or closing. Its left edge, the divider, and the current
  work-surface width must move monotonically in the requested direction. The
  main work surface must remain visually present until the expanded panel has
  covered or displaced it; reduced-motion mode may move directly to the same
  final geometry.
- While a desktop Side Panel is closing, its mounted content remains clipped by
  the shrinking host instead of disappearing before the host reaches zero. The
  host becomes inert as soon as closing begins, and keyboard focus returns to
  the current surface's Side Panel trigger.
- Opening a desktop Side Panel transfers keyboard focus from the removed opener
  into the panel controls. Context or route changes that merely make the panel
  unavailable must not steal focus from the newly active surface.
- Side Panel visibility and width changes must preserve the current route, Chat
  transcript and composer identity, scroll context, tab state, and Browser
  webview identity. A docked/expanded transition must not reload or recreate an
  active Browser guest.
- The panel should not show a generic full-page footer as the primary action for
  every target. Full-page navigation may remain a secondary object toolbar
  action, but the panel's job is adjacent work.
- Saving, hiding, restoring, or deleting a Saved View must not close or mutate
  the corresponding Side Panel target when that target is already open. Saved
  View lifecycle and directory placement are owned by
  `MESSENGER.SAVED.VIEWS.001`, not by Side Panel tab lifecycle.

Evidence:

- Side-panel target tests cover parsing supported route/mention targets, stable
  keys, labels, and full-page href generation.
- Layout tests cover shared shell behavior and panel framing decisions.
- Chat attachment/side-panel tests cover tab behavior, empty state, add-tab
  actions that return to the empty picker without opening a dropdown menu,
  desktop tab reordering, hover/focus close-affordance visibility,
  directly editable issue title/description fields, rendered/editable issue
  assignee metadata, issue and automation compact views, Library previews,
  close-tab keyboard shortcuts, final-tab panel closure, and browser placeholder
  behavior.
- Chat attachment/side-panel tests and Side Panel E2E cover inline PDF rendering,
  complete Library path hover text, and full-Library navigation from the file
  `Open` menu.
- Shared media component, Library integration, and Side Panel E2E cover the
  common audio/video renderer, no-autoplay native controls, file switching,
  byte-range seek delivery, undecodable-container recovery, Download/Open
  actions, and Messenger route/tab preservation.
- Local-file resolver, Markdown body, Chat attachment/side-panel, and Side Panel
  E2E tests cover file icons, source-location normalization, route preservation,
  Desktop preview loading, Web fallback, and preview failures.
- Chat attachment/side-panel tests and Side Panel E2E cover Markdown autosave,
  undo/redo, save errors, stale-write conflicts, both conflict decisions, and
  in-flight responses arriving after conflict resolution.
- Layout tests cover Side Panel context keys for Messenger chat and issue
  routes, and Side Panel E2E covers hiding/reopening tabs in one Messenger item,
  switching to an item with no panel history without inheriting tabs, and
  restoring the original item's active tab when returning.
- Side Panel E2E samples desktop transition frames to verify the fixed right
  edge, monotonic panel growth and Chat contraction, coordinated Work manifest
  spacing, and Browser webview identity across expand and restore.
- Side Panel E2E covers opening issue, automation, Library, and chat references
  without replacing the Chat route; editing an issue title, description,
  status, and assignee inside the panel; browsing a Library directory tree;
  opening the global empty panel from Dashboard; and keeping the desktop/web
  panel gutter compact against the main workspace.
- Side Chat E2E covers the source-boundary exception by moving a Side Chat to Messenger,
  opening it in Messenger, and navigating directly back to the source Chat
  without opening a Side Panel Chat target.
- Side Panel E2E covers expanding an issue target and rendering the embedded
  Issue Detail body, including issue content sections such as attachments,
  activity, and properties, without navigating away from Chat.
- Desktop Browser policy/profile tests and smoke cover the dedicated partition,
  secure guest policy, canonical local-file allowlisting, remote authority/UNC/
  encoded-separator/relative rejection, HTTP(S)-only page and Agent boundaries,
  Side Panel navigation, external-open escape, and address input normalization.
  Built-in Browser E2E and real Desktop smoke cover local HTML/title rendering,
  unchanged Rudder routing, and missing-file error recovery; Side Panel E2E owns
  the route-preserving global HTTP(S) link workflow.
- Chat attachment/side-panel tests and Side Panel E2E cover main-frame Browser
  failure rendering, host-specific diagnostics, Details URL disclosure, Reload
  on the existing guest, delayed error dismissal until loading starts, and
  address/tab synchronization without rewriting the guest source.

## MESSENGER.ATTENTION.001

Why:

- Messenger is the board communication shell. It must help the operator see
  what needs attention across chats, issue threads, approvals, failed runs, and
  automation output without moving ownership out of those domains.

Product model:

- Messenger thread directory includes chat threads and domain-derived attention
  threads such as issue, approval, failed run, and automation-created work.
- Failed-run cards expose a normalized scene and trigger plus an
  organization-verified source label, status, and action for Chat, Heartbeat,
  Issue/Review, and Automation runs. `sourceState` distinguishes `available`,
  `source_unavailable`, and `legacy_unknown` provenance.
- Messenger also presents Saved Views as durable directory items, but a Saved
  View is not a message thread and is excluded from thread attention semantics.
- Threads support read/unread state, previews, pin/archive/delete where the
  underlying thread type supports it, custom groups, and stable navigation.
- Issue thread entries derive from issue comments/activity and read markers.
- System-authored onboarding starter issues may be initialized with read
  markers because they are seeded starter content, not fresh operator-directed
  activity.

Flow:

1. Domain event or message creates/updates a Messenger-relevant thread.
2. Messenger service computes preview, ordering, unread state, group membership,
   and attention badge state.
3. Onboarding seed may create issue threads and write read markers at seed time
   so starter work does not appear as new unread attention.
4. Opening a thread clears relevant read markers when appropriate.
5. Actions such as pin/archive/delete route to the owning chat/thread behavior.
6. Messenger merges Saved Views into their fixed section or custom-group
   placement without sending them through read-marker or attention aggregation.
7. Failed-run origin hydration starts from a redacted allowlist and restores
   source entity IDs and navigation only after the source row is verified in
   the current organization.

Invariants:

- Messenger must cite or route to owning domain contracts; it must not redefine
  issue, approval, run, or automation state.
- Unread/attention counts must be organization-scoped and user-scoped.
- Seeded onboarding issue threads must remain read for the seeded operator
  until later issue activity occurs after the seed read marker.
- A Saved View must not have unread state, unread count, attention state,
  mark-read or mark-unread actions, or a fabricated latest-message/activity
  timestamp. Saving, opening, hiding, restoring, regrouping, or deleting it must
  not change Messenger attention badges.
- Failed-run payloads must never expose raw `contextSnapshot` data, secrets, or
  entity IDs copied from a deleted, missing, or cross-organization source.
  Unavailable and legacy origins remain non-navigable failed-run cards; source
  actions exist only when the referenced entity was verified in the current
  organization.

Evidence:

- Messenger contract E2E covers ordering, previews, read state, groups,
  redirects, empty state, pin/archive/delete, issue notifications, approvals,
  and automation-created issue attention.
- Failed-run service tests cover available and unavailable Chat, Heartbeat,
  Issue/Review, and Automation origins, organization-boundary redaction, and
  legacy fallback. Messenger contract E2E covers normalized source labels,
  status, navigation, and non-navigable unavailable cards.

## MESSENGER.THREAD.PREVIEW.001

Why:

- Compact Messenger rows truncate long titles and summaries. Operators need a
  lightweight way to inspect the full Chat context or Issue description before
  deciding whether to open the thread.

Product model:

- Hovering a Messenger Chat or split Issue row for one second opens a detail
  card beside the directory without navigating away from the current task.
- Chat cards show the full display title and available summary or latest
  preview. Split Issue cards show the full title, description, identifier,
  status, and priority when those values exist.
- Keyboard focus may disclose the same detail card without imposing the mouse
  hover delay.

Invariants:

- A row actions menu and its detail card must never be visible at the same
  time. Opening Chat actions or Issue thread actions immediately dismisses the
  card and cancels any pending disclosure timer.
- The detail card remains suppressed for the lifetime of the actions menu.
- Closing the menu does not reopen the card under a stationary pointer or
  restored trigger focus. Pointer users must leave and hover the row again for
  one second; keyboard users must move focus away and return.
- The card is supplemental disclosure only. It must not change read state,
  thread state, issue state, navigation, or action availability.

Evidence:

- Messenger sidebar component tests cover delayed disclosure, Chat and Issue
  content, pending-timer cancellation, menu suppression, and re-entry.
- Messenger hover-preview E2E covers the rendered delay, full content,
  viewport placement, menu mutual exclusion, and post-menu re-entry.

## MESSENGER.CUSTOM.GROUPS.001

Why:

- Operators use Messenger custom groups to keep related chat, issue, approval,
  and synthetic attention rows together without changing the owning domain's
  lifecycle.
- Group membership must not make a thread feel like a second-class item. A
  grouped row is still the same Messenger item for navigation, unread state,
  pin ordering, and attention semantics.

Product model:

- The default `Latest activity` directory uses the Arc-style custom-group
  layout. Custom groups and loose thread rows share one activity-ordered
  directory; the UI does not expose a separate custom-groups mode.
- Pinned custom groups and loose pinned threads share one visible `Pinned`
  domain above unpinned groups and loose rows. The section may be absent when
  no visible thread or group is pinned.
- In the `Project` directory, a hydrated thread-backed custom group remains one
  atomic directory section. Pinned groups are nested under `Pinned`; unpinned
  groups are nested under `No project`, even when individual members link to a
  project or are pinned independently.
- A custom group is an organization-scoped, operator-scoped Messenger directory
  section over hydrated directory items. Most members are thread summaries, but
  Saved Views may be mixed into the same group without becoming threads or
  owning-domain state.
- A Messenger member can belong to at most one custom group per operator.
  Moving a member into a group removes its previous custom group membership for
  that operator.
- Group membership is keyed by the stable Messenger directory-item key, not by
  chat-only identity. Existing members use thread keys and Saved Views use
  `saved-view:<id>`. Supported members include chat rows such as `chat:<id>`, aggregate
  issue rows such as `issues`, split issue rows such as `issue:<id>`, and known
  synthetic keys such as `approvals`, `failed-runs`, `budget-alerts`, and
  `join-requests`.
- Thread-backed grouped members are hydrated thread summaries and preserve the
  same identity, preview, unread count, attention state, supported actions, and
  destination route as the same summary shown outside a group. Saved View
  members hydrate as Saved Views and retain no thread-only state.
- Dormant synthetic memberships may remain persisted even when the backing
  attention count temporarily drops to zero. The visible hydrated member may be
  absent while the row is empty, but the group must not silently lose the
  membership.
- Hiding a Saved View removes its row from the visible group but preserves its
  group membership and group-local order. Restoring it returns it to that
  position when the group still exists; deleting it removes both the saved
  record and its custom-group membership.
- Onboarding may create or reuse an operator-scoped `Getting Started` custom
  group and add seeded starter issue threads such as `issue:<id>` to it.
- Custom group titles can be explicit operator titles or Fast
  Intelligence-generated titles. Automatic group title generation only runs
  when a drag/drop merge creates a new group from existing Messenger members.
  Menu-created groups keep the operator-provided title unless the operator later
  chooses `Regenerate title`.

Flow:

1. Messenger maps the persisted `Latest activity` preference to the Arc-style
   custom-group directory while keeping the preference value compatible with
   existing local state.
2. The operator creates a custom group, moves a Messenger item into a group, or
   drags an item between groups. Onboarding seed may also create the
   `Getting Started` group for starter work.
3. Rudder writes the operator-scoped membership using the item's stable
   Messenger directory key.
4. When drag/drop merges loose members into a new group, Rudder sends the
   directory-item display titles, including Saved View labels, to Fast
   Intelligence with `feature: "messenger_group_title"`.
   If Fast Intelligence returns a usable title, Rudder stores that title; if it
   fails or returns unusable output, Rudder stores the deterministic fallback
   title from the drop target so grouping still succeeds.
5. Messenger hydrates thread-backed members from the same source summaries used
   for loose Messenger rows and Saved View members from the operator's Saved
   View records.
6. Selecting a grouped member opens the same destination as selecting the loose
   row. Thread-backed members apply their normal read-marker behavior; Saved
   Views have no read marker.
7. The operator may choose `Regenerate title` from the group actions menu.
   Rudder rebuilds title-generation context from current directory-item display titles,
   calls Fast Intelligence, and updates only the group name when generation
   succeeds.
8. Actions that change a thread-backed member's visible summary, including
   mark read/unread, pin/unpin, archive/delete where supported, and
   preview-changing source events, update or refetch the group's hydrated rows
   so grouped badges do not diverge from loose rows. Saved View mutations
   refresh only Saved View state and directory placement.
9. In `Latest activity`, the operator may reorder custom groups within the
   pinned or unpinned domain. Rudder persists that domain-local order and
   restores it on reload without moving the group across the pin boundary.
   `Project` preserves the persisted group order but does not expose group drag
   handles or support group reordering.

Invariants:

- Custom groups must not redefine chat, issue, approval, run, budget, or
  join-request state. They only organize and hydrate Messenger summaries.
- `Latest activity` must not render the superseded `Pinned`, `Today`, and
  `Recent` managed-section layout. It keeps the activity ordering while custom
  groups remain first-class directory sections.
- Grouped issue rows must clear the same issue read markers as loose issue
  rows when opened. Split issue rows and aggregate issue rows must not require a
  different user gesture to become read.
- Onboarding-created `Getting Started` group entries must preserve seed order,
  hydrate as the same split issue summaries as loose `issue:<id>` rows, and
  start with unread count and attention state cleared for the seeded operator.
- Grouped chat rows must clear the same chat read state as loose chat rows when
  opened.
- A grouped thread-backed member's read/unread badge, unread count, attention state, preview,
  and last-activity ordering must not diverge from the source Messenger
  summary after local optimistic updates settle.
- Pinned custom groups render inside the `Pinned` section immediately under
  the section header and before loose pinned threads. Unpinned groups and loose
  unpinned issue, chat, approval, and synthetic attention rows follow.
- In the `Project` directory, custom groups remain atomic: pinned groups render
  first inside `Pinned`, while unpinned groups render first inside `No project`.
  Their members stay inside the group and are not reclassified or duplicated
  under a project, `System`, or another top-level section; an individually
  pinned member inside an unpinned group remains inside that group.
- In `Latest activity`, pinning assigns a custom group to the pinned ordering
  domain without locking its position. Pinned groups remain draggable relative
  to other pinned groups, and unpinned groups remain draggable relative to
  other unpinned groups; reordering must not move a group across the pin
  boundary. `Project` is the explicit exception: it preserves persisted group
  order but exposes no group drag handles or project-mode group reordering.
- Pinning a custom group does not pin every member individually, and pinning a
  member does not remove it from its group.
- Project organization must not split a thread-backed custom group across
  member projects or expose group-reordering drag handles. Group actions and
  the persisted collapse toggle remain available in that view.
- Progressive disclosure inside a Project-organized custom group is local to
  the hydrated group. `Show more` reveals additional loaded group members and
  must not request an unrelated global Messenger thread page.
- Removing an item from a group returns that item to the loose Messenger
  directory with its existing read/unread and attention state intact.
- A mixed group may contain both thread-backed members and Saved Views. Saved
  View rows preserve their Saved View route, target kind, title, hidden state,
  and manual order, but must not inherit unread badges, attention state,
  mark-read actions, or latest-message ordering from neighboring threads.
- Hiding and restoring a Saved View preserves its custom-group membership and
  order. Deleting a Saved View removes its membership but must not delete or
  close the owning automation, Library object, Browser guest, or active Side
  Panel target.
- Automatic group title generation must not run for menu-created groups or for
  moving a member into an existing group.
- Group title generation uses only directory-item display titles, including
  Saved View labels, as context. It must not send full chat transcripts, issue
  descriptions, comments, approval bodies, target payloads, or Browser URLs.
- Drag/drop merge must remain successful when Fast Intelligence is unavailable;
  the fallback title is stored and the pending group clears normally.
- While automatic or manual group title generation is in flight, Messenger
  shows a title-generation motion state on the group header.
- Manual group title regeneration failure must not mutate the existing group
  title.

Evidence:

- Messenger service tests cover thread-key membership, non-chat hydration,
  dormant synthetic membership, and fork-family group reuse.
- Messenger sidebar tests cover non-chat row group actions, grouped rendering,
  stale/newer unread handling, grouped split issue read acknowledgement,
  drag/drop auto-title requests, group title regeneration actions, and
  title-generation motion states. They also cover atomic Project placement,
  non-sortable Project groups, persisted collapse state, and group-local
  progressive disclosure.
- Messenger route tests cover Fast Intelligence group title generation,
  fallback-on-merge failure, manual regeneration, and no mutation when
  regenerated output is unusable.
- Messenger E2E covers aggregate issue grouping, split issue grouping,
  synthetic membership, drag/drop grouping, row-action group creation, and
  custom group pin/order behavior, including pinned-domain group reordering and
  pinned groups rendering above loose pinned threads after reload. It also
  covers the default Arc-style layout and the absence of the superseded
  `Pinned`, `Today`, and `Recent` managed sections. Project-mode coverage proves
  atomic group placement under `Pinned` and `No project`, pagination-independent
  member hydration, exact-once ownership, navigation, persisted collapse state,
  pin/unpin movement, empty-group visibility, local expansion without unrelated
  global-page fetching, ancestor-aware unread jumps and attention counts, and
  the absence of Project group drag handles where reordering is not supported.

## MESSENGER.SAVED.VIEWS.001

### Contract Summary

Messenger Saved Views durably place eligible Browser, Automation, and Library
Side Panel targets in the operator's Messenger directory without turning those
targets into message threads. The same saved item can remain in the fixed
`Saved` section or move into a custom group, while opening it continues work in
the adjacent Side Panel workbench.

### Intent / User Job

- An operator can keep a useful Side Panel target, organize it next to chats
  and issues, and return to it later without losing the current work at save
  time or receiving false unread and attention signals.

### Why / Design Reasoning

- Operators need a durable way to return to useful Side Panel workbench targets
  after the session-scoped tab state ends.
- Reusing message-thread semantics would create false unread, attention, and
  recency signals for objects that have no message stream.
- Target identity, not display URL or label, controls deduplication. This keeps
  two independent Browser tabs saveable even when they show the same URL while
  preventing repeated Add on one tab or durable resource from creating noise.
- Browser continuity is deliberately best effort: a stable application-level
  guest preserves live state while it exists, while the persisted URL and
  Browser partition provide an honest recovery boundary after disposal.

### Actors / Objects / State

- A Saved View is an organization-scoped, operator-scoped durable pointer to an
  eligible Side Panel target. Supported targets are Browser, Automation,
  Library document, Library entry, Library file, and Library directory.
- A Saved View stores a stable id, display label, typed target descriptor,
  hidden state, manual order, and target-specific fallback data. It does not
  own the underlying automation, Library object, Browser guest, or Side Panel
  tab.
- A Saved View is a Messenger directory item, not a message thread. It has no
  transcript, unread state, attention state, mark-read behavior, or synthetic
  latest-message/activity time.
- Messenger reserves a fixed `Saved` section immediately below `New chat`.
  Visible Saved Views that are not assigned to a custom group render there in
  manual order; grouped Saved Views render in their custom group without a
  duplicate row in the fixed section.
- A Saved View uses `/messenger/saved-views/:id` as its stable Messenger route.
  Selecting or directly loading that route opens or focuses the saved target in
  the global Side Panel through the normal target controller and forces that
  panel to the expanded workspace width while the Messenger sidebar remains
  visible.
- Hidden Saved Views are absent from the normal directory but remain available
  from explicit hidden-item management. Restore returns a record to its
  preserved group and order when that group still exists; otherwise it returns
  to its preserved position in the fixed `Saved` section.
- A saved Browser target keeps a best-effort association with its original
  Browser target identity. The live guest is reusable only while that original
  guest still exists. Restart, Browser/Side Panel reset, Browser-data reset, or
  explicit close ends the live association.
- Browser fallback opens the last persisted eligible URL as a fresh target in
  the dedicated Browser partition. It may use partition cookies that still
  exist, but it does not restore history stacks, scroll/form state, POST state,
  or in-page application memory. Browser-data reset may also clear cookies.
- The persisted record includes `targetKind`, a validated typed
  `targetPayload`, `title`, `subtitle`, optional `favicon`, fixed-section
  `sortOrder`, `hiddenAt`, and created/updated timestamps. Browser payloads keep
  the live `tabId` identity plus fallback URL. Automation and Library payloads
  keep their owning resource identity.
- Custom-group membership keeps the existing `thread_key` database column as
  an opaque item key; Saved Views use `saved-view:<id>`.
- Generic group API fields are canonical. Every hydrated member returns
  `itemKey` and `item`; a thread-backed member additionally returns compatible
  `threadKey` and `thread` aliases, while a Saved View never populates those
  thread aliases. Mutations accept either generic or legacy key fields; if both
  are supplied they must be equal or validation fails with `400`.

### Entry Points / Inputs

- `Add to Messenger` on an eligible active Side Panel target.
- Messenger Saved and Hidden row actions: Open, Move to group, Hide, Restore,
  Remove, and manual reorder.
- Direct navigation to `/messenger/saved-views/:id`.
- Organization-scoped Saved View list/create/get/update/reorder/delete APIs and
  generic custom-group item APIs.
- Browser main-frame/in-page navigation, title, and
  `page-favicon-updated` events used to refresh recovery metadata.

### Product Logic Flow

1. From an eligible active Side Panel target, the operator chooses
   `Add to Messenger`.
2. Rudder validates the target descriptor, persists the Saved View for the
   current organization and operator, and confirms success in place. Add does
   not navigate, close or hide the panel, reorder tabs, or switch the active
   tab.
3. Messenger lists the record in the fixed `Saved` section or its custom group,
   without adding it to message activity or attention aggregation.
4. Selecting the row navigates to `/messenger/saved-views/:id`, loads the
   scoped record, and asks the Side Panel to open or focus its target.
5. For Browser, Rudder focuses the original guest when it is still alive.
   Otherwise it opens a fresh Browser target from the last persisted URL under
   the existing Browser profile and navigation policies.
6. Hide removes the row from the visible directory while preserving Saved View
   and group order. Restore makes it visible at the preserved placement.
7. Delete removes the Saved View record and all custom-group membership. An
   already open or active Side Panel target remains open and unchanged.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| First Browser Add | Eligible nonblank live `tabId` has no Saved View | Create one record and show `In Messenger` | Navigate, close, switch tabs, or dedupe by URL | Service, UI, Desktop E2E |
| Repeated Browser Add | Same live `tabId` already has a record | Reuse the record; restore it when hidden | Create a duplicate record | Service and UI tests |
| Same URL, different tabs | Distinct live `tabId` values show one URL | Create distinct records | Collapse them by URL | Service and Desktop E2E |
| Durable resource Add | Same Automation or Library resource identity exists | Reuse the record; restore it when hidden | Duplicate by label/path formatting | Service tests |
| Hidden grouped item | Saved View is hidden while membership exists | Omit it from normal rows and preserve membership/order | Treat membership as stale or delete it | Service and E2E |
| Underlying resource unavailable | Library/Automation lookup is missing, forbidden, or deleted | Keep the row and show unavailable | Auto-delete or cross-scope hydrate | Route/UI/E2E |
| Browser guest alive | Original runtime still owns the saved `tabId` | Show the same guest and `webContentsId` | Remount/reparent or create a second guest | Packaged Desktop E2E |
| Browser guest gone | Original tab closed, LRU-evicted, reset, or app restarted | Open a fresh guest at last persisted eligible URL | Claim history/form/scroll recovery | Packaged Desktop E2E |
| Web/mobile Browser open | No Electron guest capability | Keep the row and ask to open in Rudder Desktop | Drop the record or fake a guest | UI E2E |

### Actor-Visible Input

- Browser shows the action in the address bar before New tab. Automation and
  Library show it at the right of the target header. The visible states are
  `Add to Messenger`, `In Messenger`, and `Restore in Messenger`; a blank
  Browser tab is not saveable.
- Messenger shows visible ungrouped records under `Saved`, grouped records in
  their group, and a `Hidden (n)` manager when hidden records exist.

### Operator-Visible Output

- Add confirms in place without route, panel, active-tab, or tab-count changes.
- Each row shows favicon or type icon, title, and domain/path/automation
  subtitle, plus Move, Hide, and Remove actions.
- Missing Library/Automation targets show an unavailable state. Browser rows on
  web/mobile say to open them in Rudder Desktop; Library/Automation remain
  usable there.
- Saved View rows never show unread, attention, mark-read, or latest-message
  time UI.

### Persisted Evidence

- `messenger_saved_views` must store the scoped typed target, presentation and
  recovery metadata, fixed-section order, hidden state, and timestamps.
- `messenger_custom_group_entries.thread_key` must store the opaque
  `saved-view:<id>` membership and group-local order.
- Each Saved View mutation must emit an organization-scoped, operator-attributed
  activity record. Metadata refreshes do not change Messenger activity order.
- Accepted Browser navigation/title/favicon events must be deduplicated and
  throttled. The newest accepted main-frame or in-page URL wins; pending
  recovery metadata is flushed before deliberate tab/reset disposal when
  possible.

### Canonical Scenarios

1. Save and resume a live Browser guest:
   - Trigger: Save Browser page A, navigate to B, fill a form, then open its
     Messenger row while the original tab remains live.
   - Expected state/action: The same runtime guest remains mounted while the
     global Side Panel expands beside the Messenger sidebar and can navigate
     back.
   - Visible output: Messenger sidebar remains visible; page and in-memory state
     remain.
   - Evidence: Stable `webContentsId`, history, form, and scroll Desktop E2E.
2. Recover after restart:
   - Trigger: Save a Browser target, navigate again, then restart/reset.
   - Expected state/action: Create a new guest at the newest persisted eligible
     URL using the persistent Browser partition.
   - Visible output: Current page and available cookie login restore; no claim
     about history/form/scroll.
   - Evidence: Packaged restart/reset E2E.
3. Hide and restore a grouped Library target:
   - Trigger: Move a saved file into a mixed group, hide it, then restore it.
   - Expected state/action: Membership and group-local order survive.
   - Visible output: Row disappears while hidden and returns to its exact group.
   - Evidence: Service and Messenger E2E.
4. Open an inaccessible Automation target:
   - Trigger: The owning resource is deleted or becomes inaccessible.
   - Expected state/action: Retain the Saved View but deny target hydration.
   - Visible output: Actionable unavailable state with no attention badge.
   - Evidence: Isolation/service/UI E2E.

### Invariants / Non-Goals

- All Saved View reads, mutations, routes, target hydration, and group
  membership are organization-scoped and operator-scoped. A stored descriptor
  never grants access to an underlying object.
- Only Browser, Automation, Library document, Library entry, Library file, and
  Library directory Side Panel targets are saveable under this contract.
- Add, hide, restore, and delete do not implicitly navigate away from the
  current work, close the Side Panel, or change its active tab or target.
- Missing, deleted, or inaccessible underlying targets produce an actionable
  unavailable state; they must not be silently redirected or hydrated across an
  organization boundary.
- Library targets retain `LIBRARY.FILES.001` path, protection, and conditional
  write rules. Automation targets retain `AUTOMATION.*` lifecycle rules.
  Browser targets retain the dedicated Browser partition and all sandbox,
  protocol, popup, permission, download, file, and Rudder-app-origin rules.
- Browser live reuse is best effort and depends on the original guest identity,
  not only URL equality. Fallback from the last URL must not claim recovery of
  ephemeral browsing state.
- The Browser guest remains mounted in an application-level runtime while live
  view anchors move between normal and expanded Side Panel workspaces.
- Hide preserves Saved View custom-group membership and ordering. Delete
  removes the saved record and membership but never deletes the underlying
  object or closes an active Side Panel target.
- Saved Views never participate in unread/attention counts, mark-read APIs, or
  latest-message ordering, including when mixed into a custom group.
- Issue, Chat, Side Chat, placeholder, and blank Browser targets are not
  saveable because Issue and Chat already have Messenger identity or no durable
  target exists.
- Live guest retention is capped at eight; least-recently-used inactive guest
  eviction preserves Saved View records. Restart recovery does not promise
  history, form state, scroll, POST state, or in-page memory.

### Drift Boundaries

- Adding a target kind, changing deduplication identity, Saved/Hidden placement,
  group membership semantics, attention exclusion, live guest ownership,
  recovery guarantees, or web/mobile behavior requires updating this contract.
- Component names, query-cache layout, throttle duration, row styling, and the
  internal activity payload may change without a contract update when visible
  behavior and persisted evidence stay equivalent.

### Traceability

Related plans:

- `doc/plans/2026-07-20-messenger-saved-views.md`

Current implementation foundation:

- `packages/db/src/schema/messenger_saved_views.ts`
- `packages/shared/src/types/messenger.ts`
- `packages/shared/src/validators/messenger.ts`
- `server/src/routes/messenger.ts`
- `server/src/services/messenger-saved-views.ts`

Remaining UI and Desktop runtime surfaces to be extended:

- `ui/src/components/MessengerContextSidebar.tsx`
- `ui/src/pages/Messenger.tsx`
- `ui/src/pages/Chat.side-panel.tsx`

Current related tests to be extended:

- `server/src/__tests__/messenger-routes.test.ts`
- `ui/src/components/MessengerContextSidebar.test.tsx`
- `ui/src/pages/Messenger.test.tsx`
- `desktop/scripts/smoke.mjs`

Known gaps:

- The approved schema, Saved View service, application-level Browser runtime,
  and dedicated Saved View E2E do not exist at contract approval time. They
  must be implemented and added to registry traceability before hand-off.

## IM.FEISHU.001

Why:

- Users do much of their work communication in external IM platforms. Feishu
  integration lets them bring that work into Rudder without leaving their
  existing chat workflow.

Product model:

- Agent integration belongs to one organization and one agent.
- Provider state includes Feishu app identity, region, bot open id,
  credentials/status, setup session metadata, binding tokens, chat bindings,
  user bindings, inbound audit/dedup, and outbound messages.
- Feishu setup starts from Agent Detail as a setup session. Rudder opens the
  Feishu/Lark SDK app launcher with a safe suggested bot name, waits for
  Feishu authorization, stores the resulting app credentials as an organization
  secret, creates or reactivates the agent integration, and refreshes the chat
  runtime.
- The setup session registry is process-local in V1. If Rudder restarts while
  authorization is pending, the operator must start a new setup session.
- When a board user completes setup and the Feishu installer identity maps to
  an active Rudder organization member, Rudder may automatically bind that
  Feishu identity to the Rudder user for the new integration.
- Active Feishu integrations use long-connection chat by default. Operators may
  disable that runtime only with an explicit environment override.
- Newly registered Feishu/Lark apps request message send, message reaction,
  self-management, bot menu, quick-command, and message receive permissions
  needed by the setup, inbound, outbound, and working-reaction flows.
- Group messages require explicit bot addressing unless provider policy says
  otherwise.
- Feishu runtime outbound text, including assistant replies and operational
  setup/command responses, defaults to provider-side rich Markdown rendering by
  sending an interactive message card with Markdown content. When Feishu
  explicitly rejects the card payload, Rudder falls back to a plain text message
  with the same body instead of dropping the reply. Ambiguous transport,
  authentication, rate-limit, or server failures do not trigger fallback because
  Rudder cannot prove whether the card reached Feishu.
- Feishu-bound conversations carry provider source metadata into Messenger
  thread summaries, so chat rows can show a compact `Feishu` source badge.
- Feishu-origin chat runs carry source metadata in the run context snapshot, so
  Agent Detail can show `Source: Feishu` on the originating run.
- Feishu-bound conversations are read-only from Rudder's local chat surface.
  Operators must fork them to continue locally. The fork keeps chat lineage but
  is not bound to the Feishu conversation.
- Feishu integrations include daily session settings. Daily session rollover is
  enabled by default with a 24-hour window and an operator-controlled setting
  for whether Feishu receives a short rollover notice.
- The external Feishu chat remains stable, but the active Rudder conversation
  bound to that external chat can roll over lazily when the next inbound message
  arrives after the configured session window.
- Daily rollover is not a background scheduler. Rudder does not create empty
  future sessions when no Feishu inbound message arrives.
- When rollover creates the next Rudder conversation, the previous conversation
  receives a system event with the previous/next conversation ids, rollover
  reason, notification setting, and best-effort previous-session summary.
- Previous-session summaries prefer the organization's Smart Intelligence path,
  then the configured agent runtime, then deterministic transcript metadata.
  Summary failure must not block the inbound Feishu message.

Setup flow:

1. Operator opens Agent Detail Integrations and starts a Feishu setup session.
2. Rudder creates a provider-region-specific setup URL with a suggested bot
   name that fits Feishu launcher limits.
3. Feishu/Lark authorization returns app credentials and installer identity.
4. Rudder stores credentials as an organization secret and creates or
   reactivates the agent integration for that agent/provider pair.
5. Rudder auto-binds the installer Feishu identity when the installer is an
   active org member.
6. Rudder refreshes the long-connection runtime before reporting the setup
   session completed.
7. Agent Detail polls the setup session and refreshes integration state when
   completion is observed.

Inbound flow:

1. Feishu callback/mock/long-connection event is verified and normalized.
2. Active integration is resolved by provider/app/org/bot identity.
3. Dedup is inserted before expensive side effects.
4. Sender binding is checked; if missing, Rudder returns/sends binding-token
   instructions.
5. External chat is bound to a Rudder Messenger conversation.
6. If the active Rudder conversation for that external chat has reached the
   configured daily session age and no reply generation is active or closing,
   Rudder creates the next Feishu-bound Rudder conversation, moves the binding,
   and records the rollover system event on the previous conversation.
7. If a reply generation is active or closing, rollover is deferred and the
   inbound message remains in the current session.
8. Inbound text is appended to chat and, when command/routing rules apply,
   issue and run work is created/enqueued.
9. Messenger summary metadata records that the conversation came from Feishu,
   and Feishu-created chat runs persist matching source metadata.
10. Outbound placeholder/status is recorded and sent to Feishu. When rollover
   happened and notifications are enabled, the outbound text includes
   `New daily session started.`.

Session switch flow:

1. `/new` or daily rollover asks Rudder to switch the external Feishu chat
   binding to a fresh Rudder conversation for the same integration and agent.
2. Rudder locks the existing binding and aborts the switch if another process
   already moved the binding.
3. Rudder creates the next Feishu-bound conversation with the same agent
   context link and updates the binding to that conversation.
4. Rudder writes a system event to the previous conversation. Manual `/new`
   uses `manual_new`; automatic daily rollover uses `daily_rollover`.
5. The next ordinary inbound message for that external chat appends to the new
   active Rudder conversation.

Accepted reply flow:

1. A normal accepted Feishu message appends the inbound user chat message and
   returns from event handling without waiting for the assistant reply to finish.
2. Rudder claims a chat generation for the Feishu-bound conversation before
   starting the background assistant reply.
3. When the Feishu sender supports reactions, Rudder adds an `OnIt` working
   reaction to the inbound Feishu message while the background reply is running.
4. The background task invokes the chat assistant without streaming to Rudder UI,
   persists the assistant message, sends or patches the final Feishu outbound
   reply, links the assistant message to the chat run, and marks the generation
   completed.
5. If the reply is stopped or aborted before a durable final response exists,
   Rudder marks the generation stopped and removes any assistant message created
   after the stop.
6. If setup or reply completion fails after the message was accepted, Rudder
   marks the generation failed and, when possible, sends a safe fallback response
   back to Feishu.
7. Rudder removes the `OnIt` working reaction after reply completion, stop, or
   failure. Reaction add/remove failures are logged but must not fail the
   Feishu message handling path.

Outbound flow:

1. Assistant/run result creates a Rudder chat message.
2. Integration runtime sends the corresponding Feishu outbound message as an
   interactive Markdown card by default.
3. If Feishu explicitly rejects the Markdown card payload, the runtime sends the
   same body as a plain text fallback so the user still receives the reply.
   Ambiguous delivery failures, authentication failures, rate limits, and server
   failures surface through the normal outbound error path instead of sending a
   possible duplicate.
4. Outbound table records provider, external chat id, status, and linked Rudder
   message/run/conversation. The persisted chat message body remains the
   canonical Rudder text/Markdown source even when provider delivery uses a
   card wrapper.

Local Rudder read-only flow:

1. Operator opens a Feishu-bound conversation in Messenger or Chat.
2. Rudder shows the existing transcript and Feishu source badge, but replaces
   the local composer with a fork-to-continue call to action.
3. Local mutation APIs for that conversation reject with `409` and the message
   `Fork this Feishu chat to continue in Rudder`.
4. Listing messages remains passive and must not repair or rewrite message
   state as a side effect of reading the Feishu-bound conversation.
5. When the operator forks, Rudder creates a normal Rudder chat with lineage to
   the Feishu-bound source. Local messages on the fork are allowed and are not
   written to Feishu outbound delivery state.

Invariants:

- Dedup must run before chat binding, issue creation, run enqueue, or outbound
  writes.
- External Feishu chat id maps to exactly one active Rudder conversation per
  integration binding at a time. Manual `/new` and daily rollover may move that
  binding to a new Rudder conversation while preserving the older conversations
  as read-only audit history.
- Daily session rollover must be lazy, inbound-driven, and controlled by
  integration settings. It must not run as a background job or create empty
  conversations for quiet external chats.
- Daily rollover must not interrupt an active or closing assistant generation.
  Inbound messages received during that state stay in the current session; a
  later inbound message can roll over after the generation reaches a terminal
  state.
- Rollover summaries and Feishu rollover notices are best-effort user
  conveniences. Failure to summarize or notify Feishu must not drop or delay the
  inbound user message.
- The daily rollover notification setting affects only whether the external
  Feishu reply includes the short notice. The previous-session Rudder system
  event remains recorded for audit either way.
- IM messages remain auditable in Rudder even when the external send fails.
- Feishu rich-card delivery is a rendering optimization, not the canonical
  message source. A provider-declared card rejection must not prevent plain text
  fallback delivery from preserving the reply in the external chat, but
  uncertain delivery state must not create a second fallback message.
- Feishu-bound Messenger chat rows must remain visibly distinguishable with a
  compact `Feishu` source badge.
- Feishu-origin chat runs must show `Source: Feishu` in Agent Detail run
  details.
- Source badges must derive from persisted provider/source metadata, not title
  parsing alone.
- Feishu-bound conversations must be locally read-only in Rudder. Local send,
  queued follow-up, edit, retry, continue, stop, attachment upload, context or
  project mutation, conversion, resolve, archive, and delete actions must be
  blocked or hidden for the bound source conversation.
- Feishu inbound dispatch and Feishu runtime outbound delivery remain the only
  paths that write back to the external Feishu chat binding.
- Accepted Feishu event handling must not block behind the full assistant reply;
  `/stop` and other follow-up commands must be able to arrive while the reply is
  still generating.
- The working `OnIt` reaction is a transient provider-side progress signal. It
  must not be treated as durable Rudder message state, and failure to add/remove
  it must not hide or corrupt the persisted chat/run/outbound evidence.
- Background accepted-reply generation must end in a terminal generation state:
  completed, failed, or stopped. Stopped replies must not leave a final assistant
  message or outbound final response that was created after the stop signal.
- Forked conversations from Feishu-bound sources must not carry
  `sourceMetadata` or create `agentIntegrationOutboundMessages` for future local
  messages.
- UI controls must teach the operator to fork before continuing instead of
  silently dropping local input or pretending the Feishu-bound conversation is a
  normal chat.

Evidence:

- Feishu route tests cover org scoping and callback verification.
- Inbound dispatcher tests cover dedup, binding, issue/run enqueue, and
  outbound response.
- Feishu DB/runtime dispatcher and outbound sender tests cover setup-session completion,
  credential secrecy, revoked integration reactivation, installer auto-binding,
  SDK normalized long-connection events, hydrated chat message attachments,
  source metadata propagation, per-event runtime failure containment, background
  accepted-reply handling, stopped reply cleanup, default Markdown card outbound
  delivery, plain text fallback, no-fallback ambiguous failures, `OnIt`
  working reaction add/remove behavior, `/new` session switching, lazy daily
  rollover, disabled rollover notification, active-generation rollover deferral,
  and Smart Intelligence, agent runtime, and deterministic summary fallback.
- Feishu app registration tests cover the permissions requested for message,
  reaction, self-management, bot menu, quick-command, and receive-event flows.
- Agent Detail Feishu E2E covers setup-session launcher flow, polling,
  persisted integration state, and credential redaction with a mocked Feishu
  app-registration provider.
- Agent Detail Feishu UI tests cover updating the daily session notification
  setting from the manage dialog.
- Feishu source badge E2E covers the visible Messenger row badge and Agent
  Detail run detail badge for Feishu-origin work.
- Feishu source badge E2E covers the Feishu-bound read-only UI, local mutation
  `409`, fork creation, fork-local message send/readback, and absence of Feishu
  outbound rows for the fork.
- Chat route tests cover Feishu-bound local mutation rejection and passive
  message listing.
- Chat UI tests cover the read-only fork call to action, hidden local mutation
  controls, and normal composer behavior on the fork.
- Messenger service tests cover Feishu source metadata in thread summaries.
- Agent Detail run facts tests and source-badge unit tests cover badge
  detection from persisted source metadata.
- Manual live Feishu validation for ZST-613 covered Feishu app creation, real
  user message intake, Rudder run success, persisted assistant chat message,
  outbound final status, and visible Feishu bot reply.
