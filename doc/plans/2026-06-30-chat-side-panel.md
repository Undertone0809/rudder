---
title: Chat Side Panel
date: 2026-06-30
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - side_panel
  - library
  - issue_surface
issue:
related_plans:
  - 2026-06-23-feishu-read-only-chat-fork.md
  - 2026-06-24-messenger-render-performance.md
  - 2026-06-30-org-library-folder-and-backup-zip.md
supersedes: []
related_code:
  - doc/product/domains/collaboration/chat-messenger-im.md
  - doc/product/domains/library-and-context/resources-library-workspaces.md
  - doc/product/domains/issues/surfaces.md
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.messages.tsx
  - ui/src/pages/Chat.parts.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/api/orgs.ts
  - ui/src/api/issues.ts
  - ui/src/api/chats.ts
  - tests/e2e/chat-side-panel.spec.ts
commit_refs: []
updated_at: 2026-07-01
---

# Chat Side Panel

## Summary

Add a general-purpose animated Side Panel to Chat. The panel lets operators open
Rudder objects referenced in chat without leaving the conversation. Library files
are the first concrete source, but the architecture must treat issue references,
Library paths/directories, chat references, artifacts, and future web pages as
panel targets rather than building a Library-specific drawer.

The approved product direction is: Chat remains the main work thread; the Side
Panel is a right-side contextual workbench with tabs. Clicking a supported object
inside chat opens or focuses a panel tab, and normal route navigation remains
available through full-page actions and modifier-click behavior.

## Problem

Agent and operator messages often produce objects that the user needs to inspect
immediately: an issue proposal/result, a Library file, a prior chat, or a linked
artifact. Today, opening those objects usually means navigating away from Chat or
losing the visible conversation context. That breaks the flow where the operator
uses Chat as intake/coordination while inspecting outputs and references.

The previous narrower Library-panel framing was insufficient because the primary
user job is object inspection from chat, not file browsing alone. The UI needs a
small extensible panel model that can host multiple object views over time.

## Product Contract Alignment

Affected current contracts:

- `CHAT.LIFECYCLE.001`: Chat is an intake and lightweight run surface; panel
  inspection must keep the chat thread active rather than turning chat into the
  primary durable work system.
- `CHAT.RICH.REFERENCE.RENDERING.001`: Rich chat references and supported links
  should be rendered as operator-friendly objects; the panel adds a new default
  click destination for supported internal references.
- `LIBRARY.FILES.001`: Library files remain durable, referenceable artifacts;
  panel file views must use existing organization-scoped workspace APIs and path
  safety rules.
- `ISSUE.SURFACE.001`: Issue compact views may summarize issue surface fields,
  but issue mutation and workflow logic remain owned by issue pages/API.

This implementation plan does not edit guarded `doc/product/**`. After the
feature lands, a separate explicit Product Logic Registry update should document
Side Panel link-opening behavior if the user approves that registry delta.

## Scope

In scope for this slice:

- Add an animated right-side `Side Panel` shell to `Chat`.
- Support tabbed panel state with open/focus/close behavior and duplicate-target
  de-duplication.
- Add an explicit Chat toolbar/header entrypoint named `Side Panel`.
- Open supported internal chat links in the Side Panel by default when clicked
  without Cmd/Ctrl modifiers.
- Support initial target kinds:
  - Library file preview.
  - Library directory listing.
  - Issue compact view.
  - Chat compact view.
- Add a `+` affordance that opens/focuses a Library browser/default view in the
  panel rather than creating a heavy generic picker yet.
- Display a Library file-count summary where the panel presents Library browsing.
- Add opening/closing motion that feels like a right-side workbench sliding in,
  respecting `prefers-reduced-motion` through CSS motion-safe classes.
- Add responsive behavior so narrow layouts use an overlay/drawer-style panel
  instead of crushing the Chat composer and message column.
- Add focused component/unit tests plus E2E coverage for opening panel targets
  from Chat and interacting with tabs.
- Use the default Rudder workflow: spawn independent reviewer and verifier agents
  before marking complete.

Out of scope for this slice:

- Editing/saving Library files inside the panel.
- Issue mutation actions inside the panel beyond full-page navigation/copy-style
  inspection actions.
- A full embedded browser/webview.
- Server-side persistence of panel tabs/layout.
- Drag-resize and tab drag-reorder.
- Replacing full `/library`, `/issues`, or `/chat` pages.

## Implementation Plan

1. Inspect existing Chat rendering and link handling.
   - Trace `MarkdownBody` link click paths in `Chat.messages.tsx`, `Chat.tsx`,
     and `Chat.parts.tsx`.
   - Identify existing internal link shapes for issues, Library references, and
     chat mentions.
   - Confirm the existing issue/chat/library read APIs and React Query keys.

2. Add target parsing and panel state primitives.
   - Create a small target type, likely in a new UI-local module such as
     `ui/src/pages/Chat.side-panel.tsx` or `ui/src/lib/chat-side-panel.ts`.
   - Normalize targets into stable keys such as `issue:<id>`,
     `library_file:<path>`, `library_directory:<path>`, and
     `chat:<id>:<messageId?>`.
   - Add a parser that converts supported hrefs into panel targets while leaving
     unknown/external URLs to normal navigation for now.
   - Preserve modifier-click behavior so Cmd/Ctrl click continues to navigate or
     open full routes rather than hijacking power-user flows.

3. Write failing tests first.
   - Component/unit tests for target parsing and tab de-duplication.
   - Chat UI test for clicking a Library/issue/chat reference and seeing a panel
     tab open.
   - E2E test `tests/e2e/chat-side-panel.spec.ts` covering the real workflow:
     render/open Chat, click supported references, verify animated panel opens,
     verify tabs and content, close/fallback.

4. Build the animated Side Panel shell.
   - Add `ChatSidePanel` with a desktop inline panel and narrow overlay mode.
   - Use CSS transitions for width/transform/opacity so opening feels deliberate
     but quiet.
   - Include `aria-label="Side Panel"`, accessible close button, tab list, and
     focusable controls.
   - Keep scrollbars quiet with `scrollbar-auto-hide`.

5. Implement initial views.
   - Library browser/default view: fetch root files, count files (bounded client
     count for loaded tree or server-provided root count if already available),
     list directories/files, open file/directory targets on click.
   - Library file view: use `organizationsApi.readWorkspaceFile`; render text and
     markdown/code safely, image/PDF/binary fallbacks using existing file detail
     fields where practical.
   - Issue view: fetch issue detail through existing issues API and show compact
     title/status/assignee/project/description plus `Open full page`.
   - Chat view: fetch the referenced chat/messages through existing chat APIs and
     show compact recent/surrounding messages plus `Open full chat`.

6. Wire Chat clicks into the panel.
   - Pass a panel-aware markdown link handler into chat message rendering.
   - If a supported target is detected and the click is not modified, prevent
     default navigation and open/focus a panel tab.
   - Keep existing normal link behavior for unsupported hrefs.

7. Validate and review.
   - Run focused unit/component tests.
   - Run the new E2E path and visually inspect the rendered panel in a browser.
   - Run UI typecheck/lint for touched files.
   - Run `pnpm product-logic:check` because the feature touches documented
     chat/library/issue contracts, even though the registry is not edited.
   - Spawn a reviewer agent for code/product fit and a verifier agent for
     acceptance evidence. Iterate on any blocking findings.

8. Handoff and git.
   - Commit and push only files touched for this task, leaving unrelated dirty
     files unstaged.
   - Include Product Logic Alignment in the handoff and ask whether to update
     `doc/product/**` with the Side Panel behavior contract.

## Design Notes

- Name: user-facing copy should call the feature `Side Panel`.
- Interaction default: supported Rudder object links open in Side Panel on normal
  click; full-page navigation is still one click away through panel actions or
  modifier-click.
- Animation: use a quiet slide/fade/right-edge expansion. Avoid bouncy or
  theatrical motion; Rudder's design system calls for calm, dense, operational
  UI.
- State ownership: keep panel state local to Chat for this slice. Optional
  session/local storage can be added only if it is low risk; server persistence
  is deferred.
- Extensibility: panel targets should be discriminated by `kind`, with view
  components registered centrally enough that future artifact/web views do not
  require rewriting the shell.
- Safety: panel views must use existing organization-scoped API clients and not
  infer cross-organization object access from link strings alone.

## Success Criteria

- Chat shows a clear Side Panel entrypoint.
- Opening the Side Panel has visible motion and can be closed.
- Clicking supported Library, issue, and chat references in Chat opens/focuses a
  Side Panel tab without navigating away from Chat.
- Library browser view shows a file-count summary and can open a file directly
  in the panel.
- Multiple panel targets open as tabs; clicking the same target focuses the
  existing tab instead of duplicating it.
- Closing a tab selects a neighboring tab or returns to the default panel view.
- Narrow viewport behavior does not break the Chat composer or message column.
- Tests and E2E cover the main user flow and at least one tab/fallback edge case.
- Independent reviewer and verifier agents pass before completion.

## Validation

Required before handoff:

- `CI=true corepack pnpm test:run <focused ui test files>`
- `CI=true corepack pnpm --filter @rudderhq/ui typecheck`
- `CI=true corepack pnpm lint:changed`
- `CI=true corepack pnpm test:e2e tests/e2e/chat-side-panel.spec.ts`
- Browser/screenshot verification of the animated Side Panel on a local Rudder
  instance.
- `CI=true corepack pnpm product-logic:check`
- Independent reviewer agent verdict: PASS.
- Independent verifier agent verdict: PASS.

If any command cannot run because of existing unrelated dirty work or local
service constraints, the handoff must state the blocker and include the closest
completed evidence.

## Open Issues

- Exact issue-link shapes must be confirmed in existing Chat/Markdown helpers
  before implementation.
- Exact chat reference shape should reuse existing `chat://`/mention parsing
  instead of inventing a second chat-link format.
- Library file count may need to be limited to the currently loaded root in MVP
  unless an efficient recursive count already exists.
- Product Logic Registry updates are deferred until the user explicitly approves
  the concrete `doc/product/**` delta.
