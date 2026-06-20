---
title: Agent run unification completion
date: 2026-06-20
kind: implementation
status: implemented
area: agent_runtimes
entities:
  - agent_runs
  - heartbeat_runs
  - chat_streaming
  - automation_runs
issue:
related_plans:
  - 2026-06-10-unified-agent-run-architecture.md
  - 2026-06-10-run-workspace-language-migration.md
  - 2026-05-29-agent-runs-sort-and-trigger-distribution.md
supersedes: []
related_code:
  - packages/shared/src/types/heartbeat.ts
  - server/src/services/chat-agent-runs.ts
  - server/src/routes/agents.management-routes.ts
  - ui/src/api/heartbeats.ts
  - ui/src/pages/AgentDetail.runs.tsx
commit_refs: []
updated_at: 2026-06-20
---

# Agent Run Unification Completion Implementation Plan

Goal: complete the compatibility-preserving Agent Run semantic migration without
renaming the physical `heartbeat_runs` table.

Architecture: keep storage and legacy `/heartbeat-runs` routes intact, add an
`AgentRun` facade in shared/API/UI contracts, normalize scene/trigger/target
metadata from the run row and `contextSnapshot`, and make Chat/Automation write
enough metadata for operators to navigate the unified run history.

Tech stack: TypeScript, Drizzle, Express, React, TanStack Query, Vitest, and
Playwright.

## Route

`implementation -> verification -> review -> handoff`.

The required review mode is spawned reviewers with functional trust,
adversarial, and heuristic lenses.

## Acceptance Bar

- `HeartbeatRun` remains compatible for existing plugin/API consumers.
- `AgentRun` is exported from shared types and used by UI/API client surfaces
  that present execution history.
- `/api/orgs/:orgId/agent-runs` and `/api/agent-runs/:runId/*` alias the
  existing heartbeat run endpoints for list, detail, events, logs, cancel,
  retry, workspace operations, and issues-for-run where present.
- Every returned Agent Run includes normalized `scene`, `triggerKind`,
  `targetType`, `targetId`, `conversationId`, `messageId`, `automationRunId`,
  `automationId`, and `wakeupRequestId`.
- Chat assistant runs write `scene=chat`, `targetType=chat_conversation`, and
  assistant/user message metadata in the normalized snapshot.
- Chat-output automation runs write `targetType=automation_run` and preserve
  linked Chat conversation/message metadata on the Agent Run created by the
  Chat assistant path.
- Agent detail can filter by scene and target type and can show the selected
  run's scene/target facts in the detail panel.
- Focused unit/API tests and at least one E2E path cover the alias and UI
  workflow.
- Terminal workflow proof demonstrates that Chat/Automation source metadata is
  visible on the Agent Run detail surface with source navigation where the
  source id is available.

## Task Plan

1. Write failing shared/API tests for `AgentRun` normalization and
   `/agent-runs` aliases.
2. Implement shared `AgentRun` facade types and server alias routes.
3. Write failing service tests for Chat and chat-output automation target
   metadata.
4. Implement metadata writes in Chat/Automation paths.
5. Write failing UI tests for API client alias use, scene/target filters, and
   detail labels.
6. Implement UI client and Agent detail updates.
7. Add or update E2E coverage for the run list/detail workflow.
8. Run focused tests, typecheck/build, browser or E2E terminal proof, then
   spawned reviewer gates.
9. Address reviewer findings, update this plan status/commit refs, commit, and
   push if branch state is safe.

## Validation Plan

- `pnpm test:run server/src/__tests__/activity-routes.test.ts server/src/__tests__/heartbeat-run-retry-routes.test.ts server/src/__tests__/chat-agent-runs.test.ts server/src/__tests__/automations-service.test.ts`
- `pnpm test:run ui/src/api/heartbeats.test.ts ui/src/pages/AgentDetail.run-filters.test.ts ui/src/pages/AgentDetail.chat-context.test.ts ui/src/pages/AgentDetail.runs.test.ts`
- `pnpm test:run packages/shared/src/agent-run.test.ts`
- `pnpm test:e2e tests/e2e/agent-runs-filter-menu.spec.ts tests/e2e/agent-detail-cancelled-retry.spec.ts tests/e2e/agent-detail-loading-state.spec.ts --workers=1`
- browser proof screenshot for the Agent Run detail facts/source links
- spawned reviewer gates after rework
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

Full checks may be narrowed only if an unrelated workspace blocker is proven and
recorded.

## Validation Evidence

Completed on 2026-06-20:

- `pnpm test:run server/src/__tests__/activity-routes.test.ts server/src/__tests__/activity-service.test.ts packages/shared/src/agent-run.test.ts ui/src/pages/AgentDetail.run-filters.test.ts ui/src/pages/AgentDetail.runs.test.ts server/src/__tests__/heartbeat-run-retry-routes.test.ts ui/src/api/heartbeats.test.ts server/src/__tests__/chat-agent-runs.test.ts server/src/__tests__/automations-service.test.ts server/src/__tests__/messenger-service.test.ts ui/src/pages/Messenger.test.tsx` passed: 11 files, 140 tests.
- `pnpm test:run ui/src/pages/AgentDetail.run-filters.test.ts` passed after the final consecutive-filter URL-state fix: 15 tests.
- `pnpm test:e2e tests/e2e/agent-runs-filter-menu.spec.ts --workers=1` passed after the final consecutive-filter URL-state fix: 1 browser test.
- `pnpm test:e2e tests/e2e/agent-runs-filter-menu.spec.ts tests/e2e/agent-detail-cancelled-retry.spec.ts tests/e2e/agent-detail-loading-state.spec.ts --workers=1` passed: 5 browser tests.
- `pnpm lint` passed.
- `pnpm -r typecheck` passed.
- `pnpm test:run` was attempted and reached unrelated flaky failures in `packages/db/src/client.test.ts`, `server/src/__tests__/organization-intelligence-profiles-routes.test.ts`, and `ui/src/pages/AutomationDetail.test.tsx`, followed by a Vitest worker `ERR_IPC_CHANNEL_CLOSED`. The failed suites passed in the focused rerun below.
- `pnpm test:run packages/db/src/client.test.ts server/src/__tests__/organization-intelligence-profiles-routes.test.ts ui/src/pages/AutomationDetail.test.tsx` passed: 3 files, 19 tests.
- `pnpm build` passed with existing CSS pseudo-element, chunk-size, package-bin, deprecation, and peer dependency warnings.

Terminal product proof:

- The Playwright Agent Runs filter workflow creates a real automation, opens an
  Agent Run detail page through `/agent-runs`, verifies normalized Scene/Target
  facts, clicks the source Automation link, verifies the Automation detail
  title, returns to the selected run, and exercises scene/target filtering
  without losing the selected run.

Spawned reviewer gate:

- Functional trust reviewer: conditional accept; remaining conditions were
  parent validation evidence and commit/push, not code blockers.
- Heuristic reviewer: accept for this implementation slice; next-slice
  recommendations were non-blocking.
- Adversarial reviewer: initially conditional on org-scope hardening,
  canonical Messenger retry actions, and E2E source-link proof. Delta review
  after rework gave final handoff-level accept with no remaining code or
  product blockers.
