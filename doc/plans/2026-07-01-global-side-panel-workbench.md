---
title: Global Side Panel Workbench
date: 2026-07-01
kind: implementation
status: planned
area: ui
entities:
  - side_panel
  - messenger_chat
  - library
  - issue_surface
related_plans:
  - 2026-06-30-chat-side-panel.md
  - 2026-06-30-org-library-folder-and-backup-zip.md
  - 2026-06-24-messenger-render-performance.md
  - 2026-06-23-feishu-read-only-chat-fork.md
supersedes:
  - 2026-06-30-chat-side-panel.md
related_code:
  - doc/product/domains/collaboration/chat-messenger-im.md
  - doc/product/domains/library-and-context/resources-library-workspaces.md
  - doc/product/domains/automations/definition-triggers-runs.md
  - doc/product/domains/issues/surfaces.md
  - doc/product/surfaces/surface-domain-map.md
  - ui/src/App.tsx
  - ui/src/components/Layout.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.parts.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/AutomationDetail.tsx
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/CommentThread.tsx
  - tests/e2e/chat-side-panel.spec.ts
commit_refs: []
updated_at: 2026-07-01
---

# Global Side Panel Workbench

## Summary

Upgrade the current Chat-local Side Panel direction into a reusable global workbench that can be opened from every Rudder page. The side panel should not be a passive preview drawer; it should let operators keep context in place while directly working on issues, automations, Library files/documents, browser-like references, and chats.

The earlier `2026-06-30-chat-side-panel.md` plan is superseded because the product direction changed from "open chat references beside Chat" to "global side panel workbench with tabs, add-tab actions, object operations, shared Library tree, and a comment/composer bottom area."

## Problem

The current implementation direction still treats the side panel as a Chat-specific reference preview. That misses the product job:

- Operators need to inspect and operate on related work without leaving their current page.
- Side panel tabs should behave like a compact workspace, not a one-off drawer.
- Issue, automation, Library, browser, and chat objects should be reachable from a shared shell.
- Empty side panel state should help the user choose what to open next.
- Library browsing inside the side panel must use the same file-tree behavior and visual language as the full Library page.
- The bottom region should be a useful comment/conversation area like Feishu task details, not a generic "Open full page" footer.

This is a product-surface change, not just CSS polish. It affects Chat, Messenger, issues, automations, Library, and the app layout shell.

## Product Contract Alignment

Read and align before implementation:

- `CHAT.LIFECYCLE.001`: Chat remains intake/lightweight work, but side panel can preserve chat context while operating on referenced objects.
- `CHAT.RICH.REFERENCE.RENDERING.001`: supported internal references can open side panel targets instead of navigating away on normal click.
- `LIBRARY.FILES.001`: Library file operations must use existing organization-scoped workspace APIs, path safety, protected-root behavior, and stable references.
- `AUTOMATION.DEFINITION.001`: automation edit/pause affordances must preserve definition ownership, context, status, and organization boundaries.
- `AUTOMATION.TRIGGER.001`: trigger edits must use existing trigger APIs and must not silently dispatch work.
- `ISSUE.SURFACE.001`: issue mutation errors must be visible, and the side panel must not redefine run/review/routing semantics.
- `MESSENGER.ATTENTION.001`: side panel comment/chat affordances must preserve native attention/read semantics.

No `doc/product/**` edits are authorized by this plan alone. After implementation, propose a guarded Product Logic Registry update that adds a side-panel surface contract under collaboration/surfaces and maps it in `doc/product/surfaces/surface-domain-map.md`.

## Scope

In scope:

- A global side panel shell mounted at the board layout level, not inside `Chat` only.
- A shared side panel target model and controller/provider.
- Tabs at the top of the side panel, including close and add-tab affordances.
- Empty side panel state with actions for `Browser`, `Library`, and `Issue`, matching the latest screenshot direction.
- Add-tab menu similar to the reference image, with initial choices:
  - `Issue`
  - `Automation`
  - `Library`
  - `Chat`
  - `Browser` placeholder target
- Object views that support direct operations:
  - Issue: title, description, status, priority, project metadata display, and comment area.
  - Automation: title/description/status pause-resume, trigger summary, run history, and no direct "Run now" in the panel.
  - Library file/doc: shared Library tree, text file/document edit/save, preview fallback for images/PDF/binary.
  - Chat: message context plus a "remember" affordance that can pin/open the chat target in the panel and attach it to the current work context if an existing API supports it.
  - Browser: first iteration placeholder/search/open-target surface unless a real browser/webview capability already exists in the app.
- Bottom region becomes a comment/composer area for objects that support discussion:
  - Issue: issue comments.
  - Chat: chat composer or latest-message context.
  - Automation: lightweight note/comment placeholder only if a first-class automation comment API does not exist.
  - Library: save/status strip plus optional notes placeholder, not an unrelated full-page button.
- Full-page navigation remains available as a small secondary action in the object toolbar.
- Current Chat link interception uses the global controller instead of local state.
- Existing Chat side panel WIP may be reused, but it must be extracted and reconciled rather than shipped as a Chat-only endpoint.

Out of scope for the first delivery:

- Server-side persistence of open panel tabs across devices.
- Drag-and-drop tab reordering.
- A fully embedded remote browser/webview if no existing secure browser surface exists.
- New backend comment model for automations or Library unless product explicitly approves it.
- Replacing full `/library`, `/issues`, `/automations`, or `/messenger/chat` pages.
- Editing protected Library/agent/skill paths that the full Library page treats as read-only or managed.

## Architecture

Mount the side panel under the existing board `Layout`, because `Layout` is shared by Chat, Messenger, issues, automations, Library, projects, agents, and other organization pages. Use a new side panel provider to keep tabs, active tab, open/close state, add-tab menu state, and target parsing independent of any one page.

Recommended file structure:

- Create `ui/src/context/SidePanelContext.tsx`
  - Own global side panel state and actions: `openTarget`, `closeTarget`, `setActiveTarget`, `openEmpty`, `openAddMenu`, `resetForOrganization`.
  - Store tabs in memory first. Optional `localStorage` can remember open state per organization only after MVP works.
- Create `ui/src/lib/side-panel-targets.ts`
  - Own target types, stable keys, labels, href parsing, full-page href generation, and mention/internal-route parsing.
  - Move reusable logic out of `ui/src/pages/Chat.parts.tsx`.
- Create `ui/src/components/side-panel/GlobalSidePanel.tsx`
  - Own top tab chrome, add-tab button/menu, empty picker, panel card layout, responsive overlay behavior, and target view dispatch.
- Create `ui/src/components/side-panel/SidePanelTabs.tsx`
  - Top tabs with close buttons and add-tab trigger.
- Create `ui/src/components/side-panel/SidePanelEmptyState.tsx`
  - Empty state with selectable Browser, Library, Issue actions.
- Create `ui/src/components/side-panel/views/IssueSidePanelView.tsx`
  - Issue detail/edit/comment view.
- Create `ui/src/components/side-panel/views/AutomationSidePanelView.tsx`
  - Automation detail/edit/status/trigger/run view.
- Create `ui/src/components/side-panel/views/LibrarySidePanelView.tsx`
  - Library tree plus file/document edit/preview view.
- Create `ui/src/components/side-panel/views/ChatSidePanelView.tsx`
  - Chat context/detail/composer view.
- Create `ui/src/components/side-panel/views/BrowserSidePanelView.tsx`
  - Browser placeholder/search/open URL view.
- Extract from `ui/src/pages/OrganizationWorkspaces.tsx` into reusable Library tree modules:
  - `ui/src/components/library/WorkspaceTree.tsx`
  - `ui/src/components/library/workspace-tree-model.ts`
  - `ui/src/components/library/workspace-file-editor.tsx`
- Modify `ui/src/components/Layout.tsx`
  - Render `GlobalSidePanel` next to the main workspace card layout.
  - Add global open/close keyboard and toolbar affordance if needed.
- Modify `ui/src/main.tsx`
  - Wrap the app with `SidePanelProvider` inside `OrganizationProvider` and `QueryClientProvider`.
- Modify `ui/src/pages/Chat.tsx`, `ui/src/pages/Chat.parts.tsx`, `ui/src/pages/Chat.side-panel.tsx`
  - Remove Chat-local side panel state after migration.
  - Keep Chat link interception, but call `useSidePanel().openTarget(...)`.
- Modify tests:
  - `ui/src/lib/side-panel-targets.test.ts`
  - `ui/src/components/side-panel/GlobalSidePanel.test.tsx`
  - `ui/src/pages/Chat.attachment-preview.test.tsx`
  - `ui/src/pages/Chat.test.tsx`
  - `tests/e2e/chat-side-panel.spec.ts`
  - Add `tests/e2e/global-side-panel-workbench.spec.ts`

## Delivery Plan

### Phase 0: Reconcile Current WIP And Scope

1. Inspect `git status --short` and split current dirty files into:
   - side-panel implementation files
   - markdown/issue status chip changes related to the screenshots
   - unrelated runtime/MCP changes
   - untracked plan/probe files
2. Do not revert user or parallel-agent work.
3. Keep side-panel WIP as reference material, but do not commit it until global architecture is in place.
4. Stage/commit only the plan if the user wants a plan checkpoint before implementation.
5. Record reviewer finding: current WIP is blocked by scope pollution and incomplete direct operations.

Exit criteria:

- `git status --short` inventory is understood.
- New work has a clear stage boundary.
- No unrelated runtime/MCP files are staged with side-panel work.

### Phase 1: Product Delta And Target Model

1. Write tests for `ui/src/lib/side-panel-targets.ts`:
   - parses issue, automation, chat, Library file, Library directory, Library entry, Library document, and internal `/automations/:id`, `/issues/:id`, `/library?...` routes.
   - preserves modifier-click and unknown external URL behavior through caller helpers.
   - generates stable keys and full-page hrefs.
2. Implement `side-panel-targets.ts`.
3. Update `Chat.parts.tsx` to consume shared parsing or remove duplicate parsing after migration.
4. Draft Product Logic Registry delta, but do not edit `doc/product/**` yet:
   - new side-panel surface contract under collaboration or surfaces.
   - map affected domains: collaboration, issues, automations, library-and-context.

Exit criteria:

- Target parsing tests pass.
- Product doc delta is named in handoff and plan.

### Phase 2: Global Side Panel Shell

1. Create `SidePanelProvider` with actions:
   - `openTarget(target, options?)`
   - `openEmpty()`
   - `closeTarget(key)`
   - `closePanel()`
   - `setActiveKey(key)`
   - `replaceTarget(key, nextTarget)`
2. Render `GlobalSidePanel` from `Layout`.
3. Implement three-card visual stack:
   - top tab card
   - content card
   - bottom comment/composer card when supported
4. Remove the generic "Side Panel" body heading and oversized content close button.
5. Keep object title/type inside content when useful, matching latest screenshot.
6. Add add-tab button and menu:
   - Issue
   - Automation
   - Library
   - Chat
   - Browser
7. Add empty state:
   - Browser
   - Library
   - Issue
8. Add responsive behavior:
   - desktop inline right panel
   - mobile overlay panel
9. Add accessibility:
   - `role="tablist"` and `role="tab"`
   - close buttons with target labels
   - menu keyboard navigation
   - Escape closes add menu, not necessarily whole panel unless focus is inside panel shell.

Exit criteria:

- Global panel can open empty from any board page.
- Add tab menu opens and creates placeholder target tabs.
- Layout still works on Chat, Library, Issues, Automations, Dashboard.

### Phase 3: Issue Workbench View

1. Move current issue view from `Chat.side-panel.tsx` to `IssueSidePanelView.tsx`.
2. Keep Feishu-like detail layout:
   - title
   - identifier
   - status
   - priority
   - project
   - owner/reviewer
   - updated time
   - details
3. Support direct operations:
   - title edit/save/cancel
   - description edit/save/cancel
   - status change
   - priority change
4. Add error handling:
   - failed save displays inline error near the edited section
   - failed status/priority change shows inline error and does not silently swallow
5. Replace bottom full-page footer with issue comment area:
   - load comments with existing issue comments API
   - add comment with existing issue comment API
   - link to full page as a secondary icon/button near title toolbar
6. Add tests:
   - edit title/description success
   - edit failure visible
   - status/priority mutation failure visible
   - comment submit success and failure

Exit criteria:

- Issue panel is an operational task detail panel, not a read-only preview.
- `ISSUE.SURFACE.001` error requirement is satisfied.

### Phase 4: Automation Workbench View

1. Move current automation view into `AutomationSidePanelView.tsx`.
2. Support direct operations:
   - title edit/save/cancel
   - description/instructions edit/save/cancel
   - pause/resume status switch
   - trigger enabled switch if existing trigger API supports it safely
3. Do not add a direct "Run now" button in the panel.
4. Keep run history and status summary visible.
5. Add full-page link as secondary action.
6. Add tests:
   - automation mention/internal route opens side panel
   - title/description save calls `automationsApi.update`
   - pause/resume calls `automationsApi.update`
   - no "Run now" button exists in panel
   - mutation failure shows inline error

Exit criteria:

- Automation panel lets the user manage the definition without accidental dispatch.
- Automation panel still preserves output routing/run evidence visibility.

### Phase 5: Library Workbench View And Shared File Tree

1. Extract reusable Library tree behavior from `OrganizationWorkspaces.tsx`:
   - tree entry model
   - expansion state
   - selected path handling
   - icon/label/badge rendering
   - protected/read-only display
2. Reuse the same tree in:
   - full Library page
   - side panel Library view
3. Support Library side panel operations:
   - browse folders
   - open file in tab
   - text file edit/save/cancel
   - Library document edit/save/cancel for `library-doc://` targets
   - image/PDF/binary preview fallback
4. Remove bottom "Open full page" footer.
5. Bottom region:
   - file save status (`Saved`, `Unsaved`, `Saving`, `Failed`)
   - for docs/files that support discussion later, reserve a compact notes/comment placeholder only if there is a real model; otherwise do not fake comments.
6. Add tests:
   - side panel tree renders same folders/files as Library page fixture
   - open folder expands tree
   - text file save calls `organizationsApi.updateWorkspaceFile`
   - Library document save calls `organizationsApi.updateLibraryDocument`
   - protected/read-only file cannot be edited
   - binary file shows preview fallback

Exit criteria:

- Side panel Library tree visually and behaviorally matches the full Library tree.
- Library file/doc editing works from the panel where the full Library page would allow editing.

### Phase 6: Chat And Browser Targets

1. Chat target:
   - show referenced conversation/title/recent messages
   - add "remember" affordance if an existing chat pin/context API exists
   - if no existing API exists, expose a secondary "Open chat" action and record the missing product/API requirement rather than inventing persistence
   - optionally provide compact chat composer only when the panel target is a chat conversation and existing chat message API supports the same permissions.
2. Browser target:
   - implement first iteration as URL/reference holder unless there is an existing browser/webview product surface.
   - allow user to paste/open a URL target.
   - do not add remote fetching or embedded browser security surface without a separate review.
3. Add tests:
   - add-tab menu can create Chat and Browser target tabs
   - empty panel can choose Browser/Library/Issue
   - Browser placeholder does not perform unsafe remote fetches.

Exit criteria:

- The add-tab menu and empty state match the reference direction.
- Chat has a concrete remembered/open target behavior or a named API gap.

### Phase 7: Chat Integration Migration

1. Remove Chat-local side panel state after global shell works.
2. Update `MarkdownBody`/Chat link handling:
   - supported internal references open global side panel on normal click.
   - Cmd/Ctrl/Shift/middle click preserves normal navigation behavior.
3. Ensure Chat page layout no longer owns side panel width/card layout.
4. Keep existing rich issue status icon rendering improvements if they are part of the requested screenshot fix; otherwise split into a separate commit.
5. Update E2E:
   - from Chat, open issue/automation/library/chat references into side panel
   - add a tab through add menu
   - close a tab and keep remaining tab active
   - empty state appears when no tabs remain

Exit criteria:

- Chat uses the same global side panel as every other page.
- Current Chat side panel tests pass under the global model.

### Phase 8: Verification, Review, Product Registry Proposal

1. Run focused tests:
   - `pnpm test:run ui/src/lib/side-panel-targets.test.ts ui/src/components/side-panel/GlobalSidePanel.test.tsx ui/src/pages/Chat.attachment-preview.test.tsx ui/src/pages/Chat.test.tsx`
2. Run broader checks:
   - `pnpm lint:changed`
   - `pnpm --filter @rudderhq/ui typecheck`
   - `pnpm product-logic:check`
3. Run E2E:
   - `pnpm test:e2e tests/e2e/global-side-panel-workbench.spec.ts --project=chromium`
   - keep `tests/e2e/chat-side-panel.spec.ts` or migrate it into the new suite.
4. Browser visual proof:
   - desktop screenshot of empty side panel and add menu.
   - desktop screenshot of issue panel with comment area.
   - desktop screenshot of automation panel with editable fields and no Run Now.
   - desktop screenshot of Library tree matching full Library page.
   - mobile screenshot of overlay behavior.
5. Spawn acceptance verifier:
   - black-box user path, no edits.
6. Spawn final reviewer:
   - functional trust plus adversarial/product-systems lens.
7. Reconcile reviewer findings.
8. Commit and push only side-panel files.
9. Ask for explicit approval to update `doc/product/**` with the side-panel surface contract.

Exit criteria:

- Automated tests pass or exact blockers are reported.
- Visual evidence exists outside repo.
- Spawned verifier/reviewer pass.
- Commit excludes unrelated runtime/MCP dirty files.

## UX Acceptance Details

Required visual behavior:

- Top tabs are at the topmost panel card.
- Add-tab button sits in the top tab chrome, similar to the reference image.
- Content card and bottom comment/composer card are separate from the tab card with transparent gaps.
- No generic "Side Panel" label in the content body.
- No oversized close button in the content body; close belongs in tab chrome.
- Empty panel shows selectable rows/actions for Browser, Library, and Issue.
- Library tree uses the same hierarchy, icons, folder row states, protected/read-only badges, and spacing as the full Library page.
- Bottom area is not an "Open full page" footer. Use object-specific comment/composer/status behavior.
- Full-page navigation is a secondary action in object toolbars, not the dominant bottom CTA.

## Success Criteria

- A user can open the side panel from Chat, Issues, Automations, Library, and at least one neutral page such as Dashboard.
- A user can add a tab from the side panel itself.
- Empty side panel helps choose Browser, Library, or Issue.
- Issue panel supports edit and comment workflows with visible error handling.
- Automation panel supports non-dispatching definition operations and no direct Run Now.
- Library panel supports tree browsing and text file/document editing using the same tree as the Library page.
- Chat references open side panel targets without navigating away.
- Modifier-click behavior still navigates normally.
- The design matches existing Rudder density and the referenced Codex/Feishu side-panel language.
- Product contract deltas are documented and ready for explicit Product Logic Registry approval.

## Validation

Required before handoff:

- `pnpm lint:changed`
- `pnpm --filter @rudderhq/ui typecheck`
- `pnpm test:run ui/src/lib/side-panel-targets.test.ts ui/src/components/side-panel/GlobalSidePanel.test.tsx ui/src/pages/Chat.attachment-preview.test.tsx ui/src/pages/Chat.test.tsx`
- `pnpm test:e2e tests/e2e/global-side-panel-workbench.spec.ts --project=chromium`
- `pnpm product-logic:check`
- Browser screenshots saved under `/tmp`, not in the repo.
- Spawned verifier verdict.
- Spawned reviewer verdict.

If local isolated E2E fails before tests because of embedded PostgreSQL startup, record the exact startup log and either fix the test home conflict or run against a disposable explicit E2E home.

## Open Issues

- Product approval is needed before editing `doc/product/**`.
- The Browser target needs a security/product decision before becoming a real embedded browser.
- "Chat remember" needs confirmation against existing APIs. If no current API exists, implement only a visible placeholder/open action and create a follow-up backend/API plan.
- Automation comments do not appear to be a current first-class product model. Do not fake comments for automations unless a real persistence path is approved.
- The current dirty worktree includes unrelated runtime/MCP files. Side-panel commits must not include them.
