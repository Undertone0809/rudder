---
title: Agent model fallback
date: 2026-04-28
kind: implementation
status: completed
area: agent_runtimes
entities:
  - heartbeat_runs
  - agent_runtime_control
  - model_fallback
issue: RUD-157
related_plans:
  - 2026-04-27-agent-run-concurrency.md
  - 2026-04-16-unify-chat-agent-run-semantics.md
supersedes: []
related_code:
  - server/src/services/runtime-kernel/heartbeat.ts
  - ui/src/components/AgentConfigForm.tsx
  - packages/agent-runtime-utils/src/types.ts
commit_refs:
  - feat: add agent model fallback
updated_at: 2026-04-28
---

# Agent Model Fallback

## Summary

Add an ordered model fallback mechanism for agents. An agent keeps its primary
runtime and model, plus up to two backup model IDs. When a heartbeat adapter
invocation fails, Rudder retries the same adapter with the next configured
fallback model until one succeeds or the fallback list is exhausted.

## Diagnosis

The current configuration treats `agentRuntimeConfig.model` as a single point
of failure. That is brittle for local CLI runtimes where model availability,
provider rate limits, and provider outages can fail independently of the
agent's task context.

## Scope

- In scope:
  - persist up to two fallback model IDs in `agentRuntimeConfig.modelFallbacks`
  - expose primary and fallback model selection in Agent configuration
  - retry failed heartbeat adapter execution with fallback models in order
  - mark fallback attempts in run logs and adapter invocation metadata
  - add focused server, UI, and E2E coverage
- Out of scope:
  - cross-adapter fallback, such as switching from Codex CLI to Gemini CLI
  - automatic provider health scoring
  - chat-scene fallback unification
  - schema migration for first-class fallback columns

## Implementation Plan

1. Add shared config helpers for normalizing a maximum of two fallback model
   IDs and applying a selected model to adapter config.
2. Wrap heartbeat adapter execution with an ordered attempt loop:
   primary model first, then configured fallbacks after failed attempts.
3. Use fresh runtime session state on fallback attempts so a prior model-bound
   session cannot block the backup model.
4. Add Agent configuration UI controls for fallback model 1 and fallback model
   2, allowing values from discovered models or manually typed provider/model
   IDs.
5. Extend create-mode adapter config builders so new agents persist
   `modelFallbacks` consistently across local model-backed runtimes.
6. Document the V1 contract and add tests for runtime behavior, config
   defaults/builders, and visible configuration persistence.

## Success Criteria

- Operators can configure up to two fallback models per agent.
- A failed primary heartbeat attempt retries with fallback model 1, then
  fallback model 2.
- A successful fallback attempt makes the run succeed and records the fallback
  model in normal run result/cost metadata.
- Fallback attempts are visible in run logs.
- Existing agents without `modelFallbacks` keep current behavior.

## Validation

- `pnpm exec vitest run packages/agent-runtime-utils/src/model-fallbacks.test.ts server/src/__tests__/model-fallback.test.ts ui/src/components/agent-config-defaults.test.ts`
  passed.
- `pnpm --filter @rudderhq/agent-runtime-utils typecheck` passed.
- `pnpm --filter @rudderhq/server typecheck` passed.
- `pnpm --filter @rudderhq/ui typecheck` passed.
- `pnpm -r typecheck` passed.
- `pnpm test:run` passed.
- `pnpm build` passed.
- `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-config-advanced-options.spec.ts`
  was attempted. The isolated server started and became healthy, but Chromium
  launch timed out after 180 seconds before test code executed.

## Commit

- `feat: add agent model fallback`
