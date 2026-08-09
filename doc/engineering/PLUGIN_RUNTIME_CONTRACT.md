---
title: Plugin Runtime Contract
status: active
---

# Plugin Runtime Contract

This document is the current engineering anchor for implemented plugin host
behavior. Product behavior is owned by `doc/product/domains/plugins/**`; plugin
author workflows are owned by `doc/engineering/PLUGIN_AUTHORING_GUIDE.md`.

Use the archived `doc/archive/plugins/PLUGIN_SPEC.md` only for future-looking
or historical design context.

## Current Runtime Boundaries

- Plugins are trusted instance-level extension code.
- Plugin UI runs as same-origin JavaScript inside the main Rudder app.
- Worker-side host APIs are capability-gated.
- Manifest capabilities do not sandbox plugin UI from ordinary board-session
  HTTP APIs.
- Local-path installs and repo example plugins are development workflows.
- npm packages are the intended deployment artifact for distributed plugins.
- Dynamic install currently assumes a writable persistent filesystem, available
  package tooling, and single-node or otherwise coordinated deployment.

## Implemented Host Surfaces

- Lifecycle and worker management: install, activate, disable, update,
  uninstall, logs, and worker health.
- Capabilities and tools: capability validation, namespaced plugin tools, and
  host bridge dispatch.
- Jobs and webhooks: plugin-owned scheduled/manual jobs, webhook routes, logs,
  state, and persisted operational evidence.
- UI slots: host-rendered plugin pages, settings pages, dashboard widgets,
  sidebars, detail tabs, toolbar/context actions, and comment annotations.
- SDK surfaces: worker context, UI hooks, testing harness, bundler presets, and
  development server helpers.

### Outbound HTTP

`http.outbound` calls reject private and reserved IP ranges by default. A local
trusted operator may explicitly allow exact HTTP(S) origins with
`RUDDER_PLUGIN_HTTP_ALLOWLIST`; the allowlist is origin-only and applies to
paths below that origin. This is intended for controlled local fixtures and
does not make arbitrary private targets reachable.

## Current Truth Links

- Product contracts: `doc/product/domains/plugins/lifecycle-capabilities.md`
- Authoring workflow: `doc/engineering/PLUGIN_AUTHORING_GUIDE.md`
- SDK package surface: `packages/plugins/sdk/README.md`
- Historical target architecture: `doc/archive/plugins/PLUGIN_SPEC.md`
