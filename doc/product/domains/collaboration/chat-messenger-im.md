---
title: Chat Messenger And IM Integration
domain: collaboration
status: active
coverage: detailed
contract_ids:
  - CHAT.LIFECYCLE.001
  - CHAT.TITLE.GENERATION.001
  - CHAT.FORK.001
  - CHAT.RICH.REFERENCE.RENDERING.001
  - CHAT.WEBSITE.LINK.ICON.001
  - CHAT.THREAD.MANIFEST.001
  - CHAT.SIDE.PANEL.001
  - MESSENGER.ATTENTION.001
  - MESSENGER.THREAD.PREVIEW.001
  - MESSENGER.CUSTOM.GROUPS.001
  - IM.FEISHU.001
related_code:
  - desktop/src/browser-ipc.ts
  - desktop/src/browser-profile.ts
  - desktop/src/browser-webview-policy.ts
  - packages/db/src/schema/chat_conversations.ts
  - packages/db/src/schema/chat_messages.ts
  - packages/db/src/schema/chat_generations.ts
  - packages/db/src/schema/chat_work_manifest_items.ts
  - packages/db/src/schema/agent_integrations.ts
  - packages/shared/src/constants.ts
  - packages/shared/src/types/chat.ts
  - packages/shared/src/project-mentions.ts
  - packages/shared/src/chat-work-manifest.ts
  - packages/shared/src/website-icons.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/product-intelligence.ts
  - server/src/services/chats.ts
  - server/src/services/chat-work-manifest.ts
  - server/src/services/chat-agent-runs.ts
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
  - ui/src/lib/side-panel-targets.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/context/ChatGenerationContext.tsx
  - ui/src/components/Layout.tsx
  - ui/src/components/MilkdownMarkdownEditor.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/components/WorkspaceFilePreview.tsx
  - ui/src/components/WorkspacePdfPreview.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/Chat.work-manifest.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.messages.tsx
  - ui/src/pages/Messenger.tsx
  - ui/src/pages/AgentDetail.runs.tsx
  - server/src/routes/website-metadata.ts
  - server/src/services/website-metadata.ts
  - ui/src/pages/AgentDetail.integrations.tsx
related_tests:
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-profile.test.ts
  - desktop/src/browser-webview-policy.test.ts
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
  - ui/src/components/MilkdownMarkdownEditor.test.ts
  - ui/src/components/MarkdownBody.test.tsx
  - ui/src/lib/side-panel-targets.test.ts
  - ui/src/context/SidePanelContext.test.tsx
  - ui/src/components/Layout.test.ts
  - ui/src/components/WorkspaceFilePreview.test.tsx
  - ui/src/components/WorkspacePdfPreview.test.tsx
  - ui/src/pages/AgentDetail.runs.test.ts
  - ui/src/pages/Chat.test.tsx
  - ui/src/context/ChatGenerationContext.test.tsx
  - ui/src/lib/chat-stream-state.test.ts
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - ui/src/pages/Chat.messages.test.tsx
  - server/src/__tests__/website-metadata.test.ts
  - server/src/__tests__/website-metadata-routes.test.ts
  - packages/shared/src/website-icons.test.ts
  - tests/e2e/markdown-website-link-rendering.spec.ts
  - tests/e2e/messenger-contract.spec.ts
  - tests/e2e/messenger-hover-preview.spec.ts
  - tests/e2e/chat-edit-stream-layout.spec.ts
  - tests/e2e/chat-fork.spec.ts
  - tests/e2e/chat-rich-references.spec.ts
  - tests/e2e/chat-side-panel.spec.ts
  - tests/e2e/chat-work-manifest.spec.ts
  - tests/e2e/agent-detail-feishu-integration.spec.ts
  - tests/e2e/feishu-source-badges.spec.ts
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
- Messages have role, status, body, attachments, rich references, structured
  payloads, and optional run attribution.
- A conversation Work manifest reconciles inspectable Outputs, Sources, and
  References from the active visible message branch and durable production
  evidence under `CHAT.THREAD.MANIFEST.001`.
- Chat-native assistant turns that invoke runtimes are Agent Runs under
  `RUN.CHAT.AGENT.001`.
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
- When a user sends a local chat follow-up while that conversation already has
  an active assistant generation, Rudder parks the follow-up in a visible
  running queue instead of starting a second concurrent reply in the same chat.
- Queued follow-ups preserve the queued body and composer context until they are
  delivered. Operators can edit or delete queued follow-ups while they remain
  queued, and Rudder can claim the next queued follow-up only after the current
  reply reaches a completed state.
- The current runtime does not accept mid-run steering for queued follow-ups.
  A steering attempt records a fallback reason and leaves the follow-up queued
  for normal delivery.
- Chat-native work remains inspectable through the conversation, Agent Runs,
  Work manifest, and linked outputs. Creating or linking an issue is optional
  structured coordination, not a prerequisite for real or durable work.

Flow:

1. User creates or opens chat.
2. Composer may include attachments, mentions, rich references, selected agent,
   selected skills, and structured proposal payloads.
3. Server persists user message and context links.
4. If a runtime assistant is invoked, Rudder creates a chat Agent Run and
   streams/persists assistant messages.
5. Chat can continue executing the task conversationally or create/link an
   issue, automation, or approval when the operator asks for that additional
   structure. The assistant must not emit an issue proposal merely because the
   work is large, durable, assignable, or issue-shaped.
6. When the operator refreshes a completed assistant answer, Rudder reuses the
   original turn context, creates a new turn variant, and surfaces branch
   controls for moving between variants.
7. While the refreshed or edited variant is still streaming, the operator may
   switch the visible turn branch back to an earlier variant to inspect prior
   user and assistant content. The current stream continues in the background,
   generation controls remain available, and returning to the active/latest
   variant shows the live stream draft again.
8. If the operator sends another local follow-up while the selected chat has an
   active generation, Rudder creates a queued follow-up with the current draft,
   attachments, selected project, skills, model/effort, access mode, and
   expected active generation id.
9. The queue renders beside the composer with stable ordering. The first queued
   item is marked as next, later items show their queue position, and editable
   queued items expose edit/delete controls.
10. When the current reply completes, Rudder claims the next queued follow-up,
   sends it as the next chat turn, and hides the queued row after it is linked
   to the delivered user message.
11. If the current reply is stopped, fails, or is otherwise not completed,
   queued follow-ups stay parked. The operator can edit/delete them, but Rudder
   does not auto-deliver them as if the interrupted reply had completed.

Invariants:

- Chat messages must remain tied to their conversation and organization.
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
- A queued follow-up must not become a visible user message until it is claimed
  and delivered through the normal chat send path. Delivered or running queued
  rows are hidden from the running-queue UI once linked to a user message.
- Stopped or failed replies leave queued follow-ups parked. Rudder must not
  silently flush old queued work after an interrupted run.
- Steering controls are visible only while a matching active generation exists.
  Stale-generation or unsupported steering attempts keep the follow-up queued
  and record the fallback reason instead of dropping the user input.
- External-bound Feishu conversations are read-only locally. They must reject
  queued follow-up mutations through the same fork-to-continue boundary as
  normal local chat mutation APIs.
- Agent attribution is visible enough to navigate from message to run/agent.
- Work-manifest reconciliation must not read hidden reasoning, transcript tool
  payloads, stdout, or stderr as user-visible Sources or References.

Evidence:

- Chat E2E covers rich references, skill picker, attachments, draft
  persistence, and attribution navigation.
- Chat assistant tests cover runtime-backed turns.
- Chat assistant tests cover stopped runtime turns that keep reasoning out of
  partial assistant bodies.
- Chat refresh E2E covers refreshing a completed assistant answer as a second
  turn variant and navigating back to the first variant.
- Chat edit streaming E2E covers switching between prior and active turn
  branches while the replacement branch is still streaming, with the active
  generation still stoppable.
- Chat concurrent-streaming E2E covers queueing a follow-up during an active
  stream, editing the queued body, steering fallback, delivery after the active
  reply completes, and parked queued follow-ups after a stopped reply.
- Chat route and UI tests cover queue snapshots, active-generation reporting,
  queued follow-up editing/cancellation/claiming, hidden delivered rows,
  retained parked rows, and Feishu-bound queue mutation rejection.

## CHAT.TITLE.GENERATION.001

## Contract Summary

Rudder chat titles use a deterministic first-user-message fallback plus the
organization's `lightweight` Product Intelligence profile, surfaced as Fast
Intelligence, for automatic generation and manual regeneration. The title
pipeline must keep Messenger scannable without blocking chat replies or
overwriting explicit operator naming.

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

## Actors / Objects / State

- Board operator: the user who sends chat messages, renames chats, or chooses
  `Regenerate title`.
- Chat conversation: `chat_conversations.id`, `orgId`, `title`, and updated
  timestamp.
- Chat messages: persisted user and assistant messages used as generation
  source text.
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
- `POST /api/chats/:id/title/regenerate` for manual title regeneration.
- Messenger chat actions menu, which exposes `Regenerate title` only when the
  selected organization has a configured `lightweight` intelligence profile.
- The first non-empty user message for automatic generation.
- The latest bounded user/assistant message excerpt for manual regeneration.

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
7. When the operator chooses `Regenerate title` from Messenger chat actions,
   Rudder builds a bounded excerpt from the latest user/assistant messages,
   calls Fast Intelligence, persists the returned title, refreshes chat and
   Messenger rows, and records `chat.title_regenerated` activity.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| First message, Fast Intelligence configured | Chat title is `New chat`; first user message is non-empty; `lightweight` profile is configured and returns usable output | User message persists, assistant flow continues, fallback title is stored, then usable Fast title replaces fallback | Chat send or assistant reply must not wait on title generation | `server/src/__tests__/chat-routes.test.ts` automatic title cases |
| First message, Fast Intelligence unavailable | Chat title is `New chat`; first user message is non-empty; profile missing/disabled/failing/unusable | Fallback from first user message remains visible; send succeeds; warning may be logged | Chat title must not remain `New chat` when a fallback can be derived | Chat route fallback tests |
| Manual rename races async generation | Operator changes title after fallback but before async generation finishes | Late generated title is ignored unless current title is still fallback or `New chat` | Explicit operator title must not be overwritten | `server/src/__tests__/messenger-service.test.ts` manual rename guard |
| Manual regeneration succeeds | Board operator triggers regenerate; chat has eligible source messages; Fast Intelligence returns usable title | Existing title is replaced, Messenger/chat caches refresh, activity records previous and new title | Regeneration must not create a new conversation or message | Chat route regeneration tests and E2E |
| Manual regeneration lacks source | Chat has no eligible user/assistant messages | Request returns 422 and title is unchanged | Runtime must not be called with an empty prompt | Chat route missing-source test |
| Manual regeneration unauthorized | Actor is not board access | Request is rejected before loading chat/product-intelligence state | Agent-auth actor must not regenerate chat title through board route | Chat route authorization test |
| Messenger action visibility | Selected organization has no configured `lightweight` profile | `Regenerate title` action is hidden | UI must not offer an action that predictably fails due to missing Fast Intelligence | Messenger sidebar unit/E2E tests |
| Long input/excerpt | First message or recent excerpt is large | Prompt is bounded/truncated before Product Intelligence invocation | Title generation must not send unbounded chat history | Chat route prompt-bound tests |

## Actor-Visible Input

For automatic generation, the operator-visible input is the first non-empty
message they send in a default-titled chat. Rudder does not ask the operator for
extra title input and does not block the chat composer while generation runs.

For manual regeneration, the operator sees a `Regenerate title` menu item in
the Messenger chat actions menu only when Fast Intelligence is configured for
the selected organization. The server uses a bounded excerpt of the latest
eligible user and assistant messages; raw internal transcript data is not part
of the title prompt contract.

Product Intelligence receives a concise prompt instructing it to return only a
title, with no quotes, markdown, or trailing punctuation, bounded to the chat
title length limit.

## Operator-Visible Output

The operator sees the chat title update in the chat surface and Messenger row:

- On first send, the title changes from `New chat` to a readable fallback
  derived from the first user message.
- If Fast Intelligence later returns a usable title, the fallback may be
  replaced by the generated title.
- If Fast Intelligence fails, the fallback stays visible and the chat send path
  still succeeds.
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
- `chat_messages` stores the user/assistant messages that form the title source
  material.
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

## Invariants / Non-Goals

- Automatic title generation must not block message persistence or assistant
  reply streaming/non-streaming.
- Automatic generation only applies to default-titled chats. Explicitly titled
  chats and manually renamed chats must not be overwritten by late asynchronous
  generation.
- The deterministic fallback must remain available when Fast Intelligence is
  not configured or fails.
- Manual regeneration is board-only, organization-scoped, and must reject chats
  without usable title-generation source messages.
- The Messenger `Regenerate title` action is only shown when the selected
  organization has a configured `lightweight` intelligence profile.
- Generated titles are sanitized for display: no markdown fences, heading/list
  prefixes, wrapping quotes, or trailing punctuation; titles are bounded to the
  chat title length limit.
- Title-generation prompts must be bounded. First-message prompts truncate long
  input, and regeneration prompts use only the latest eligible excerpt.
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

- `doc/plans/2026-06-18-chat-title-defaults.md`
- `doc/plans/2026-05-22-organization-intelligence-profiles.md`

Related code:

- `packages/db/src/schema/chat_conversations.ts`
- `server/src/routes/chats.ts`
- `server/src/services/chats.ts`
- `server/src/services/product-intelligence.ts`
- `server/src/services/organization-intelligence-profiles.ts`
- `ui/src/api/chats.ts`
- `ui/src/components/MessengerContextSidebar.tsx`

Related tests:

- Chat route tests cover non-blocking automatic title generation, deterministic
  fallback when Fast Intelligence is unavailable, unusable generated output,
  bounded prompts, streaming sends, board-only regeneration, missing-source
  rejection, and `chat.title_regenerated` activity.
- Messenger service tests cover the manual-rename guard that prevents late
  asynchronous generated titles from replacing an explicit operator title.
- Messenger sidebar tests and E2E cover hiding/showing `Regenerate title` based
  on configured Fast Intelligence and updating the visible Messenger row after
  regeneration.
- Product Intelligence tests cover resolving organization-scoped lightweight
  profiles, purpose metadata, and configured/disabled/missing provider failure
  cases.

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
2. Rudder creates a new active conversation in the same organization.
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
- Attachments are not copied by the initial fork contract; their original
  source messages remain available in the source conversation.
- Nested forks must not produce duplicate fork-family custom groups.
- Forking must not attempt to put the root conversation in multiple custom
  groups; preexisting root group membership is the fork-family grouping anchor.

Evidence:

- Chat route tests cover authorization, active-generation rejection, and
  activity logging.
- Messenger service tests cover message-level copy bounds and nested fork group
  reuse.
- Chat message/UI tests cover the message-level fork action.
- Chat fork E2E covers the visible fork workflow and copied-message boundary.
- Feishu source badge E2E covers that a fork from a Feishu-bound conversation
  returns a normal Rudder chat with no Feishu outbound rows.
- Chat refresh E2E covers that a refreshed assistant answer appears as a chat
  branch/variant rather than as a forked conversation.

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
- Composer/editor surfaces and read-only markdown surfaces share the same
  visual grammar for the same reference type.
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
- Human-readable entity labels take precedence over raw ids in user-facing
  tokens. Raw ids are acceptable only as fallback or secondary disambiguation.
- Truncation in editors is only for labels long enough to threaten the current
  line; ordinary labels should not be shortened.

Evidence:

- CSS contract tests lock the composer token icon alignment and truncation
  behavior.
- Markdown editor/body tests cover special markdown rendering consistency.
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

Invariants:

- Embedded known icons must use real image assets for the represented website or
  product, not generated letter or abbreviation placeholders.
- Known-icon hostname matching must stay explicit and narrow enough to avoid
  accidentally branding unrelated provider subdomains.
- The embedded set is an optimization for common sites, not an exhaustive
  website directory. Unlisted public sites continue through metadata discovery
  and generic-icon fallback instead of requiring a bundled asset.
- Same-origin Rudder app links remain internal navigation links and do not use
  website metadata discovery.
- Unsafe or non-HTTP schemes are not fetched for metadata.
- Metadata and icon fetches must not carry user credentials, cookies, or board
  secrets to the external site.
- Private, loopback, link-local, and otherwise internal network targets must be
  rejected before fetch; redirects must be revalidated before they are followed.
- The icon is decorative; it must not change selectable/copyable link text.

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

Messenger Chat exposes a compact, conversation-scoped Work manifest that keeps
the current thread's inspectable Outputs, Sources, and References visible
without requiring the operator to search the transcript. Work from other
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

- Board operator: reads the manifest, adds a Source, opens an item, jumps to its
  source message, or opens Project-level surfaces for broader Project work.
- Chat conversation: organization-scoped thread and optional Project context.
- Chat message: active, non-superseded user or assistant visible body, optional
  Run id, replying Agent id, and attachments.
- Manifest item: category, target type/key, title, URL or internal locator,
  status, source role, message/Run/Agent/user provenance, Project id, metadata,
  and timestamps.
- Output: Agent-created Chat attachment or Run-backed assistant Library artifact
  under the guarded `artifacts/...` output namespace.
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

1. The operator opens a Chat and Rudder requests its Work manifest.
2. Rudder verifies Chat access through the same organization boundary as normal
   Chat reads.
3. Reconciliation reads active, non-superseded user and assistant messages and
   their attachments. Transcript entries, reasoning, tool results, stdout, and
   stderr are excluded.
4. User attachments, user Library references, and user HTTP(S) links become
   Source candidates. Agent-created attachments become Output candidates.
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
   merely because the message that announced it was refreshed.
9. The API returns the current Chat sections. It may continue returning a
   Project id/count as compatibility metadata, but Chat does not render it or
   include it in the Work count.
10. When at least one current-thread item exists, wide Chat renders the compact
    shelf and a header icon that animates the shelf between open and collapsed
    states; narrow Chat exposes the same data from a compact Work trigger. A
    project-only or otherwise empty current-thread manifest renders no Work
    control or shelf. Opening an internal target reuses Side Panel behavior from
    `CHAT.SIDE.PANEL.001`.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| User supplies a file or website | Active user message attachment or visible HTTP(S) URL | One Source with user/message provenance | The input must not be labeled as Agent Output | Service tests and Chat Work Manifest E2E |
| Agent creates a Chat attachment | Assistant attachment has Agent creator provenance | One Output with Agent/message/Run provenance where available | It must not be downgraded to a Reference | Service tests and E2E |
| Agent links a produced Library artifact | Assistant message has a Run id and `artifacts/...` Library target | One Output that opens through Library Side Panel | A normal external link must not satisfy this rule | Extraction/service tests |
| Agent recommends a website | Visible assistant HTTP(S) link with no production evidence | One Reference | Rudder must not claim the website was created by the Run | Extraction/service tests |
| Link appears in tool history only | URL exists only in transcript, reasoning, stdout, or stderr | No manifest item | Tool exploration must not pollute the visible manifest | Service tests |
| Answer is refreshed or edited | Prior message becomes superseded | Stale derived References disappear; durable Outputs remain inspectable | Refresh must not erase a real artifact | Service tests |
| Chat is forked | Copied historical assistant rows have no producing Run id | Sources can be re-derived; copied rows do not gain Output ownership | Fork must not claim the source thread's Outputs as newly produced | Fork/service tests |
| Chat has a linked Project | Other Project conversations contain manifest rows | Current rows stay unchanged; other-conversation rows are omitted from Chat | Project membership must not import other conversations into the current Chat manifest | API and E2E |
| No current-thread items exist | Reconciliation returns no current-thread candidates, even if compatibility metadata reports Project items | No Work control or empty shelf is rendered | UI must not reserve space or invent Create Site/Browser capability | Component/E2E tests |
| Manifest request fails | Current manifest state cannot be confirmed | Show the compact Work error state instead of treating the result as empty | Operators must be able to distinguish retrieval failure from confirmed absence | Component/E2E tests |

## Actor-Visible Input

The operator sees the selected Chat, its normal transcript/composer, and a Work
surface containing only the current thread's Outputs, Sources, and References.
Each row exposes a readable title and type icon. Website rows expose the
normalized URL and website icon instead of a generic link icon or redundant
`From Agent` origin label.

## Operator-Visible Output

- Wide desktop: a compact top-right shelf with bounded rows and counts, plus a
  header icon that collapses or restores the shelf with a short transition.
- Empty state: no Work shelf, count, trigger, or reserved rail is rendered.
- Error state: a compact Work error remains visible so retrieval failure is not
  mistaken for confirmed absence.
- Narrow desktop/mobile: a compact Work count trigger that opens the same list.
- Chat scrolling: the message scrollbar remains attached to the outer right
  edge of the Chat workspace while content spacing keeps messages and the
  composer clear of an open Work shelf.
- Internal Library targets: existing Side Panel preview behavior.
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
   - Visible output: no change to Work.
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
- V1 does not aggregate Browser sessions, crawl tool history, implement generic
  bookmarks, create Sites/documents, or replace Library/Issue work products.

## Drift Boundaries

Update this contract when categories, production evidence, reconciliation,
Project membership isolation, provenance, responsive visibility, or item-open
behavior changes. Parser implementation, row-limit constants, icon choices,
compatibility metadata, and query batching may change without a contract edit
when the visible semantics and invariants remain intact.

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

Related tests:

- `packages/shared/src/chat-work-manifest.test.ts`
- `server/src/__tests__/chat-work-manifest.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `ui/src/pages/Chat.work-manifest.test.tsx`
- `tests/e2e/chat-work-manifest.spec.ts`

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
- Chat Work manifest internal targets use the same typed Side Panel target model;
  the manifest is an index and does not create a second preview drawer.
- Side Panel targets are typed objects: issue, automation, Library file,
  Library directory, chat, browser tab, and explicit placeholders for target
  classes that need a link/search before loading a concrete object.
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
  The compact mobile Side Panel keeps its separate overlay layout and enter/exit
  treatment.
- On desktop pointer surfaces, operators can drag a Side Panel tab label before
  or after another tab to reorder the current context's tab strip without
  changing the active target. The close affordance stays visually quiet until
  its tab is hovered or receives keyboard focus, while its reserved width keeps
  tab labels from shifting when the affordance appears.
- In Messenger, panel tab state is session-scoped to the active work item when
  the item has a stable chat or issue identity. Chat conversations and concrete
  issue threads each keep their own in-memory Side Panel tabs and active tab
  until the app session ends.
- Hiding the Side Panel is a visibility action, not a tab-destruction action.
  The operator must explicitly close a tab to remove it from the current item.
- Closing the final tab removes that tab and closes the Side Panel. The empty
  picker remains available when the operator explicitly opens an empty panel or
  uses the add-tab affordance, but is not left behind as a side effect of closing
  the final tab.
- When the Side Panel has an active tab, the close-tab keyboard shortcut
  (`Command+W` on macOS, `Ctrl+W` on non-macOS shells) closes that active tab
  before the shell or browser can treat the shortcut as a window/tab close. The
  shortcut must not close the whole Desktop window, replace the main route, or
  merely hide the panel while leaving the active tab intact.
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
  Ordinary external HTTP(S) links use that target by default without replacing
  the current Rudder route. Unsupported shells or unavailable Browser
  capability must not perform an unsafe remote fetch by themselves.
- Library file targets render supported inline previews inside the Side Panel,
  including PDFs. Truncated Library breadcrumbs reveal the complete
  Library-relative path on hover, and the file `Open` menu offers `Open in
  Library` alongside any Desktop app, IDE, file-browser, or terminal targets.

Flow:

1. The operator opens the Side Panel from the global right-edge trigger, the
   panel add-tab affordance, or a supported internal reference in
   Chat/Messenger.
2. The side-panel target parser normalizes the object into a stable tab key.
3. If the target is already open, Rudder focuses the existing tab instead of
   duplicating it.
4. The target view loads through the existing organization-scoped API for that
   domain.
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
15. Browser tabs normalize address-bar input into either a URL or search-query
   navigation, keep back/forward/reload state scoped to the embedded browser,
   can open the current page externally as a secondary action, and route popup
   requests into another Browser tab instead of an unrestricted guest window
   while the Browser tab and popup limits permit it.
16. Desktop routes ordinary external HTTP(S) links to a Browser Side Panel tab
    when its instance preference is `built_in`, independently of Agent Browser
    access. The `default_browser` preference and explicit `Open externally`
    action use the operating-system browser instead.
17. From a Library file tab, `Open in Library` navigates to the full Library
    work surface with the same organization-scoped file selected.

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
- Side Panel PDF previews must use the organization-scoped inline workspace
  content endpoint. Full-path hover text and full-Library navigation must use
  the Library-relative path rather than exposing an absolute filesystem root.
- Side Panel chat views must preserve chat lifecycle and Messenger attention
  semantics; opening a chat target in the panel is not a read-state or routing
  rewrite unless the owning Messenger/chat code performs that action.
- Side Panel Browser navigation must not grant file, organization, or
  application privileges beyond the embedded browser shell. Local non-control-
  plane web apps may be navigated, but Rudder board/API origins stay in the
  Rudder renderer and are rejected by the Browser profile.
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
- Side Panel E2E covers expanding an issue target and rendering the embedded
  Issue Detail body, including issue content sections such as attachments,
  activity, and properties, without navigating away from Chat.
- Desktop Browser policy/profile tests and smoke cover the dedicated partition,
  secure guest policy, Side Panel navigation, external-open escape, and address
  input normalization. Side Panel E2E owns the route-preserving global link
  workflow.

## MESSENGER.ATTENTION.001

Why:

- Messenger is the board communication shell. It must help the operator see
  what needs attention across chats, issue threads, approvals, failed runs, and
  automation output without moving ownership out of those domains.

Product model:

- Messenger thread directory includes chat threads and domain-derived attention
  threads such as issue, approval, failed run, and automation-created work.
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

Invariants:

- Messenger must cite or route to owning domain contracts; it must not redefine
  issue, approval, run, or automation state.
- Unread/attention counts must be organization-scoped and user-scoped.
- Seeded onboarding issue threads must remain read for the seeded operator
  until later issue activity occurs after the seed read marker.

Evidence:

- Messenger contract E2E covers ordering, previews, read state, groups,
  redirects, empty state, pin/archive/delete, issue notifications, approvals,
  and automation-created issue attention.

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

- A custom group is an organization-scoped, operator-scoped Messenger directory
  section over thread summaries. It is a `threadKey` membership overlay, not
  owning-domain state.
- A Messenger member can belong to at most one custom group per operator.
  Moving a member into a group removes its previous custom group membership for
  that operator.
- Group membership is keyed by the Messenger thread key, not by chat-only
  identity. Supported members include chat rows such as `chat:<id>`, aggregate
  issue rows such as `issues`, split issue rows such as `issue:<id>`, and known
  synthetic keys such as `approvals`, `failed-runs`, `budget-alerts`, and
  `join-requests`.
- Grouped members are hydrated thread summaries. They must preserve the same
  identity, preview, unread count, attention state, supported actions, and
  destination route as the same summary shown outside a group.
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

1. The operator creates a custom group, moves a Messenger item into a group, or
   drags an item between groups. Onboarding seed may also create the
   `Getting Started` group for starter work.
2. Rudder writes the operator-scoped membership using the item's Messenger
   thread key.
3. When drag/drop merges loose members into a new group, Rudder sends the
   member titles to Fast Intelligence with `feature: "messenger_group_title"`.
   If Fast Intelligence returns a usable title, Rudder stores that title; if it
   fails or returns unusable output, Rudder stores the deterministic fallback
   title from the drop target so grouping still succeeds.
4. Messenger hydrates the group's members from the same source summaries used
   for loose Messenger rows.
5. Selecting a grouped member opens the same destination as selecting the loose
   row and applies the same read-marker behavior.
6. The operator may choose `Regenerate title` from the group actions menu.
   Rudder rebuilds title-generation context from current group member titles,
   calls Fast Intelligence, and updates only the group name when generation
   succeeds.
7. Actions that change a member's visible summary, including mark read/unread,
   pin/unpin, archive/delete where supported, and preview-changing source
   events, update or refetch the group's hydrated rows so grouped badges do not
   diverge from loose rows.
8. The operator may reorder custom groups within the pinned or unpinned domain.
   Rudder persists that domain-local order and restores it on reload without
   moving the group across the pin boundary.

Invariants:

- Custom groups must not redefine chat, issue, approval, run, budget, or
  join-request state. They only organize and hydrate Messenger summaries.
- Grouped issue rows must clear the same issue read markers as loose issue
  rows when opened. Split issue rows and aggregate issue rows must not require a
  different user gesture to become read.
- Onboarding-created `Getting Started` group entries must preserve seed order,
  hydrate as the same split issue summaries as loose `issue:<id>` rows, and
  start with unread count and attention state cleared for the seeded operator.
- Grouped chat rows must clear the same chat read state as loose chat rows when
  opened.
- A grouped member's read/unread badge, unread count, attention state, preview,
  and last-activity ordering must not diverge from the source Messenger
  summary after local optimistic updates settle.
- Pinned custom groups render inside the `Pinned` section immediately under
  the section header and before loose pinned threads. Unpinned groups and loose
  unpinned issue, chat, approval, and synthetic attention rows follow.
- Pinning assigns a custom group to the pinned ordering domain; it does not lock
  the group's position. Pinned groups remain draggable relative to other pinned
  groups, and unpinned groups remain draggable relative to other unpinned
  groups. Group reordering must not move a group across the pin boundary.
- Pinning a custom group does not pin every member individually, and pinning a
  member does not remove it from its group.
- Removing an item from a group returns that item to the loose Messenger
  directory with its existing read/unread and attention state intact.
- Automatic group title generation must not run for menu-created groups or for
  moving a member into an existing group.
- Group title generation uses only member thread titles as context. It must not
  send full chat transcripts, issue descriptions, comments, or approval bodies.
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
  title-generation motion states.
- Messenger route tests cover Fast Intelligence group title generation,
  fallback-on-merge failure, manual regeneration, and no mutation when
  regenerated output is unusable.
- Messenger E2E covers aggregate issue grouping, split issue grouping,
  synthetic membership, drag/drop grouping, row-action group creation, and
  custom group pin/order behavior, including pinned-domain group reordering and
  pinned groups rendering above loose pinned threads after reload.

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
