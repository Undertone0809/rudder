---
title: Agent workspace canonicalization
date: 2026-04-14
kind: plan
status: completed
area: workspace
entities:
  - agent_workspace
  - runtime_cwd
  - session_migration
issue:
related_plans:
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
  - 2026-04-17-agent-workspace-key-contract.md
supersedes: []
related_code:
  - server/src/services/workspace-runtime.ts
  - server/src/__tests__/heartbeat-workspace-session.test.ts
  - server/src/__tests__/workspace-runtime.test.ts
commit_refs:
  - fix: canonicalize agent run workspace
updated_at: 2026-04-17
---

## Goal

Make the agent workspace the single canonical run workspace:

- every agent run starts from `~/.rudder/instances/<instanceId>/workspaces/<agentId>`
- project workspaces and execution workspaces remain metadata/runtime resources, not the agent's primary cwd
- saved sessions migrate toward the canonical agent workspace instead of drifting toward project or worktree paths

## Why

The current model treats the agent workspace as a fallback. That creates an ownership inversion:

- repo/worktree resolution decides the run cwd
- session resume persists that choice
- the agent workspace loses its role as the stable home for the agent

The desired model is the opposite:

- the agent has one stable workspace
- project/execution workspace resolution is supplemental context

## Planned Changes

1. Keep execution workspace realization for project/worktree/runtime-service flows.
2. Introduce a canonical agent run cwd in heartbeat and use it for adapter launch context.
3. Update runtime session migration so existing sessions move to the canonical agent workspace.
4. Replace fallback-oriented warning copy with canonical-workspace wording.
5. Update automated tests around session migration and warning formatting.

## Validation

- targeted Vitest coverage for heartbeat workspace/session behavior
- repository typecheck
- `pnpm vitest run server/src/__tests__/heartbeat-workspace-session.test.ts`
- `pnpm vitest run server/src/__tests__/workspace-runtime.test.ts`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## Commit

- `fix: canonicalize agent run workspace`
