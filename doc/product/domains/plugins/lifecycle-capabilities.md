---
title: Plugin Packages And Capability Lifecycle
domain: plugins
status: active
coverage: detailed
contract_ids:
  - PLUGIN.PACKAGE.001
  - PLUGIN.IMPORT.001
  - PLUGIN.INSTALLATION.001
related_code:
  - packages/db/src/schema/rudder_plugins.ts
  - packages/shared/src/types/plugin-v1.ts
  - packages/shared/src/validators/plugin-v1.ts
  - server/src/routes/rudder-plugins.ts
  - server/src/services/rudder-plugins.ts
  - server/src/services/rudder-plugin-catalog.ts
  - ui/src/pages/PluginDetail.tsx
  - ui/src/pages/Plugins.tsx
related_tests:
  - server/src/services/rudder-plugins.test.ts
  - server/src/__tests__/rudder-plugins-lifecycle.test.ts
  - tests/e2e/plugins-v1.spec.ts
related_plans:
  - doc/plans/2026-08-09-codex-compatible-rudder-plugins-v1.md
edit_policy: user_confirmed_only
---

# Plugin Packages And Capability Lifecycle

## Retired Contracts

`PLUGIN.LIFECYCLE.001`, `PLUGIN.CAPABILITY.001`, and
`PLUGIN.JOBS.WEBHOOKS.001` are retired. Rudder Plugins no longer provide a
worker runtime, jobs, webhooks, generic state, UI slots, host tools, or an SDK.
Historical database migrations may remain dormant for upgrade safety, but
their tables and records are not active Plugin authority.

## PLUGIN.LIFECYCLE.001

Retired. Replaced by `PLUGIN.PACKAGE.001` and `PLUGIN.INSTALLATION.001`.

## PLUGIN.CAPABILITY.001

Retired. Skills, MCP servers, and Apps use their owning domain permissions.

## PLUGIN.JOBS.WEBHOOKS.001

Retired without replacement. Plugins do not own scheduled or webhook runtime.

## PLUGIN.PACKAGE.001

Why:

- Users need one installable capability boundary without learning whether the
  implementation uses Skills, MCP servers, Apps, or a combination.
- Rudder should consume the Codex Plugin ecosystem instead of defining a
  competing distribution format.

Product model:

- A Plugin is an immutable package snapshot and distribution identity, not a
  runtime or work-management object.
- Rudder accepts the Codex `.codex-plugin/plugin.json` package shape. A package
  may contain one or more Skills, MCP definitions, or App references.
- Rudder's curated catalog may describe either a native Codex Plugin or one
  public GitHub source compatible with `skills add`. For the latter, Rudder
  discovers one or more Skill roots and deterministically generates a
  Skills-only Codex manifest in memory; one repository remains one Plugin even
  when it contains one Skill or many.
- Unknown and unsupported package fields remain preserved in the snapshot.
  Codex `.app.json` aliases are reported but never inferred to be Rudder Local
  Apps or MCP endpoints.
- Rudder Local Apps appear as app-only Plugins in the product surface while
  retaining App Builder and Desktop runtime ownership. This host-native shape
  is not claimed to be portable to Codex.
- Each existing App Builder record has one active Installed Plugin and App
  component link. Each observable App revision produces a new immutable package
  snapshot in `review_required` state while the current revision stays active.
  Applying the reviewed revision advances the installation and retains the
  prior package. The link preserves the existing App identity and direct
  `/apps/...` launch path; it does not copy source or business data into Plugin
  storage.

Invariants:

- Package identity includes name, semantic version, digest, manifest, source,
  and source snapshot.
- The same publisher, source namespace, name, and version cannot silently
  resolve to a different digest within an Organization. Private source
  identity and conflict checks do not leak across Organizations.
- Plugins do not own Agents, Goals, Automations, Chats, Issues, Documents, Runs,
  schedules, credentials, or App business data.

## PLUGIN.IMPORT.001

Why:

- Imported packages are untrusted input and must be understandable before they
  create capability.

Flow:

1. An Organization owner opens a manually curated public Plugin, enters a
   public GitHub source accepted by `skills add`, selects a local Codex Plugin
   folder or ZIP, or adds a local Codex marketplace folder or GitHub marketplace
   pinned to a full commit SHA.
2. For a curated or URL source, Rudder resolves the newest stable semantic
   Release when one exists and otherwise the default branch HEAD, then locks a
   full commit SHA and bounded repository subdirectory. Discover itself remains
   a lightweight catalog and does not download every package.
3. Rudder validates bounded input, safe relative paths, ZIP expansion, manifest
   identity, referenced component paths, and literal credential exposure.
4. Rudder computes the digest and persists an immutable Preview containing the
   exact package snapshot, source resolution, compatibility inventory, warnings,
   errors, and organization-scoped Preview ID.
5. Plugin Detail shows ready, setup-required, unsupported, warning, and error
   states before installation. Refreshing Detail by Preview ID before or after
   install and uninstall reads that persisted snapshot and does not resolve or
   download the upstream again.
6. When the same installed identity has a different semantic version, Plugin
   Detail is an update Preview. The current package remains active until the
   Preview revision is fully prepared.
7. Update Preview shows added, removed, and changed components with the old and
   new execution surface. A new Skill or MCP, changed Skill instructions or
   executable files, or changed MCP command/endpoint is an access expansion and
   requires an explicit operator confirmation before apply.
8. A marketplace entry becomes a Discover Preview. `INSTALLED_BY_DEFAULT` is
   retained as provenance and never causes installation without an explicit
   Rudder install action.

Invariants:

- Preview executes no `npx`, hooks, Skill scripts, MCP servers, Apps,
  package-manager lifecycle steps, or third-party installers. Network access is
  limited to bounded catalog and public source retrieval before the immutable
  Preview is created.
- Traversal, absolute paths, duplicate/case-colliding paths, oversize files,
  oversize packages, invalid JSON, invalid identity, and literal MCP secrets
  are rejected.
- ZIP input is limited to 500 files, 2 MiB per file, 10 MiB compressed and
  expanded package size, and a 100:1 expansion ratio. Rudder strips at most one
  common outer package root and then applies the normal path checks.
- GitHub marketplace ingestion accepts only HTTPS `github.com` repositories
  with a full 40-character commit SHA. Rudder fetches that immutable archive;
  moving branches and tags are not accepted as provenance.
- A package with no supported or setup-capable component cannot be installed.
- Curated and URL sources accept only public HTTPS GitHub repositories and
  bounded redirects. SSH, private repositories, and local paths stay behind
  the existing explicit import boundaries.
- The same version with a conflicting digest is a source-integrity error, not
  an in-place update.
- Discover uses the manually curated Rudder Plugin catalog by default. Catalog
  fetches use ETag and the instance's latest successful cache; a temporary
  outage may show stale discovery data but never disables or mutates installed
  Plugins.
- Codex browser extensions, scheduled-task templates, hooks, and other known
  unsupported surfaces are named in the compatibility inventory and never
  silently ignored or executed.

## PLUGIN.INSTALLATION.001

Why:

- Installation should add capability while keeping execution, credentials,
  assignment, and user data inside their existing owners.

Flow:

1. The exact immutable package named by a Preview ID is installed into exactly
   one Organization. Install and Update never re-resolve the upstream source.
2. Skills materialize as read-only `plugin_managed` Organization Skills.
   When a package Skill conflicts with an existing Organization Skill, the
   operator must explicitly choose keep existing, replace, or install both by
   renaming. Keeping the existing Skill never transfers Plugin ownership.
3. Agent assignment is explicit and replaceable.
4. MCP definitions create only disabled managed-connection drafts after the
   existing deployment policy accepts them; authentication and activation
   continue in Managed MCP settings.
5. Enable, disable, and uninstall reconcile package-owned projections without
   deleting external MCP connections, Local App source/data, or ordinary user
   records.
6. Customize creates an independent editable Organization Skill fork with
   package provenance. It is not a Plugin component target and is never removed
   or overwritten by Plugin lifecycle operations.
7. An explicitly accepted update Preview prepares new Skill projections before atomically switching
   package and component links. The prior immutable package remains available
   for explicit rollback; a preparation failure leaves the current package
   active and retryable.
8. Plugin MCP setup and health are derived from the linked Managed MCP
   connection. Active connections may expose HTML UI resources through managed
   MCP resource discovery and a network-disabled sandbox; `.app.json` aliases
   never activate that path.
9. A changed App Builder revision creates an immutable pending Local App package
   and update Preview. The last known-good revision remains active until the
   operator applies the pending revision. If the projection is uninstalled
   while the underlying App still exists, directory reconciliation recreates it
   without changing App source, data, identity, or `/apps/...` launch
   continuity.

Invariants:

- Organization A cannot see, configure, enable, disable, or uninstall
  Organization B's installation, component links, or source label.
- Install never silently creates an Agent, Goal, Automation, Chat, Issue,
  Document, credential, or running process.
- Disabling removes Plugin Skills from new runtime projections and Agent
  selection while preserving the prior selection for re-enable.
- Uninstall removes only package-owned Skill projections. External component
  targets and user-owned data remain intact, and a later reviewed import may be
  installed again.
- A failed initial install compensates package-owned files, component links,
  and the partial installation while leaving its accepted review retryable.
- Disabling and re-enabling does not erase MCP setup. Connection activation,
  error, reauthorization, and disablement reconcile back into component setup
  and Plugin health without duplicating MCP runtime state.
- A Plugin-linked MCP connection is excluded from new Agent runtime context
  whenever that Plugin is disabled or uninstalled. The preserved Managed MCP
  record is not execution access.
- Plugin-managed Skills are likewise excluded from all new runtime
  materialization whenever their Plugin is disabled, even if an older Agent
  selection record remains.
- Updating or rolling back never mutates an immutable package snapshot. A
  failed update keeps the last known-good package and component targets active.
- Installed Plugins remain on their current immutable revision. A lightweight
  Release/HEAD check may show `Update available`, but only a newly opened Detail
  Preview and explicit Update can advance the installation.
- Hub is a Primary Rail capability with Plugins, Skills, and Showcase views that
  is visible only when the instance-level Experimental Plugins capability is
  enabled. Existing `/hub`, `/plugins`, and `/apps/...` routes remain directly
  launchable; when Experimental Plugins is enabled, they select the Hub rail.

Evidence:

- Parser tests cover Codex paths, unknown fields, hooks, browser extensions,
  scheduled-task templates, Skill executable inventory, Apps, MCP definitions,
  secret detection, file bounds, and malicious paths.
- PostgreSQL lifecycle tests cover migration, provenance, Agent assignment,
  enable/disable recovery, failed-install compensation and retry, MCP policy,
  MCP status and UI resources, Organization isolation, Customize preservation,
  Local App revision projection and rebuild, access-expansion confirmation,
  update, rollback, uninstall, and reinstall.
- Browser E2E covers Discover, immutable Detail Preview, URL import, install, assignment,
  enablement, update diff and confirmation, rollback, Organization mutation
  isolation, Local App projection recovery, and uninstall journey.
