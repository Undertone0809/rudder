---
title: Messenger Side Panel Session State
date: 2026-07-07
kind: proposal
status: completed
area: ui
entities:
  - side_panel
  - messenger_chat
  - issue_surface
related_plans:
  - 2026-07-01-global-side-panel-workbench.md
supersedes: []
related_code:
  - doc/product/domains/collaboration/chat-messenger-im.md
  - doc/product/registry.yml
  - ui/src/context/SidePanelContext.tsx
  - ui/src/components/Layout.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - tests/e2e/chat-side-panel.spec.ts
commit_refs: []
updated_at: 2026-07-07
---

# Messenger Side Panel Session State

## Overview

Messenger Side Panel tabs should behave like a temporary workbench attached to
the active Messenger item, not like one global drawer whose contents are erased
whenever it is hidden. Chat conversations and concrete issue threads need their
own in-memory tab sets for the current app session.

## What Is The Problem?

Today the Side Panel's hidden state and tab lifecycle are coupled. When the
operator hides the Side Panel and opens it again, the previously opened tab is
gone. When the operator moves across Messenger items, the global tab state can
also imply the wrong context because the panel is not keyed to the selected chat
session or issue.

That breaks the intended Messenger workflow: operators inspect a referenced
issue, chat, Library object, or browser-like target beside the current
conversation, then temporarily hide it to focus on the thread. Hiding the panel
should not mean the workbench has been reset.

## What Will Be Changed?

- Add session-scoped Side Panel state keyed by stable Messenger item context.
- Use `chat:<conversationId>` for chat contexts.
- Use `issue:<issueId>` for concrete Messenger issue contexts.
- Keep global/non-Messenger Side Panel behavior available for routes without a
  stable Messenger item key.
- Make hiding the panel preserve tabs and active tab for the current context.
- Keep explicit tab close as the action that removes a tab.
- When switching to a Messenger item with no Side Panel history, default to a
  closed panel instead of showing the previous item's tabs or auto-opening an
  empty picker.
- Allow all Side Panel tab state to clear on app restart; no server persistence
  or localStorage tab recovery is required.

## Success Criteria For Change

- Opening a Side Panel tab from chat A, hiding the panel, and reopening it in
  chat A restores the tab and active tab.
- Switching from chat A to chat B with no Side Panel history does not show chat
  A's tabs and keeps the panel closed by default.
- If chat B later gets its own tabs, switching between chat A and chat B restores
  each item's own active tab.
- Closing a tab removes it from that item's session state.
- Restarting the app may clear all Side Panel tabs.

## Out Of Scope

- Persisting Side Panel tabs in the database.
- Syncing Side Panel tabs across devices or operators.
- Restoring tabs after app restart.
- Supporting every synthetic Messenger aggregate row as a first-class Side
  Panel context in this iteration.
- Reworking issue, automation, Library, chat, or browser target internals beyond
  the state scoping needed for this behavior.

## Non-Functional Requirements

- Maintainability: keep state ownership in `SidePanelContext` and route context
  mapping in `Layout`, rather than duplicating panel state in Chat or Messenger
  pages.
- Usability: hiding, switching, reopening, and closing tabs must have distinct
  outcomes that match common workbench expectations.
- Accessibility: existing tab roles, selected state, and close controls should
  remain intact.

## User Experience Walkthrough

1. The operator opens Messenger chat A.
2. The operator opens a referenced issue or chat in the Side Panel.
3. Rudder records the tab under chat A's session context and makes it active.
4. The operator hides the Side Panel.
5. Rudder hides the panel but keeps chat A's tab state in memory.
6. The operator reopens the Side Panel while still in chat A.
7. Rudder restores chat A's tabs and active tab.
8. The operator switches to chat B, which has no Side Panel state.
9. Rudder closes the Side Panel by default and does not show chat A's tabs.
10. The operator returns to chat A.
11. If the panel is opened for chat A, Rudder restores chat A's previous tabs.

## Implementation

### Product Or Technical Architecture Changes

`SidePanelContext` should store a map of context keys to `{ tabs, activeKey }`.
The provider continues to own global panel visibility, while the current route
chooses which tab bucket is active.

`Layout` should derive the current Side Panel context key from organization
relative routes:

- `/messenger/chat/:conversationId` -> `chat:<conversationId>`
- `/messenger/issues/:issueId` -> `issue:<issueId>`
- `/chat/:conversationId` -> `chat:<conversationId>`

Routes with no stable context key fall back to the global context.

### Breaking Change

No API, database, or product-storage breaking change is intended. The behavioral
change is that hiding the panel no longer clears tabs, and switching to a new
Messenger item with no history closes the panel instead of carrying old tabs.

### Design

Keep these actions separate:

- `hidePanel`: set `open=false`, preserve current context tabs.
- `openEmpty`: show the panel and set the active target to the empty picker for
  the current context.
- `openTarget`: add or focus a tab in the current context and open the panel.
- `closeTarget`: remove a tab from the current context.
- `setContextKey`: switch the active context. If the panel is already open and
  the new context has no state, close it.

## What Is Your Testing Plan (QA)?

### Goal

Prove the Side Panel now follows the active Messenger work item and that hide,
switch, reopen, and close have distinct behaviors.

### Prerequisites

- Existing web E2E dev setup.
- Seeded organization with at least two Messenger chat threads and side-panel
  link targets.

### Test Scenarios / Cases

- Unit: route paths resolve to the expected Side Panel context keys.
- E2E: open two tabs from chat A, hide the panel, reopen it, and verify the same
  tabs and active tab return.
- E2E: hide the panel, switch to chat B with no history, and verify the panel
  remains closed and does not inherit chat A tabs.
- E2E: reopen panel in chat B and verify it starts empty.
- E2E: switch back to chat A and verify chat A's active tab is restored.
- E2E: open a Side Panel tab in a concrete Messenger issue route, hide and
  restore it, switch to a no-history chat without inheriting issue state, and
  return to the issue with its own tab state restored.

### Expected Results

Each Messenger item has independent in-memory Side Panel state for the current
app session. No unrelated item inherits tabs from another item.

### Pass / Fail

Passed implementation verification on 2026-07-07 with focused unit, product
logic, typecheck, changed-lint, and E2E checks.

## Documentation Changes

- Update `CHAT.SIDE.PANEL.001` in
  `doc/product/domains/collaboration/chat-messenger-im.md`.
- Add this plan to `CHAT.SIDE.PANEL.001` in `doc/product/registry.yml`.

## Open Issues

- Synthetic Messenger rows such as approvals, failed runs, and aggregate issue
  inboxes may need their own context keys later. This proposal intentionally
  keeps the first iteration to chat conversations and concrete issues.
