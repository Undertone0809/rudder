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
  - MESSENGER.ATTENTION.001
  - MESSENGER.CUSTOM.GROUPS.001
  - IM.FEISHU.001
related_code:
  - packages/db/src/schema/chat_conversations.ts
  - packages/db/src/schema/chat_messages.ts
  - packages/db/src/schema/chat_generations.ts
  - packages/db/src/schema/agent_integrations.ts
  - packages/shared/src/constants.ts
  - packages/shared/src/types/chat.ts
  - packages/shared/src/project-mentions.ts
  - server/src/routes/chats.ts
  - server/src/routes/chats.stream-routes.ts
  - server/src/services/product-intelligence.ts
  - server/src/services/chats.ts
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
  - ui/src/components/MilkdownMarkdownEditor.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.messages.tsx
  - ui/src/pages/Messenger.tsx
  - ui/src/pages/AgentDetail.runs.tsx
  - server/src/routes/website-metadata.ts
  - server/src/services/website-metadata.ts
  - ui/src/pages/AgentDetail.integrations.tsx
related_tests:
  - server/src/__tests__/chat-routes.test.ts
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
  - ui/src/pages/AgentDetail.runs.test.ts
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - ui/src/pages/Chat.messages.test.tsx
  - server/src/__tests__/website-metadata.test.ts
  - server/src/__tests__/website-metadata-routes.test.ts
  - tests/e2e/messenger-contract.spec.ts
  - tests/e2e/chat-fork.spec.ts
  - tests/e2e/chat-rich-references.spec.ts
  - tests/e2e/agent-detail-feishu-integration.spec.ts
  - tests/e2e/feishu-source-badges.spec.ts
edit_policy: user_confirmed_only
---

# Chat Messenger And IM Integration

## CHAT.LIFECYCLE.001

Why:

- Chat is where humans clarify intent, run lightweight assistant turns, draft
  issue/automation proposals, and attach context before work becomes durable
  tracked execution.

Product model:

- A chat conversation belongs to an organization and may link to issues,
  projects, resources, approvals, or automation runs.
- Messages have role, status, body, attachments, rich references, structured
  payloads, and optional run attribution.
- Chat-native assistant turns that invoke runtimes are Agent Runs under
  `RUN.CHAT.AGENT.001`.
- Durable tracked work remains issue-centric unless the configured flow is
  explicitly chat-native, such as automation `chat_output`.

Flow:

1. User creates or opens chat.
2. Composer may include attachments, mentions, rich references, selected agent,
   selected skills, and structured proposal payloads.
3. Server persists user message and context links.
4. If a runtime assistant is invoked, Rudder creates a chat Agent Run and
   streams/persists assistant messages.
5. Chat can convert or propose conversion into issue/automation/approval work.

Invariants:

- Chat messages must remain tied to their conversation and organization.
- Chat proposals/structured payloads must not be confused with plain user
  instructions or automation run input.
- Agent attribution is visible enough to navigate from message to run/agent.

Evidence:

- Chat E2E covers rich references, skill picker, attachments, draft
  persistence, and attribution navigation.
- Chat assistant tests cover runtime-backed turns.

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
- Chat rich-reference E2E covers real chat insertion and rendering behavior.

## CHAT.WEBSITE.LINK.ICON.001

Why:

- Operators often paste external website links into chat and issue text. The
  link should feel like the linked website, not like a Rudder-maintained list
  of favored domains.
- Website icon rendering must degrade predictably when a site has no discoverable
  icon or the metadata fetch fails.

Product model:

- External `http` and `https` links render as ordinary inline text links with a
  compact leading website icon.
- Rudder discovers the website icon from the target page metadata, preferring
  declared favicon links such as `rel="icon"` or `rel="shortcut icon"`.
- The browser receives the discovered icon through a Rudder proxy URL instead
  of relying on cross-origin image fetch behavior.
- Rudder caches metadata lookups briefly so repeated rendering of the same link
  does not repeatedly fetch the same external page during normal reading.
- Rudder falls back to the generic website icon when metadata discovery returns
  no valid image icon, fails, or the proxied image cannot be rendered.

Flow:

1. A user or agent writes an external website link in chat, issue/comment
   markdown, or another rendered markdown surface.
2. The renderer initially shows a generic website icon so the message remains
   readable immediately.
3. Rudder fetches the target page metadata server-side and resolves the best
   site-declared icon.
4. When an icon is found, the renderer swaps the generic icon for the proxied
   website icon while keeping the link label/copy text unchanged.
5. If no icon is found, the generic website icon remains visible.

Invariants:

- Do not choose website icons from a hard-coded social/product domain allowlist.
- Same-origin Rudder app links remain internal navigation links and do not use
  website metadata discovery.
- Unsafe or non-HTTP schemes are not fetched for metadata.
- Metadata and icon fetches must not carry user credentials, cookies, or board
  secrets to the external site.
- Private, loopback, link-local, and otherwise internal network targets must be
  rejected before fetch; redirects must be revalidated before they are followed.
- The icon is decorative; it must not change selectable/copyable link text.

Evidence:

- Website metadata service tests cover favicon discovery, no-icon fallback,
  invalid declared icon fallback, and redirect-to-private rejection.
- Markdown/body and chat message tests cover metadata icon rendering, generic
  fallback, image-load failure fallback, safe external-link attributes, and
  unchanged link text.

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

Flow:

1. Domain event or message creates/updates a Messenger-relevant thread.
2. Messenger service computes preview, ordering, unread state, group membership,
   and attention badge state.
3. Opening a thread clears relevant read markers when appropriate.
4. Actions such as pin/archive/delete route to the owning chat/thread behavior.

Invariants:

- Messenger must cite or route to owning domain contracts; it must not redefine
  issue, approval, run, or automation state.
- Unread/attention counts must be organization-scoped and user-scoped.

Evidence:

- Messenger contract E2E covers ordering, previews, read state, groups,
  redirects, empty state, pin/archive/delete, issue notifications, approvals,
  and automation-created issue attention.

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
- Custom group titles can be explicit operator titles or Fast
  Intelligence-generated titles. Automatic group title generation only runs
  when a drag/drop merge creates a new group from existing Messenger members.
  Menu-created groups keep the operator-provided title unless the operator later
  chooses `Regenerate title`.

Flow:

1. The operator creates a custom group, moves a Messenger item into a group, or
   drags an item between groups.
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

Invariants:

- Custom groups must not redefine chat, issue, approval, run, budget, or
  join-request state. They only organize and hydrate Messenger summaries.
- Grouped issue rows must clear the same issue read markers as loose issue
  rows when opened. Split issue rows and aggregate issue rows must not require a
  different user gesture to become read.
- Grouped chat rows must clear the same chat read state as loose chat rows when
  opened.
- A grouped member's read/unread badge, unread count, attention state, preview,
  and last-activity ordering must not diverge from the source Messenger
  summary after local optimistic updates settle.
- Loose pinned threads render first. Pinned custom groups render immediately
  after that top pinned-thread section. Unpinned groups and loose unpinned
  issue, chat, approval, and synthetic attention rows follow.
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
  custom group pin/order behavior.

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
- Group messages require explicit bot addressing unless provider policy says
  otherwise.
- Feishu-bound conversations carry provider source metadata into Messenger
  thread summaries, so chat rows can show a compact `Feishu` source badge.
- Feishu-origin chat runs carry source metadata in the run context snapshot, so
  Agent Detail can show `Source: Feishu` on the originating run.
- Feishu-bound conversations are read-only from Rudder's local chat surface.
  Operators must fork them to continue locally. The fork keeps chat lineage but
  is not bound to the Feishu conversation.

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
6. Inbound text is appended to chat and, when command/routing rules apply,
   issue and run work is created/enqueued.
7. Messenger summary metadata records that the conversation came from Feishu,
   and Feishu-created chat runs persist matching source metadata.
8. Outbound placeholder/status is recorded and sent to Feishu.

Outbound flow:

1. Assistant/run result creates a Rudder chat message.
2. Integration runtime patches or sends the corresponding Feishu outbound
   message.
3. Outbound table records provider, external chat id, text, status, and linked
   Rudder message/run/conversation.

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
  integration binding.
- IM messages remain auditable in Rudder even when the external send fails.
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
- Feishu DB/runtime dispatcher tests cover setup-session completion,
  credential secrecy, revoked integration reactivation, installer auto-binding,
  SDK normalized long-connection events, hydrated chat message attachments,
  source metadata propagation, and per-event runtime failure containment.
- Agent Detail Feishu E2E covers setup-session launcher flow, polling,
  persisted integration state, and credential redaction with a mocked Feishu
  app-registration provider.
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
