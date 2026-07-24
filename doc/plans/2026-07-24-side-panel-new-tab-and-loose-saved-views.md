---
title: Side Panel New Tab Shortcut And Loose Saved Views
date: 2026-07-24
kind: implementation
status: in_progress
area: chat
entities:
  - side_panel
  - messenger_saved_views
  - messenger_chat
issue:
related_plans:
  - 2026-07-20-messenger-saved-views.md
  - 2026-07-23-messenger-main-workbench-promotion.md
supersedes: []
related_code:
  - desktop/src/side-panel-close-shortcut.ts
  - ui/src/context/SidePanelContext.tsx
  - server/src/services/messenger-saved-views.ts
  - ui/src/components/MessengerContextSidebar.tsx
commit_refs: []
updated_at: 2026-07-24
---

# Side Panel New Tab Shortcut And Loose Saved Views

## Summary

Make `Command+T` on macOS and `Ctrl+T` on Windows/Linux open the Side Panel's
existing `Open a panel` picker. An expanded Side Panel keeps its existing tabs;
a collapsed Side Panel opens first. Main Workbench keeps its existing Browser
new-tab shortcut when Main owns focus.

Allow Browser, Automation, Library, and Desktop Local App Saved Views to exist
as loose Messenger directory rows as well as custom-group members. Moving a row
changes only directory placement; it never closes or recreates the associated
Main tab, guest, editor, or Local App process.

## Product Logic Alignment

This approved implementation changes:

- `CHAT.SIDE.PANEL.001` for the cross-target Side Panel new-tab shortcut.
- `MESSENGER.CUSTOM.GROUPS.001` to permit loose Saved View placement and
  group separation.
- `MESSENGER.SAVED.VIEWS.001` to make custom-group membership optional while
  preserving attention exclusion and exact runtime identity.

## Implementation

1. Route the protected Desktop new-tab shortcut to Side Panel unless a Main
   Workbench Browser owns it. Main renderer and guest web contents both reach
   the same Side Panel `openEmpty` action.
2. Add `loose` to Saved View placement, make keep results and mutation receipts
   accept no group, and retain the current Chat/Issue automatic grouping path.
3. Load visible Saved Views independently in Messenger, filter grouped rows,
   and render the remainder in the existing loose directory and manual-order
   model.
4. Add menu, pointer, and keyboard movement between loose placement and custom
   groups. Separating a group releases Saved Views without deleting them.
5. Synchronize guarded contracts and add unit, service, UI, E2E, and packaged
   Desktop coverage.

## Verification

- Relevant unit and service suites for shortcuts, Side Panel state, Saved View
  validation/service behavior, Messenger rendering, and DnD.
- `tests/e2e/chat-side-panel.spec.ts`,
  `tests/e2e/messenger-saved-views.spec.ts`, and representative Local App
  coverage.
- `pnpm product-logic:check`, `pnpm desktop:verify`, `pnpm lint`,
  `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
- Independent adversarial code review and real Desktop black-box verification
  with final screenshots.
