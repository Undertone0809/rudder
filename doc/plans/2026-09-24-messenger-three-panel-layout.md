---
title: Messenger responsive three-panel layout
date: 2026-09-24
kind: implementation
status: completed
area: ui
entities:
  - messenger
  - side_panel
  - workspace_shell
related_code:
  - ui/src/components/Layout.tsx
  - ui/src/context/SidebarContext.tsx
  - ui/src/lib/workspace-shell-layout.ts
  - ui/src/pages/Chat.tsx
  - ui/src/components/Layout.test.ts
---

# Messenger responsive three-panel layout

## Goal

Keep Messenger useful when a docked Side Panel is open without forcing the
conversation list to disappear on wide displays or closing the Side Panel when
the operator explicitly reopens the conversation list.

## Decisions

- On Messenger detail routes, automatically collapse the context conversation
  list only when the viewport is below the three-panel desktop threshold.
- Keep the existing automatic collapse behavior for Agent Run routes.
- When the operator explicitly opens the Messenger list while the Side Panel is
  open, treat that as an intentional override for the current Side Panel
  session. Keep both panels open and allow the three-panel layout.
- Reset the explicit override when the Side Panel opens again or the route
  changes, so each new Side Panel session can make its own space decision.
- Use a 1440px desktop viewport threshold for the default Messenger layout;
  an explicit list reveal remains available below that width.

## Acceptance

1. Messenger at a constrained desktop width automatically hides its context
   list when the Side Panel opens.
2. Messenger at a wide desktop width keeps the context list visible when the
   Side Panel opens.
3. Clicking the context-list reveal control while the Side Panel is open shows
   the context list without closing the Side Panel.
4. Unit coverage exercises the width rule and the user-override state boundary.
5. The rendered workflow is checked at constrained and wide desktop widths,
   including the three-panel state after the explicit reveal action.
