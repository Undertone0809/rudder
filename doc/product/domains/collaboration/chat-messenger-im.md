---
title: Chat Messenger And IM Integration
domain: collaboration
status: active
coverage: detailed
contract_ids:
  - CHAT.LIFECYCLE.001
  - CHAT.RESPONSE.ANNOTATION.001
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
  - packages/shared/src/validators/chat.ts
  - packages/shared/src/chat-transcript-provenance.ts
  - packages/shared/src/project-mentions.ts
  - packages/shared/src/chat-work-manifest.ts
  - packages/shared/src/browser-shortcuts.ts
  - packages/shared/src/website-icons.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/product-intelligence.ts
  - server/src/services/chats.ts
  - server/src/services/chats.helpers.ts
  - server/src/services/postgres-json.ts
  - server/src/services/run-events.ts
  - server/src/services/chat-work-manifest.ts
  - server/src/services/chat-agent-runs.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/services/chat-inline-annotations.ts
  - server/src/services/chat-steer-messages.ts
  - server/src/services/side-chats.ts
  - server/src/services/messenger.ts
  - server/src/services/legacy-operator-state.ts
  - server/src/services/local-account-auth.ts
  - server/src/services/organization-intelligence-profiles.ts
  - server/src/routes/integrations.ts
  - server/src/services/integrations/agent-integrations.ts
  - server/src/services/integrations/feishu/inbound-dispatcher.ts
  - server/src/services/integrations/feishu/inbound-dispatcher-db.ts
  - server/src/services/integrations/feishu/inbound-normalizer.ts
  - server/src/services/integrations/feishu/event-verifier.ts
  - ui/src/index.css
  - ui/src/components/MarkdownBody.tsx
  - ui/src/components/chat/ResponseAnnotations.tsx
  - ui/src/lib/chat-response-annotation-selection.ts
  - ui/src/lib/chat-pending-attachments.ts
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
  - ui/src/lib/messenger-preferences.ts
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
  - server/src/__tests__/local-account-auth.test.ts
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
  - ui/src/components/chat/ResponseAnnotations.test.tsx
  - ui/src/components/side-panel/SideChatPanelView.test.tsx
  - packages/shared/src/chat-transcript-provenance.test.ts
  - server/src/services/chat-assistant.annotations.test.ts
  - server/src/services/chat-inline-annotations.test.ts
  - server/src/services/postgres-json.test.ts
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
  - tests/e2e/local-account-upgrade.spec.ts
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
  - tests/e2e/chat-response-annotations.spec.ts
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
- A pending Issue Proposal is a reviewable Chat object, not only assistant
  prose. It rests as a complete inline proposal card with a bounded details
  preview. `Show full proposal` opens or focuses a dedicated `Issue proposal`
  Side Panel tab for the same conversation message and replaces the inline card
  with a compact launcher while that tab exists.
- Hiding the Side Panel preserves the proposal tab and compact launcher so the
  operator can resume review. Explicitly closing the proposal tab removes that
  temporary panel target and restores the complete inline card in the
  transcript.
- Proposal fields, decision feedback, and review actions inside the Side Panel
  operate on the same current proposal state as the inline card. Requesting
  changes continues the Chat review loop, approval creates the issue through
  the existing governed conversion path, and rejection preserves the existing
  proposal-review semantics; opening the panel must not fork or snapshot those
  actions.
- User-provided original images are first-class proposal evidence when they
  directly explain a requirement, reproduction, design reference, or acceptance
  result. The proposal keeps that evidence inspectable instead of replacing it
  with a redraw, generated substitute, or lossy text-only description.

Product model:

- A chat conversation belongs to an organization and may link to issues,
  projects, resources, approvals, or automation runs.
- Every locally created native chat has a preferred agent. The create API uses
  the caller's selected organization agent when supplied and otherwise assigns
  the organization's first available agent; it rejects creation before
  persistence when the organization has no available agent.
- A new-chat draft exposes the organization Agent choice before the first
  message. The first accepted message atomically binds that Agent to the
  conversation. Afterward the Agent identity is locked, while its menu remains
  inspectable and its next-message Model / Thinking controls remain
  available on the bound Agent row.
- Model and Thinking are nullable composer-draft overrides for the next message,
  not durable conversation preferences. Selecting either value performs no
  conversation mutation. The Send request carries the explicit choice and the
  server freezes the resolved Agent, model, and effort at message or Queue
  admission. After acknowledgement the composer returns to Agent defaults; a
  rejection before acknowledgement preserves the complete draft for retry.
  Legacy persisted conversation override fields remain readable for compatible
  older clients, but current Messenger and Side Chat composers do not create or
  update them.
- Entry points that only establish context, such as Project `Chat`, open an
  unpersisted new-chat draft. They must not create an empty conversation merely
  because the operator opened the composer.
- No Chat may persist without at least one durable message or structured system
  event. The first accepted message is the atomic creation boundary across UI,
  API, CLI, MCP, automation, and IM entry points.
- A Messenger custom-group `New chat` action carries only an ephemeral
  group-selection context while the draft is unpersisted. When the first user
  message is accepted, the new Chat and its `chat:<id>` group membership are
  created atomically. If the selected group was deleted or is no longer owned
  by the operator before acceptance, the Chat remains valid and is placed loose.
- Messages have role, status, body, attachments, rich references, structured
  payloads, and optional run attribution.
- A pending `requestUserInput` assistant message is a waiting decision surface.
  Each question preserves its structured options and always exposes an `Other`
  path for operator-authored feedback, including legacy payloads that set
  `allowFreeform: false`. A non-empty freeform answer, with optional
  attachments, is submitted through the normal Chat message path as Steer
  feedback rather than being limited to the structured option labels.
- A user message may carry response annotations under
  `CHAT.RESPONSE.ANNOTATION.001`. An annotation-only message is valid in an
  existing Chat, and Queue, Steer, retry, and edit branching preserve the
  annotation evidence with the same durability as the message body.
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
- A run-backed failed assistant message exposes `Open run` for that exact
  message attempt, independent of the conversation's newest run. Chat omits the
  action when either run attribution or agent identity is unavailable, so it
  does not render a dead Agent Run link.
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
- Runtime transcript evidence may contain NUL characters. Rudder replaces those
  characters deterministically while preserving the rest of the evidence across
  the generation ledger, linked Agent Run events, and streaming or non-streaming
  message transcript state.
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
  delivered, including response annotations and their annotation-owned files.
  Operators can edit or delete ordinary queued follow-ups while they remain
  queued. Deleting one requires an explicit confirmation that explains the
  message will be removed before delivery; cancel, close, or Escape sends no
  request, while confirmation sends at most one request. Admission snapshots
  the effective Agent, primary model, and thinking
  effort so later conversation-runtime changes or Agent availability changes
  do not retarget queued work. The
  server, rather than the open browser, owns claiming and delivering eligible
  follow-ups.
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
  assistant response follows the Work Transcript. Even inside the collapsible
  Work Transcript, the Steer interjection uses the same right-aligned user
  bubble edge as an ordinary sent message. The live, completed, and reloaded
  projections must preserve that same ordering, alignment, and message
  identity.
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
3. Composer's primary identity control is the Agent. Before the first send the
   operator may choose another available organization Agent; changing it clears
   draft model and effort overrides and restores that Agent's defaults. Before
   every send, the current Agent row alone exposes a compact Model / Thinking
   entry backed by that Agent's runtime-owned catalogs.
4. Before the first send, the server performs a side-effect-free preflight for
   organization access, Agent/runtime/model support, context ownership, and
   attachment validity. A failure keeps the complete unpersisted draft.
5. On the first accepted send, the server atomically persists the selected
   Agent binding, context links, first message, title, and activity before
   acknowledging the turn, while freezing optional model and effort overrides
   only for that admitted message. The Agent then becomes immutable for the
   conversation; other Agent rows remain visible but disabled, while the bound
   row's next-message runtime entry stays editable. Direct create callers must
   supply a non-empty first message; the server derives its role from the
   authenticated actor.
6. If assistant startup or generation fails after acceptance, Rudder retains
   the accepted user message and durable, visible failure evidence.
7. If a runtime assistant is invoked, Rudder creates a chat Agent Run and
   streams/persists assistant messages. If the runtime pauses on a
   `requestUserInput` question, the operator can choose a structured option or
   select `Other` and enter freeform feedback. The answer remains blocked until
   every question has an answer; submitting it materializes one normal user
   message through the existing Chat send path, preserving attachments and
   Steer delivery/state handling.
8. The operator can open the conversation menu to inspect its newest linked
   Agent Run, then use `Chat Replies` to move between distinct attempts without
   expanding duplicate conversation entries in the Agent Runs navigation.
   A run-backed failed assistant message instead opens that message's exact
   Agent Run directly; retryable failures keep this action alongside Retry, and
   failures without complete run and agent attribution expose no run action.
9. Chat can continue executing the task conversationally or create/link an
   issue, automation, or approval when the operator asks for that additional
   structure. The assistant must not emit an issue proposal merely because the
   work is large, durable, assignable, or issue-shaped.
   When an explicitly requested Issue Proposal needs a relevant user-provided
   image, its description embeds the original through Markdown using that
   attachment's canonical `contentPath` and a meaningful alt text. A revision
   turn re-checks relevant image attachments within the available bounded Chat
   prompt history even when the revision-feedback message has no attachments.
10. A pending Issue Proposal initially renders as the complete inline review
    card. Choosing `Show full proposal` opens or focuses one Side Panel target
    keyed to that conversation message, expands the full proposal details and
    review controls there, and leaves a compact `Issue proposal` launcher in the
    transcript. Hiding and reopening the Side Panel retains that tab; choosing
    the compact launcher reopens it. Explicitly closing the proposal tab
    restores the complete inline card.
11. Review actions taken in the proposal tab use the current proposal fields
    and decision note. Request changes persists that feedback and continues the
    conversation with the revised-proposal path; approve and reject retain the
    same domain behavior as the inline review surface.
12. When the operator refreshes a completed assistant answer, Rudder reuses the
   original turn context, creates a new turn variant, and surfaces branch
   controls for moving between variants.
13. While the refreshed or edited variant is still streaming, the operator may
   switch the visible turn branch back to an earlier variant to inspect prior
   user and assistant content. The current stream continues in the background,
   generation controls remain available, and returning to the active/latest
   variant shows the live stream draft again.
14. If the operator sends another local follow-up while the selected chat has an
   active generation, Rudder creates a queued follow-up with the current draft,
   attachments, selected project, skills, admitted Agent, effective primary
   model, effort, access mode, and expected active generation id. The queued
   Agent/model/effort snapshot remains authoritative even if conversation
   configuration or Agent availability changes before dequeue.
15. The queue renders beside the composer with stable ordering. The first queued
   item is marked as next, later items show their queue position, and editable
   queued items expose edit/delete controls.
16. When the operator chooses Steer, Rudder atomically persists the durable
   control action, one normal user message, their queue linkage, and message
   activity evidence before attempting provider delivery. The message records
   its target generation and exact Work Transcript boundary. It stays in the
   conversation whether delivery is native, deferred, unknown, or actionable
   failure; delivery status remains separate evidence. Pending, provider-
   acceptance-unknown, and accepted native delivery use that one anchored
   interjection. Continuation delivery keeps the message outside the old run.
17. When the current reply completes, a server-owned worker claims the next
   eligible queued follow-up, sends it as the next chat turn, and hides the
   queued row after it is linked to the delivered user message. The row leaves
   the composer as soon as that user message is visible, even while the new
   assistant reply is still running. Delivery does not depend on the
   originating page remaining open.
18. If the operator Stops the current reply, the stopped generation remains
   visibly `Stopped`, including when it was stopped before producing body or
   transcript output, and the server-owned queue worker automatically delivers
   the next ordinary queued follow-up as a distinct subsequent turn after the
   Stop reaches its verified terminal boundary. If the current reply fails,
   loses control, or ends without verified Stop/completion evidence, ordinary
   queued follow-ups stay parked. The operator may explicitly Steer retained
   feedback; Rudder then persists a continuation, waits for the prior owner to
   terminate, and starts that continuation without requiring the feedback to
   be resent.

Invariants:

- Chat messages must remain tied to their conversation and organization.
- A Chat transaction must not commit a conversation before its first message or
  structured system event. Preflight, validation, permission, context,
  attachment-preparation, Agent, runtime, and model failures are side-effect
  free and must not add Messenger rows, activities, or bindings.
- After the first message is accepted, runtime startup and generation failures
  are real work evidence: the Chat, accepted message, and durable visible error
  remain inspectable.
- NUL characters in transcript evidence alone must not fail a Chat turn that
  otherwise completed. The completed reply and its normalized generation, Agent
  Run, and message transcript evidence must remain inspectable after reload.
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
- Composer model or effort choices affect only the next message submitted with
  those values. An in-flight invocation retains its admitted runtime config,
  and queued or fallback-continuation work retains the Agent, model, and effort
  snapshots stored at queue admission. Selecting `Agent default` clears only
  the local composer override.
- Per-message overrides replace only the primary model and adapter-owned
  effort field in the derived Chat runtime config. Secrets, workspace, skills,
  fallback models, and other Agent runtime settings remain inherited. A null
  effort override means Agent default; explicit `Auto` clears inherited effort
  in the admitted config. If the chosen model does not support the inherited or
  overridden effort, the derived message config also uses Auto without mutating
  the Agent or conversation.
- Chat proposals/structured payloads must not be confused with plain user
  instructions or automation run input.
- A pending `requestUserInput` question must keep its structured options
  visible and must always expose `Other` for freeform feedback. The legacy
  `allowFreeform` flag must not hide that path; blank freeform input cannot be
  submitted unless an attachment supplies the answer evidence.
- Assistant-created issue proposals must be grounded in an explicit latest
  operator-authored request for issue creation, chat-to-issue conversion, or
  issue-proposal drafting.
- One pending proposal message must map to at most one temporary Side Panel tab
  in its current Chat context. Opening it repeatedly focuses the existing tab
  instead of duplicating review surfaces.
- Side Panel visibility and proposal-tab existence are distinct. Hiding the
  panel must keep the proposal compact and resumable; closing the proposal tab
  must restore the complete inline card.
- Inline and Side Panel proposal presentations must share current editable
  proposal data, decision feedback, pending action state, and review callbacks.
  A stale render captured when the tab opened must not submit obsolete fields or
  feedback after the Chat state changes.
- The proposal Side Panel presentation must expose the complete description and
  the same available review decisions without requiring conversion to an issue
  or navigation away from the current Chat.
- Initial and revised Issue Proposal descriptions preserve directly relevant
  user-provided original images with Markdown image syntax, meaningful alt
  text, and the attachment's canonical `contentPath`.
- A temporary runtime `localPath` exists only so the Agent can inspect the
  image. It, internal retrieval commands, and authentication material must
  never enter user-visible proposal JSON, Markdown, or the created Issue
  description.
- Proposal image selection remains scope-relevant. The Agent must not copy all
  attachments indiscriminately, treat non-images as proposal images, invent a
  path when `contentPath` is unavailable, or claim ambiguous evidence is
  relevant.
- Before persistence, Rudder rejects a generated Issue Proposal that exposes a
  materialized attachment `localPath` or uses a Markdown image target other
  than the canonical `contentPath` of a user image attachment available in the
  bounded prompt window.
- Requesting a proposal revision does not discard eligible historical image
  evidence inside the current bounded prompt window. The replacement proposal
  applies the same canonical-path and relevance rules; attachments outside that
  window are not retrieved implicitly.
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
- Queue ordering must be deterministic by stored position and creation time. A
  locked or concurrently inspected head item blocks later eligible items in the
  same conversation; worker concurrency must never let a later Queue message
  leapfrog it. Idempotency keys must not allow the same queued item id to be
  reused with a different payload.
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
- A verified operator Stop advances the next ordinary queued follow-up through
  the server-owned worker as a distinct turn without changing the stopped
  generation's visible `Stopped` result. Failed, control-lost, aborted, or
  unverified replies leave ordinary queued follow-ups parked; Rudder must not
  silently flush queued work without completion or verified operator-Stop
  evidence. A retained row changes this rule only when the operator explicitly
  chooses Steer.
- Steering is fenced to the expected generation, runtime attempt, and control
  version. A stale request resolves through its durable action identity; it
  must not steer a newer attempt, lose feedback, or create a duplicate
  continuation.
- Native steering is offered only by the active attempt that registered that
  capability. Attempts without native support use interrupt-and-continue, and
  retained feedback after Stop remains steerable as a server-owned
  continuation.
- External-bound Feishu conversations are read-only locally. They must reject
  model/effort-override and queued-follow-up mutations through the same
  fork-to-continue boundary as normal local chat mutation APIs.
- Agent attribution is visible enough to navigate from message to run/agent.
- Conversation-to-run navigation chooses the newest linked assistant attempt;
  per-conversation grouping in the run rail must not collapse the underlying
  run records or their evidence.
- When Chat merges organization-wide mention candidates with the selected
  agent's enabled skill candidates, one canonical skill target appears only
  once. The selected-agent candidate wins so the composer preserves the
  agent-specific enabled-skill boundary and metadata.
- Work-manifest reconciliation must not read hidden reasoning, transcript tool
  payloads, stdout, stderr, or response-annotation payloads as user-visible
  Sources or References.
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
- Chat assistant prompt and output-validation tests cover relevant
  original-image retention,
  canonical `contentPath` Markdown guidance, runtime-only `localPath`
  exclusion, relevance filtering, and historical image reconsideration for
  revised Issue Proposals. Proposal-review E2E covers the original upload,
  first proposal, Request changes replacement, approval, and the same image in
  the created Issue Detail.
- Proposal-review E2E covers the complete inline card, `Show full proposal`
  transition, one `Issue proposal` Side Panel tab, compact launcher,
  hide/reopen behavior, explicit tab-close restoration, full details, and
  current Request changes feedback submitted from the panel.
- Chat assistant, route, queue, and runtime-selector tests cover model/effort
  precedence, atomic first-turn persistence, Agent-switch reset, fallback
  preservation, adapter effort projection and compatibility, in-flight
  admission, queue/Steer snapshots, refresh persistence, and non-inheritance
  boundaries.
- Ask User UI regression tests and E2E cover the always-visible `Other` path,
  non-blank freeform submission, legacy `allowFreeform: false` payloads,
  draft restoration, disabled submission state, and attachment-backed answers.
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
  continuation, immediate Stop, automatic ordered Queue advancement after a
  verified operator Stop, removal of the linked Queue row while its delivered
  turn is still running, and one durable native-Steer interjection that survives
  reload without duplication. Service tests cover locked-head ordering and
  parked ordinary follow-ups after failed, aborted, control-lost, or unverified
  replies. Focused UI tests distinguish linked in-flight rows from linked rows
  recovered to `queued` or `failed_actionable`. The focused UI tests and
  native-Steer E2E also verify the production-shaped ordering `reasoning A ->
  Steer -> reasoning/tool B -> final response` while streaming, after final
  persistence, during historical message edit replacement, and after reload;
  fallback continuation remains outside the old run.
- Chat route and UI tests cover queue snapshots, active-generation reporting,
  queued follow-up editing/cancellation/claiming, hidden delivered rows,
  retained parked rows, and Feishu-bound queue mutation rejection.
- Shared, route, UI, and Chat response-annotation E2E tests cover
  annotation-only messages, Queue and Steer preservation, immutable historical
  evidence, failure recovery, and annotation-owned image/file attachments.
- Chat empty-state UI and E2E coverage verify aligned tabs/Project context,
  the selected Project icon/clear-action swap, the locked-conversation icon,
  full-width square resting rows, and inset rounded hover emphasis for recent
  Project conversations.
- Chat prompt-flow UI, motion-contract, and E2E coverage verify compact starters,
  the two-page transition lock, reduced-motion behavior, context preservation,
  editable prompt completion, retained hidden DOM, and the existing-chat boundary.

## CHAT.RESPONSE.ANNOTATION.001

## Contract Summary

Rudder lets an operator quote a precise selection from a stable assistant
answer, already-loaded operator-visible Process prose, or an eligible saved text
file open in the current Chat's Side Panel and attach that quote to a Chat
message. Each annotation may include an optional operator comment and its own
images or files. Draft annotations remain editable; after Send they are
immutable, message-owned evidence that Queue, Steer, retry, edit branching,
Fork, and Side Chat preserve.

## Intent / User Job

An operator can point to the exact part of a long answer or visible work
transcript that needs clarification, correction, or follow-up without manually
copying context into the composer or losing the relationship to its source.

## Why / Design Reasoning

- Plain copy/paste loses source identity, makes several quoted passages hard to
  distinguish, and cannot return the operator to the original evidence.
- Process prose can be useful quoted context, but it remains Run evidence. A
  deliberate user selection must not silently promote Thinking into an
  assistant final answer or system instruction.
- Annotation comments and files belong to an individual quote. Keeping that
  ownership explicit prevents an image or document from becoming ambiguous
  generic message context.
- Stable hashes, canonical source offsets, bounded surrounding context, and
  generation-event provenance detect stale or fabricated anchors without
  storing a second mutable copy of the source.
- The user message owns the immutable sent snapshot. A separate annotation
  table would introduce an independently mutable lifecycle that this workflow
  does not need.

## Actors / Objects / State

- Board operator: creates, comments on, attaches files to, removes, inspects,
  and sends annotations in a Chat the operator can access.
- Annotation draft: an ordered, mutable item with a client id, exact selected
  text snapshot, optional comment, source anchor, and zero or more pending
  image/file attachments.
- Canonical annotation: a typed `ChatInlineAnnotation` stored in the owning user
  message's structured payload. It contains `id`, `selectedText`, nullable
  `comment`, `sourceConversationId`, surface-specific source identity,
  `sourceHash`, source `start`/`end`, bounded `prefix`/`suffix`, and canonical
  annotation attachment ids.
- Assistant-body source: one stable `completed`, `stopped`, or `failed`
  assistant message. Its hash and offsets address the canonical Markdown
  source while `selectedText` preserves the exact rendered text the operator
  saw; Markdown links, inline code, lists, CJK text, and selections spanning
  visible paragraphs remain supported.
- Process source: one visible assistant/thinking prose transcript block from a
  terminal generation. In addition to the common anchor it stores
  `transcriptKind`, `generationId`, and inclusive
  `generationSeqStart`/`generationSeqEnd`. Generation event sequence is source
  identity; transcript-array index and wall-clock timestamp are not.
- Agent Run transcript source: one stable assistant reasoning, message, or
  completed tool transition from the terminal Nice Transcript of an Agent Run.
  It stores the owning `sourceRunId`, fixed `sourceAgentId`, `anchorKind`, a
  stable source entry id/member set, and a source hash. Raw, Invocation,
  hidden/internal, user/Steer, and incomplete live blocks are not annotatable.
- Workspace-file source: one saved, non-truncated Markdown, plain-text, or
  code/source file visible in the current Chat's Library Side Panel. It stores
  the normalized Library-relative path, optional stable Library entry id,
  Markdown/text render mode, exact saved-content hash, and canonical range.
- Local-file source: one saved, non-truncated text file loaded from a canonical
  absolute path through the trusted Desktop bridge. The server stores its
  operator-selected snapshot and path as untrusted user context but never reads
  that Desktop path while admitting a Chat message.
- Annotation attachment: an ordinary governed Chat asset and
  `chat_attachment`, but assigned to exactly one annotation and owned by the
  same organization, conversation, and user message as its annotation. Before
  a queued message is materialized, its upload may exist only as a bounded,
  server-owned staged asset reference.
- Draft annotation set: at most ten ordered annotations associated with one
  organization and conversation composer. Its markers are numbered by current
  order.
- Sent annotation set: the immutable canonical snapshot on one user message.
  Its count chip, quoted text, comments, files, source status, and source-jump
  behavior remain inspectable after reload.

## Entry Points / Inputs

- A mouse, touch, or keyboard text selection contained within one eligible
  assistant body, visible Process transcript block, or saved editable text
  file in the current Chat's Side Panel.
- `Add to chat` on every eligible selection. `Ask in side chat` is additionally
  available when the owning assistant message satisfies the completed-message
  anchor required by `CHAT.SIDE.CHAT.001`.
- The annotation editor's optional comment field plus image/file add and remove
  actions.
- Existing Chat JSON, stream, multipart, Queue, and Steer message admission
  paths.
- Agent Run Detail and Agent Detail Runs surfaces may stage these sources into
  one Messenger-visible Chat draft. The draft is keyed by organization and
  Agent, survives Run navigation, defaults to `No project`, and locks its
  project after the first accepted message. The first accepted message may be
  annotation-only.
- Historical user-message edit/retry, conversation Fork, and Side Chat first
  Send.

## Product Logic Flow

1. The operator completes a non-empty selection in one eligible source. Rudder
   maps the rendered range to one canonical source anchor and rejects a range
   that crosses messages, transcript blocks, user/system messages, hidden
   content, raw tool output, stdout/stderr, an inline visual, or an iframe.
   Markdown rendering preserves raw-source position metadata through
   normalization, mention-label resolution, and visual-piece splitting; the
   selected snapshot preserves visible paragraph/list/line-break boundaries
   while offsets and hashes continue to address the persisted raw source.
   File selection actions are withheld while that file is saving, conflicted,
   truncated, binary, or otherwise not editable.
2. Rudder shows a portal-based selection toolbar positioned with flip/shift
   collision handling. `Add to chat` adds the annotation, immediately opens its
   anchored editor, and focuses the optional comment field without sending.
3. For a completed assistant anchor, `Ask in side chat` places the same
   annotation in a provisional Side Chat draft and leaves the main Chat draft
   unchanged. The action is unavailable for a stopped or failed source because
   those messages are not valid Side Chat anchors. Opening the draft creates no
   conversation; first Send follows `CHAT.SIDE.CHAT.001`. A file selection uses
   the current Chat's latest eligible completed assistant response as that Side
   Chat lifecycle anchor while preserving the file as annotation source.
4. Adding the same source surface and canonical range to the same draft is
   idempotent. New distinct annotations append in order and immediately render
   a non-interactive translucent highlight over the exact selected source text
   plus an accent marker beside the complete visual source line. The highlight
   does not change layout or intercept pointer input. A marker uses an available
   line-end or line-start gutter and must not cover selected or adjacent
   response text; same-line and narrow-surface collision handling keeps every
   marker within the visible surface and clear of body text. Deleting an item
   removes its highlight and renumbers the remaining markers.
5. The composer renders an `N annotations` chip. Expanding it shows an ordered
   list whose entries separate the selected source into a labeled
   `Selected excerpt` quote block and, when present, the operator-authored text
   into a labeled `Your comment` section. Annotation-owned files remain
   associated with their entry in a portal above the composer, without
   increasing composer height. Details
   appear only after explicit chip activation; creating or editing an
   annotation does not automatically reveal the complete list. Draft rows
   expose edit and delete actions. Collapsing the details keeps the draft
   unchanged. Activating the chip's explicit Clear/X control clears all
   annotations and their draft-only files but preserves the message body and
   unrelated composer attachments.
6. Marker or row-edit activation closes the complete-list surface and opens
   only that selected annotation in an anchored editor above the composer. In
   the main Chat draft, the exact source range remains highlighted, including
   after descendant scrolling and clipping, so the editor does not repeat the
   selected-text snapshot. A provisional Side Chat editor retains a compact
   selected-text snapshot because its source highlight is not rendered in that
   panel. The editor otherwise shows only the text comment input, an icon-only
   attachment action with an accessible name, image/file removal controls,
   Delete, Cancel, and Save. Cancel restores the prior draft item; Save commits
   the local draft changes without sending. Opening and closing the list and
   editor, and marker appearance, use directional non-essential motion; Save
   and Delete commit immediately while their visual surface completes its exit,
   and reduced-motion preference preserves the same state transitions without
   animation.
7. An existing Chat message may be sent with an empty body when it has at least
   one annotation. If both body and annotations are empty, normal validation
   rejects Send. A direct first-message Chat create still requires its normal
   non-empty first message because no eligible in-conversation source exists.
8. The client serializes a versioned draft by organization and conversation.
   It reads legacy string-only drafts as body-only drafts. Draft annotation
   metadata survives reload; pending local files follow the governed pending
   attachment lifecycle and never serialize file bytes into browser storage.
9. Before an annotation-bearing Send, Queue, Side Chat first Send, or
   historical-message edit, the client consults the latest observed
   development-runtime health. When that health reports that the development
   server requires restart, Rudder blocks the mutation before issuing its API
   request, preserves the complete draft, and surfaces one stable
   restart-required warning. A restart action may be offered only when the
   draft is durably recoverable; an in-memory-only Side Chat or edit draft
   instead tells the operator to copy unsaved text before restarting. A
   subsequently observed fresh runtime state dismisses the stale-runtime
   warning and allows the mutation.
10. On admission, the server validates organization and conversation access,
   the source message and Side Chat lineage, eligible surface and terminal
   status, source hash, range, surrounding context, generation sequence
   provenance, annotation limits, and every file reference. A source or file
   from another organization, conversation, user message, or annotation is
   rejected without revealing its content. Workspace-file annotations are
   reread through the organization-scoped Library boundary and must match the
   saved hash/range; protected Library paths are rejected. Desktop-local file
   snapshots require canonical absolute-path provenance and valid bounded
   metadata, but the server does not gain permission to read that local path.
11. Multipart input refers to newly uploaded annotation files by bounded request
    indexes. Queue uses private staged asset references, never client-supplied
    persisted staging ids. On message materialization Rudder creates
    organization- and message-scoped attachment rows, replaces temporary
    references with canonical attachment ids, and commits the message,
    attachment ownership, annotation payload, Queue/Steer linkage, and activity
    evidence atomically. Failed admission cleans up unowned staged uploads.
12. A successful send clears the matching draft only after server
    acknowledgement. A network, upload, runtime-admission, or server validation
    failure retains body, ordinary attachments, annotations, comments, and
    annotation files for correction or retry.
13. An annotated feedback turn opened from an Agent Run Side Panel uses the
    same runtime stream control as ordinary Chat. While the reply is active,
    the composer action becomes Stop; the client submits a control action fenced
    to the observed generation, attempt, control version, and rendered-body
    checkpoint. It stages events until the server accepts or rejects the
    cutoff, suppresses later visible bytes after acceptance, and polls the
    conversation until terminal state or an explicit indeterminate outcome.
    Refresh or target changes must not move the action to a newer generation or
    admit late output into the stopped body.
14. The assistant prompt receives annotations as an ordered, bounded
    user-authored quote section. Selected text is explicitly untrusted quoted
    context, not a system/developer instruction. Operator comments retain their
    user origin, and annotation attachment metadata preserves which files
    belong to which quote. Process text remains Run evidence under
    `RUN.RESULT.001`; prompt projection does not turn it into assistant final
    body.
15. After Send, the user message renders a read-only count chip above the
   message. Each card uses the same distinct `Selected excerpt` quote block and
   optional `Your comment` section as the draft list, and shows
   annotation-owned files without edit/delete controls or duplicate generic
   attachment tiles. Editing that historical user message creates a new turn
   variant carrying the annotation semantic snapshots unchanged while
   remapping attachment ids to the new user message; retry, queued delivery,
   and Steer reuse the same evidence.
16. Expanding historical annotations temporarily restores their numbered source
    markers. Selecting a card item reveals eligible collapsed Process details,
    scrolls to the source, and briefly highlights it. If the immutable snapshot
    remains readable but its source cannot be loaded or verified, the card says
    it cannot be located and does not fabricate a marker. Selecting a
    workspace- or local-file annotation opens or focuses its matching Side
    Panel file target before attempting source location.
17. Fork copies annotation snapshots with copied user messages, remaps source
    message ids to the child copies, and creates child-owned annotation
    attachment rows. Side Chat validates the owning completed assistant anchor
    and uses the exact selected snapshot in its preview and first user message.
    Work Manifest, automatic learning, and artifact discovery ignore annotation
    payloads.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Stable final-answer selection | One completed/stopped/failed assistant body; one valid range | Add one ordered annotation, exact-range highlight, source marker, and focused comment editor; expose Side Chat only for a completed owning assistant message | Select a user/system message, cross-message range, streaming content, or create a Side Chat from a stopped/failed anchor | UI, service, and E2E tests |
| Visible Process selection | Loaded visible assistant/thinking prose; terminal generation; one provenance range | Add one process annotation with generation sequence identity | Use transcript index/timestamp, hidden reasoning, tool payload, stdout/stderr, or lifecycle events | Provenance, service, UI, and E2E tests |
| Saved Side Panel file selection | Current Chat; saved eligible workspace or Desktop-local text file; one canonical range | Add one file annotation and open its comment editor; allow Side Chat through the current Chat's latest completed assistant lifecycle anchor | Annotate an unsaved/conflicted/truncated/binary file, protected Library path, foreign conversation, or grant the server arbitrary Desktop filesystem reads | Desktop bridge, service, UI, and E2E tests |
| Comment and files | Draft annotation is editable and uploads satisfy Chat file policy | Save optional comment and annotation-owned images/files from the picker or pasted clipboard images | Attach a foreign asset, duplicate the file as a generic message tile, replace ordinary pasted text, or log file contents | Multipart, ownership, UI, and E2E tests |
| Inspect or edit one draft | Operator adds an annotation, explicitly opens the count chip, or activates one marker/edit action | Open the new annotation editor directly, show the ordered list above the composer on request, or show only the activated annotation editor | Expand the complete list automatically, repeat selected text inside the editor, increase composer height, show unrelated annotations, or cover response text with a marker | UI and E2E tests |
| Annotation-only Send | Existing Chat; body empty; at least one valid annotation | Persist and run one normal user turn | Reject solely for empty body or create an empty first Chat | Shared, route, and E2E tests |
| Duplicate selection | Same source surface and canonical range already in draft | Keep one item and one marker | Add duplicate payloads or skip numbering | UI tests |
| Send failure | Upload, validation, admission, or network failure | Preserve the complete draft and surface the failure | Clear comments/files or leave unowned staged assets | Route, UI, and E2E tests |
| Queue or Steer | Active generation; valid annotated follow-up/control message | Preserve annotations/files through materialization and exactly one visible user message | Lose evidence, expose staged ids, or duplicate a Steer message | Queue/Steer service and E2E tests |
| Run annotation feedback Stop | Annotated feedback turn is streaming from an Agent Run Side Panel | Fence Stop to the observed generation/attempt/control checkpoint, freeze the accepted visible prefix, suppress late events, and wait for terminal readback | Stop a newer target, admit staged/late output after acceptance, or report terminal completion without evidence | Side Panel UI and Run Transcript Detail E2E tests |
| Historical edit/retry | Sent annotated user message | Carry immutable annotations and remapped attachments into the new turn variant/retry | Mutate the old snapshot or silently drop a file | Service, UI, and E2E tests |
| Fork | Copied range includes source and owning user message | Remap source-message and attachment ids to child-owned copies | Retain foreign mutable attachment ownership or claim copied Run/output ownership | Fork service and E2E tests |
| Side Chat | Exact selection belongs to the validated completed assistant anchor | Stage client-only; persist once on first Send with exact quote/files | Mutate the parent draft or create a Side Chat merely by selecting | Side Chat service, UI, and E2E tests |
| Historical source unavailable | Snapshot is valid but source is absent, collapsed evidence cannot load, or variant differs | Show immutable snapshot with cannot-locate state | Re-anchor to a different answer variant or invent source text | UI and E2E tests |

## Actor-Visible Input

- The toolbar uses the labels `Add to chat` and `Ask in side chat`.
- Desktop controls use the normal 32–36 CSS-pixel Rudder control rhythm. Coarse
  pointer controls have at least a 44 CSS-pixel target.
- Toolbar, marker, chip, list, and editor are keyboard operable. `Escape`
  dismisses the active surface, arrow keys move within the toolbar, and
  Enter/Space activates the focused command. Focus returns to the selection,
  marker, or composer that opened it.
- The editor accepts text comments plus the same governed image/file types and
  size limits as normal Chat attachments. Clipboard images can be pasted
  directly into the comment field without intercepting ordinary text paste.
  The attachment picker is presented as an icon-only action with an accessible
  label and tooltip. The editor shows pending/upload failure and removal state
  per file.
- Selection, toolbar, count changes, deletion, source-unavailable state, and
  upload failure have appropriate labels or polite live announcements. Reduced
  motion preserves the same state changes without movement-dependent meaning.

## Operator-Visible Output

- Draft source text shows a translucent exact-range highlight plus ordered
  accent markers beside, never over, response text. The composer shows one
  compact count chip and, only after explicit activation, a portaled
  ordered-details surface above the composer without changing composer height.
- Adding an annotation or activating its marker/row edit shows only that
  annotation's anchored editor. The source highlight provides the selected-text
  context, so the editor contains no duplicate quote; other draft details remain
  hidden until the operator explicitly requests them.
- Each detail shows Selected text, places the optional operator comment beneath
  it without a `User comment` label, and displays its own image/file attachments.
- Sent user messages retain the read-only chip and card after reload. Annotation
  attachments open through normal governed Chat image/file inspection.
- Source navigation expands Process evidence when required, scrolls to the
  matching source, and uses a brief non-essential highlight.
- Narrow Chat and an open Side Panel use collision-aware placement without
  clipping the toolbar/editor, covering response text, or covering the active
  composer action.

## Persisted Evidence

- No new annotation database table is created.
- `chat_messages.structuredPayload.inlineAnnotations` stores the normalized
  ordered annotation snapshots. Canonical attachment ids point only to
  `chat_attachments` owned by that same user message.
- Queue payloads preserve typed annotations plus private staged asset
  references until one message is materialized. Steer, retry, edit variants,
  and Fork preserve or remap that same typed evidence.
- Draft storage is a client-side versioned organization/conversation object;
  legacy body-only string drafts remain readable.
- Activity and diagnostic logs record only annotation count and source ids
  needed for audit. They never copy selected text, operator comments, visible
  Thinking, attachment contents, or temporary file paths.

## Limits

- At most 10 annotations per user message.
- At most 4,000 characters of selected text per annotation.
- At most 2,000 characters of operator comment per annotation.
- At most 16,000 characters across all selected text and comments in one user
  message.
- Prefix and suffix anchor context are each bounded to 160 characters.
- One annotation set references at most 10 total annotation-owned attachments,
  additionally subject to ordinary Chat file count, byte-size, and type policy.
- Server prompt projection and rendered previews remain independently bounded;
  truncation must not alter the persisted immutable snapshot.

## Canonical Scenarios

1. Explain two passages with supporting screenshots:
   - Trigger: select two final-answer ranges, choose Add to chat, comment on each,
     and attach one screenshot to each annotation.
   - Expected state/action: two numbered markers and one `2 annotations` chip;
     explicit chip activation opens the two-row list above the composer, while
     activating marker 2 opens only annotation 2. Annotation-only Send persists
     two quoted contexts and two message-owned image attachments.
   - Visible output: immutable sent card with each screenshot under its own
     quote, then source jump/highlight after reload.
   - Evidence: shared/service/UI tests and response-annotation E2E.
2. Ask about visible Thinking:
   - Trigger: expand completed Process details, select meaningful thinking prose,
     choose Add to chat, and enter a focused comment.
   - Expected state/action: provenance uses generation sequence, the exact
     Process range remains highlighted, and the comment editor opens directly
     without repeating the selected text.
   - Visible output: Process highlight and marker plus composer annotation
     preview; prompt labels the excerpt as a user quote rather than instructions.
   - Evidence: generation-provenance, prompt, UI, and E2E tests.
3. Queue then Steer:
   - Trigger: submit an annotated follow-up with a file during an active answer,
     then choose Steer.
   - Expected state/action: the server preserves one staged asset set and
     materializes exactly one visible annotated user message.
   - Visible output: Queue count remains inspectable until delivery; sent
     annotation survives reload without duplicate message/file tiles.
   - Evidence: Queue/Steer service and E2E tests.
4. Focused Side Chat:
   - Trigger: select an assistant passage, choose Ask in side chat, attach a
     document, and Send.
   - Expected state/action: parent draft remains unchanged; first Send creates
     one hidden Side Chat with exact quote, comment/file, and validated lineage.
   - Visible output: selected-answer preview and normal Side Chat response.
   - Evidence: Side Chat service and E2E tests.
5. Stop an annotated Agent Run feedback turn:
   - Trigger: annotate a terminal Run transcript, open the Run feedback Side
     Panel, Send, and Stop while the assistant reply is streaming.
   - Expected state/action: the Stop request carries the current generation
     fence and rendered-body checkpoint; the visible prefix freezes only after
     server acceptance, late events remain hidden, and the panel waits for
     terminal queue readback without changing the feedback target.
   - Visible output: the stopped/indeterminate state is explicit, and reload
     does not append the late reply to the stopped body.
   - Evidence: RunFeedbackChatPanel UI tests and Run Transcript Detail E2E.

## Invariants / Non-Goals

- Only an explicit operator selection creates an annotation. Rudder does not
  infer annotations from copied text or model output.
- Streaming/growing content is not eligible in V1. Stable
  completed/stopped/failed assistant content and terminal, loaded, visible
  Process prose are the only selectable sources.
- Hidden reasoning, tool request/response payloads, raw logs, stdout/stderr,
  lifecycle events, system/user messages, inline-visual iframes, and
  cross-message/block ranges are never valid sources.
- Canonical identity uses source hashes, offsets, bounded context, and generation
  event sequence where applicable. Transcript array indexes and timestamps are
  not identities.
- Sent annotations are immutable snapshots. A refreshed answer or later variant
  never silently re-anchors them, and a historical user-message edit cannot
  change or remove the original annotation set.
- Annotation files cannot be borrowed across organization, conversation,
  message, draft, or annotation boundaries. Public request payloads cannot
  claim server-owned staged asset ids.
- Selected text is user-quoted context, not trusted instructions. It cannot
  override system/developer policy merely because it came from assistant or
  Process output.
- Annotation payloads and files do not become Work Manifest items, automatic
  learning input, artifacts, or assistant final body merely by being attached
  to a user message.
- V1 has no collaborative annotation thread, reaction, reply, resolved state,
  server-side annotation search, automatic re-anchoring, or audio comment
  recording.

## Drift Boundaries

Changes to eligible sources, source identity, data limits, annotation file
ownership, draft/sent mutability, selection actions, Queue/Steer/edit/retry
durability, Side Chat/Fork mapping, prompt trust boundaries, source navigation,
logging redaction, or Manifest/learning/artifact exclusion require updating this
contract. Visual token tuning that preserves the documented interaction,
accessibility, and responsive outcomes does not.

## Traceability

Related contracts:

- `CHAT.LIFECYCLE.001`
- `CHAT.FORK.001`
- `CHAT.SIDE.CHAT.001`
- `CHAT.THREAD.MANIFEST.001`
- `RUN.RESULT.001`
- `RUN.CHAT.AGENT.001`
- `LEARNING.PROMOTION.001`

Related plan:

- `doc/plans/2026-07-23-chat-response-annotations.md`

Related code:

- `packages/shared/src/types/chat.ts`
- `packages/shared/src/validators/chat.ts`
- `packages/shared/src/chat-transcript-provenance.ts`
- `server/src/services/chat-inline-annotations.ts`
- `server/src/services/chat-assistant.annotations.ts`
- `server/src/services/chat-assistant.helpers.ts`
- `server/src/services/chat-generation-provenance.ts`
- `server/src/services/chat-generation-protocol.ts`
- `server/src/services/chats.annotation-persistence.ts`
- `server/src/services/chats.ts`
- `server/src/routes/chats.annotation-routes.ts`
- `server/src/routes/chats.ts`
- `server/src/routes/chats.stream-routes.ts`
- `server/src/services/side-chats.ts`
- `ui/src/api/chats.ts`
- `ui/src/components/chat/ResponseAnnotations.tsx`
- `ui/src/components/chat/SelectionAnnotationToolbar.tsx`
- `ui/src/components/MarkdownBody.tsx`
- `ui/src/components/transcript/RunTranscriptView.chat.tsx`
- `ui/src/components/side-panel/RunFeedbackChatPanel.tsx`
- `ui/src/lib/chat-draft-storage.ts`
- `ui/src/lib/chat-response-annotation-selection.ts`
- `ui/src/lib/chat-response-annotations.ts`
- `ui/src/pages/Chat.messages.tsx`
- `ui/src/pages/Chat.tsx`

Related tests:

- `packages/shared/src/chat-transcript-provenance.test.ts`
- `packages/shared/src/validators/chat.test.ts`
- `server/src/services/chat-inline-annotations.test.ts`
- `server/src/services/chat-assistant.annotations.test.ts`
- `server/src/services/chat-generation-protocol.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `server/src/__tests__/messenger-service.test.ts`
- `ui/src/components/chat/ResponseAnnotations.test.tsx`
- `ui/src/components/chat/SelectionAnnotationToolbar.test.tsx`
- `ui/src/components/MarkdownBody.test.tsx`
- `ui/src/components/transcript/RunTranscriptView.test.tsx`
- `ui/src/lib/chat-draft-storage.test.ts`
- `ui/src/lib/chat-response-annotation-selection.test.ts`
- `ui/src/lib/chat-response-annotations.test.ts`
- `ui/src/pages/Chat.messages.test.tsx`
- `ui/src/components/side-panel/RunFeedbackChatPanel.test.tsx`
- `tests/e2e/chat-response-annotations.spec.ts`
- `tests/e2e/run-transcript-detail.spec.ts`

Known gaps:

- None for the V1 contract.

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
- Response annotations copied with a user message remain immutable snapshots
  under `CHAT.RESPONSE.ANNOTATION.001`. The child receives remapped source
  message ids and child-owned annotation attachment rows rather than retaining
  mutable ownership in the source conversation. File annotations retain their
  normalized source path and immutable selected snapshot while their
  `sourceConversationId` is remapped to the child; copying the snapshot does not
  copy or claim ownership of the underlying file.

Flow:

1. The operator chooses `Fork` from a chat or `Fork from here` on a persisted
   assistant response.
2. Rudder serializes title allocation for the source family and creates a new
   active conversation in the same organization. Without an explicit title,
   the child receives the next available family-numbered title beginning at
   `(2)`.
3. Rudder copies context links and messages up to the requested fork point. If
   no source message is supplied, it copies through the latest eligible message.
4. For every copied response annotation, Rudder maps response-source message
   anchors to corresponding child messages, remaps file-source conversation
   identity to the child while preserving the source path and selection
   snapshot, copies annotation-owned files, and rewrites attachment ids to
   child-owned rows without assigning copied Run, Output, or filesystem
   ownership provenance.
5. Rudder writes a system message in the child conversation naming the fork
   source.
6. When the source is Feishu-bound, Rudder leaves the Feishu binding on the
   source conversation only. The fork has no provider source metadata or
   outbound Feishu binding.
7. Rudder ensures the fork-family Messenger custom group contains the root and
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
- Annotation-owned attachments are the other narrow exception because the
  copied immutable annotation would otherwise point outside the child. They
  receive child message attachment rows and remapped ids but do not become
  ordinary copied attachments, Outputs, or new Run evidence.
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
  the title-length boundary, plus annotation source-message and attachment-id
  remapping.
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
  optional completed assistant-message anchor, source context used for
  creation, and an owner-scoped client mutation id. The source answer remains
  internal context and is not repeated as a preview card at the top of the Side
  Chat. When opened from
  `CHAT.RESPONSE.ANNOTATION.001`, it also owns the exact selected annotation
  draft, comment, and pending annotation files while leaving the main Chat
  composer unchanged. It has no persisted conversation id before the first Send.
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
- Choose `Ask in side chat` on an eligible response selection.
- Choose `Side Chat` from the Side Panel empty/add-target surface.
- First Send posts the exact source assistant message, provisional mutation id,
  and selected Agent to `POST /api/chats/:sourceId/side-chats`, then carries the
  nullable Model / Thinking draft overrides on the normal Chat message stream
  route.
- Closing a persisted Side Chat posts to `DELETE /api/chats/:id/side-chat`.
- `Move to Messenger` in the Side Chat tab context menu posts to the
  compatibility endpoint `/api/chats/:id/side-chat/keep`.

### Product Logic Flow

1. All three entry points open the same provisional Side Panel workflow. The
   assistant-message action uses that exact message; `/side` and the empty
   Side Panel target resolve the latest completed assistant answer.
2. Opening the provisional target does not create a server record. The parent
   Chat stays mounted and its draft, transcript, scroll, and active generation
   remain untouched. The source answer remains available to anchor creation but
   is not rendered as a persistent preview above the Side Chat transcript.
3. On first Send, the server validates organization access, operator ownership,
   and a completed assistant-message anchor. When the provisional draft
   contains response annotations, their source conversation, owning assistant
   message, source anchors, and files must satisfy
   `CHAT.RESPONSE.ANNOTATION.001`; the exact quote is used in the preview and
   first user message. Creation is idempotent for the organization, owner, and
   client mutation id. The persisted title snapshots the direct source title
   with the `Side chat from: ` prefix and stays within the 200-character Chat
   title limit. The creation boundary validates and persists the provisional
   Agent. The following message admission validates and freezes Model and
   Thinking for that message without persisting them on the Side Chat. A replay
   with the same mutation id but a different Agent conflicts instead of silently
   rebinding the Side Chat.
4. The server copies source context links, messages, and message attachments
   through the anchor. Copied messages do not acquire new run, approval, turn,
   or output ownership. A boundary system event records the Side Chat source.
5. The user message and assistant response run through the normal Chat runtime
   and Agent Run evidence path. Once created, the Side Chat Agent is locked;
   its Agent menu remains inspectable and its Model / Thinking controls remain
   available for the next message. Each persisted send while `active` refreshes
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
| Provisional open | Valid normal Chat; completed assistant anchor available | Open one unsaved Side Panel target with an independent composer, inherited Agent identity at that Agent's defaults, and the normal Agent → Model / Thinking controls | Create a conversation before first Send, inherit source runtime overrides, change parent state, or duplicate the source answer above the Side Chat transcript | Side Chat UI and E2E entry screenshots |
| First Send | Owner and organization match; anchor is completed; selected Agent/runtime is valid; annotations, if any, resolve to that lineage; mutation id is new or an identical retry | Create exactly one hidden active Side Chat with the selected Agent/runtime binding, bounded direct-source title snapshot, exact quoted context/files, and ordinary Chat runtime flow | Duplicate records, rebind an idempotent replay, mutate the parent draft, copy messages after the anchor, expose the thread in Messenger, or run automatic title generation | Service, route, and E2E tests |
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
- The source answer is creation and annotation context, not a persistent visual
  header. Side Chat does not repeat a `From the main chat` source-answer preview
  card above its transcript.
- Apart from its expiry state, the Side Chat transcript and composer use the
  normal Chat visual and interaction grammar: normal user messages, assistant
  attribution, process transcript, streaming answer, editor, send affordance,
  and visible Agent and Skills controls.
- The Side Chat composer does not show a Project chip or project selector.
  Source project context remains inherited through copied context links at
  creation, without adding redundant project status to the focused composer.
- The Side Chat Agent chip opens the same parent Agent menu used by normal
  Chat. Before first Send, the operator may choose an organization Agent; only
  the current row exposes its Model / Thinking child control. After first Send,
  other Agent rows are visibly locked while the bound row's runtime control
  remains available for future turns, including while the current turn runs.
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

- Before first Send, the operator sees an independent provisional composer
  without a repeated source-answer preview card above it.
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
  The first user message owns any response-annotation snapshots and remapped
  annotation attachment rows.
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
- Merely selecting `Ask in side chat` never persists a conversation or uploads a
  client-claimable staged asset. Annotation text/comments/files remain
  provisional until first Send succeeds.
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
- `tests/e2e/chat-response-annotations.spec.ts`

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
current thread's inspectable Outputs, direct Subagents, Sources, and References
visible without requiring the operator to search the transcript. Work from other
conversations linked to the same Project is intentionally omitted from this
surface and remains available from Project-level surfaces. When the current
Chat has successfully created or converted to a primary issue, that issue is a
conversation Reference regardless of whether its creation receipt is a visible
message.

## Intent / User Job

An operator returning to a long or active Chat needs to answer four questions
quickly: what this thread produced, which direct subagents are still active or
done, what input it used, and which external sites the visible conversation
cited. The manifest is an index into work and provenance, not a second chat
transcript or a generic bookmark manager.

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
- Response annotation: message-owned quoted context under
  `CHAT.RESPONSE.ANNOTATION.001`. Its selected text, comment, source link, and
  annotation-owned files remain inspectable in the message but are excluded
  from Work manifest candidate extraction.
- Manifest item: category, target type/key, title, URL or internal locator,
  status, source role, message/Run/Agent/user provenance, Project id, metadata,
  and timestamps.
- Subagent summary: a transcript-derived, conversation-scoped projection keyed
  by subagent thread id. It carries the source message/Run, readable task name,
  prompt, avatar seed, model/reasoning metadata, normalized state/status, and
  start/update timestamps, but not the full nested transcript.
- Output: Agent-created ordinary Chat attachment or Run-backed assistant Library
  artifact under the guarded `artifacts/...` output namespace. A trusted
  same-message inline visual backing attachment under `CHAT.INLINE.VISUAL.001`
  is presentation state and is excluded.
- Source: user attachment, user-provided URL or Library reference, or a Project
  Context Resource eligible for a project-scoped Chat Run.
- Reference: deduplicated external HTTP(S) website or typed Rudder entity
  reference in a visible user or assistant message that is not promoted by the
  category precedence rules, plus the current conversation's same-organization
  primary issue after successful creation/conversion. Every safely resolvable
  Issue or Issue Comment reference uses its same-organization canonical Issue
  id, identifier, title, and current status; Issue Comments retain their
  canonical comment id and parent Issue identity. A normal Chat reference uses
  the referenced conversation's current title when that conversation can be
  resolved inside the same organization. An Automation reference with a
  UUID-like id uses the current Automation title only when it resolves inside
  the same organization. Side Chats are deliberately excluded because their
  titles are owner-private while manifest rows are conversation-scoped shared
  state. Unresolved, invalid, Side Chat, or cross-organization targets retain
  their visible message label, or the safe generic typed label when the message
  provides no usable label.

## Entry Points / Inputs

- `GET /api/chats/:id/work-manifest` for the selected Chat.
- User message bodies and user-created Chat attachments.
- Completed assistant message bodies, Run attribution, replying Agent identity,
  and Agent-created Chat attachments.
- Typed Rudder entity references in visible user and assistant message bodies,
  including `chat://` conversation targets.
- `library-entry://` and `library-file://` references in visible message bodies.
- The Chat's explicit Project context and that Project's attached resources.
- The Chat's `primaryIssueId` and its matching issue context-link metadata.
- Chat edit, refresh/variant, fork, attachment, and message supersession state.
- Response-annotation payload and attachment ownership, used only to exclude
  those private quote-supporting files from manifest classification.
- Accepted native assistant transcript-ledger entries through each generation's
  acceptance cutoff, plus legacy `structuredPayload.__chatTranscript` evidence
  when no accepted native transcript is available for that message.

## Product Logic Flow

1. The operator opens a Chat and Rudder requests its conversation manifest.
2. Rudder verifies Chat access through the same organization boundary as normal
   Chat reads.
3. Reconciliation reads active, non-superseded user and assistant messages and
   their attachments. Transcript entries, reasoning, tool results, stdout, and
   stderr remain excluded from Output/Source/Reference extraction. Direct
   subagent lifecycle evidence is the narrow exception: Rudder reads accepted
   native transcript-ledger events through the generation cutoff, or the
   compatible legacy transcript payload when native evidence is absent.
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
7. When the current Chat has a `primaryIssueId`, Rudder resolves that issue only
   inside the same organization and adds it as a Reference with target key
   `issue:<issue-id>`, readable identifier/title, and issue identity metadata.
   A matching issue context link may supply proposal provenance only when its
   `sourceMessageId` still belongs to the active visible message set. Pending,
   rejected, or revision-requested proposals have no primary issue and add
   nothing.
8. Before persistence, typed Issue and Issue Comment candidates are resolved in
   organization-scoped batches by id or identifier. Resolved rows use target
   keys built from the canonical Issue id (and canonical comment id for Issue
   Comments), a title of `<identifier> · <title>`, and current Issue status
   metadata. Issue Comment hydration additionally verifies that the active
   comment belongs to that Issue. Canonicalization deduplicates primary
   association and explicit message references to the same Issue. Missing,
   deleted, malformed, ambiguous, or cross-organization targets retain only
   their safe message-derived fallback and never disclose stored Issue data.
9. Before persistence, Chat reference candidates with UUID-like conversation
   ids are resolved in one organization-scoped lookup that excludes Side Chats.
   A same-organization normal conversation's current stored title replaces
   stale, empty, or generic link text. Missing, malformed, Side Chat, or
   cross-organization targets are not disclosed and keep the visible message
   label or generic `Chat` fallback. Reconciliation refreshes the persisted
   manifest title after a referenced normal Chat is renamed and overwrites any
   previously persisted Side Chat title with the safe message-derived label.
10. Before persistence, Automation reference candidates with UUID-like ids are
    resolved in one organization-scoped lookup. A resolved Automation's current
    title replaces stale, empty, or generic link text. Missing, malformed, or
    cross-organization targets keep the safe visible-message fallback and never
    disclose stored Automation data.
11. Rudder canonicalizes target keys, removes URL fragments/default ports,
   deduplicates candidates, and applies `output > source > reference` so one
   target appears once in its strongest supported category. The canonical
   primary-issue target key also deduplicates an explicit visible link to the
   same issue.
12. Reconciliation removes stale derived Sources/References from superseded or
   edited visible messages, but it does not silently delete a durable Output
   merely because the message that announced it was refreshed. A historical row
   now proven to be trusted inline visual presentation is removed because it
   was never production evidence. A primary-issue Reference is also removed
   when the association is cleared or the issue is deleted.
13. Rudder collects only direct subagents exposed by the current Chat's main
    assistant transcripts. It deduplicates observations by `threadId`: the
    earliest observation supplies identity and task metadata while the newest
    accepted snapshot supplies status, source message/Run, and update time.
    Running, in-progress, pending, queued, and started states are Active.
    Completed, failed, error, interrupted, cancelled, and stopped states are
    Done while retaining their terminal status. Unknown states follow whether
    the owning message/generation is still running. Nested subagents remain
    visible only inside their parent subagent detail.
14. The API returns the current Chat sections. Its existing `totalCount`
    continues to count only Outputs, Sources, and References; `subagents`
    provides separate Active, Done, and total counts. The response never embeds
    a complete subagent transcript. It may continue returning a
   Project id/count as compatibility metadata, but Chat does not render it or
   include it in the visible category count.
15. When at least one current-thread item or subagent exists, wide Chat renders the compact
    shelf. Its fixed top row renders the first non-empty category in
    `Outputs > Subagents > Sources > References` order as a normal category header, with
    the same icon, label, count, height, background, and typography used by
    every later category header. The fixed placement must not promote that
    category into a parent or a visually stronger panel title, and the label is
    not repeated above its rows. The shelf has no add/create action. A header
    icon animates the shelf between open and collapsed states; narrow Chat
    exposes the same data from a compact category/count trigger. When Subagents
    is the only section, the compact trigger reads `Subagents N`. The Subagents
    row shows at most four existing Agent avatars, preferring Active and then
    the most recently updated Done entries, plus `N active`, `M done`, or the
    combined count. A project-only
    or otherwise empty current-thread manifest renders no control or shelf.
    Opening an internal target reuses Side Panel behavior from
    `CHAT.SIDE.PANEL.001`. Wide and compact panels cap their expanded height at
    `32rem` (512 CSS pixels) on normal viewports, shrink to the available
    viewport allowance when necessary, and keep longer lists internally
    scrollable.
16. While any subagent remains Active, Chat refreshes the manifest every two
    seconds and invalidates it immediately when the owning generation changes or
    finishes. A thread moves from Active to Done without appearing twice.
    Selecting the Subagents summary opens the conversation-scoped Side Panel
    target from `CHAT.SIDE.PANEL.001`.
17. Opening an image attachment uses the application-level image preview shared
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
| Chat issue proposal is pending, rejected, or revision requested | Conversation has no successfully created primary issue | No issue Reference from the proposal | A proposed issue must not appear as if it already exists | Service tests and proposal-review E2E |
| Chat creates or converts to an issue | Current conversation has a same-organization `primaryIssueId` | One issue Reference with identifier/title and valid proposal provenance when available | The issue must not be labeled Output or duplicated by an explicit visible issue link | Service tests and proposal-review E2E |
| Message references an Issue or Issue Comment | Typed target resolves in the current organization; a comment also resolves to that parent Issue | One canonical Reference titled `<identifier> · <title>` with Issue type, current status, canonical Issue identity, and canonical comment identity when applicable | Stale link text, a foreign title/status, a deleted comment, or duplicate id/identifier aliases must not become trusted manifest identity | Service, component, and Chat Work Manifest E2E |
| Primary issue association becomes stale | Association is cleared, issue is deleted, or id does not resolve in the conversation organization | Derived primary-issue Reference is removed | A foreign, deleted, or detached issue must not remain in the current Chat manifest | Service tests |
| Message references another normal Chat | Visible `chat://` target resolves to a normal conversation in the same organization | The Reference uses the target conversation's current complete title and refreshes after rename; the compact row visually truncates it to one line while preserving the complete title for hover and accessibility | Stale link text must not replace the stored title, long text must not widen the shelf, and title lookup must not cross organization boundaries | Service, component, and Chat Work Manifest E2E |
| Chat reference cannot be resolved safely | Target id is malformed, missing, a Side Chat in any lifecycle state, or belongs to another organization | Keep the visible message label, or generic `Chat` when none is usable, plus normal typed target metadata; reconciliation repairs any previously hydrated Side Chat title | Rudder must not load or persist the private or cross-organization conversation title | Service tests |
| Message references an Automation | UUID-like Automation id resolves in the same organization | The Reference uses the Automation's current title | Missing, malformed, or cross-organization ids must not disclose a stored Automation title | Service tests and Chat Work Manifest E2E |
| Link appears in tool history only | URL exists only in transcript, reasoning, stdout, or stderr | No manifest item | Tool exploration must not pollute the visible manifest | Service tests |
| Chat transcript exposes direct subagents | Accepted, non-superseded assistant transcript evidence belongs to the current organization and Chat | One summary per thread, grouped under Active or Done, with the newest state and earliest identity | Full nested transcript, another Chat/Project/organization's subagent, or duplicate snapshots must not enter the response | Shared/service tests and Chat Work Manifest E2E |
| Subagent changes from running to terminal | A later accepted snapshot for the same thread becomes completed, failed, interrupted, cancelled, or stopped | The same row moves from Active to Done and preserves terminal styling | Active and Done must not contain duplicate copies of the thread | Shared/service tests and Chat Work Manifest E2E |
| Link or file supports an annotation | URL exists only inside selected text/comment, or attachment id is owned by a response annotation | No manifest item | Quoted context or its supporting file must not become a Source, Reference, or Output | Annotation/manifest regression tests |
| Answer is refreshed or edited | Prior message becomes superseded | Stale derived References disappear; durable Outputs remain inspectable | Refresh must not erase a real artifact | Service tests |
| Chat is forked | Copied historical assistant rows have no producing Run id | Sources can be re-derived; copied rows do not gain Output ownership | Fork must not claim the source thread's Outputs as newly produced | Fork/service tests |
| Chat has a linked Project | Other Project conversations contain manifest rows | Current rows stay unchanged; other-conversation rows are omitted from Chat | Project membership must not import other conversations into the current Chat manifest | API and E2E |
| Long manifest is expanded | Current-thread rows exceed the compact panel allowance | Panel stops growing at `32rem` (512 CSS pixels) on normal viewports, uses the smaller viewport allowance on short screens, and scrolls internally | The panel must not grow to near-full-screen height or overlap the composer | Component and Chat Work Manifest E2E |
| No current-thread items exist | Reconciliation returns no current-thread candidates, even if compatibility metadata reports Project items | No manifest control or empty shelf is rendered | UI must not reserve space or invent Create Site/Browser capability | Component/E2E tests |
| Manifest request fails | Current manifest state cannot be confirmed | Show a compact, category-neutral files-and-links error state instead of treating the result as empty | Operators must be able to distinguish retrieval failure from confirmed absence | Component/E2E tests |
| Operator opens an image attachment | Attachment has an image content type, or a known image extension when content type is absent | Open the shared image preview with close, copy, and download actions | The attachment must not be routed into the built-in Browser or leave the operator without an exit | Image preview component tests and Chat Work Manifest E2E |

## Actor-Visible Input

The operator sees the selected Chat, its normal transcript/composer, and a
category-led work shelf containing only the current thread's Outputs, direct
Subagents, Sources, and References. Each row exposes a readable title and type
icon. Normal Chat Reference rows expose the current same-organization
conversation title; the complete title remains the row's text, hover title,
and accessible name while compact layout applies a one-line ellipsis. Website
rows expose the normalized URL and website icon instead of a generic link icon
or redundant `From Agent` origin label. A safely resolved Issue or Issue Comment
appears in References with the parent Issue identifier/title, an explicit Issue
type icon, and a simultaneous current-status affordance with an accessible
status description.

## Operator-Visible Output

- Wide desktop: a compact top-right shelf whose first non-empty category header
  stays fixed above bounded rows, plus a header icon that collapses or restores
  the shelf with a short transition. Expanded height is capped at `32rem` (512
  CSS pixels) on normal viewports; short viewports use the smaller available
  allowance and long lists scroll inside the shelf.
- Category hierarchy: Outputs, Subagents, Sources, and References are peer
  sections in that order. Every
  visible category uses the same icon/label/count header treatment; fixed
  placement for the first section must not imply a higher level.
- Actions: the shelf provides open and source-message navigation, but no add or
  create icon.
- Subagents: up to four existing Agent avatars plus Active/Done counts open a
  conversation-scoped list. Empty subagent projections reserve no section.
- Normal Chat References: use the current same-organization conversation
  title, keep the complete title accessible, and constrain long visible labels
  to a one-line ellipsis without widening the compact shelf. Side Chat titles
  are never hydrated into this shared projection.
- Automation References: use the current title only after same-organization
  resolution; otherwise retain the safe message-derived fallback.
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
- Issue and Issue Comment References: the existing issue Side Panel target
  under `CHAT.SIDE.PANEL.001`, without replacing the current Chat route; Comment
  references keep their canonical comment target.
- Provenance action: jump to the source message when a message id exists.
- Side Panel open: the compact shelf yields to the workbench and returns when
  the panel is hidden.

## Persisted Evidence

`chat_work_manifest_items` stores organization/conversation/Project scope,
category, target identity, title/URL, status, source role, message id, Run id,
Agent/user provenance, metadata, and timestamps. Chat messages, attachments,
context links, and Project resource attachments remain the source evidence used
to reconcile the projection. `chat_conversations.primary_issue_id` is the
authoritative current-thread association for the created issue; the matching
issue context link is optional provenance, not authority.

Subagents are not stored in `chat_work_manifest_items`. They are a bounded
read-time projection from accepted `chat_generation_events` transcript evidence
and compatible legacy message payloads. The complete child transcript remains
behind the existing message-transcript API and is loaded only when the operator
opens a detail row.

For normal Chat References, reconciliation persists the latest safely resolved
full title; visual truncation does not shorten the stored value. Side Chat
titles are not persisted into manifest rows. Issue and Issue Comment rows are
also reconciled on every manifest read so historical generic rows and cached
title/status metadata are lazily replaced with the latest safely resolved
canonical values. Automation references likewise persist the current title only
after same-organization resolution.

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
5. Approved Chat issue proposal:
   - Trigger: manual approval, auto-create, or direct Chat-to-Issue conversion
     sets the conversation's primary issue.
   - Expected state/action: one issue Reference appears using
     `issue:<issue-id>` and any valid visible proposal provenance; an explicit
     link to the same issue is deduplicated.
   - Visible output: identifier, title, and current status icon in References;
     opening it uses the current Chat's issue Side Panel and closing the panel
     restores the shelf.
   - Evidence: conversation primary issue id, issue context link, manifest row,
     service tests, and proposal-review E2E.
6. Long renamed normal Chat reference:
   - Trigger: a visible message references a same-organization normal Chat,
     then that target conversation receives a newer long title.
   - Expected state/action: reconciliation replaces stale link text and the
     previous manifest title with the current conversation title.
   - Visible output: the row remains one compact ellipsized line while hover and
     accessibility expose the complete title; opening the row targets the same
     Chat.
   - Evidence: manifest service, component, and real Chat Work Manifest E2E.
7. Automation reference without a message label:
   - Trigger: a visible message contains an `automation://` reference with a
     same-organization Automation id and no usable label.
   - Expected state/action: reconciliation resolves the Automation in the Chat
     organization and replaces the generic fallback with its current title.
   - Visible output: one Automation Reference with the current title.
   - Evidence: manifest service and Chat Work Manifest E2E.

## Invariants / Non-Goals

- Organization access is enforced before reconciliation or listing.
- Chat Reference title lookup is organization-scoped and excludes Side Chats in
  every lifecycle state under `CHAT.SIDE.CHAT.001`; an unresolved, malformed,
  private, or cross-organization target must not disclose or persist the target
  conversation's stored title.
- Project membership does not import work from other conversations into the
  current Chat manifest.
- Only the current conversation's same-organization primary issue may be
  projected from durable Chat association state; Project peers and other Chats'
  issues are excluded. Visible typed references may point to any safely
  resolvable Issue or Issue Comment in the same organization.
- Issue and Issue Comment hydration is organization-scoped. Missing, deleted,
  invalid, ambiguous, or cross-organization targets keep safe generic/message
  fallbacks and never disclose canonical title or status.
- Automation title hydration is organization-scoped. Missing, malformed, or
  cross-organization targets keep the safe message-derived fallback and never
  disclose the stored Automation title.
- A primary issue is a Reference, never an Output, and unresolved proposals do
  not create an issue row.
- One target appears once per conversation under its strongest supported
  category.
- Outputs require structured production evidence and persist across answer
  refreshes unless explicitly hidden/archived by a future governed flow.
- Manifest References are not automatically attached to Project Context.
- Response annotations and their files are message evidence, not Work manifest
  Sources, References, or Outputs. They are also excluded from automatic
  learning and artifact discovery under `CHAT.RESPONSE.ANNOTATION.001`.
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
responsive visibility, internal-reference label resolution, accessible
truncation, or item-open behavior changes. Parser implementation, row-limit
constants, icon choices, compatibility metadata, and query batching may change
without a contract edit when the visible semantics and invariants remain
intact.

## Traceability

Related plans:

- `doc/plans/2026-07-12-chat-work-manifest.md`
- `doc/plans/2026-07-23-chat-created-issue-work-manifest.md`

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
- `tests/e2e/chat-response-annotations.spec.ts`
- `tests/e2e/chat-proposal-review.spec.ts`

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
- Agent Run annotation opens a normal Messenger-visible Chat target in the
  Side Panel, keyed as `agent-runs:<agent-id>`. It preserves one draft across
  Agent Detail Run navigation, keeps the current Agent fixed, and opens with
  staged Run annotations already attached. On desktop opening it releases the
  Agent Sidebar while retaining the compact Run rail; on mobile it uses the
  full-screen Chat overlay. Project selection is available only before the
  first accepted message and then remains locked.
- Supported internal references can open or focus tabs in the Side Panel without
  replacing the current route on ordinary clicks. Modifier-click and unsupported
  links preserve normal navigation behavior.
- The `side_chat_started` boundary event is an explicit exception: its source
  Chat title is return navigation, so an ordinary click replaces the current
  route with the source Chat's main Messenger route instead of opening a Chat
  target in the Side Panel.
- Chat Work manifest internal targets use the same typed Side Panel target model;
  the manifest is an index and does not create a second preview drawer.
- Chat Work manifest exposes a conversation-scoped `Subagents` target keyed by
  `subagents:<conversation-id>`. Its read-only body groups direct subagents into
  `Active · N` and `Done · N`, shows explicit empty states for either group,
  preserves failure/interruption status, and keeps long task names accessible
  while visually truncating them.
- Selecting a Subagents row lazily loads that row's source message transcript,
  resolves the matching `threadId`, and opens or focuses the existing read-only
  subagent detail without closing the aggregate list tab. Individual subagent
  targets canonicalize to `subagent:<thread-id>` inside the current conversation
  context so refreshed state and repeated clicks cannot create duplicate tabs.
  A detail-load failure leaves the aggregate list open and exposes an error.
- Chat and Work manifest image attachments are intentionally not Side Panel
  Browser targets. They use the shared image preview overlay so image inspection
  has one consistent toolbar and exit path across Chat surfaces.
- Side Panel targets are typed objects: issue, Chat Issue Proposal, automation,
  Library file, Library directory, structured transcript local file, chat,
  browser tab, Desktop Agent-workspace Terminal, and explicit placeholders for target classes that need a
  link/search before loading a concrete object.
- Rudder Desktop exposes `Terminal` in `Open a panel` for a Messenger Chat.
  Each Terminal tab binds its opaque renderer session identity to the Chat's
  selected Agent and organization. The renderer never supplies a cwd: Desktop
  resolves the Agent's immutable workspace key and validates the canonical
  `$AGENT_HOME` directory before starting the user's login shell. A missing or
  cross-organization Agent, missing workspace, or PTY failure stays visible as
  an actionable error and never falls back to a Project or arbitrary directory.
- Terminal tabs are session-only and are excluded from Saved Views, Messenger
  promotion, and restart restoration. Hiding the panel, switching tabs, or
  resizing keeps the PTY alive and synchronizes its dimensions. Explicit tab
  close terminates the owned shell process tree; Desktop shutdown closes all
  remaining sessions. Web does not expose the Terminal picker entry.
- A Chat Issue Proposal target is a temporary, message-scoped review tab. It is
  not a Saved View and has no independent full-page route. Its identity is the
  source conversation plus proposal message, and its content remains owned by
  that live Chat message.
- While a Chat Issue Proposal tab exists, the transcript replaces the complete
  inline proposal card with a compact `Issue proposal` launcher. Hiding the
  panel preserves the tab and launcher; the launcher reopens the same tab.
  Explicitly closing the tab restores the complete inline proposal card.
- The Issue Proposal tab presents full proposal details and the existing review
  controls at the docked panel width. Its fields, decision note, pending state,
  and actions stay synchronized with the owning Chat review state rather than
  becoming a detached snapshot.
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
- In Rudder Desktop, the new-tab keyboard shortcut (`Command+T` on macOS,
  `Ctrl+T` on Windows and Linux) invokes that same add-tab behavior whenever
  the Main Workbench Browser does not own the shortcut. If the Side Panel is
  hidden, Rudder opens it directly into `Open a panel`; if it is visible,
  Rudder preserves its tabs and activates the picker. Repeated shortcuts while
  the picker is active do not create placeholder or duplicate tabs.
- A focused Main Workbench Browser keeps priority for its existing new-Browser-
  tab shortcut. Browser and Local App guests hosted in Side, and ordinary main
  renderer surfaces outside that focused Main Browser, route the shortcut back
  to the Side Panel controller instead of creating a guest-local tab.
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
  Library directory, and Desktop Local App targets can be moved into Messenger.
  The action freezes the active target's exact `viewInstanceId`, persists its
  Saved View placement, and transfers that same working instance into the
  Messenger Main Workbench. It is not a copy or a route-only reopen.
- A successful move detaches only the exact source tab after the Main Workbench
  has claimed its live surface. Sibling Side Panel tabs keep their order and
  runtime state; the right neighbor becomes active when present, otherwise the
  left neighbor. The Side Panel closes only when the moved tab was its final
  tab.
- Moving from a stable Chat or Issue defaults to atomically creating or reusing
  that work item's custom group and placing both the host row and Saved View
  there. The placement selector also offers `Messenger sidebar`; global Side
  Panel targets may use that loose placement or an operator-selected group.

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
6. For a Chat Issue Proposal target, the transcript swaps its complete inline
   card for the compact launcher as the tab is registered. The panel renders
   the complete proposal details and current review actions. Hiding the panel
   retains this registered state; closing the tab removes it and restores the
   complete inline card.
7. If an issue target is expanded to the wide Side Panel state, Rudder swaps the
   compact issue workbench for the embedded Issue Detail body so the operator
   can use the same issue content sections without leaving the current route.
   The same panel host continues expanding from right to left; it does not jump
   to the workspace left edge and then grow toward the right.
8. When the operator clicks the add-tab affordance while a target is already
   open, Rudder keeps existing tabs available but sets the active panel content
   to the empty `Open a panel` picker instead of showing a dropdown menu.
   The Desktop new-tab shortcut follows this same flow, first opening a hidden
   Side Panel when necessary. Repeating it while the picker is active remains
   idempotent and does not create a tab until the operator chooses a target.
9. Lightweight mutations exposed in the panel, such as issue title,
   description, status, priority, assignee, reviewer, project, goal, parent, or
   automation status edits, call the same domain APIs and show errors in the
   panel instead of silently ignoring failures.
10. On desktop pointer surfaces, dragging a tab label onto the left or right half
   of another tab moves it before or after that tab. Reordering changes only the
   current Side Panel context's in-memory tab order and preserves the active tab.
11. Closing a tab focuses a neighboring tab. Closing the final tab removes it and
    closes the Side Panel instead of leaving an empty picker open.
12. Pressing the close-tab keyboard shortcut while an active Side Panel tab is
   present follows the same close behavior as the tab's close button and
   prevents the host window from handling that shortcut.
13. When the operator hides the panel and reopens it in the same Messenger chat
   or issue context, Rudder restores that context's tabs and active tab.
14. When the operator switches from one Messenger item to another, Rudder
   switches the Side Panel to the destination item's session state. If that
   destination has no session state, the panel stays or becomes closed by
   default.
15. App restart may clear all Side Panel tab/session state; this contract does
   not require server persistence, cross-device sync, or localStorage recovery
   for tabs.
16. Browser tabs normalize address-bar input into a web URL, an explicit
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
17. When a main-frame Browser navigation fails for a reason other than an
    intentional abort, Rudder keeps the attempted URL visible and renders the
    Browser failure state over the existing guest. `Details` reveals the failed
    URL. `Reload` retries that same guest and keeps the failure state visible
    until a new load actually starts; subframe failures do not replace the
    main-frame view. Missing local files follow this same path, expose the
    Chromium file error, and preserve the current Rudder route.
18. Desktop routes ordinary external HTTP(S) links to a Browser Side Panel tab
    when its instance preference is `built_in`, independently of Agent Browser
    access. The `default_browser` preference and explicit `Open externally`
    action use the operating-system browser instead.
19. From a Library file tab, `Open in Library` navigates to the full Library
    work surface with the same organization-scoped file selected.
20. A recognized Library audio/video tab delegates playback, file switching,
    and codec recovery to the shared media renderer. Native seek requests use
    the organization-scoped byte-range content path without changing the
    Messenger route or Side Panel tab identity.
21. Markdown autosave supplies the last confirmed content as a write
    precondition. When the server reports a conflict, the panel pauses autosave,
    keeps the draft visible, and offers `Keep mine` or `Use latest`; an older
    in-flight response must not override the operator's conflict decision.
22. When the operator moves an eligible active target to Messenger, Rudder
    freezes its exact source context, `viewInstanceId`, and revision; performs
    the idempotent placement-aware keep mutation under
    `MESSENGER.SAVED.VIEWS.001`; stages the Main tab; navigates to
    `/messenger/saved/:id`; and waits for the Main anchor to claim the same live
    surface before detaching the source tab.
23. A server failure leaves the source tab and Messenger directory unchanged.
    An uncertain response keeps the source and retries with the same mutation
    identity. If the server committed but the Main host claim fails, the Saved
    View and source tab both remain with a retry action; Rudder must not delete
    the durable row or create a replacement runtime.
24. Selecting a structured transcript file action opens or focuses a local-file
    tab keyed by its resolved absolute path. Desktop canonicalizes and validates
    the target through its preview bridge before returning bounded text or binary
    preview data; unsupported, missing, oversized, or Web-only targets fail in
    the panel without changing the current Chat route.

Invariants:

- The Side Panel must not infer cross-organization access from a link string; all
  target loads and mutations remain enforced by existing organization-scoped
  APIs.
- A Chat Issue Proposal target must remain scoped to its owning conversation
  and message. It must not be promoted to a Saved View, exposed as a full-page
  target, carried into another Messenger item, or resolved from another
  organization's message.
- Hiding the Side Panel while a proposal tab exists and closing that tab must
  remain separate actions. Hiding keeps the temporary target and compact
  transcript launcher; closing removes the target and restores the complete
  inline card. Closing the final proposal tab follows the normal final-tab
  panel closure rule.
- Proposal review in the Side Panel must use the live state of its owning Chat
  message. Field edits, decision-note changes, pending actions, and review
  callbacks must not become stale because the panel target was opened earlier.
  A revised proposal is a new message-scoped review object with its own target;
  it does not replace the proposal owned by an already open tab.
- Proposal-panel entry, compact-card replacement, tab content, and inline-card
  restoration must use the shared Side Panel and Chat motion tokens. Reduced
  motion may move directly to the same final states.
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
- Side Panel editing for eligible Markdown, plain-text, and code/source files
  must preserve `LIBRARY.FILES.001` conditional-write semantics. HTML and CSV
  remain preview-first and become editable only in Source mode. External updates
  visible to the guarded comparison, failed responses, and overlapping
  in-process saves must not silently discard or overwrite a dirty draft.
- Desktop local-file editing uses a separate trusted-renderer-only conditional
  write bridge. It accepts only the canonical regular UTF-8 text file already
  admitted by the bounded preview contract, rejects aliases, binaries,
  truncation-sized content, stale expected content, and NUL-bearing writes, and
  never turns the server Library API into an arbitrary filesystem writer.
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
- Side and Main Workbench share at most eight live operator Browser guests per
  organization. A live transfer does not increase that count and must still
  succeed at capacity. New, popup, and cold-open requests at capacity fail
  visibly without silently reusing or evicting an unrelated exact tab. Desktop
  also accepts at most eight Browser popup requests in a rolling ten-second
  window.
- Browser profile data is shared across organizations in one local instance,
  but Side Panel tab/session state continues to follow this contract's active
  work-item rules. Disabling Agent Browser access preserves operator Browser
  targets; clearing Browser data closes those targets without deleting unrelated
  Side Panel tabs.
- On desktop and web shells, the Side Panel docks directly against the main
  workspace with only a narrow resize affordance between them. It must not leave
  a broad blank gutter that visually separates the panel from the current work
  surface.
- A visible Browser runtime surface must clip its toolbar and page content to
  all four shared workspace-radius corners in both docked and expanded Side
  Panel states. The Browser must not expose square toolbar or page corners
  against the surrounding desktop shell, and resizing or transferring the
  exact guest must preserve that boundary without remounting it.
- Desktop Side Panel geometry must preserve a fixed right edge while opening,
  expanding, restoring, or closing. Its left edge, the divider, and the current
  work-surface width must move monotonically in the requested direction. The
  main work surface must remain visually present until the expanded panel has
  covered or displaced it. Once expanded, the main work surface remains mounted
  to preserve the current route and render identity, while the stable panel host
  preserves Browser guest identity. The main work surface is inert,
  accessibility-hidden, fully visually hidden, and contributes no painted
  border or layout remnant beside the panel. Restoring or closing the Side Panel
  makes the main work surface visible and interactive again. Reduced-motion mode
  may move directly to the same final geometry.
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
- Side Panel shortcut routing must be independent of editable-field focus and
  must work from the main renderer, Side Browser guests, and Side Local App
  guests. It must not override a focused Main Workbench Browser's new-tab
  priority or create more than one empty-picker state.
- The panel should not show a generic full-page footer as the primary action for
  every target. Full-page navigation may remain a secondary object toolbar
  action, but the panel's job is adjacent work.
- Saved View persistence alone does not authorize runtime disposal. Promotion
  detaches the exact source tab only after the Main host owns the same runtime;
  failure before that boundary keeps the source intact. Removing a Saved View
  later unbinds durable placement without closing its open Main tab. Saved View
  lifecycle and directory placement remain owned by
  `MESSENGER.SAVED.VIEWS.001`.
- Removing a Saved View from Messenger requires an explicit confirmation that
  names the Saved View, explains that durable placement is deleted while an
  open Main tab remains, and sends no request on cancel, close, or Escape.

Evidence:

- Side-panel target tests cover parsing supported route/mention targets, stable
  keys, labels, and full-page href generation.
- Side-panel target tests cover stable Issue Proposal keys and its intentional
  absence of Saved View and full-page navigation support. Proposal-review E2E
  covers full-card to compact-launcher replacement, dedicated tab rendering,
  hide/reopen, final-tab close restoration, complete details, and review feedback
  submitted from the panel.
- Layout tests cover shared shell behavior and panel framing decisions.
- Chat attachment/side-panel tests cover tab behavior, empty state, add-tab
  actions that return to the empty picker without opening a dropdown menu,
  desktop tab reordering, hover/focus close-affordance visibility,
  directly editable issue title/description fields, rendered/editable issue
  assignee metadata, issue and automation compact views, Library previews,
  close-tab keyboard shortcuts, final-tab panel closure, and browser placeholder
  behavior.
- Desktop shortcut, preload, Side Panel context, E2E, and packaged smoke
  coverage prove macOS and Windows/Linux new-tab mappings, focused Main Browser
  priority, hidden/visible Side Panel entry, repeated-shortcut idempotency, and
  main-renderer, Browser-guest, Local-App-guest, and editable-field focus paths.
- Promotion reducer, component, E2E, and packaged Desktop smoke cover exact-tab
  transfer, sibling preservation, neighboring selection, delayed source detach,
  Browser/Local App guest continuity, and claim-failure recovery.
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
6. Messenger merges grouped and loose Saved Views into the directory without
   sending them through read-marker or attention aggregation.
7. Failed-run origin hydration starts from a redacted allowlist and restores
   source entity IDs and navigation only after the source row is verified in
   the current organization.

Invariants:

- Messenger must cite or route to owning domain contracts; it must not redefine
  issue, approval, run, or automation state.
- Unread/attention counts must be organization-scoped and user-scoped.
- When a local installation changes from the legacy `local-board` principal to
  an account UUID, its acknowledged read progress must be reconciled under
  `ORG.LOCAL.ACCOUNT.UPGRADE.001`; identity upgrade must not turn historical
  acknowledged work into fresh unread attention.
- Seeded onboarding issue threads must remain read for the seeded operator
  until later issue activity occurs after the seed read marker.
- A Saved View must not have unread state, unread count, attention state,
  mark-read or mark-unread actions, or a fabricated latest-message/activity
  timestamp. Saving, opening, moving, restoring, regrouping, or deleting it must
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
  synthetic attention, and durable Saved View rows together without changing
  the owning domain's lifecycle.
- Group membership must not make a thread feel like a second-class item. A
  grouped row is still the same Messenger item for navigation, unread state,
  pin ordering, and attention semantics.
- Operators must be able to remove one grouped Chat, Issue, or Saved View
  without dismantling the group or changing any sibling member.

Product model:

- The default `Latest activity` directory uses the Arc-style custom-group
  layout. Custom groups, loose thread rows, and loose Saved Views share one
  directory; thread activity and device-level manual placement are kept without
  inventing activity timestamps for Saved Views. The UI does not expose a
  separate custom-groups mode.
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
- Each custom group's actions menu exposes `New chat`. Selecting it opens the
  normal unpersisted Chat draft with that group as pending context; it does not
  create an empty Chat or mutate group membership. The first accepted message
  appends the new Chat as `chat:<id>` to the selected operator-scoped group in
  the same transaction as Chat creation. A missing, deleted, or foreign group
  is treated as loose placement rather than a Chat-creation failure.
- A visible Saved View may be loose in the Messenger directory or belong to
  exactly one custom group. Messenger has no fixed `Saved` section. Saving from
  a Chat or Issue keeps the existing automatic host-group default; a global or
  Main-session save lets the operator choose either `Messenger sidebar` for
  loose placement or an existing group.
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
   drags an item between groups. Saved Views use the same pointer and keyboard
   sortable model as Chat and Issue rows. Dropping a Saved View on an ungrouped
   Chat or Issue atomically creates or reuses the host group and adds both
   items. Onboarding seed may also create the `Getting Started` group for
   starter work.
3. Rudder writes the operator-scoped membership using the item's stable
   Messenger directory key.
   Selecting `New chat` from a group instead keeps the group ID in the
   unpersisted Chat draft. On first-message acknowledgement, Rudder writes the
   conversation and its `chat:<id>` membership together. If group deletion
   wins the placement lock before that acknowledgement, the conversation is
   created as a loose row.
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
10. Saved View group order and Main Workbench tab order are independent.
    Reordering or moving a Messenger row does not move, close, focus, or
    reassign the corresponding Main tab or live runtime.
11. Every grouped Chat, Issue, and Saved View row exposes `Move out of group`
    from its `Move to group` menu. The action removes only that selected
    member's operator-scoped membership, returns it to the loose directory,
    and leaves the group plus all sibling members intact. It does not delete or
    mutate the owning Chat, Issue, or Saved View. A loose member can then be
    reordered, moved into an existing group, or merged with another eligible
    loose Chat or Issue through the same pointer and keyboard placement model.

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
- Removing a thread-backed item or Saved View from a group returns it to the
  loose Messenger directory. Thread-backed items retain existing read/unread
  and attention state; Saved Views retain their non-thread identity.
- `Move out of group` is a per-member operation for grouped Chat, Issue, and
  Saved View rows. It must not delete the custom group, remove sibling
  memberships, or delete the selected owning-domain object.
- A mixed group may contain both thread-backed members and Saved Views. Saved
  View rows preserve their Saved View route, target kind, title, and manual
  order, but must not inherit unread badges, attention state, mark-read actions,
  or latest-message ordering from neighboring threads.
- A Saved View may be dropped into a loose directory position, between groups,
  into an existing group, or on an eligible ungrouped Chat or Issue. Loose
  placement removes membership without deleting the Saved View; the Chat/Issue
  drop uses the atomic create/reuse-group path. An invalid target rebounds
  without losing placement or creating an orphan Saved View.
- Loose Saved Views participate in the existing device-level manual directory
  order and pointer/keyboard drag model, but they do not gain a pin/unpin
  lifecycle. Group separation releases Saved View members to that loose order.
- Deleting a Saved View removes its membership but must not delete or close the
  owning automation, Library object, Browser guest, Local App process, or active
  Main Workbench tab.
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
- Local account claim and already-claimed repair must preserve custom groups,
  membership, group pin state, and supported device-local ordering under
  `ORG.LOCAL.ACCOUNT.UPGRADE.001`. Repeating recovery must not duplicate groups
  or overwrite newer account-era ordering.

Evidence:

- Messenger service tests cover thread-key membership, non-chat hydration,
  dormant synthetic membership, and fork-family group reuse.
- Messenger sidebar tests cover non-chat row group actions, grouped rendering,
  stale/newer unread handling, grouped split issue read acknowledgement,
  drag/drop auto-title requests, group title regeneration actions, and
  title-generation motion states. They also cover atomic Project placement,
  non-sortable Project groups, persisted collapse state, and group-local
  progressive disclosure, plus loose and grouped Saved View pagination,
  pointer/keyboard movement, loose ordering, cross-group ordering, group
  separation, atomic Chat/Issue grouping, and invalid-drop rollback.
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

Messenger Saved Views durably place exact Browser, Automation, Library, and
Desktop Local App working instances as loose Messenger rows or inside custom
groups without turning them into message threads. A Saved View row opens or
focuses its instance in the Messenger Main Workbench. Moving a live Side Panel
target transfers that same instance into Main; it does not reopen a copy in
Side. A Local App Saved View can also be pinned to the Primary Rail as an
independent navigation shortcut.

### Intent / User Job

- An operator can move one useful Side Panel tab into Messenger, keep working
  with it in Main, organize its durable entry next to the related Chat or Issue,
  and return later without receiving false unread or attention signals.
- Main can hold multiple mixed Browser, Automation, Library, and Local App tabs,
  including session-only tabs that have not been kept in Messenger.
- An operator can pin a Local App directly from its working surface without
  first understanding or performing a separate Keep step.

### Why / Design Reasoning

- Operators need a durable way to return to useful Side Panel workbench targets
  after the session-scoped tab state ends.
- Reusing message-thread semantics would create false unread, attention, and
  recency signals for objects that have no message stream.
- A durable row, a current Main tab, and a physical runtime have related but
  distinct lifecycles. Removing the row must not close the tab, and closing the
  tab must not delete the row.
- Exact `viewInstanceId` identity, not URL, path, label, canonical resource, or
  Saved View id, controls live-instance deduplication. Two independent tabs may
  show the same resource and remain independently saveable.
- Live continuity is exact while the runtime exists. Cold recovery after close,
  crash, reset, or restart is intentionally weaker and must not claim to
  restore Browser history, form state, scroll, POST state, or in-page memory.

### Actors / Objects / State

- A Saved View is an organization-scoped, operator-scoped durable pointer to an
  eligible exact target. Supported targets are Browser, Automation, Library
  document, Library entry, Library file, Library directory, and Desktop Local
  App.
- A Saved View stores a stable id, display label, typed target descriptor,
  exact `viewInstanceId`, and target-specific fallback data. It does not own the
  underlying automation, Library object, Browser guest, Local App process, or
  Main tab.
- A Saved View is a Messenger directory item, not a message thread. It has no
  transcript, unread state, attention state, mark-read behavior, or synthetic
  latest-message/activity time.
- Every visible Saved View has either loose placement or exactly one custom-
  group membership. Messenger has no fixed `Saved` section or normal hidden-item
  manager.
- Only a Local App Saved View may have a `primaryRailPinnedAt` timestamp. That
  pin is an independent navigation projection: it does not change loose/group
  placement, Main tab state, or Local App process state. One operator may pin
  at most 100 Local Apps per organization.
- A Saved View uses `/messenger/saved/:id` as its stable route. Selecting or
  directly loading that route opens or focuses the exact live Main tab when it
  exists, otherwise hydrates a Main tab from durable fallback data. It never
  opens the target back into Side.
- `/messenger/workbench` represents a Main session with no durable active
  target, such as an active session-only Browser tab. With no Main tabs it
  returns to `/messenger`.
- A `MainWorkbenchTab` is organization-scoped session state keyed by
  `viewInstanceId`. Its optional Saved binding can be added or removed without
  replacing the tab.
- Browser and Local App guests, editable Library sessions, and embedded work
  surfaces live in an application-level runtime layer with one current host
  lease: Side, transferring, Main, parked, crashed, or disposed. Side and Main
  provide visual anchors; route changes do not create a replacement runtime.
- A saved Browser fallback opens the last persisted eligible URL in the
  dedicated Browser partition only after the original guest is gone. A Local
  App fallback never starts a service and follows `DESKTOP.LOCAL.APPS.001`.
- The persisted record includes `targetKind`, a validated typed
  `targetPayload`, `title`, `subtitle`, optional `favicon`, fixed-section
  compatibility fields, and created/updated timestamps. Browser payloads keep
  exact instance identity plus fallback URL. Automation and Library payloads
  keep resource and instance identity. Local App payloads keep only opaque
  installation, binding, app, and instance identity.
- Custom-group membership keeps the existing `thread_key` database column as
  an opaque item key; Saved Views use `saved-view:<id>`.
- Idempotent keep receipts preserve the chosen placement; their `groupId` is
  nullable when the Saved View was kept loose.
- Generic group API fields are canonical. Every hydrated member returns
  `itemKey` and `item`; a thread-backed member additionally returns compatible
  `threadKey` and `thread` aliases, while a Saved View never populates those
  thread aliases. Mutations accept either generic or legacy key fields; if both
  are supplied they must be equal or validation fails with `400`.

### Entry Points / Inputs

- `Move to Messenger` on an eligible active Side Panel target.
- `Keep in Messenger` on an eligible session-only Main Browser tab.
- `Pin to Primary Rail` and `Unpin from Primary Rail` in a Local App working
  surface's More menu. An unsaved Local App exposes the same enabled Pin action;
  it does not require a disabled `Keep in Messenger to pin` precursor.
- Messenger Saved View row actions: Open, Move to Messenger sidebar, Move to
  group, Remove from Messenger, and loose or group-local reorder.
- Main tab actions: focus, reorder, close, create Browser tab, Browser Keep,
  Remove, and target-specific controls. A Local App tab exposes project
  settings from its hover/focus More menu.
- Direct navigation to `/messenger/saved/:id` or `/messenger/workbench`.
- Organization-scoped Saved View list/create/get/update/reorder/delete APIs,
  including an atomic Local App Keep-and-Pin input and pinned-only list filter,
  plus generic custom-group item APIs.
- Browser main-frame/in-page navigation, title, and
  `page-favicon-updated` events used to refresh recovery metadata.

### Product Logic Flow

1. From an eligible active Side target, the operator chooses
   `Move to Messenger`. Rudder freezes the exact source context,
   `viewInstanceId`, and source revision and marks only that tab as moving.
2. One idempotent keep mutation validates the descriptor and atomically places
   it. A stable Chat or Issue creates or reuses its group and adds both host and
   Saved View exactly once by default. A global or Main-session source can use
   the operator-selected `Messenger sidebar` loose placement or an existing
   group.
3. Rudder writes the returned nullable group and Saved View into the local
   directory cache, stages the Main tab, preserves the displayed source Side
   context, and navigates to `/messenger/saved/:id`.
4. After the target Main anchor is ready, the runtime layer transfers its unique
   host lease from Side to Main. Only after a successful claim does Rudder
   detach the exact source tab and focus Main. Sibling Side tabs remain in their
   previous order and state.
5. A server failure leaves no row and no transfer. A timeout or uncertain
   response retains the source and retries with the same mutation id. A
   committed row plus failed Main claim retains both source and row and offers
   `Retry move`; Rudder does not compensate by deleting the row or create a
   second guest.
6. Selecting a Saved View row focuses its live Main tab by exact
   `viewInstanceId`, or cold-hydrates a Main tab when no live instance exists.
   The mixed Main tab strip remains visible even with one tab.
7. `+` and the focused Main Browser new-tab shortcut create a session-only
   Browser tab in Main. Keeping that tab requires explicit placement
   confirmation: `Messenger sidebar` creates a loose row, while a recent group
   may be preselected but is not silently committed.
8. `Remove from Messenger` deletes the durable Saved View and membership,
   unbinds the open Main tab, and replaces the route with
   `/messenger/workbench`. The exact Main instance remains session-only.
9. `Close tab` disposes that Main instance but leaves its Saved View row.
   Selecting the row later cold-hydrates a new instance under the target's
   honest recovery boundary.
10. Accepted Browser title, favicon, and URL events update fallback metadata
    from the runtime layer after promotion. Browser rows render only title or
    domain plus favicon/Web fallback and never show the URL.
11. Messenger independently paginates visible Saved Views, excludes those
    already hydrated through custom-group membership, and inserts the remainder
    as loose rows into the unified directory and its device-level manual order.
12. Moving a Saved View to `Messenger sidebar` or separating/deleting its group
    removes only membership. Moving a loose Saved View into a group, or dropping
    it on an eligible loose Chat or Issue, creates the corresponding membership
    without replacing or closing its Main tab or live runtime.
13. Pinning an existing Local App Saved View sets its Primary Rail pin without
    changing placement. Pinning a session-only Local App atomically creates its
    loose Saved View and Primary Rail pin in one idempotent keep mutation. An
    uncertain response is retried with the same mutation id, so it cannot create
    a duplicate Saved View or consume a second pin. Unpinning removes only the
    Primary Rail shortcut.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| First exact move | Eligible live `viewInstanceId` has no Saved View | Atomically place it, claim Main, then detach that source tab | Detach before claim, copy the runtime, or disturb siblings | Reducer, E2E, packaged Desktop |
| Repeated exact move | Same `viewInstanceId` already has a row | Bind and focus the existing row/Main tab | Duplicate the row or move it to another group implicitly | Service and UI tests |
| Same URL/resource, different instances | Distinct `viewInstanceId` values show one URL or resource | Keep distinct rows and Main tabs | Collapse them by URL, path, or canonical resource key | Service and Desktop E2E |
| Server failure | Keep transaction returns a definite failure | Keep source unchanged and create no placement | Navigate or detach the source | Service and promotion tests |
| Main claim failure | Keep committed but exact runtime cannot claim Main | Keep source and row; expose retry | Delete the row or construct another guest | Promotion tests |
| Underlying resource unavailable | Library/Automation lookup is missing, forbidden, or deleted | Keep the row and show unavailable | Auto-delete or cross-scope hydrate | Route/UI/E2E |
| Browser guest alive | Original runtime still owns the exact instance | Transfer/focus the same guest and `webContentsId` | Remount, DOM-reparent, or create a second guest | Packaged Desktop smoke |
| Browser guest gone | Original tab closed, reset, crashed, or app restarted | Open a fresh guest at last persisted eligible URL | Claim history/form/scroll recovery | Route/UI/Desktop tests |
| Capacity during live move | Side plus Main already own eight live Browser guests | Move succeeds because ownership transfers without increasing count | Reject move, evict another exact tab, or create guest nine | Reducer and packaged Desktop |
| Capacity during cold open | Eight unrelated live Browser guests already exist | Keep row and show recoverable capacity state | Reuse or evict another exact tab silently | Reducer and UI tests |
| Remove while open | Saved binding and live Main tab both exist | Delete row/membership; retain exact session-only tab | Close guest, stop Local App, or lose editor state | UI/E2E/Desktop |
| Close while saved | Live Main tab has a Saved binding | Dispose tab; keep row for later cold open | Delete durable membership | UI/E2E |
| Group to loose | Grouped Saved View is moved to Messenger sidebar or its group is separated | Keep the Saved View and return it to loose manual order | Delete the row or close/stop its runtime | Service/UI/E2E |
| Loose to group | Loose Saved View is moved into a group or dropped on an eligible loose Chat/Issue | Assign one membership and preserve the same Saved View/runtime | Duplicate the row or restart the target | Service/UI/E2E |
| First Local App pin | Exact Local App instance has no Saved View | Atomically create one loose Saved View and pin it to the Primary Rail | Require a separate Keep, create an unpinned intermediate row, or duplicate on retry | Validator, service, UI, and packaged Desktop |
| Existing Local App pin toggle | Exact Local App Saved View already exists | Set or clear only its Primary Rail shortcut | Move its Messenger placement, close its tab, or stop its process | Service and UI tests |
| Web/mobile Browser open | No Electron guest capability | Keep the row and ask to open in Rudder Desktop | Drop the record or fake a guest | UI E2E |

### Actor-Visible Input

- Eligible Side surfaces expose `Move to Messenger`; eligible session-only Main
  Browser tabs expose `Keep in Messenger`; a blank Browser tab is not durable.
- Messenger shows Saved Views as loose rows or inside custom groups. Rows share
  Chat/Issue density, focus, actions, drag handle, pointer DnD, and keyboard DnD
  behavior without acquiring pin/unpin controls. The Local App working surface,
  not its Saved View row, owns the Primary Rail Pin toggle.
- A Saved View row is selected only while the current Messenger route is
  `/messenger/saved/:id` for that row. A live or active Main Workbench tab
  retained behind Chat, Issue, or another Messenger route must not leave the
  Saved View row selected.
- Main exposes one WAI-ARIA mixed tab strip with roving keyboard focus,
  left/right/home/end navigation, close, whole-tab reorder, and `+` for a
  Browser tab. Pointer reorder uses the tab surface itself rather than a
  separate drag-handle button.

### Operator-Visible Output

- Successful promotion announces the selected Messenger sidebar or group
  placement, focuses the exact Main tab, and removes only that tab from Side.
- Main Browser and Local App surfaces fill the Main content directly beneath
  the mixed tab strip. They must not be wrapped in another card, inset frame,
  rounded inner shell, or second Browser tab strip. The Main shell and tab
  strip use a theme-appropriate masked surface instead of exposing the
  wallpaper transparently, preserve the shared outer workspace radius, and
  clip the live Browser toolbar and page content at all four outer corners.
- Browser rows show a legal favicon or generic Web/Globe icon and title/domain,
  never the URL. Library, Automation, and Local App rows use their type icons.
- Missing or device-local targets show an explicit unavailable/retry state in
  the Main tab. Browser rows on web/mobile remain movable/removable and ask for
  Rudder Desktop.
- A pinned Local App appears after the fixed Primary Rail destinations and opens
  its exact Saved View route. Unpinning removes that shortcut while leaving its
  Messenger row, Main tab, and process unchanged.
- Saved View rows never show unread, attention, mark-read, or latest-message
  time UI.

### Persisted Evidence

- `messenger_saved_views` must store the scoped typed target, presentation and
  recovery metadata, compatibility fields, timestamps, and nullable
  `primaryRailPinnedAt` for Local App shortcuts.
- `messenger_custom_group_entries.thread_key` must store the opaque
  `saved-view:<id>` membership and group-local order when a Saved View is
  grouped; a loose Saved View has no such membership.
- Each Saved View mutation must emit an organization-scoped, operator-attributed
  activity record. Metadata refreshes do not change Messenger activity order.
- Accepted Browser navigation/title/favicon events must be deduplicated and
  throttled. The newest accepted main-frame or in-page URL wins; pending
  recovery metadata is flushed before deliberate tab/reset disposal when
  possible.
- Main tabs, host leases, Browser `webContentsId`, Local App PID/generation/URL,
  editor selections, and runtime markers are session/device state and must not
  enter the Saved View database payload.

### Canonical Scenarios

1. Move Browser B while Side holds A/B/C:
   - Trigger: Fill a form and scroll B, then choose `Move to Messenger`.
   - Expected state/action: B's exact runtime lease transfers to Main; A and C
     stay in Side and C becomes active.
   - Visible output: Full-bleed Browser Main content plus its durable loose or
     grouped row;
     history, form, scroll, zoom, and `webContentsId` remain.
   - Evidence: Promotion E2E and packaged Desktop smoke.
2. Recover after restart:
   - Trigger: Keep a Browser target, navigate again, then restart/reset.
   - Expected state/action: Create a new guest at the newest persisted eligible
     URL using the persistent Browser partition.
   - Visible output: Current page and available cookie login restore; no claim
     about history/form/scroll.
   - Evidence: Packaged restart/reset E2E.
3. Remove and close independently:
   - Trigger: Remove an open Saved View, then keep another view and close only
     its Main tab.
   - Expected state/action: Remove leaves the first exact tab session-only;
     Close leaves the second durable row for cold reopen.
   - Visible output: `/messenger/workbench` for the session-only tab and a
     durable loose or grouped row for the closed saved tab.
   - Evidence: Main Workbench unit, Messenger E2E, and Desktop smoke.
4. Open an inaccessible Automation or device-local target:
   - Trigger: The owning resource is deleted or becomes inaccessible.
   - Expected state/action: Retain the Saved View but deny target hydration.
   - Visible output: Actionable unavailable state with no attention badge.
   - Evidence: Isolation/service/UI E2E.
5. Pin an unsaved Local App:
   - Trigger: Open a session-only Local App's More menu and choose
     `Pin to Primary Rail`.
   - Expected state/action: One mutation creates a loose Saved View and sets its
     Primary Rail pin; replaying the same uncertain request returns that result.
   - Visible output: The action stays enabled before Keep, then the exact Local
     App appears in the Primary Rail without restarting or moving its runtime.
   - Evidence: Validator/service/UI tests and packaged Desktop smoke.

### Invariants / Non-Goals

- All Saved View reads, mutations, routes, target hydration, and group
  membership are organization-scoped and operator-scoped. A stored descriptor
  never grants access to an underlying object.
- Only Browser, Automation, Library document, Library entry, Library file,
  Library directory, and Desktop Local App exact targets are saveable under
  this contract.
- Every visible Saved View is either loose or has one custom-group membership.
  There is no fixed Saved section or normal hidden manager.
- Missing, deleted, or inaccessible underlying targets produce an actionable
  unavailable state; they must not be silently redirected or hydrated across an
  organization boundary.
- Library targets retain `LIBRARY.FILES.001` path, protection, and conditional
  write rules. Automation targets retain `AUTOMATION.*` lifecycle rules.
  Browser targets retain the dedicated Browser partition and all sandbox,
  protocol, popup, permission, download, file, and Rudder-app-origin rules.
  Local Apps retain `DESKTOP.LOCAL.APPS.001`.
- A live runtime has exactly one host lease. Side-to-Main transfer changes the
  lease without creating, remounting, DOM-reparenting, or disposing the
  physical guest/editor session.
- Main Workbench tab order and Messenger group order are independent.
- Loose Saved View order is device-level manual directory state and remains
  independent of Main Workbench tab order. Only Local App Saved Views have the
  bounded Primary Rail pin/unpin lifecycle; other Saved Views have no pin/unpin
  lifecycle. No Saved View has unread state, attention state, or synthetic
  activity timestamp.
- Local App Primary Rail pin state is independent of loose/group placement,
  Main tab order, and process lifecycle. Pinning an unsaved Local App always
  uses loose placement, accepts only `primaryRailPinned: true`, and atomically
  creates the Saved View and pin. The per-operator, per-organization limit is
  100; non-Local-App targets and requests above the limit fail without partial
  mutation.
- Remove deletes durable binding only; Close disposes the current Main
  instance only. Neither action stops a Local App process.
- Saved Views never participate in unread/attention counts, mark-read APIs, or
  latest-message ordering, including when mixed into a custom group.
- Issue, Chat, Side Chat, placeholder, and blank Browser targets are not
  saveable because Issue and Chat already have Messenger identity or no durable
  target exists.
- Side and Main share at most eight live operator Browser guests per
  organization. Live transfer does not increase the count and cannot be blocked
  by capacity. New or cold-open guests at capacity fail visibly; Rudder does not
  silently reuse or evict an unrelated exact tab.
- Restart, renderer crash, explicit tab close, and Browser reset may create a
  new `webContentsId`. Cold recovery promises only the last eligible URL and
  profile, not history, form state, scroll, POST state, or in-page memory.
- Local account claim and already-claimed repair must preserve Saved View
  identity, membership, and placement under `ORG.LOCAL.ACCOUNT.UPGRADE.001`.
  When a target Saved View already exists, recovery must map legacy receipts to
  its actual target placement instead of duplicating it or restoring stale
  placement.

### Drift Boundaries

- Adding a target kind, changing deduplication identity, loose/group placement,
  group membership semantics, Local App Primary Rail pin lifecycle or limit,
  attention exclusion, live guest ownership, Main/Side transfer, Remove/Close
  semantics, recovery guarantees, capacity, or web/mobile behavior requires
  updating this contract.
- Component names, query-cache layout, throttle duration, row styling, exact
  masked-surface color, and the internal activity payload may change without a
  contract update when visible behavior and persisted evidence stay
  equivalent.

### Traceability

Related plans:

- `doc/plans/2026-07-20-messenger-saved-views.md`
- `doc/plans/2026-07-23-messenger-work-packages-local-apps.md`
- `doc/plans/2026-07-23-messenger-main-workbench-promotion.md`
- `doc/plans/2026-07-24-side-panel-new-tab-and-loose-saved-views.md`

Related code:

- `packages/db/src/schema/messenger_saved_views.ts`
- `packages/shared/src/types/messenger.ts`
- `packages/shared/src/validators/messenger.ts`
- `server/src/routes/messenger.ts`
- `server/src/services/messenger-saved-views.ts`
- `ui/src/context/MainWorkbenchContext.tsx`
- `ui/src/context/LiveSurfaceRuntimeContext.tsx`
- `ui/src/context/SavedViewPromotionContext.tsx`
- `ui/src/context/SidePanelContext.tsx`
- `ui/src/components/workbench/MessengerMainWorkbench.tsx`
- `ui/src/components/MessengerContextSidebar.tsx`
- `ui/src/pages/Chat.side-panel.tsx`
- `ui/src/pages/MessengerSavedViewWorkspace.tsx`
- `desktop/scripts/smoke.mjs`

Related tests:

- `server/src/__tests__/messenger-routes.test.ts`
- `server/src/__tests__/messenger-service.test.ts`
- `ui/src/lib/main-workbench-state.test.ts`
- `ui/src/context/MainWorkbenchContext.test.tsx`
- `ui/src/context/LiveSurfaceRuntimeContext.test.tsx`
- `ui/src/context/SavedViewPromotionContext.test.tsx`
- `ui/src/components/workbench/MessengerMainWorkbench.test.tsx`
- `ui/src/components/MessengerContextSidebar.test.tsx`
- `tests/e2e/messenger-saved-views.spec.ts`
- `tests/e2e/messenger-local-apps.spec.ts`
- `desktop/scripts/smoke.mjs`

The Saved View E2E and packaged Desktop paths cover representative Browser,
Library document, and Local App placement; grouped-to-loose movement, loose
manual reorder, loose-to-group movement, and persistence after reload; and the
independence of placement, Main tab, editor, Browser guest, and Local App
process lifecycles.

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
