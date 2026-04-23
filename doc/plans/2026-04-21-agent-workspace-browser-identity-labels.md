---
title: Agent workspace browser identity labels
date: 2026-04-21
kind: implementation
status: completed
area: workspace
entities:
  - agent_workspace
  - workspace_browser
issue:
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-17-agent-workspace-key-contract.md
  - 2026-04-17-agent-skill-ownership-and-workspace-editing.md
supersedes: []
related_code:
  - packages/shared/src/types/organization.ts
  - server/src/services/organization-workspace-browser.ts
  - ui/src/pages/OrganizationWorkspaces.tsx
  - server/src/__tests__/organization-workspace-browser.test.ts
  - tests/e2e/workspace-shell.spec.ts
commit_refs:
  - fix: show agent names in workspace browser
updated_at: 2026-04-21
---

# Agent Workspace Browser Identity Labels

## Summary

Keep agent workspace directories keyed by stable `workspaceKey`, but stop using
that internal storage handle as the primary label in the organization
`/workspaces` browser. The browser should show the current Agent identity for
`agents/` first-level entries while preserving the underlying path contract.

## Problem

The current workspace browser renders raw filesystem names directly. For agent
workspaces, that leaks an internal persistence handle such as
`nia--6764296e` into the primary UI label. After an Agent is renamed, the
filesystem directory intentionally stays stable, but the browser now looks
wrong because it still presents the old slug as if it were the Agent's current
name.

## Scope

- in scope: add semantic metadata for agent workspace directories in the
  workspace browser contract
- in scope: render Agent name as the primary label for `agents/` children in
  `/workspaces`
- in scope: keep the raw `workspaceKey` available only as secondary context
- in scope: add automated coverage for the server contract and visible UI
- out of scope: renaming workspace directories
- out of scope: changing agent workspace key allocation or immutability rules
- out of scope: changing non-agent workspace listings

## Implementation Plan

1. Extend the shared workspace entry type with optional display metadata.
2. Teach the organization workspace browser service to resolve `agents/`
   first-level directory names against org agents by `workspaceKey`.
3. Update the Workspaces page tree row renderer so Agent identity becomes the
   primary label without changing click behavior or path selection.
4. Add server and E2E coverage for renamed agents whose workspace directory
   remains on the original `workspaceKey`.

## Design Notes

- `workspaceKey` remains the canonical filesystem contract and navigation path.
- Semantic labeling is added only for `agents/` first-level children because
  that is where the leaked internal handle becomes user-visible and ambiguous.
- The browser should tolerate unmatched directories under `agents/` by falling
  back to the raw filesystem name.
- The UI should not imply that the directory itself has been renamed.

## Success Criteria

- Browsing `/workspaces` still opens the same underlying files and directories.
- Under `agents/`, an Agent rename updates the visible workspace label to the
  Agent's latest name.
- The raw `workspaceKey` is no longer the primary label for matched agent
  workspaces.
- Existing non-agent folders keep their current behavior.

## Validation

- targeted server test for agent workspace semantic labeling
- targeted E2E for `/workspaces` agent directory rendering
- targeted typecheck and affected test runs before hand-off

## Open Issues

- The initial semantic treatment is intentionally narrow; future work may want
  richer identity rows for projects or other workspace-backed entities.
