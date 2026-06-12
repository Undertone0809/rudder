---
title: Retire Issue-Bound Documents
date: 2026-06-12
kind: proposal
status: proposed
area: data_model
entities:
  - issue_documents
  - project_library
  - agent_output_references
issue:
related_plans:
  - 2026-03-13-issue-documents-plan.md
  - 2026-05-19-library-project-context-workspace-proposal.md
  - 2026-06-06-agent-library-local-filesystem-first.md
supersedes:
  - 2026-03-13-issue-documents-plan.md
related_code:
  - packages/db/src/schema/issue_documents.ts
  - packages/shared/src/types/issue.ts
  - packages/shared/src/validators/issue.ts
  - server/src/services/documents.ts
  - server/src/routes/issues.ts
  - server/src/services/chats.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/services/runtime-kernel/heartbeat.*
  - cli/src/commands/client/issue.ts
  - cli/src/agent-v1-registry.ts
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/Chat.parts.tsx
  - ui/src/pages/Chat.messages.tsx
commit_refs: []
updated_at: 2026-06-12
---

# Retire Issue-Bound Documents

## Overview

Rudder should retire the legacy issue-bound document model. New agents and the
CLI should no longer know that an issue can own a keyed document such as
`plan`, `design`, or `notes`. Durable work should be written as normal Project
Library files, then cited from issue descriptions, comments, reviews, or done
notes with renderable Library links.

The current code is only partially migrated: agent direct writes are blocked on
`PUT /issues/:id/documents/:key`, but the data model, routes, CLI commands,
chat proposal conversion, runtime prompts, UI cards, and agent response schema
still expose the feature. This creates a product mismatch where current agents
can still be instructed to create plan documents even though the intended model
is Library-first.

## What Is The Problem?

Current state:

- The database still has `issue_documents`, linking `documents` rows to issues
  with workflow keys.
- Issue fetch payloads still include `planDocument`, `documentSummaries`, and a
  legacy plan body fallback.
- Server routes still expose `GET/PUT/DELETE /api/issues/:id/documents...`.
- The CLI still exposes `rudder issue documents list|get|put|revisions`.
- The agent-facing CLI registry still advertises issue document capabilities.
- Chat issue creation still converts `structuredPayload.planDocument` into a
  DB-backed `plan` issue document.
- Chat assistant prompts and JSON schema still mention `planDocument`.
- Issue detail and Library UI still render migrated issue document links such
  as `migrated from ZST-314:plan`.
- Heartbeat/runtime context still imports document service code and can inject
  issue document prompts.

Problem:

The supported product contract has changed. Project Library files are the
durable authoring surface; issue descriptions and comments are the citation
surface. Keeping issue-bound documents alive teaches agents and operators a
second, obsolete way to create durable work.

Impact:

- New agents can generate obsolete `planDocument` payloads.
- Users see confusing Library references that look issue-owned instead of
  Library-owned.
- CLI/API docs imply the old model is still supported.
- Tests can keep the obsolete behavior from being removed.
- Runtime prompt budget is spent on document prompts that should now be normal
  Library references.

## What Will Be Changed?

This proposal removes active issue-bound document behavior while preserving
existing Library documents and the general `documents` table if other Library
features still need it.

1. Remove agent-facing creation and discovery.
   - Delete `structuredPayload.planDocument` from chat assistant output schema
     and plan-mode guidance.
   - Stop chat issue creation from reading `planDocument` and calling
     `upsertIssueDocument`.
   - Remove plan preview rendering from chat issue proposal messages.
   - Remove `rudder issue documents ...` commands.
   - Remove issue document entries from `cli/src/agent-v1-registry.ts`.

2. Remove active issue API surface.
   - Delete `/api/issues/:id/documents` route handlers, or return a deliberate
     `410 Gone` for one release if compatibility is needed.
   - Remove issue document validators from shared API surfaces when unused.
   - Remove issue document activity actions if no writer remains.

3. Remove issue payload coupling.
   - Stop `GET /issues/:id` from embedding `planDocument`,
     `documentSummaries`, and `legacyPlanDocument`.
   - Update shared issue types and UI clients accordingly.
   - Remove issue detail Library cards sourced from
     `issue.documentSummaries`.
   - Keep Library cards sourced from explicit Library mentions in issue
     description/comment content.

4. Remove runtime prompt coupling.
   - Stop building and injecting `issueDocumentsPrompt`.
   - Remove imports of `documentService` from heartbeat/runtime files when they
     exist only for issue document prompt hydration.
   - Update bundled runtime instructions so agents write
     `$RUDDER_PROJECT_LIBRARY_ROOT/...` and cite with
     `rudder library file ref "$RUDDER_PROJECT_LIBRARY_PATH/..." --json`.

5. Decide the storage migration boundary.
   - Preferred first pass: leave `documents`, `document_revisions`, and
     `issue_documents` tables in place for historical data, but remove all
     active product/API/runtime paths.
   - Follow-up cleanup: after no runtime/UI/API readers remain, generate a DB
     migration to drop `issue_documents` and any orphan-only document columns
     if `documents` is no longer shared by Library.

## Success Criteria For Change

- Fresh chat issue proposals cannot include a first-class plan document.
- Creating an issue from chat never writes an `issue_documents` row.
- `rudder issue documents` is not available in the latest CLI.
- Agent-facing capability registry no longer advertises issue document
  commands.
- Issue detail no longer shows Library cards only because
  `issue.documentSummaries` exists.
- Agents are only instructed to create durable work under Project Library and
  cite it in descriptions/comments/replies.
- Existing issue descriptions and comments with Library links remain clickable.
- Historical issue-bound data is not accidentally destroyed unless a separate
  migration decision explicitly drops it.

## Out Of Scope

- Removing Project Library files, Library document rendering, Library file refs,
  or `library:projects/...` resource locators.
- Removing normal file/image attachments from issue descriptions or comments.
- Rewriting all historical issue descriptions that mention old plan docs.
- Replacing the general Library document model unless code inspection proves it
  is only used by issue-bound documents.
- Changing Project Context resource injection.

## Non-Functional Requirements

- Maintainability: remove the obsolete behavior from schema-facing types,
  prompts, tests, CLI, server routes, and UI in the same change so future code
  does not accidentally reintroduce it.
- Data safety: do not drop stored historical content in the same pass unless a
  migration and recovery story is explicit.
- Compatibility: prefer a clear `410 Gone` response for old HTTP clients if
  silent removal would create confusing 404s during one release window.
- Usability: issue detail should still surface Library links that the user or
  agent intentionally cites in issue description/comment content.

## User Experience Walkthrough

1. An operator asks an agent to write a proposal or plan for an issue.
2. The agent creates a file under the project Library, for example
   `$RUDDER_PROJECT_LIBRARY_ROOT/proposals/example.md`.
3. The agent obtains a renderable reference with
   `rudder library file ref "$RUDDER_PROJECT_LIBRARY_PATH/proposals/example.md" --json`.
4. The agent posts that Markdown link in the issue description, issue comment,
   review, done note, or chat reply.
5. The issue detail Library section shows the cited Library file because it is
   explicitly linked in user-visible issue content, not because the issue owns
   a hidden keyed document.

## Implementation

### Product Or Technical Architecture Changes

Issue-bound documents stop being an active workflow primitive. The issue object
returns issue state, work products, attachments, comments, approvals, runs, and
Library mentions found in issue content. It does not return keyed document
payloads.

Project Library becomes the only supported durable authoring model for agent
generated plans, specs, notes, and proposals.

### Breaking Change

This is a deliberate breaking change for old CLI/API consumers of
`rudder issue documents` and `/api/issues/:id/documents...`.

Recommended compatibility choice:

- CLI: remove commands immediately because the user explicitly expects latest
  CLI to have no Issue Plan / issue document surface.
- HTTP API: either remove routes or return `410 Gone` with a message that points
  to Project Library files. Use one approach consistently and update tests.
- Database: do not drop historical tables in the first implementation unless
  no remaining Library code depends on the shared `documents` table.

### Design

Implementation should proceed in four small cuts:

1. Agent and chat contract cut.
   - Remove `planDocument` from the chat assistant response schema.
   - Remove plan mode instructions that require `structuredPayload.planDocument`.
   - Remove `planDocumentFromPayload` from chat issue creation.
   - Remove chat UI plan preview logic for issue proposals.

2. CLI/API cut.
   - Remove `rudder issue documents` subcommands.
   - Remove issue document capabilities from the agent CLI registry.
   - Remove or `410` issue document routes.
   - Remove shared validators/types that are no longer referenced.

3. Issue/runtime/UI payload cut.
   - Remove issue document hydration from issue fetch payloads.
   - Remove heartbeat issue document prompt injection.
   - Remove Issue Detail cards based only on `documentSummaries`.
   - Keep explicit Library mention parsing in issue content intact.

4. Persistence cleanup cut.
   - Run `rg` for `issueDocuments`, `planDocument`, `documentSummaries`,
     `issue.documents`, and `/documents/:key`.
   - If no active readers/writers remain, decide whether to keep historical
     tables for one release or generate a drop migration.

### Security

No new endpoints, dependencies, external APIs, or temporary files are needed.
The change reduces the server write surface by removing or retiring issue
document mutation routes.

## What Is Your Testing Plan (QA)?

### Goal

Prove that latest agents, chat issue creation, CLI, server API, runtime prompts,
and Issue Detail UI no longer expose issue-bound documents, while Library file
references still work.

### Prerequisites

- Local Rudder dev database.
- At least one seeded issue with a description containing a Library reference.
- Optional historical fixture with an `issue_documents` row to prove it no
  longer surfaces as an active Issue Detail Library card.

### Test Scenarios / Cases

- Chat assistant prompt/schema does not mention `planDocument`.
- Chat issue proposal approval creates an issue without writing
  `issue_documents`.
- CLI help output does not list `rudder issue documents`.
- Agent CLI registry does not list issue document capabilities.
- Old issue document route returns the chosen retired response, or no longer
  exists if routes are removed.
- `GET /issues/:id` response has no `planDocument` or `documentSummaries`.
- Issue Detail shows Library links from explicit issue description/comment
  mentions.
- Issue Detail does not show a Library card only from a historical
  `issue_documents` row.
- Runtime prompt context does not include issue document bodies.

### Expected Results

- Latest user and agent-facing surfaces point to Project Library authoring.
- Historical data remains in storage unless the implementation includes an
  explicit migration.
- Existing Library mention rendering remains unchanged.

### Pass / Fail

To be filled during implementation.

## Documentation Changes

- Update `doc/CLI.md` to remove issue document command references.
- Update `doc/SPEC-implementation.md` to mark issue documents retired or remove
  the API/data-model section if the implementation removes the surface fully.
- Update bundled agent operating instructions and any skill/reference docs that
  still teach issue-bound documents.
- Add a note to the implementation issue explaining that Project Library files
  plus description/comment links are now the supported replacement.

## Open Issues

1. HTTP route behavior: remove routes outright or return `410 Gone` for one
   release window.
2. Database cleanup timing: keep historical `issue_documents` rows until a later
   migration, or drop immediately after active readers/writers are removed.
3. Historical Library UI labels: if migrated issue docs are already represented
   as Library documents, decide whether to hide only issue-link badges or remove
   those migrated Library entries from default issue-linked surfaces.
