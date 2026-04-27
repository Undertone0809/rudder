---
title: Agent run concurrency
date: 2026-04-27
kind: implementation
status: completed
area: agent_runtimes
entities:
  - heartbeat_runs
  - agent_runtime_control
  - agent_run_concurrency
issue:
related_plans:
  - 2026-04-18-org-heartbeats-workspace.md
  - 2026-03-28-heartbeats-on-off-buttons.md
supersedes: []
related_code:
  - server/src/services/runtime-kernel/heartbeat.ts
  - ui/src/components/AgentConfigForm.tsx
  - ui/src/pages/NewAgent.tsx
  - ui/src/components/OnboardingWizard.tsx
  - packages/agent-runtime-utils/src/types.ts
commit_refs: []
updated_at: 2026-04-27
---

# Agent Run Concurrency

## Summary

Expose per-agent run concurrency as an Agent configuration setting and make the
default `3`. This is the number of agent runs Rudder may execute for one agent
at the same time; it is separate from instance heartbeat scheduler tick
parallelism.

## Problem

The scheduler already has queue draining logic that reads
`runtimeConfig.heartbeat.maxConcurrentRuns`, but the current default is `1` in
the runtime service and the main create/onboarding flows also write `1`. The
setting is therefore present but not productized as the default operator model
for concurrent task execution.

## Scope

- In scope:
  - Change the service default to three concurrent runs per agent.
  - Ensure new Agent creation and onboarding write the same default.
  - Expose the setting in the Agent config surface as run concurrency language,
    not scheduler heartbeat concurrency language.
  - Add targeted coverage that queued runs for different task scopes can start
    concurrently up to the configured limit.
- Out of scope:
  - New database columns or migrations.
  - Changing issue-level single active execution locking.
  - Instance heartbeat scheduler worker parallelism.

## Implementation Plan

1. Introduce a shared UI/runtime default constant of `3` where Agent config
   creation values are built.
2. Update runtime queue policy fallback in `heartbeat.ts` from `1` to `3`.
3. Update Agent config UI copy and create-mode form fields so operators can set
   "Agent run concurrency" directly.
4. Update New Agent and onboarding payloads to write `maxConcurrentRuns: 3`.
5. Add or update focused tests for default value and concurrent queued run
   startup behavior.

## Design Notes

The compatibility-preserving path is to keep reading and writing the existing
`runtimeConfig.heartbeat.maxConcurrentRuns` field. Although the key is nested
under `heartbeat`, the actual behavior is the run queue limit for all wake
sources. Renaming the persisted key would create unnecessary migration and
import/export risk for this change.

Issue execution locking remains per issue. Increasing an agent's concurrency
allows the same agent to work on different issues in parallel; it should not
allow two simultaneous execution runs for the same issue.

## Success Criteria

- New agents default to `maxConcurrentRuns: 3`.
- Existing agents without an explicit value behave as if the value is `3`.
- Operators can edit the run concurrency value from Agent config.
- The queue can promote multiple eligible runs for one agent when slots are
  available.

## Validation

- `pnpm vitest run ui/src/components/agent-config-defaults.test.ts server/src/__tests__/heartbeat-run-concurrency.test.ts`
  passed.
- `pnpm --filter @rudderhq/server typecheck` passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm -r typecheck` passed.
- `pnpm test:run` passed.
- `pnpm build` passed.
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-config-advanced-options.spec.ts`
  was attempted twice, but Chromium launch timed out after 180 seconds before
  the test reached page code or assertions.
- Isolated local service boot on port `4211` passed and a verification org plus
  agent were created through the API. Chrome MCP visual navigation also timed
  out in the local browser layer, so visual screenshot verification remains
  blocked by the same browser-launch class of issue.
