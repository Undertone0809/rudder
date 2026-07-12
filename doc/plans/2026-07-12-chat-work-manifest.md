---
title: Chat Work Manifest
date: 2026-07-12
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - chat_work_manifest
  - side_panel
  - library
issue:
related_plans:
  - 2026-07-01-global-side-panel-workbench.md
  - 2026-07-07-messenger-side-panel-session-state.md
  - 2026-07-11-chat-transcript-local-file-preview.md
  - 2026-06-02-library-project-workspace-contract.md
supersedes: []
related_code:
  - packages/db/src/schema/chat_work_manifest_items.ts
  - packages/shared/src/types/chat.ts
  - packages/shared/src/chat-work-manifest.ts
  - server/src/services/chat-work-manifest.ts
  - server/src/routes/chats.ts
  - ui/src/api/chats.ts
  - ui/src/pages/Chat.work-manifest.tsx
  - ui/src/pages/Chat.tsx
  - doc/product/domains/collaboration/chat-messenger-im.md
  - doc/product/domains/library-and-context/documents-and-work-products.md
  - tests/e2e/chat-work-manifest.spec.ts
commit_refs: []
updated_at: 2026-07-12
---

# Chat Work Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact, trustworthy Work manifest to Messenger Chat so operators can inspect the current conversation's Outputs, Sources, and References and reach a separate Project roll-up without searching the transcript.

**Architecture:** Persist normalized manifest items in a new organization-scoped table and reconcile them from active visible Chat messages, attachments, Library references, and attached Project resources. A dedicated endpoint returns current-thread sections plus a project-wide count; a focused React component renders the compact shelf and delegates object inspection to the existing Side Panel. Output classification requires structured production evidence and never promotes arbitrary Agent links.

**Tech Stack:** PostgreSQL, Drizzle ORM, Express, TypeScript, React, TanStack Query, Vitest, Playwright, and the existing Side Panel target controller.

---

## Approved Product Decisions

- Current Chat is the primary scope.
- Project assets remain a separate second-level roll-up and never mix into the current Chat rows.
- The only sections are `Outputs`, `Sources`, and `References`; there is no `Browser` section.
- External URLs are extracted only from visible user and assistant message bodies, not transcripts, tool logs, reasoning, stdout, or stderr.
- One target has one primary category per conversation with priority `output > source > reference`.
- Outputs require structured evidence: an Agent-created Chat attachment, or an assistant Library reference under `artifacts/...` with a producing Run id.
- Sources include user attachments, user Library references, user-provided URLs, and Project resources actually eligible for a project-scoped run.
- References are deduplicated external websites from visible messages that are not Sources or Outputs.
- Clicking internal targets reuses the existing Side Panel. External references keep the current safe external-link behavior and expose message provenance.
- Wide desktop renders a compact top-right shelf. Narrow layouts use a header control that opens the same manifest on demand.
- V1 does not add `Create document`, `Create site`, Browser-session aggregation, tool-history collection, or automatic promotion into `CONTEXT.RESOURCES.001`.

## Product Logic Delta

Affected contracts:

- Add `CHAT.THREAD.MANIFEST.001` as the owning logic contract.
- Update `CHAT.LIFECYCLE.001` for manifest reconciliation on message, attachment, edit, refresh, and fork flows.
- Update `CHAT.SIDE.PANEL.001` for opening manifest targets through the existing workbench.
- Update `DOCUMENT.WORKPRODUCT.001` so Chat-native structured outputs are inspectable without requiring an Issue.
- Clarify `CONTEXT.RESOURCES.001`: manifest References are not admitted Project Context Resources.

## File Structure

- `packages/db/src/schema/chat_work_manifest_items.ts`: durable manifest row, provenance, classification, lifecycle state, and organization/conversation/project indexes.
- `packages/shared/src/chat-work-manifest.ts`: pure Markdown-visible-link extraction, URL normalization, target keys, and category precedence.
- `packages/shared/src/types/chat.ts`: public manifest item, section, project roll-up, and response contracts.
- `server/src/services/chat-work-manifest.ts`: reconcile current active messages and list current/project manifest state.
- `server/src/routes/chats.ts`: organization-scoped `GET /api/chats/:id/work-manifest` endpoint.
- `ui/src/pages/Chat.work-manifest.tsx`: isolated responsive shelf, section rows, origin labels, counts, and empty/error states.
- `ui/src/pages/Chat.tsx`: query integration, current-message jump handler, and Side Panel target delegation.
- `tests/e2e/chat-work-manifest.spec.ts`: real Chat workflow for Sources, Outputs, References, deduplication, project separation, and responsive behavior.

## Task 1: Guard The Product Contract

**Files:**
- Modify: `doc/product/domains/collaboration/chat-messenger-im.md`
- Modify: `doc/product/domains/collaboration/README.md`
- Modify: `doc/product/domains/library-and-context/documents-and-work-products.md`
- Modify: `doc/product/domains/library-and-context/resources-library-workspaces.md`
- Modify: `doc/product/surfaces/surface-domain-map.md`
- Modify: `doc/product/registry.yml`

- [ ] **Step 1: Add the owning contract**

Add `CHAT.THREAD.MANIFEST.001` with Why, Product model, Flow, Invariants, and Evidence. State the three categories, project separation, provenance rules, visible-message boundary, structured Output evidence, reconciliation behavior, category precedence, and exclusion of Browser/tool history.

- [ ] **Step 2: Synchronize adjacent contracts**

Add explicit cross-references to Chat lifecycle, Side Panel, work products, and Project Context. Preserve the rule that an external manifest Reference is not a Project Context Resource until an operator explicitly attaches it.

- [ ] **Step 3: Register traceability**

Add the new contract to `doc/product/registry.yml` with the exact code and test paths in this plan, and map it in the collaboration README and surface-domain map.

- [ ] **Step 4: Run the registry gate**

Run: `pnpm product-logic:check`

Expected: PASS with `CHAT.THREAD.MANIFEST.001` present in the registry and document frontmatter.

## Task 2: Define And Test Manifest Extraction

**Files:**
- Create: `packages/shared/src/chat-work-manifest.ts`
- Create: `packages/shared/src/chat-work-manifest.test.ts`
- Modify: `packages/shared/src/types/chat.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing extraction tests**

Cover Markdown links, bare HTTP(S) URLs, links inside inline/fenced code, trailing punctuation, duplicate canonical URLs, Library entry/file references, image Markdown exclusion, and category priority.

The public pure API is:

```ts
export type ChatWorkManifestCategory = "output" | "source" | "reference";

export interface ExtractedChatWorkTarget {
  targetType: "external_url" | "library_entry" | "library_file";
  targetKey: string;
  title: string;
  url: string | null;
  metadata: Record<string, unknown>;
}

export function extractVisibleChatWorkTargets(markdown: string): ExtractedChatWorkTarget[];
export function normalizeChatWorkExternalUrl(value: string): string | null;
export function preferChatWorkManifestCategory(
  current: ChatWorkManifestCategory,
  candidate: ChatWorkManifestCategory,
): ChatWorkManifestCategory;
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm --filter @rudderhq/shared test -- chat-work-manifest.test.ts`

Expected: FAIL because the module and exports do not exist.

- [ ] **Step 3: Implement the pure extractor**

Strip fenced and inline code before parsing. Reuse `parseLibraryEntryMentionHref` and `parseLibraryFileMentionHref`, normalize HTTP(S) URLs with the standard `URL` API, remove fragments, lowercase hostnames, remove default ports, and keep path/query identity.

- [ ] **Step 4: Verify shared tests pass**

Run: `pnpm --filter @rudderhq/shared test -- chat-work-manifest.test.ts`

Expected: PASS.

## Task 3: Persist And Reconcile The Thread Manifest

**Files:**
- Create: `packages/db/src/schema/chat_work_manifest_items.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/migrations/0099_chat_work_manifest.sql`
- Create: `server/src/services/chat-work-manifest.ts`
- Create: `server/src/__tests__/chat-work-manifest.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover:

- user attachments become Sources;
- Agent-created attachments become Outputs;
- user URLs become Sources and assistant URLs become References;
- assistant `library-entry://...?...p=artifacts/...` with `runId` becomes Output;
- the same target resolves to one row using `output > source > reference`;
- superseded message References disappear on reconcile;
- persisted Outputs survive message refresh/edit reconciliation;
- project resources become Sources only when the Chat has project context and a project-scoped assistant Run;
- project roll-up counts other conversations without mixing their rows into the current sections;
- forked copied assistant messages with `runId = null` do not become Outputs;
- organization boundaries are enforced.

- [ ] **Step 2: Verify service tests fail**

Run: `pnpm --filter @rudderhq/server test -- chat-work-manifest.test.ts`

Expected: FAIL because the schema and service do not exist.

- [ ] **Step 3: Add the durable schema**

Create `chat_work_manifest_items` with:

```ts
id, orgId, conversationId, projectId, messageId, runId,
category, targetType, targetKey, title, url, status,
sourceRole, createdByAgentId, createdByUserId, metadata,
createdAt, updatedAt
```

Add a unique index on `(conversation_id, target_key)`, an organization/conversation/category index, and an organization/project/category index. Foreign keys must cascade with organization/conversation and set optional provenance fields to null.

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate -- --name chat_work_manifest`

Expected: `packages/db/src/migrations/0099_chat_work_manifest.sql` plus updated Drizzle metadata.

- [ ] **Step 5: Implement reconciliation**

`chatWorkManifestService(db)` exposes:

```ts
reconcileConversation(conversationId: string): Promise<void>;
getConversationManifest(conversationId: string): Promise<ChatWorkManifestResponse>;
```

Read only non-superseded user/assistant messages. Build candidates from message attachments, visible body targets, Library artifact references, and eligible Project resources. Upsert the preferred candidate for each target key, delete stale non-Output derived rows, and preserve durable Output rows.

- [ ] **Step 6: Verify service tests pass**

Run: `pnpm --filter @rudderhq/server test -- chat-work-manifest.test.ts`

Expected: PASS.

## Task 4: Expose The Organization-Scoped API

**Files:**
- Modify: `server/src/routes/chats.ts`
- Modify: `server/src/__tests__/chat-routes.test.ts`
- Modify: `ui/src/api/chats.ts`
- Modify: `ui/src/lib/queryKeys.ts`

- [ ] **Step 1: Write failing route tests**

Add cases for board access, missing Chat, cross-organization denial, empty manifest, populated sections, and project roll-up counts.

- [ ] **Step 2: Verify route tests fail**

Run: `pnpm --filter @rudderhq/server test -- chat-routes.test.ts -t "work manifest"`

Expected: FAIL with route not found.

- [ ] **Step 3: Add the route and client**

Add:

```text
GET /api/chats/:id/work-manifest
```

The route must call the existing `assertConversationAccess`, reconcile the current conversation, and return typed sections plus `{ projectId, totalCount }`. Add `chatsApi.getWorkManifest(chatId)` and `queryKeys.chats.workManifest(orgId, chatId)`.

- [ ] **Step 4: Verify API tests pass**

Run: `pnpm --filter @rudderhq/server test -- chat-routes.test.ts -t "work manifest"`

Expected: PASS.

## Task 5: Render The Responsive Work Shelf

**Files:**
- Create: `ui/src/pages/Chat.work-manifest.tsx`
- Create: `ui/src/pages/Chat.work-manifest.test.tsx`
- Modify: `ui/src/pages/Chat.tsx`

- [ ] **Step 1: Write failing component tests**

Cover section ordering, maximum visible rows, `View all`, empty/loading/error states, origin labels, Source add action, Project roll-up separation, wide shelf visibility, compact trigger, and hiding while Side Panel is open.

- [ ] **Step 2: Verify component tests fail**

Run: `pnpm --filter @rudderhq/ui test -- Chat.work-manifest.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the isolated component**

Expose:

```ts
interface ChatWorkManifestProps {
  manifest: ChatWorkManifestResponse | null;
  loading: boolean;
  error: string | null;
  sidePanelOpen: boolean;
  onOpenItem(item: ChatWorkManifestItem): void;
  onJumpToMessage(messageId: string): void;
  onAddSource(): void;
  onOpenProject(projectId: string): void;
}
```

Use one compact surface with full-width section bands, restrained borders, existing radius tokens, Lucide icons, stable row heights, accessible labels, and no nested cards.

- [ ] **Step 4: Integrate with Chat**

Fetch only for a selected native or readable Chat. Internal Library targets call `openSidePanelTargetForContext`; external URLs keep safe external navigation; provenance actions call the existing `jumpToChatMessage`; `Add source` opens the current composer file/options flow; Project roll-up navigates to the linked Project detail.

- [ ] **Step 5: Verify component and existing Chat tests pass**

Run: `pnpm --filter @rudderhq/ui test -- Chat.work-manifest.test.tsx Chat.test.tsx Chat.attachment-preview.test.tsx`

Expected: PASS.

## Task 6: Add Real Workflow E2E And Visual Proof

**Files:**
- Create: `tests/e2e/chat-work-manifest.spec.ts`

- [ ] **Step 1: Seed a production-shaped Chat**

Create one project with attached context, two project Chats, user attachments and URLs, assistant final links, one Agent-generated attachment, one Run-backed Library artifact reference, duplicates, and a superseded assistant variant.

- [ ] **Step 2: Verify the desktop workflow**

At `1440x900`, assert that the current Chat shelf shows Outputs/Sources/References, excludes Browser, deduplicates URLs, labels provenance, keeps Project assets separate, opens a Library Output in Side Panel, and returns after closing the panel.

- [ ] **Step 3: Verify the narrow workflow**

At `1024x768`, assert that the floating shelf is replaced by the compact Work count trigger and that opening it does not overlap the composer or transcript.

- [ ] **Step 4: Run the E2E**

Run: `pnpm test:e2e -- tests/e2e/chat-work-manifest.spec.ts`

Expected: PASS.

- [ ] **Step 5: Capture screenshots outside the repository**

Save final desktop, narrow, and Side Panel-open screenshots under `/tmp/rudder-chat-work-manifest/` and inspect them for overlap, truncation, dark/light readability, and correct object framing.

## Task 7: Full Verification And Delivery

**Files:**
- Modify: `doc/plans/2026-07-12-chat-work-manifest.md`

- [ ] **Step 1: Run focused gates**

```bash
pnpm product-logic:check
pnpm --filter @rudderhq/shared test -- chat-work-manifest.test.ts
pnpm --filter @rudderhq/server test -- chat-work-manifest.test.ts
pnpm --filter @rudderhq/ui test -- Chat.work-manifest.test.tsx
pnpm test:e2e -- tests/e2e/chat-work-manifest.spec.ts
```

Expected: all PASS.

- [ ] **Step 2: Run repository gates**

```bash
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all PASS. Report any unrelated pre-existing failure with the exact command and evidence.

- [ ] **Step 3: Update plan metadata**

Set plan `status: completed`, update `updated_at`, and add the final Conventional Commit subject to `commit_refs`.

- [ ] **Step 4: Commit only this feature**

Stage the plan, Product Logic files, manifest schema/migration/shared/server/UI files, focused tests, and E2E. Do not stage the existing release workflow, Side Panel polish, local-file-preview, or screenshot changes that predated this task.

Commit message:

```text
feat: add chat work manifest
```

- [ ] **Step 5: Push the current branch**

Run: `git push origin codex/automation-three-column-detail`

Expected: the feature commit is present on the current remote branch without unrelated dirty files in the commit.
