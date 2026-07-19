---
title: Plugin Lifecycle And Capabilities
domain: plugins
status: active
coverage: detailed
contract_ids:
  - PLUGIN.LIFECYCLE.001
  - PLUGIN.CAPABILITY.001
  - PLUGIN.JOBS.WEBHOOKS.001
related_code:
  - packages/db/src/schema/plugins.ts
  - packages/db/src/schema/plugin_config.ts
  - packages/db/src/schema/plugin_state.ts
  - packages/db/src/schema/plugin_jobs.ts
  - packages/db/src/schema/plugin_webhooks.ts
  - packages/db/src/schema/plugin_logs.ts
  - server/src/routes/plugins.ts
  - server/src/routes/plugins.operations-routes.ts
  - server/src/routes/plugin-ui-static.ts
  - server/src/services/plugin-registry.ts
  - server/src/services/plugin-loader.ts
  - server/src/services/plugin-lifecycle.ts
  - server/src/services/plugin-worker-manager.ts
  - server/src/services/plugin-capability-validator.ts
  - server/src/services/plugin-job-scheduler.ts
  - server/src/services/plugin-tool-dispatcher.ts
  - server/resources/bundled-skills/rudder-docs/references/plugin-authoring.md
  - ui/src/pages/PluginManager.tsx
  - ui/src/pages/PluginSettings.tsx
  - ui/src/pages/PluginPage.tsx
related_tests:
  - server/src/__tests__/plugin-job-scheduler.test.ts
  - server/src/__tests__/plugin-worker-manager.test.ts
  - server/src/__tests__/plugin-package-resolution.test.ts
  - server/src/__tests__/plugin-dev-watcher.test.ts
  - tests/e2e/linear-plugin-import.spec.ts
  - server/src/__tests__/bundled-rudder-skill-docs.test.ts
related_plans:
  - doc/plans/2026-07-20-merge-rudder-creation-skills-into-docs.md
edit_policy: user_confirmed_only
---

# Plugin Lifecycle And Capabilities

## PLUGIN.LIFECYCLE.001

Why:

- Plugins keep Rudder's core thin while allowing optional integrations,
  adapters, widgets, tools, and operational surfaces.
- Plugin lifecycle must be host-managed so installed code cannot silently become
  part of core invariants.

Product model:

- A plugin has identity, version, manifest, install source, config, status,
  worker path, UI bundle paths, logs, jobs, webhooks, and state.
- Local-path plugins may be watched during development.
- Uninstall is a lifecycle state and cleanup path, not an uncontrolled file
  deletion.

Flow:

1. Operator installs plugin from supported package/source.
2. Host resolves package, validates manifest, stores config, and starts worker
   when enabled.
3. Plugin registers UI slots, tools, jobs, webhooks, and event subscriptions
   through the host bridge.
4. Host surfaces status/logs/config in Plugin Manager/Settings.
5. Update/uninstall stops workers and reconciles state without mutating core
   domain records outside declared boundaries.

Invariants:

- Plugins are additive extension points; they do not redefine core product
  state machines.
- Host must preserve installed plugin status, config, logs, and worker health
  enough for operator debugging.

Evidence:

- `server/src/__tests__/plugin-worker-manager.test.ts`,
  `server/src/__tests__/plugin-package-resolution.test.ts`, and
  `server/src/__tests__/plugin-dev-watcher.test.ts` cover worker/package/dev
  lifecycle behavior.
- `tests/e2e/linear-plugin-import.spec.ts` covers an installed plugin user path.
- Known gap: plugin contracts are extension-surface guardrails, not a promotion
  of plugins into the dated V1 core scope.
- The bundled `rudder-docs` Plugin authoring reference routes explicit scaffold
  and package-development requests through the current engineering guide and
  SDK, then requires package and applicable host verification. It does not add
  a new install source or lifecycle state.

## PLUGIN.CAPABILITY.001

Why:

- A plugin bridge is safe only if capability declaration is meaningful.
  Otherwise optional integrations could bypass approval, auth, checkout,
  budget, or workspace boundaries.

Product model:

- Plugin manifests declare capabilities for tools, state, HTTP, UI slots,
  events, webhooks, jobs, and host service access.
- Host maps bridge operations to required capabilities.
- Tool names are plugin-namespaced and cannot shadow core tools or other
  plugins.

Flow:

1. Plugin manifest declares requested capabilities.
2. Install/activation validates manifest and config.
3. Runtime bridge checks each operation against declared capabilities.
4. Forbidden operations fail and are logged.

Invariants:

- Plugins cannot override core routes or core actions by name collision.
- Plugins cannot mutate approval, auth, issue checkout, or budget enforcement
  logic except through public host APIs that enforce those contracts.

Evidence:

- `server/src/services/plugin-capability-validator.ts` maps bridge operations to
  required capabilities.
- `server/src/services/plugin-tool-dispatcher.ts` and
  `server/src/services/plugin-tool-registry.ts` own namespaced tool dispatch.
- Known gap: every new bridge operation must update capability validation
  before it is exposed to plugins.
- The bundled Plugin authoring reference preserves the current trusted-code and
  worker capability boundary, including the absence of a frontend capability
  sandbox. It does not grant a Plugin new host APIs.

## PLUGIN.JOBS.WEBHOOKS.001

Why:

- Plugin jobs and webhooks are external execution surfaces. Operators need to
  see when they ran, what they attempted, and whether they failed.

Product model:

- Plugin jobs are namespaced scheduled/manual tasks owned by a plugin.
- Plugin webhooks are namespaced HTTP entry points owned by a plugin.
- Logs and state store plugin-owned operational evidence.

Flow:

1. Plugin registers job or webhook.
2. Host scheduler or webhook route invokes plugin worker through the bridge.
3. Plugin result/logs/state are persisted.
4. Plugin settings or dashboard slots expose health and operational evidence.

Invariants:

- Job/webhook execution must be attributed to plugin id and organization/scope
  when applicable.
- Plugin execution evidence must be queryable enough to debug failures.

Evidence:

- `server/src/__tests__/plugin-job-scheduler.test.ts` covers plugin job
  dispatch behavior.
- `plugin_jobs`, `plugin_webhooks`, `plugin_logs`, and `plugin_state` schema
  tables preserve plugin-owned operational evidence.
- Known gap: webhook delivery retry policy should be expanded if external
  plugin webhooks become a primary automation path.
- The bundled Plugin authoring reference points authors back to these
  namespacing, capability, logging, and failure-evidence rules for jobs and
  webhooks; it does not change their runtime semantics.
