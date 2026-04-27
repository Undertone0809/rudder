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
  - server/src/services/chat-assistant.ts
  - ui/src/components/AgentConfigForm.tsx
  - ui/src/pages/OrganizationSettings.tsx
  - packages/agent-runtime-utils/src/types.ts
commit_refs:
  - feat: add agent model fallback
  - fix: support provider-aware model fallbacks
updated_at: 2026-04-28
---

# Agent Model Fallback

## Summary

Add an ordered provider-aware model fallback mechanism for agents and system
chat. A primary runtime/model attempt can be followed by any number of fallback
attempts, each with its own `agentRuntimeType`, `model`, and optional advanced
runtime config. When an invocation fails, Rudder retries the next configured
attempt until one succeeds or the fallback list is exhausted.

## Diagnosis

The current configuration treats `agentRuntimeConfig.model` as a single point
of failure. That is brittle for local CLI runtimes where model availability,
provider rate limits, and provider outages can fail independently of the
agent's task context.

## Scope

- In scope:
  - persist ordered fallback attempt objects in `agentRuntimeConfig.modelFallbacks`
    and organization `defaultChatAgentRuntimeConfig.modelFallbacks`
  - expose primary, fallback, and add-card model provider selection in Agent
    configuration
  - expose the same provider-aware fallback editor for Rudder Copilot system
    chat defaults
  - retry failed heartbeat and chat adapter execution with fallback attempts in
    order
  - mark fallback attempts in run logs and adapter invocation metadata
  - add focused server, UI, and E2E coverage
- Out of scope:
  - automatic provider health scoring
  - schema migration for first-class fallback columns

## Implementation Plan

1. Add shared config helpers for normalizing provider-aware fallback attempt
   objects while retaining backward compatibility for legacy string entries.
2. Wrap heartbeat adapter execution with an ordered attempt loop:
   primary runtime/model first, then configured fallback attempts after failed
   attempts.
3. Use fresh runtime session state on fallback attempts so a prior model-bound
   session cannot block the backup model.
4. Add Agent configuration UI provider cards for Primary, each fallback, and an
   Add fallback action in a horizontally scrollable rail. Each card owns its
   runtime, model, and collapsed Advanced options, and uses a wide item width
   so provider-specific settings are not squeezed into narrow columns.
5. Extend create-mode adapter config builders so new agents persist
   `modelFallbacks` consistently across local model-backed runtimes.
6. Reuse the provider-card editor for organization system chat defaults.
7. Document the V1 contract and add tests for runtime behavior, config
   defaults/builders, and visible configuration persistence.

## Success Criteria

- Operators can configure any number of fallback attempts per agent or system
  chat default.
- A failed primary heartbeat or chat attempt retries fallback 1, then fallback
  2, and so on.
- A successful fallback attempt makes the run succeed and records the fallback
  runtime/model in normal run result/cost metadata.
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
