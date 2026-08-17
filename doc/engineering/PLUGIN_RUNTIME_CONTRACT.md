---
title: Plugin Import And Activation Contract
status: active
---

# Plugin Import And Activation Contract

Rudder Plugins are distribution and lifecycle records. There is no Plugin
runtime. Product behavior is owned by
`doc/product/domains/plugins/lifecycle-capabilities.md`; package authoring is
described in `doc/engineering/PLUGIN_AUTHORING_GUIDE.md`.

## Import Boundary

- Input is a curated public descriptor, a public GitHub source compatible with
  `skills add`, a bounded browser upload of a Codex Plugin folder or ZIP, or an
  ordered local/GitHub Codex marketplace. Curated and URL sources resolve a
  stable Release or default branch HEAD to a full immutable SHA; explicitly
  configured GitHub marketplaces require the full SHA as input.
- The required manifest is `.codex-plugin/plugin.json`.
- Inspection normalizes safe package paths, computes SHA-256 over the exact
  snapshot, parses declared/default Skills, MCP definitions, and App aliases,
  and preserves the raw manifest and unknown content.
- Preview executes no `npx`, scripts, hooks, MCP servers, Apps, package-manager
  lifecycle steps, or third-party installer. Network requests are limited to
  bounded catalog and public GitHub retrieval before Rudder persists the
  immutable package snapshot.
- Literal MCP credentials, unsafe paths, ZIP expansion, path collisions,
  invalid identity, missing references, and package limits fail before
  installation.

## Installation Boundary

- Installation is scoped to one Organization and references an immutable
  package snapshot plus the Organization's source record and Preview ID.
- Detail refresh and installation read the persisted Preview. They never
  re-resolve a moving upstream Release, branch, or tag between Preview and
  install.
- Skills materialize through the Organization Skill Library with
  `plugin_managed` provenance and remain read-only.
- Existing Skill collisions require an explicit keep, replace, or rename
  choice. Keeping an existing Skill does not transfer Plugin ownership.
- Agent Skill assignment is explicit and uses the existing Agent Skill
  selection service.
- MCP setup uses the managed MCP service and deployment allowlists. It creates
  a disabled draft only; credentials and activation stay in Managed MCP.
- `.app.json` aliases and unsupported components are visible evidence, never
  executable authority.
- Codex browser extensions, scheduled-task templates, and hooks are explicit
  unsupported inventory. They remain in the snapshot and are never loaded.
- Local Apps retain App Builder/Desktop process, source, attestation, and data
  ownership. Each observable Local App revision produces an immutable pending
  app-only package. The current revision stays active until explicit Preview and
  apply advances the installed Plugin without changing its `/apps/...` route.
  Reconciliation can recreate an uninstalled projection while the App still
  exists.
- Active managed MCP connections may discover and read HTML UI resources.
  Rudder renders accepted HTML in a network-disabled sandbox; `.app.json`
  aliases do not participate in MCP resource discovery.

## Lifecycle Boundary

- Disable removes package Skills from new runtime projection and current Agent
  selection, preserving the prior selection for re-enable.
- Customize creates an independent editable managed-local Organization Skill
  with package provenance. It is not a package-owned projection.
- Update prepares new projections before switching the installation's package
  pointer. The previous immutable package remains available for explicit
  rollback; preparation failure leaves the current package active.
- Update Preview compares the old and new component and execution surfaces.
  Added or changed executable Skills and MCP commands/endpoints require an
  explicit access-expansion confirmation before the package pointer can move.
- Uninstall removes package-owned Skill projections and the active installation
  identity. It does not delete external MCP connections, Local App source/data,
  or user-owned Rudder records.
- Hub is always available in the Primary Rail. Legacy `experimentalPluginsEnabled`
  and `experimentalSitesEnabled` fields are accepted for compatibility but no
  longer gate Plugin, Skill, or App behavior.
- Plugin disablement excludes linked MCP connections and Plugin-managed Skills
  from new Agent runtime context without deleting the Managed MCP connection or
  immutable package.
- Historical legacy Plugin tables may remain for migration safety but no active
  route, service, CLI, SDK, worker, job, webhook, UI slot, state store, or tool
  RPC may depend on them.
