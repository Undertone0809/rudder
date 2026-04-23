---
title: Agent workspace slug-shortid contract
date: 2026-04-17
kind: plan
status: completed
area: workspace
entities:
  - agent_workspace
  - workspace_key
  - home_paths
issue:
related_plans:
  - 2026-04-14-agent-workspace-canonicalization.md
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
  - 2026-04-16-org-workspaces-fixed-root-resources.md
supersedes: []
related_code:
  - server/src/home-paths.ts
  - server/src/services/workspace-runtime.ts
commit_refs:
  - 5b0b003
updated_at: 2026-04-17
---

# Agent Workspace `slug--shortid` Contract

## Summary

Change the canonical agent workspace path from `organizations/<org-id>/workspaces/agents/<agent-id>` to `organizations/<org-id>/workspaces/agents/<workspaceKey>`, where `workspaceKey` is a stable immutable filesystem handle in `slug--shortid` form.

This is a filesystem-contract change only. It does not widen into agent route refs or UI handle changes in this pass.
This cutover is intentionally breaking for old on-disk agent workspace layouts.

## Decisions

- Add `agents.workspaceKey` as a persistent internal field with org-scoped uniqueness.
- Allocate `workspaceKey` from the final stored agent name using `slug--shortid`.
- Define `shortid` as the first 8 lowercase hex chars of the agent UUID; if the candidate collides within the org, extend the UUID slice by 4 hex chars at a time until unique, up to the full UUID.
- Keep `workspaceKey` immutable after creation. Agent rename does not rename the canonical workspace in this pass.
- Keep `agent.urlKey` and all existing public agent refs unchanged in this pass.
- Do not read, migrate, copy, backfill, or rewrite from legacy `agent-id` workspace paths in runtime code.
- Rely on explicit data reset instead of compatibility logic for pre-existing local instances.

## Implementation Notes

- Update canonical agent workspace helpers to resolve by `workspaceKey`.
- Remove legacy workspace-path compatibility code:
  - no copy-forward from older roots
  - no rename from `agents/<agent-id>` to `agents/<workspaceKey>`
  - no startup reconciliation or backfill pass
- Keep runtime/session/instructions/skills code on the same canonical helper so `AGENT_HOME` and agent-private artifacts land on the new path automatically.
- Delete existing local instance data after the code change so stale organizations and workspaces cannot continue running through leftover state.

## Validation

- Targeted unit tests for workspace-key derivation and immutability
- Home-path tests for canonical-only layout and explicit non-support for legacy roots
- Runtime regression coverage for canonical cwd, instructions, and agent-private skills
