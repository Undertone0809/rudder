---
title: Workspace root launcher
date: 2026-04-30
kind: implementation
status: completed
area: workspace
entities:
  - org_workspace
  - workspace_browser
  - desktop_workspace_launcher
issue:
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-17-agent-skill-ownership-and-workspace-editing.md
  - 2026-04-21-agent-workspace-browser-identity-labels.md
supersedes: []
related_code:
  - desktop/src/ide-opener.ts
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/lib/desktop-shell.ts
  - tests/e2e/workspace-shell.spec.ts
commit_refs:
  - feat: add workspace root launcher
updated_at: 2026-04-30
---

# Workspace Root Launcher

## Summary

Move the Workspaces external-open affordance from a selected-file editor action
to a workspace-root launcher in the page header. The launcher should detect
local editor, terminal, and folder targets and open the organization workspace
root in the selected tool.

## Problem

The current Workspaces action only opens a selected file in the first detected
IDE. Operators need the same root-level launcher behavior they expect from
Codex: choose a local development tool, open the workspace folder as the root,
or open a terminal already located in that root.

## Scope

- in scope: desktop launcher detection, preload/UI shell contract, Workspaces
  header split button, removal of the editor-card single-file opener, automated
  unit/E2E coverage
- out of scope: redesigning the workspace file editor, changing the org
  workspace filesystem contract, or adding per-user launcher preferences beyond
  local UI last-target memory

## Implementation Plan

1. Extend the desktop opener service from IDE-file targeting to workspace-root
   launcher targets covering editors, terminals, and the OS folder opener.
2. Add IPC/preload/UI-shell methods for listing targets and opening a workspace
   root by target id.
3. Render a header split launcher beside Refresh on the Workspaces page, using
   the last chosen target when still available and falling back to the first
   detected target.
4. Remove the selected-file IDE button and update tests to cover root opening
   and target selection.

## Design Notes

- The folder target is always available and maps to Finder on macOS or the
  platform folder opener elsewhere.
- IDE targets receive the workspace root path as the project/folder argument.
- Terminal targets launch with cwd set to the workspace root.
- Target ordering starts with common Codex-style choices: VS Code, Cursor,
  Xcode, Terminal, Warp, Finder, followed by existing supported IDEs.

## Success Criteria

- Workspaces shows a root launcher left of Refresh when running in Desktop and
  the org workspace root exists.
- The launcher can open the root in an editor, terminal, or folder target.
- No editor-card single-file external-open action remains.
- Tests prove detection, opening, root validation, and UI interactions.

## Validation

- Passed: `pnpm --filter @rudderhq/desktop typecheck`
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm --filter @rudderhq/desktop exec vitest run src/ide-opener.test.ts`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Attempted: targeted Playwright workspace shell E2E; blocked by Chromium
  headless launch timeout before test assertions.
- Attempted: `pnpm test:run`; failed in unrelated
  `server/src/__tests__/heartbeat-run-retry-routes.test.ts` while current
  working tree contained separate runtime-kernel changes.

## Open Issues

- Packaged Desktop smoke remains required if future changes touch packaging or
  startup paths; this implementation is limited to runtime IPC and UI launcher
  behavior.
