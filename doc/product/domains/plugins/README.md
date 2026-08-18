---
title: Plugins Domain
domain: plugins
status: active
coverage: detailed
contract_ids: []
related_code:
  - packages/db/src/schema/rudder_plugins.ts
  - server/src/routes/rudder-plugins.ts
  - server/src/services/rudder-plugins.ts
  - ui/src/pages/Plugins.tsx
related_tests:
  - server/src/services/rudder-plugins.test.ts
  - server/src/__tests__/rudder-plugins-lifecycle.test.ts
  - tests/e2e/plugins-v1.spec.ts
edit_policy: user_confirmed_only
---

# Plugins Domain

Plugins are organization-installed capability bundles compatible with the
Codex Plugin package shape. They own distribution, inspection, installation,
and package-component links. They do not own execution.

## Owns

- Package identity, immutable snapshots, provenance, digest, and compatibility
  reports.
- Organization-scoped install, enable, disable, previewed update, rollback, and
  uninstall lifecycle.
- Links from a package to package-managed Skills, managed MCP drafts, preserved
  App references, and host-native Local Apps.
- Editable Skill fork provenance and managed MCP UI resource entry points,
  while their execution remains owned by Skills and Managed MCP.
- The instance-level Experimental Plugins-gated Hub Primary Rail surface:
  Plugins, Skills, and Showcase views, plus curated discovery, URL import,
  creation, Preview, assignment, and setup entry points.

## Does Not Own

- Workers, jobs, webhooks, schedules, generic state, UI slots, host tool RPC,
  or an extension SDK.
- Agent, Goal, Automation, Chat, Issue, Run, Document, credential, Skill
  execution, MCP runtime, or App runtime state machines.
- User data owned by an App, external connection, or ordinary Rudder record.

## Contract Index

- `PLUGIN.PACKAGE.001`: Codex-compatible package identity and component model.
- `PLUGIN.IMPORT.001`: bounded, non-executing discovery and immutable
  compatibility Preview.
- `PLUGIN.INSTALLATION.001`: organization-scoped component projection and
  non-destructive lifecycle.

Retired: `PLUGIN.LIFECYCLE.001`, `PLUGIN.CAPABILITY.001`, and
`PLUGIN.JOBS.WEBHOOKS.001`.
