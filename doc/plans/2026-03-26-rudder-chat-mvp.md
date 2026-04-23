# Rudder Chat MVP

## Summary

Add a first-class `Chat` surface to Rudder as a conversational intake and clarification layer for company work. Chat is not a replacement for issues. Its job is to clarify requests, suggest routing, propose issue creation, and support a small set of approval-gated lightweight operations. Execution and long-running tracking remain issue-centric.

The MVP should introduce a company-scoped chat experience with a built-in server-side assistant, not an agent-backed chat UI. A chat conversation may have no issue at all, or at most one primary issue. It may also reference multiple existing issues, projects, and agents. The main UI entrypoint is a new top-level `Chat` page, with additional entrypoints from Issue and Project pages.

## Implementation Changes

### Product behavior

- Add a top-level `Chat` page in the sidebar as the primary entrypoint.
- Support starting chat from:
  - the standalone Chat page
  - an existing Issue
  - an existing Project
- Treat chat as a clarification and triage surface first.
- The assistant must ask clarifying questions before proposing issue creation when requirements are incomplete.
- Support small requests that stay in chat without creating an issue.
- Support larger requests by generating a structured issue proposal.
- Allow a conversation to exist without any linked issue.
- Allow a conversation to reference multiple existing objects while keeping at most one primary issue created from that conversation.

### Data model

Add new company-scoped chat entities:

- `chat_conversations`
  - stores status, title, summary, preferred agent, routed agent suggestion, primary issue, creation mode, operation mode, creator, timestamps
- `chat_messages`
  - stores role (`user`, `assistant`, `system`)
  - stores message kind (`message`, `issue_proposal`, `operation_proposal`, `routing_suggestion`, `system_event`)
  - stores freeform body plus structured payload
- `chat_context_links`
  - stores references from a conversation to existing `issue`, `project`, or `agent` records
- `chat_attachments`
  - stores message-level attachment associations and reuses existing asset storage

Enforce these rules:

- A conversation belongs to exactly one company.
- A conversation may have zero or one `primary_issue_id`.
- A conversation may have many context links.
- Attachments belong to a message and company.

### Shared types and validation

Add shared constants, types, and validators for:

- chat conversation status
- chat message role
- chat message kind
- create/update chat payloads
- add message payloads
- add context-link payloads
- convert-to-issue payloads
- chat operation proposal payloads

Extend mention support to include issue references in addition to the existing agent and project mention system.

### Server API

Add new REST endpoints:

- `GET /api/companies/:companyId/chats`
- `POST /api/companies/:companyId/chats`
- `GET /api/chats/:id`
- `PATCH /api/chats/:id`
- `GET /api/chats/:id/messages`
- `POST /api/chats/:id/messages`
- `POST /api/companies/:companyId/chats/:chatId/attachments`
- `POST /api/chats/:id/context-links`
- `POST /api/chats/:id/convert-to-issue`
- `POST /api/chats/:id/resolve`

Behavior requirements:

- Company access checks must match existing company-scoped route patterns.
- All mutating chat actions must write activity log entries.
- Conversion to issue must create the issue through the existing issue service path, not a parallel implementation.
- When converting to issue, persist the resulting issue as the conversation’s `primary_issue_id` and emit a system message with the result.
- When chat is started from an Issue or Project page, seed the conversation with the matching context link.

### Built-in assistant

Add a new server-side chat assistant service that uses instance-level `llm` configuration.

Requirements:

- It is a built-in assistant, not an existing Rudder agent.
- It must support OpenAI and Claude through the existing instance config shape.
- If no usable LLM configuration is present, Chat should be unavailable for sending messages and should show a clear configuration error.
- The assistant must output validated structured result types:
  - plain reply
  - issue proposal
  - lightweight operation proposal
  - routing suggestion
- The assistant must default to clarification-first behavior.
- The assistant may recommend an assignee or agent route, but MVP should not automatically hand off the conversation to an agent execution loop.

### Approval and safety model

Reuse the existing approval system instead of inventing a parallel review workflow.

Add approval types for chat-driven actions:

- `chat_issue_creation`
- `chat_operation`

Rules:

- Default issue creation mode is manual approval.
- Company settings should expose a default chat issue-creation mode.
- Conversations may override that default with a small set of composer controls.
- In manual mode, an issue proposal creates an approval and waits for board/user action.
- Approval actions must support optional review notes through the existing `decisionNote` path.
- Lightweight configuration or settings changes proposed from chat must always require approval in MVP.
- Approved operations must execute by calling existing company/agent update services and routes, then log the resulting mutation.
- Rejected or revision-requested proposals remain attached to the conversation as proposal history.

### UI

Add a dedicated Chat experience:

- Sidebar nav item: `Chat`
- Main page layout:
  - conversation list
  - message pane
  - composer
- Composer optional controls, MVP only:
  - preferred agent
  - issue creation mode
  - operation mode
- Proposal messages should render as distinct cards, not ordinary chat bubbles.
- Proposal cards should expose direct actions:
  - approve
  - request revision
  - reject
  - create issue when applicable
- Add “Open in Chat” actions on:
  - Issue detail
  - Project detail
- Support file attachment upload in chat and display uploaded assets in the message pane.
- Do not integrate Chat into Inbox unread/badge behavior in MVP.

## Test Plan

- Schema and service tests for:
  - creating conversations
  - creating messages
  - linking context objects
  - enforcing zero-or-one primary issue
  - storing and listing attachments
- API route tests for:
  - list/create/get/update chat conversations
  - add/list chat messages
  - add context links
  - convert chat to issue
  - resolve chat
  - upload chat attachments
- Assistant service tests for:
  - clarification-first behavior
  - structured output validation
  - issue proposal generation
  - operation proposal generation
  - missing-LLM-config failure mode
- Approval flow tests for:
  - manual issue proposal approval
  - reject and request-revision flows with decision notes
  - approved operation proposal execution
- UI tests for:
  - Chat page rendering
  - creating a conversation
  - starting chat from Issue and Project pages
  - proposal card rendering and actions
  - attachments in chat
  - context-link display
- Full verification before handoff:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Assumptions and Defaults

- Public UI terminology uses `Chat` and `conversation`, not `thread`.
- MVP uses a built-in server-side assistant, not a special agent.
- A conversation may have no issue, which is normal.
- A conversation may have at most one primary issue.
- A conversation may reference multiple existing issues, projects, and agents.
- MVP does not support streaming responses.
- MVP does not support multi-agent live chat inside one conversation.
- MVP does not support automatic execution handoff from chat to agent runtime; handoff happens through issue creation and assignee suggestion.
- Chat is a core product feature for MVP, not a plugin.
