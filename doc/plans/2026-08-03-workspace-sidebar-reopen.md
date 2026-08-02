---
title: Restore collapsed workspace sidebar reopening
date: 2026-08-03
kind: implementation
status: completed
area: ui
entities:
  - workspace_shell
  - apps_workspace
issue:
related_plans: []
supersedes: []
related_code:
  - ui/src/components/Layout.tsx
  - ui/src/pages/Chat.tsx
  - tests/e2e/app-builder.spec.ts
commit_refs: []
updated_at: 2026-08-03
---

# Restore Collapsed Workspace Sidebar Reopening

## Summary

Keep desktop frameless workspace context sidebars recoverable after collapse by
showing a hover- and focus-revealed opener at the left edge of the workspace
content, immediately to the right of the Primary Rail.

## Implementation

- Render one shared opener from `Layout` when a desktop workspace context
  sidebar is present, collapsed, and the current main surface is frameless.
- Use the existing motion token conventions, an accessible button name, and a
  stable test id. The button restores the shared `sidebarOpen` state.
- Remove the duplicate Library and Messenger Chat page-level openers. Normal
  card-page header openers remain unchanged.
- Keep mobile drawer and left-edge swipe behavior unchanged.

## Verification

- Cover Apps collapse, left-edge hover reveal, click reopen, and keyboard
  focus/activation in the Apps E2E workflow.
- Update Chat component tests so they no longer assert the removed page-owned
  opener or its reserved top spacing.
- Validate the rendered Apps states in a desktop browser and run the focused
  tests plus repository checks required by `AGENTS.md`.

## Product Logic Alignment

- Affected contract: `APP.BUILDER.001`.
- This restores the existing Apps workspace sidebar's discoverability; it does
  not change the product contract or authorize edits under `doc/product/**`.
