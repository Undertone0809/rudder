# 2026-03-29 Agent Runtime Rename

## Summary

Perform a full-stack hard rename from `Adapter` to `Agent Runtime`.

This change uses `Agent Runtime` as the product term and `agentRuntime*` / `runtime_*` as the code and schema naming direction. The rename includes database column names, shared/public API fields, TypeScript types, server and CLI registries, UI copy, workspace package names, and relevant docs.

`Model Provider` is explicitly rejected as the primary term because the concept in Rudder covers runtime invocation, environment validation, session persistence, stdout parsing, and skill sync, not just upstream model/vendor selection.

## Implementation Changes

- Rename shared/public contracts:
  - `AgentAdapterType` -> `AgentRuntimeType`
  - `AGENT_ADAPTER_TYPES` -> `AGENT_RUNTIME_TYPES`
  - `adapterType` / `adapterConfig` fields -> `agentRuntimeType` / `agentRuntimeConfig`
  - adapter environment test types -> agent runtime environment test types
- Rename database schema and persisted fields:
  - `agents.adapter_type` -> `agents.runtime_type`
  - `agents.adapter_config` -> `agents.runtime_config_agent`
  - `agent_task_sessions.adapter_type` -> `agent_task_sessions.runtime_type`
  - `organizations.default_chat_adapter_type` / `default_chat_adapter_config` -> runtime equivalents
  - `issues.assignee_adapter_overrides` and `finance.execution_adapter_type` -> runtime equivalents
  - regenerate Drizzle migration and schema exports for the renamed columns/indexes
- Rename runtime integration code:
  - registry/module/type names move from `Adapter*` to `AgentRuntime*` or `Runtime*` where the shorter name stays unambiguous
  - server/UI/CLI registries move from adapter naming to runtime naming
  - heartbeat/auth/import/export/services switch to `agentRuntimeType` and `agentRuntimeConfig`
- Rename workspace packages and imports:
  - `@rudder/adapter-utils` -> `@rudder/agent-runtime-utils`
  - `@rudder/adapter-*` packages -> `@rudder/agent-runtime-*`
  - update package manifests, import paths, build config references, and changelog headers where needed
- Rename product/UI terminology:
  - section/title labels from `Adapter` to `Agent Runtime`
  - field labels from `Adapter type` to `Runtime type`
  - help text explains this as how Rudder runs the agent
  - agent detail/import/invite/onboarding screens use the new terminology consistently
- Update docs and specs to reflect `Agent Runtime` as the canonical term and reserve `provider` for model/vendor, storage, secret, or billing contexts only

## Test Plan

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- Spot-check key flows after the rename:
  - create/edit agent
  - test runtime environment
  - invoke/cancel heartbeat run
  - organization import/export path that includes runtime overrides
  - join/invite flow carrying runtime selection

## Assumptions

- This is a hard cut with no compatibility aliases for old `adapter*` public fields or database column names.
- The new persisted field for the agent-owned config is `agentRuntimeConfig`; if an existing table already has a generic `runtimeConfig`, keep both concepts separate and name the agent invocation config unambiguously.
- Package renames are included in this change rather than deferred.
