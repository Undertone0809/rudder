---
title: Agent issue search capability
date: 2026-05-09
kind: implementation
status: completed
area: developer_workflow
entities:
  - agent_capabilities
  - issue_search
  - cli
issue: 0ef7f2b2-cde4-47e1-b073-d74c343eadec
related_plans: []
supersedes: []
related_code:
  - cli/src/commands/client/issue.ts
  - cli/src/agent-v1-registry.ts
  - server/src/routes/issues.ts
  - server/src/services/issues.ts
  - doc/CLI.md
  - doc/TASKS.md
commit_refs:
  - feat: expose server-backed issue search capability
updated_at: 2026-05-09
---

# Agent Issue Search Capability

## Goal

Expose a stable agent-facing issue search command that uses the server-side issue query parameter rather than client-side filtering.

## Steps

1. Trace the existing issue list route, CLI issue command, and agent v1 capability registry.
2. Add or normalize a stable CLI search path that calls `GET /api/orgs/:orgId/issues?q=...`.
3. Ensure results include identifier, title, status, assignee, project, updated time, and any available match snippet.
4. Register the command in Agent v1 stable capabilities and update CLI/agent docs.
5. Add focused tests for server query usage, CLI behavior, and capability registry exposure.

## Validation

- Passed: `pnpm --filter @rudderhq/cli exec vitest run src/__tests__/issue-search.test.ts src/__tests__/agent-v1-registry.test.ts --reporter=verbose`.
- Passed: `pnpm --filter @rudderhq/cli typecheck && pnpm --filter @rudderhq/server typecheck`.
- Passed: `pnpm -r typecheck`.
- Passed: `pnpm build`.
- Blocked by local embedded PostgreSQL init: `pnpm --filter @rudderhq/server exec vitest run src/__tests__/issues-service.test.ts --reporter=verbose`.
- Blocked by local embedded PostgreSQL init: `pnpm test:run` failed in DB-backed suites; it also reported an unrelated `server/src/__tests__/health.test.ts` body assertion failure.
