# Rudder Chat Revision Plan: Hybrid Runtime + Claude-style Chat UX

## Summary

Revise the current Chat MVP in two directions at once:

- Replace the current `config.llm`-only assistant path with a hybrid chat runtime:
  - if a conversation has an assigned/preferred agent, chat uses that agent’s `agentRuntimeType + agentRuntimeConfig`
  - if no agent is assigned, chat uses a company-level default chat model config
- Redesign the Chat UI to feel Anthropic/Claude-inspired:
  - a calm, centered new-chat landing state
  - warmer dark surfaces, cleaner typography, quieter chrome
  - hover actions on conversation cards for rename/archive
  - subtle motion for page, list, composer, and message transitions

This pass stays chat-only. It does not broaden the redesign to the rest of Rudder.

## Key Changes

### 1. Chat runtime and model resolution

- Remove the hard dependency on instance `config.llm` as the only way Chat can reply.
- Add company-level chat defaults on `Company`:
  - `defaultChatAgentRuntimeType`
  - `defaultChatAgentRuntimeConfig`
- Keep `defaultChatIssueCreationMode` as-is.
- Resolve runtime in this order for every assistant turn:
  1. `conversation.preferredAgentId` if present and valid
  2. company `defaultChatAgentRuntimeType + defaultChatAgentRuntimeConfig`
  3. otherwise reject send with a clear “Configure Chat model in Company Settings” error
- Treat assigned-agent chat as model/runtime inheritance only. It should not hand the conversation into full agent task execution.
- Restrict company chat defaults to adapters with usable conversational execution semantics.

### 2. Adapter-backed chat execution path

- Introduce a dedicated `chat runtime service` on the server instead of direct OpenAI/Anthropic fetches.
- The service should:
  - resolve the effective adapter source
  - build the clarification-first Rudder chat prompt
  - invoke the selected adapter through the existing server adapter registry
  - normalize the result into the existing structured chat result kinds:
    - `message`
    - `issue_proposal`
    - `operation_proposal`
    - `routing_suggestion`
- Do not invent a separate “chat agent” entity.
- Reuse adapter execution where possible by creating an ephemeral chat execution context:
  - no issue/task checkout
  - no worktree requirement by default
  - no worktree mutation assumptions
- Preserve the current clarification-first system behavior and proposal validation rules.

### 3. Public API and type changes

- Extend shared company types and validators with:
  - `defaultChatAgentRuntimeType: AgentRuntimeType | null`
  - `defaultChatAgentRuntimeConfig: Record<string, unknown>`
- Extend chat conversation/detail responses with a computed runtime descriptor:
  - `chatRuntime.sourceType: "agent" | "company_default" | "unconfigured"`
  - `chatRuntime.sourceLabel`
  - `chatRuntime.agentRuntimeType`
  - `chatRuntime.model`
  - `chatRuntime.available`
  - `chatRuntime.error`
- Update `PATCH /api/chats/:id` to support inline rename and archive:
  - `title`
  - `status`
  - `preferredAgentId`
- Update `GET /api/companies/:companyId/chats` to support status filtering:
  - `status=active|resolved|archived|all`
- Keep delete out of scope. Archive is the only removal action from the main sidebar.

### 4. Company settings UX for chat defaults and archives

- Expand `Company Settings > Chat` into the control surface for unassigned chat behavior.
- Add a “Default chat model” section that reuses the same adapter/model selection patterns as agent configuration:
  - adapter type picker
  - model picker from adapter model discovery
  - adapter-specific fields only when required for that adapter
- Do not force users to choose a model per conversation.
- Add an “Archived conversations” management section in Company Settings:
  - list archived chats
  - restore action
- Keep archived chat browsing out of the main Chat sidebar.

### 5. Chat UI redesign toward Claude language

- Rework the empty/new-chat state into a centered landing composition:
  - single large prompt shell
  - minimal entry affordance
  - optional low-noise helper chips
  - warm serif-style display heading and muted support text
- Hide advanced chat controls from the empty state by default.
- Move model/agent/options controls into a subtle popover or footer tray near the composer.
- Change the active conversation view to a calmer reading layout:
  - narrower content column
  - softer surfaces
  - less dashboard-card framing
  - cleaner spacing rhythm
- Restyle the left sidebar conversation cards:
  - hover reveals a trailing more action
  - menu actions are `Rename` and `Archive`
  - inline rename preferred over modal rename
  - stronger active-state highlight, but still restrained
- Remove noisy message chrome:
  - make assistant messages feel lighter and less boxed
  - demote role labels and timestamps visually
  - keep proposal cards distinct, but closer to Claude’s document-like tone than bright callout styling

### 6. Motion and polish

- Add subtle transitions using existing CSS/Tailwind patterns only.
- Animate:
  - landing-state to conversation-state transition
  - message insertion
  - sidebar hover action reveal
  - menu open/close
  - proposal-card status transitions
  - composer focus/expand states
- Keep motion fast and quiet:
  - short fades/slides
  - no spring-heavy or playful motion
  - no attention-grabbing pulsing outside meaningful status feedback

## Test Plan

- Server tests for runtime resolution precedence:
  - assigned agent uses agent adapter/model even when company default exists
  - unassigned chat uses company default adapter/model
  - missing both returns the new configuration error
- Server tests for supported/unsupported adapter behavior.
- Server tests for conversation mutations:
  - rename via `PATCH /api/chats/:id`
  - archive via `PATCH /api/chats/:id`
  - archived filtering in company chat list
- Server tests for company settings:
  - save and read `defaultChatAgentRuntimeType/defaultChatAgentRuntimeConfig`
  - model discovery-backed validation for required adapter config
- UI tests for:
  - Claude-style empty state rendering
  - sidebar hover menu visibility
  - inline rename flow
  - archive action removing the conversation from the active list
  - company chat model settings form
  - runtime descriptor display for assigned vs unassigned chats
- Regression tests for:
  - issue proposal approval flow
  - operation proposal approval flow
  - Open in Chat from Issue and Project
- Verification remains:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Assumptions and defaults

- `preferredAgentId` is the effective assigned agent for chat runtime in this revision.
- Company default chat model is the only fallback for unassigned chats; there is no per-conversation model picker.
- Archive is the only sidebar removal action; delete is intentionally not implemented.
- Archived conversation management lives in Company Settings, not the main Chat UI.
- This pass redesigns only Chat and the chat-related settings surface, not the rest of the product.
- Claude/Anthropic direction means warmer dark neutrals, softer borders, calmer hierarchy, and editorial-looking composition, not a literal clone of Claude’s full product UI.
