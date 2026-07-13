---
title: Local app Langfuse settings
date: 2026-04-15
kind: plan
status: completed
area: langfuse
entities:
  - instance_settings
  - langfuse_config
  - local_trusted
issue:
related_plans:
  - 2026-04-14-langfuse-trace-observability.md
supersedes: []
related_code:
  - server/src/services/instance-settings.ts
  - server/src/routes/instance-settings.ts
  - ui/src/lib/instance-settings.ts
commit_refs:
  - feat: add local langfuse instance settings
updated_at: 2026-04-17
---

# Local App Langfuse Settings

## Goal

Add a dedicated local-app Langfuse settings surface under instance settings so instance admins can configure Rudder's bootstrap-time Langfuse tracing without editing environment variables manually.

## Scope

- Local `local_trusted` instances only
- Config persisted in local `config.json`
- Restart required after save
- No DB migration
- No hot re-init

## Implementation Outline

1. Extend shared config and instance-setting contracts with Langfuse config/settings types.
2. Add server-side config-file write/update helpers and Langfuse settings routes.
3. Add a dedicated instance settings page and wire it into sidebar, routing, remembered paths, and prefetch.
4. Add targeted config/server/UI/E2E coverage.

## Commit

- `feat: add local langfuse instance settings` on the branch HEAD after implementation verification
