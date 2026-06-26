---
title: Langfuse integration install gate
date: 2026-06-26
kind: implementation
status: in_progress
area: langfuse
entities:
  - instance_settings
  - langfuse_config
  - local_trusted
related_plans:
  - 2026-04-15-local-app-langfuse-settings.md
  - 2026-04-14-langfuse-trace-observability.md
supersedes: []
related_code:
  - packages/shared/src/validators/instance.ts
  - server/src/routes/instance-settings.ts
  - ui/src/pages/InstanceLangfuseSettings.tsx
  - ui/src/api/instanceSettings.ts
commit_refs: []
updated_at: 2026-06-26
---

# Langfuse Integration Install Gate

## Problem

The current `Settings > Integrations > Langfuse` surface opens directly into the full bootstrap-time Langfuse configuration form. That implies Langfuse is already part of the local Rudder setup, but the default user has not opted into the Rudder Langfuse integration.

This makes the first click feel like provider plumbing instead of a deliberate optional integration install.

## Decision

Add an instance-scoped install gate before the full Langfuse configuration page.

When a local trusted operator opens Langfuse settings before installation, Rudder shows a compact introduction:

- Langfuse is an optional tracing integration for Rudder agent and chat execution traces.
- Rudder installs/enables its own Langfuse integration components only.
- The operator remains responsible for their Langfuse host, credentials, and local environment.
- A primary action installs the Rudder Langfuse integration.

After installation completes, Rudder reveals the existing full configuration page.

## Scope

In scope:

1. Persist a local instance `installed` flag as part of the Langfuse settings response.
2. Add an install endpoint/action that marks the Rudder Langfuse integration installed.
3. Show an install introduction page when `installed === false`.
4. Show an in-page progress indicator while the install action is pending.
5. Reveal the existing configuration form after install succeeds.
6. Keep environment-managed read-only behavior unchanged after installation.
7. Add unit/API tests and user-visible E2E coverage for the install-gated path.

Out of scope:

- Installing or managing a Langfuse server.
- Creating Langfuse projects or keys.
- Editing user `.env` values.
- Hot reinitializing Langfuse without restart.
- Moving existing `@langfuse/*` server dependencies into a dynamically installed package.

## Implementation Notes

The server already ships Rudder's Langfuse integration code and dependencies. In this repo, "install Rudder's Langfuse integration" should therefore mean recording the operator's opt-in for the local instance and unlocking the configuration surface. It should not run `pnpm install` from the product UI.

Persist the opt-in in local `config.json` under the existing `langfuse` object so it follows the same bootstrap-time local instance config boundary as the rest of this page.

## Acceptance Criteria

1. A fresh local instance with no Langfuse opt-in opens `Settings > Langfuse` to an introduction page, not the full config form.
2. The introduction page includes a primary install action and explains that Rudder only installs its Langfuse integration.
3. Clicking install shows progress and disables duplicate install clicks.
4. After install succeeds, the existing configuration page appears.
5. Refreshing after install keeps the configuration page visible.
6. Existing config saves, secret handling, restart-required notice, and environment-managed read-only behavior continue to work.
7. The install state is local instance-scoped and does not depend on organizations.

## Validation Plan

- `pnpm --filter @rudderhq/shared typecheck`
- `pnpm --filter @rudderhq/server test -- --run instance-settings-routes`
- `pnpm --filter @rudderhq/ui test -- --run InstanceLangfuseSettings`
- Relevant E2E settings test covering first-open install gate and post-install config reveal.
- Browser verification of the Settings Langfuse path with a screenshot artifact outside the repo.
- `pnpm product-logic:check`

## Product Logic Registry

Affected current contract: `ORG.SETTINGS.001`.

This plan records the intended delta, but does not edit `doc/product/**`. After implementation, the Product Logic Registry should be updated only after explicit approval to add the Langfuse install-gate behavior to `ORG.SETTINGS.001` or a more specific Langfuse settings contract.
