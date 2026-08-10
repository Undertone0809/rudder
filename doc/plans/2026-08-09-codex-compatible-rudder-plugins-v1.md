---
title: Codex-Compatible Rudder Plugins V1
date: 2026-08-09
kind: implementation
status: implemented
area: skills
entities:
  - rudder_plugins
  - codex_plugin_import
  - plugin_marketplace
  - plugin_components
issue:
related_plans:
  - 2026-07-23-managed-mcp-oauth-integrations.md
  - 2026-07-27-managed-mcp-connection-scopes.md
  - 2026-07-29-app-builder-prd.md
  - 2026-07-29-app-builder-implementation.md
supersedes:
  - 2026-03-13-plugin-kitchen-sink-example.md
related_code:
  - packages/db/src/schema/app_builder_apps.ts
  - packages/db/src/schema/mcp_connections.ts
  - packages/shared/src/organization-skill-reference.ts
  - server/src/services/agent-enabled-skills.ts
  - server/src/services/mcp
  - ui/src/pages/Apps.tsx
  - ui/src/pages/InstanceExperimentalSettings.tsx
  - ui/src/components/PrimaryRail.tsx
commit_refs: []
updated_at: 2026-08-10
---

# Codex-Compatible Rudder Plugins V1

## Implementation Status

This PRD is implemented as the Codex-compatible Rudder Plugins V1 candidate.
The approved Product Logic Registry delta is synchronized in
`doc/product/domains/plugins/lifecycle-capabilities.md` and the related Agent,
MCP, App Builder, Desktop, and Organization contracts.

The legacy Rudder Plugin worker, jobs, webhooks, UI slots, host SDK, and tool
RPC implementation has been removed from active source and product surfaces.
Historical migrations remain only for upgrade safety. No legacy Plugin runtime
or package compatibility promise carries into V1.

## Executive Decision

Rudder Plugins should be installable capability bundles that users discover,
install, configure, and share. The user-facing promise is an outcome or
capability. The package contents are implementation detail.

The V1 decisions are:

1. **Codex Plugin compatibility is the upstream package baseline.** Rudder can
   import an unmodified Codex Plugin folder, archive, or supported marketplace
   entry and produce a compatibility report before installation.
2. **A Rudder Plugin is not a runtime.** It does not own workers, jobs,
   webhooks, schedules, goals, agents, documents, or generic UI slots.
3. **The executable V1 component set is Skills, MCP servers, and Apps.** A
   Plugin must contain at least one supported or setup-capable component.
4. **Install adds capability; setup binds it to work.** Installation never
   silently creates an Agent, Goal, Automation, Chat, Issue, or user document.
5. **Plugins are installed into an Organization.** Skill enablement, MCP
   credentials, Agent access, and App execution keep their existing narrower
   ownership and permission boundaries.
6. **Codex compatibility is asymmetric.** Compatible Codex Plugins should
   import directly into Rudder. Rudder-native Local App extensions are not
   automatically claimed to be portable back to Codex.
7. **Unsupported upstream components are preserved and reported, not silently
   dropped or executed.** Future Codex fields can therefore be supported
   without destructive re-import.
8. **The experimental product entry becomes Enable Plugins.** When enabled,
   Plugins replaces Apps in the Primary Rail while preserving direct access to
   installed Rudder Apps.

In compact form:

```text
User intent -> capability promise -> Plugin install -> explicit setup
            -> Chat / Goal / Messenger / App use -> inspectable result

Plugin package = identity + metadata + one or more capability components
Rudder V1 components = Skills + MCP servers + App entries
```

## What Is The Problem?

### The current Rudder Plugin solves the wrong problem

The legacy Plugin system is a generic host extension runtime. Its model is
centered on workers, host capabilities, jobs, webhooks, UI mount slots, logs,
state, and tool dispatch. That architecture asks authors and operators to
understand Rudder-specific extension machinery before they can distribute a
repeatable capability.

The intended new user job is simpler:

> Help my Agent team gain a reusable capability, connect the tools it needs,
> and open an interactive surface when the work benefits from one.

Reusing the old runtime would preserve implementation weight without improving
this user journey.

### Component nouns are not a user information architecture

Apps, Skills, and MCP servers are not equivalent user concepts:

- a Skill describes how an Agent should perform repeatable work;
- an MCP server provides controlled tools, data, authentication, and actions;
- an App gives a human an interactive surface to inspect or manipulate work.

They belong together as package components, but users should not have to
assemble their relationship before installing a useful capability. A Plugin
listing should lead with what it helps the user accomplish, what it accesses,
what it changes, and where its result appears.

### Rudder needs an ecosystem strategy, not another private format

OpenAI currently defines Plugins as installable packages shared by ChatGPT and
Codex. The public shape has a required `.codex-plugin/plugin.json` manifest and
can include Skills, MCP server configuration, optional MCP-backed UI, assets,
hooks, and other product-specific resources.

Creating a Rudder-first package and translating Codex Plugins into it would:

- force authors to maintain two distributions;
- make import lossy as the upstream format evolves;
- fragment identity, versions, assets, and marketplace metadata;
- require Rudder to recreate an ecosystem before delivering user value.

Rudder should instead adopt a compatibility profile around the upstream
package while retaining host-specific activation and security policy.

### “Direct import” is currently ambiguous

V1 defines direct import at the **package level**:

> A user can give Rudder a valid Codex Plugin folder, archive, or marketplace
> source without editing or repackaging it. Rudder inspects the package,
> reports component compatibility, and installs the supported capabilities.

This does not yet mean importing a user's cloud-installed Plugin list,
credentials, or private ChatGPT workspace state. No stable public account-level
export API is assumed by this proposal.

## Reasoning

### 1. Start with the user transition

The meaningful transition is not “a manifest was installed.” It is:

```text
Before: my Agent team cannot reliably perform this class of work.
After:  the capability is available, permissioned, and usable from normal work.
```

That leads to three separate product moments:

1. **Discover**: understand the capability and trust boundary.
2. **Install and set up**: add the package, connect access, and choose scope.
3. **Use**: return to Chat, Goal, Messenger, or an App instead of operating a
   generic Plugin runtime.

The Plugin page owns the first two moments and provides return entry points. It
does not become the universal place where work runs.

### 2. Separate distribution from execution

A Plugin is a distribution and lifecycle boundary. Existing Rudder objects
remain responsible for execution:

| Concern | Owning Rudder object or surface |
| --- | --- |
| Durable responsible actor | Agent |
| Repeatable method | Skill |
| External tools and data | Managed MCP connection and binding |
| Interactive human surface | App entry |
| Current conversational work | Chat |
| Structured current work | Issue |
| Long-term outcome | Goal |
| Scheduled recurrence | Automation |
| One bounded execution | Agent Run |
| User context and outputs | Library, Documents, and artifacts |

This prevents Plugin installation from creating a shadow work-management
system.

### 3. Treat Codex as a compatibility source, not Rudder runtime authority

Rudder should accept the upstream package shape, but it must not delegate its
security or product invariants to package metadata.

- Codex marketplace policy is imported as provenance and intent.
- Rudder organization, Agent, credential, sandbox, approval, and Desktop App
  rules remain authoritative during setup and use.
- An upstream field that Rudder cannot safely map is shown as unsupported.
- Import never means immediate execution.

This approach gives users ecosystem compatibility without letting a foreign
manifest bypass Rudder governance.

### 4. Preserve unknown components instead of flattening the package

The importer should store an immutable source snapshot, raw manifest, parsed
manifest, package digest, compatibility profile, and component report.

Supported components are materialized into their owning Rudder domains, but
the source package remains intact. When Rudder adds support for a future Codex
field, it can re-evaluate the same package rather than require the user to find
and import it again.

### 5. Do not equate Codex Apps with Rudder Local Apps

The current OpenAI package documentation treats `.app.json` as an alias map to
OpenAI-registered ids such as `asdk_app_*`, `connector_*`, or
`templated_apps_*`. It does not contain an MCP endpoint or MCP UI resource and
cannot independently reconstruct a connection in Rudder. Custom MCP UI is
served by a connected MCP server through its tool/resource protocol. Rudder App
Builder produces a different object: a local web application with source,
local data, a reviewed Desktop runner, process ownership, and loopback
attestation.

Both can appear to the user as interactive Plugin entry points, but they need
different adapters and trust boundaries:

| App kind | Source | Execution owner | Primary trust boundary |
| --- | --- | --- | --- |
| OpenAI registered App reference | Codex `.app.json` | OpenAI host registration, unavailable to Rudder V1 | Preserve aliases and ids; do not execute or infer an endpoint |
| MCP UI App | UI resources returned by a connected MCP server | Managed MCP integration | Provider auth, tool policy, UI resource policy |
| Rudder Local App | `rudder.app.json` and an App Builder/App record | Rudder Desktop | Reviewed source, fixed runner, listener ownership, local data |

The UI can call both “Apps.” The importer and runtime must not treat them as
the same executable format.

### 6. Make compatibility asymmetric on purpose

Importing Codex Plugins is the V1 requirement. Exporting every Rudder Plugin
back to Codex is not.

A Skills-only or MCP-backed Rudder Plugin may remain fully Codex-compatible.
An app-only Rudder Local App Plugin uses the Rudder-native package envelope
defined below and is labeled as a Rudder extension. It is a real Installed
Plugin in Rudder, but it is outside the Codex-portable subset. This avoids
misrepresenting a Local App as portable MCP UI while preserving the product
requirement that a Plugin may consist of only an App.

### 7. Prefer explicit setup over silent convenience

Installation may add package metadata and make supported components available
for setup. It must not silently:

- enable Skills for every Agent;
- connect or reuse credentials without disclosure;
- grant organization-wide MCP access;
- start a local process;
- create a Goal or Automation;
- copy user data into an App;
- send data to an external service.

Context can reduce setup friction. For example, installation initiated from an
Agent Chat can preselect that Agent, while installation from Organization
settings can preselect Organization scope. The user still confirms the target
and access.

## Goals

1. Import a valid supported Codex Plugin without requiring package changes.
2. Present one capability-oriented Plugins experience rather than separate
   top-level Apps, Skills, and MCP catalogs.
3. Reuse Rudder's existing Skill, managed MCP, App Builder, Agent, Chat, Goal,
   Automation, and permission systems.
4. Preserve package provenance, version, digest, unknown fields, and unsupported
   components.
5. Make permissions and side effects understandable before activation.
6. Keep the new Plugin domain free of generic execution and host-extension
   APIs.
7. Allow app-only, skills-only, MCP-only, and combined Plugins in Rudder.
8. Keep existing Rudder Apps directly launchable after Apps moves under
   Plugins.

## Non-Goals

- Compatibility with the legacy Rudder Plugin package or SDK.
- Migration of legacy Plugin workers, jobs, webhooks, UI slots, config, state,
  logs, or tool RPC.
- A new Plugin worker process or server-side extension runtime.
- Silent creation of Agents, Goals, Automations, Chats, Issues, or Documents.
- A workflow state-machine engine inside Plugin.
- An account-level import of ChatGPT/Codex cloud credentials or installed state.
- Scraping or depending on an undocumented universal Plugin Directory API.
- Executing Codex hooks, browser extensions, or scheduled task templates in V1.
- Claiming that every Rudder Local App can run in Codex.
- Public Plugin publishing, commercial marketplace policy, ratings, payments,
  or marketplace moderation in V1.
- Replacing the existing Skill, MCP, App Builder, Goal, Automation, or runtime
  permission contracts.

## Product Model

### Capability promise

The user-facing Plugin identity answers:

- What outcome does this help me achieve?
- What examples can I try?
- What will it access or change?
- Where will I use it or receive results?
- Who published it and where did it come from?

### Package definition

Rudder accepts the Codex Plugin package as the upstream import envelope:

```text
plugin-root/
├── .codex-plugin/
│   └── plugin.json
├── skills/                 optional
├── .mcp.json               optional
├── .app.json               optional, OpenAI registered App alias map
├── assets/                 optional
├── hooks or other files    preserved, unsupported in V1 unless mapped
└── .rudder/                optional Rudder extension, never required to import Codex
```

The upstream manifest remains stored without destructive rewriting. Rudder may
derive normalized presentation and component records, but the raw package is
the provenance source.

### Rudder-native Local App package envelope

An app-only Rudder Local App Plugin is a first-class Installed Plugin with an
immutable package version. It uses:

- `.codex-plugin/plugin.json` for compatible identity and presentation
  metadata; and
- `.rudder/plugin.json` for a typed reference to one `rudder.app.json`
  definition, the verified source revision/digest, and the minimum compatible
  Rudder host version.

The Rudder sidecar must not overload the Codex `apps` or `.app.json` fields.
Codex may ignore the sidecar, but Rudder does not claim an app-only package is
useful or publishable in Codex. The sidecar schema is a Rudder extension and
must be validated independently.

App Builder creates this package envelope only after **Register & preview** has
verified a real App source revision. Each later registered revision creates a
new immutable Plugin package version; the Installed Plugin moves to that
version only after normal update review. The package records source identity
and digest but does not copy App business data into Plugin storage.

Existing App Builder records migrate one-to-one into this model: each App gets
one Rudder-native package and one organization-scoped Installed Plugin linked
to the existing App record, source, Desktop binding, and data. The migration
does not rebuild, start, copy, or delete the App.

### Installed Plugin

An Installed Plugin is an organization-scoped record that refers to one
immutable package version and records:

- identity, publisher, version, and source;
- package digest and cached snapshot;
- normalized interface metadata;
- compatibility profile and import report;
- installation, enablement, setup, and health state;
- links to package-owned Skill projections, MCP connections/bindings, and App
  entries;
- requested and granted scopes without storing plaintext secrets;
- update availability and last evaluated package identity.

It does not store Plugin-owned jobs, webhooks, generic state, worker health, or
UI slot registrations.

### Installation scope

The package installation is organization-scoped because Rudder work, Agents,
Skills, MCP access, Apps, and outputs are organization-scoped.

The package cache may be instance-owned and deduplicated by digest. This is a
storage optimization, not a shared permission boundary. Each Organization has
an independent Installed Plugin record and setup state.

Component scopes remain narrower:

- imported Skills appear in the Organization Skill Library as package-owned,
  read-only projections and are enabled for intended Agents separately;
- MCP connections retain organization or Agent ownership and independent
  credentials;
- Rudder App records remain organization-scoped while Desktop owns machine
  execution details;
- MCP UI Apps are discovered from connected MCP servers and inherit their
  managed connection and authorization scope;
- Rudder Local Apps belong to the same organization as their Installed Plugin
  while Desktop retains machine execution ownership.

## Compatibility Profile

Rudder should report every imported component using one of four results:

| Result | Meaning |
| --- | --- |
| `supported` | Rudder can install and use the component without semantic loss. |
| `setup_required` | Rudder understands it, but auth, target, permission, or local review is required. |
| `preserved_unsupported` | Rudder retains it but will not execute or expose it in V1. |
| `incompatible` | The package or component is invalid, unsafe, or cannot be represented truthfully. |

Initial mapping:

| Codex package content | Rudder V1 behavior |
| --- | --- |
| Manifest identity and interface metadata | Import, normalize, and preserve raw values. |
| `skills/` and manifest Skill paths | Project into Organization Skill Library as read-only package content with Plugin provenance; require Agent enablement. |
| HTTP MCP server definitions | Map to managed MCP setup; require explicit target, auth, and access confirmation. |
| STDIO MCP server definitions | Allow only where existing deployment policy permits; require command/environment review. |
| `.app.json` registered App aliases/ids | Preserve as unsupported in V1; never infer an endpoint or MCP UI from the id. |
| UI resources returned by a configured `.mcp.json` server | Expose through the supported MCP UI adapter after managed connection setup. |
| Assets and screenshots | Validate containment and media constraints, then use as presentation metadata. |
| Hooks | Preserve but do not execute in V1. |
| Browser extensions | Preserve but do not execute in V1. |
| Scheduled task templates | Preserve; do not create Rudder Automations in V1. |
| Unknown future fields | Preserve and report; do not fail the entire import unless validation or safety requires it. |

Unknown optional fields must not make a safe known subset disappear. Unknown
required semantics, path violations, invalid identity, or ambiguous executable
content may make the package incompatible.

## User Experience

### Experimental entry

Settings > Experimental replaces **Enable Apps** with **Enable Plugins**.

When disabled:

- Plugins is hidden from the Primary Rail;
- new Plugin import, install, update, and activation are blocked;
- Plugin-provided Skills and MCP bindings are not projected into new Agent
  Runs;
- running Rudder Local Apps reached through Plugins are stopped using the
  existing Desktop ownership rules;
- package snapshots, installation records, source, App source/data, and shared
  MCP credentials are not deleted;
- non-Plugin Organization Skills and MCP connections continue to follow their
  existing settings.

When enabled, **Plugins** replaces **Apps** in the Primary Rail.

### Primary Plugins information architecture

The primary user structure is capability-oriented:

1. **Discover**: browse, search, and inspect available capabilities.
2. **Yours**: installed, recently used, shared, private, and update-available
   Plugins; Apps remain directly launchable here.
3. **Build**: start App Builder when no existing capability fits. Future
   Plugin authoring can be added here without making author tools part of V1.

Skills, MCPs, and Apps may be filters and detail metadata. They are not the
default top-level mental model.

Plugins preserves the current App access continuity. The workspace keeps
installed Apps in its persistent left context column and keeps open App tabs in
the main header. Selecting Plugins in the Primary Rail restores the last active
Plugins location for that Organization; if the user last had an App open, it
returns directly to that App rather than routing through Discover or Yours.
First entry opens Yours when the Organization already has an installed App and
Discover otherwise. Replacing the rail label must not add a mandatory catalog
step before daily App use.

### Plugin card

A compact Plugin card should show:

- icon, name, and one outcome-oriented sentence;
- publisher/source trust marker;
- one primary action derived from current state;
- compact component badges only when they aid scanning;
- setup, update, or degraded status when action is needed.

It should not show raw MCP transport, Skill paths, or manifest fields by
default.

### Plugin detail

The detail surface should answer in this order:

1. What can I accomplish with this?
2. What are representative prompts or workflows?
3. What will it access, execute, or change?
4. Where will results appear?
5. What must I connect or choose?
6. Which Apps, Skills, and MCP servers are included?
7. Who published it, what version is this, and where did it come from?
8. Is any part unsupported in Rudder?

Technical details and raw compatibility reports use progressive disclosure.

### State-derived primary actions

| Installed shape or state | Primary action |
| --- | --- |
| Skills ready | Try in Chat |
| Skills need Agent target | Add to Agent |
| MCP needs authentication | Connect |
| MCP ready | Try in Chat |
| App ready | Open |
| Combined Plugin with unfinished setup | Set up |
| Update available | Review update |
| Unsupported only | View compatibility |

These are interaction outcomes, not schema subclasses.

## User Journeys

### Journey 1: Import an existing Codex Plugin

1. The operator opens Plugins > Yours and selects **Import**.
2. The operator chooses a Plugin folder, archive, or configured marketplace
   entry. Rudder does not ask them to convert the manifest.
3. Rudder copies the source into a bounded staging area, validates it without
   executing package code, computes a digest, and creates an import report.
4. The review surface shows identity, source, version, supported components,
   required setup, unsupported preserved components, permissions, and likely
   side effects.
5. The operator selects the Organization and confirms installation.
6. Rudder stores the immutable package snapshot and materializes only supported
   component metadata.
7. If setup is required, the operator connects MCP access or selects Agent
   targets. Otherwise the Plugin becomes Ready.
8. **Try in Chat** returns the operator to normal work with the selected Agent.

Terminal result: the original Codex package is installed without repackaging,
and the operator knows exactly which capabilities are usable in Rudder.

### Journey 2: A current Chat needs a capability

1. An Agent or operator identifies that the current task needs an unavailable
   capability.
2. Rudder offers a relevant Plugin without replacing the Chat.
3. The operator opens a compact detail/review surface and installs it for the
   current Organization.
4. Current Chat and Agent context preselect the likely Agent target; the
   operator confirms Skill and MCP access.
5. Rudder returns to the same Chat after setup.
6. A new Agent Run receives only the explicitly enabled Skills and MCP
   bindings.
7. In composer `@` search, Rudder presents the Plugin as one capability entry.
   It does not flatten the Plugin's internal Skills into separate results;
   independently owned or customized Skills remain individually mentionable.

Terminal result: capability acquisition feels like resolving a current work
blocker, not navigating to a separate runtime.

### Journey 3: Install a Skills-only operating method

1. The operator discovers a review, research, writing, or delivery Plugin.
2. The detail page shows its intended outcomes and example requests.
3. Install imports its Skills into the Organization Skill Library with source,
   version, digest, and Plugin ownership.
4. The operator chooses one or more Agents. Installation alone does not enable
   it for every Agent.
5. **Try in Chat** opens a normal Chat with a representative editable request.
6. Runs and outputs remain visible through Chat, Issue, review, and artifact
   surfaces.

Terminal result: the Agent gains a repeatable method without a Plugin worker or
new workflow object.

### Journey 4: Install a Plugin that connects an external service

1. The operator chooses a service-oriented Plugin.
2. Before connection, Rudder shows provider, requested access, read/write
   behavior, data boundary, auth timing, and whether access targets the
   Organization or one Agent.
3. The operator authenticates through the existing managed MCP flow or reviews
   a permitted custom MCP definition.
4. Rudder discovers tools, stores secrets server-side, applies coarse access,
   and records a Plugin-to-connection link.
5. A failed connection leaves the Plugin in Setup Required or Degraded without
   blocking unrelated Agent work.
6. The user returns to Chat and asks for the desired outcome.

Terminal result: Plugin setup reuses Rudder MCP security and failure isolation
instead of introducing Plugin-specific credentials or tool dispatch.

### Journey 5: Open an App Plugin

1. The operator opens Plugins > Yours and selects an installed App Plugin.
2. If a configured MCP server exposes supported UI resources, Rudder verifies
   the managed connection and opens that interactive resource. `.app.json`
   registered ids alone never activate this path.
3. If it is a Rudder Local App, Desktop applies the existing reviewed-source,
   process, readiness, and loopback rules.
4. Multiple local Apps retain the existing closable-tab interaction.
5. Chat, source, data recovery, start, and stop actions remain available where
   appropriate for the App kind.

Terminal result: replacing Apps in the Primary Rail does not add friction to
daily App access or weaken either App trust model.

### Journey 6: Build a missing capability as an App

1. The operator searches Discover and finds no suitable capability.
2. Plugins > Build offers **Build App** as a Rudder core action.
3. The existing App Builder journey starts a normal Chat with the
   `app-builder` Skill and preserves its explicit build/runtime disclosure.
4. After successful registration, Rudder creates an immutable Rudder-native
   App Plugin package for that verified source revision and installs it into
   the current Organization.
5. The private App Plugin appears in Yours and links the existing App record
   and originating Chat. It does not create a hidden Project, Agent, Goal, or
   Automation, and its package does not own or copy App business data.

App Builder is a core creation entry, not a Plugin that recursively installs
another Plugin runtime.

### Journey 7: Configure recurring work after installation

1. The operator installs a Plugin that helps produce a recurring result.
2. The Plugin can explain the recurring workflow through Skills and starter
   prompts.
3. If the operator wants recurrence, Rudder opens the existing Automation or
   Goal creation flow with editable prefilled intent.
4. The operator explicitly chooses Agent, schedule, output destination, and
   approval policy.
5. The Automation and subsequent Runs remain normal Rudder objects.

Terminal result: the Plugin helps establish the work but does not own its
schedule or state machine.

### Journey 8: Update, disable, and uninstall

1. Rudder detects a new source version or digest and prepares an update report.
2. The operator reviews manifest, component, permission, and compatibility
   changes before applying the update.
3. Update installs a new immutable package snapshot, rematerializes supported
   components, and preserves compatible Agent bindings and connections.
4. Permission expansion, new executable content, or changed MCP identity
   requires explicit confirmation.
5. Disable removes Plugin-provided capabilities from new Runs and stops its
   Rudder Local Apps without deleting source or data.
6. Uninstall removes the Installed Plugin and owned component bindings.
7. Shared MCP connections, user-created Goals/Automations/Documents, App
   business data, and App source are not deleted implicitly. The operator sees
   separate cleanup choices when safe and relevant.

Terminal result: lifecycle actions are predictable and recoverable rather than
being disguised data deletion.

## Import And Installation Architecture

### Source types

V1 should support the smallest sources that establish real Codex package
compatibility:

1. local Plugin folder;
2. local archive;
3. local or Git-backed Codex marketplace entry with an explicit ref or SHA;
4. optionally, an already resolved npm Plugin package if it can be fetched
   without running lifecycle scripts.

The OpenAI universal Plugin Directory can become another source only after a
documented and permitted discovery/install API exists. Rudder must not scrape
the directory or depend on Codex's private cache layout.

### Import pipeline

```text
Source selection
  -> bounded fetch/copy
  -> archive and path safety checks
  -> raw package digest
  -> manifest parse
  -> component discovery
  -> compatibility analysis
  -> permission and side-effect summary
  -> operator confirmation
  -> immutable package snapshot
  -> organization installation
  -> explicit component setup/binding
  -> Ready | Setup Required | Degraded
```

No Skill script, package script, hook, MCP process, network endpoint, or App
process runs during import analysis.

### Proposed storage shape

The final schema should stay smaller than the removed Plugin runtime:

- `plugin_sources`: configured local, marketplace, Git, or package sources;
- `plugin_packages`: immutable identity/version/digest snapshots plus raw and
  normalized manifest metadata;
- `installed_plugins`: organization installation, selected package, enabled
  flag, setup/readiness, health, and update status;
- `plugin_component_links`: typed provenance links from an installation to
  Organization Skills, managed MCP connections/bindings, and App records;
- `plugin_import_reports`: bounded validation, compatibility, permission, and
  failure evidence.

This proposal intentionally does not include Plugin jobs, webhooks, logs,
generic state, worker processes, capability bridge tables, or UI slots.

### Identity and namespace

- Package identity uses normalized Plugin name plus publisher/source identity.
- A package version is immutable by version and digest. Same version with a
  different digest is a source-integrity conflict, not an in-place update.
- Imported Skill identities are namespaced by Plugin provenance internally so
  two packages cannot silently overwrite each other.
- User-facing Skill names remain readable. Collisions require an explicit
  resolution rather than automatic replacement.
- MCP server and App entry names are scoped to the Installed Plugin and mapped
  to stable Rudder records.

### Composable lifecycle state

One enum cannot truthfully represent installation, enablement, readiness,
health, and update availability at the same time. Persist separate axes:

| Axis | Proposed values |
| --- | --- |
| Import operation | `fetching`, `inspecting`, `review_required`, `accepted`, `rejected`, `failed` |
| Installation lifecycle | `installed`, `uninstalling`, `uninstalled` |
| Enabled | boolean |
| Setup/readiness | `not_required`, `setup_required`, `configuring`, `ready`, `blocked` |
| Health | `unknown`, `healthy`, `degraded`, `unavailable` |
| Update | `none`, `available`, `review_required`, `applying`, `failed` |
| Last operation | operation kind, result, timestamp, and bounded diagnostic |

These axes can coexist. For example, a Plugin may be installed, enabled,
ready, degraded, and update-available at the same time.

`ready` means every required supported component has completed setup. Optional
component failure changes Health to `degraded`. An unsupported-only package
cannot claim ready. Disable changes only the Enabled axis and runtime
projection; it does not erase setup, health, or update information.

An import, update, disable, or uninstall operation failure is recorded on that
operation. It does not replace the last known-good Installed Plugin with a
global Failed state. A failed update keeps the current package active. A failed
uninstall remains installed until reconciliation finishes.

## Runtime Behavior

### Skills

- Project imported Skills into the Organization Skill Library instead of
  copying them directly into arbitrary Agent homes.
- Mark them `plugin_managed`: package-owned, read-only, and backed by the
  immutable installed snapshot.
- Preserve Plugin name, package version, source, and digest in provenance.
- Keep installed projections usable without contacting upstream during
  ordinary Runs.
- Require explicit Agent enablement under `AGENT.SKILLS.001`.
- **Customize** creates an editable Organization Skill fork with a new stable
  identity and provenance pointing to the source package/Skill version.
- The user explicitly chooses whether enabled Agents switch from the packaged
  Skill to the fork. No silent replacement occurs.
- After creation, the fork is independent: Plugin update, disable, and
  uninstall cannot overwrite, disable, or delete it.
- Plugin update replaces only the read-only packaged projection after review.
  Plugin disable removes that projection from new Runs; uninstall removes the
  projection after Agent references are reconciled.

This introduces a new package-managed read-only Skill ownership class and
therefore requires an explicit delta to `AGENT.SKILLS.001`.

### MCP servers

- Route all imported MCP definitions through managed connection validation,
  discovery, credentials, Agent access, run-scoped proxying, audit, timeout,
  and failure isolation.
- Never place imported secrets directly into model prompts or package snapshots.
- HTTP and STDIO transports retain the existing deployment-mode restrictions.
- An imported package cannot mark an MCP capability as runtime-admission
  authority. Unavailable external MCP removes that capability while unrelated
  Agent work continues.

### Apps

- MCP UI Apps use the managed MCP connection and supported MCP UI rendering
  path.
- Rudder Local Apps preserve App Builder and Desktop execution contracts.
- Opening a Plugin page, App card, tab, Chat, or Rudder itself does not
  passively start a Local App.
- App data stays owned by the App. Plugin lifecycle does not copy business
  rows into Rudder or delete them implicitly.

### Workflows, Goals, and Automations

- A Skill may describe a repeatable workflow.
- A Plugin may provide starter prompts that help configure a Goal or
  Automation.
- The resulting Goal, Automation, Chat, Issue, Run, and output are ordinary
  Rudder records with normal ownership and review.
- Scheduled task templates imported from a Codex Plugin remain preserved but
  unsupported in V1 rather than silently creating recurrence.

## Marketplace Model

Rudder should distinguish sources from installations:

- **OpenAI/public**: future source when an official directory integration is
  available;
- **Workspace**: an administrator-curated Rudder or Codex marketplace;
- **Personal/local**: local Plugin and marketplace sources on the operator's
  machine;
- **Created by you**: private Apps and future Plugins built inside Rudder;
- **Shared with you**: future sharing surface, not required for V1.

Codex `marketplace.json` metadata should be parsed rather than rewritten.

- `policy.installation` informs availability, but external
  `INSTALLED_BY_DEFAULT` never causes a silent Rudder installation merely by
  adding a marketplace source.
- `policy.authentication` maps to install-time or first-use setup where Rudder
  supports the auth flow.
- `policy.products` is preserved as publisher intent. Rudder does not pretend
  to be an OpenAI product named in that list.
- Category and source ordering may inform discovery presentation without
  overriding Rudder trust and compatibility status.

## Security And Trust

### Package ingestion

- Treat every imported package and archive as untrusted input.
- Enforce size, file-count, decompression-ratio, path-length, and nesting
  limits.
- Reject traversal, absolute paths, device files, escaping symlinks, and
  case-folding collisions.
- Validate referenced files remain within the package root.
- Compute the digest before materialization and recheck it before install.
- Do not execute package-manager lifecycle scripts during fetch or import.
- Store a bounded, inspectable import report without secrets or unbounded file
  dumps.

### Skills and scripts

Skills are instructions and may contain scripts that execute only when a later
Agent task uses them. The install review must disclose scripts and executable
assets. Later execution remains subject to the selected runtime's sandbox,
approval, workspace, and network policy.

### MCP and authentication

- Show provider, endpoint/command class, read/write intent, requested scope,
  and external data boundary before connection.
- Keep credentials in the existing encrypted managed MCP boundary.
- Apply live permission reductions to active runs according to current MCP
  contracts.
- Require additional confirmation for destructive or open-world tools where
  annotations and Rudder policy indicate side effects.

### Apps

- MCP UI follows managed connection and UI resource policy.
- Local App import or execution never bypasses the existing Desktop disclosure,
  reviewed definition, fixed runner, process ownership, and loopback checks.
- Imported visual assets are presentation data, not executable host UI slots.

### Updates

- Show identity, digest, component, executable content, endpoint, permission,
  and compatibility changes before update.
- Never auto-accept a same-version different-digest package.
- Preserve a rollback pointer to the previous installed package until the new
  package setup succeeds or the bounded retention window expires.

## Failure And Recovery

| Failure | Required behavior |
| --- | --- |
| Invalid manifest | Reject install with field-level diagnostics; preserve no active partial installation. |
| One optional component unsupported | Install supported components only after explicit review; report Degraded. |
| Required component unsupported | Do not claim Ready; allow cancel or install disabled for inspection. |
| MCP auth canceled | Keep Setup Required; expose retry without affecting unrelated work. |
| MCP unavailable at run time | Omit affected tools, record bounded diagnostic, continue Agent execution. |
| Skill collision | Require explicit keep, replace, or renamed/forked import resolution. |
| Local App review canceled | Run nothing and create no App Plugin package for the unverified revision; preserve any last known-good installed revision. |
| Update expands permission | Pause update until explicit confirmation. |
| Source disappears | Continue using the immutable installed snapshot; report update source unavailable. |
| Disable is interrupted | Keep the persisted Enabled value until component projection is reconciled; record the operation failure separately. |
| Uninstall is interrupted | Remain Installed until component references reconcile; do not delete user data. |

## Observability

The new Plugin domain needs lifecycle and compatibility evidence, not a generic
Plugin log platform.

Record:

- import source class, package identity, version, and digest;
- compatibility result by component;
- install, setup, enable, disable, update, and uninstall outcomes;
- links to existing Skill, MCP, App, and Agent audit evidence;
- failure category and safe recovery direction;
- last used timestamp and entry surface for product usability analysis.

Do not duplicate MCP tool-call logs, Agent Run transcripts, App process logs,
or Automation run evidence inside Plugin tables.

## Migration And Breaking Change

This is a deliberate breaking replacement of the legacy Rudder Plugin system.

- Legacy Plugin packages are not imported or migrated.
- Legacy Plugin database tables, workers, jobs, webhooks, slots, SDKs, pages,
  routes, and docs are removed by the separate retirement workstream.
- A legacy artifact may be installed only as a new Plugin if it independently
  contains a valid Codex Plugin package.
- Existing Rudder App records and business data are preserved. A narrow
  migration creates one Rudder-native package and Installed Plugin for each App
  and links them to the existing App record, source identity, Desktop binding,
  and data without rebuilding or starting it.
- Existing non-Plugin Organization Skills and managed MCP connections remain
  independent. Import may link to or reuse them only after explicit identity
  and scope confirmation.
- **Enable Apps** becomes **Enable Plugins**. Disabling the feature remains
  non-destructive.

## Rollout

### Phase 0: Legacy retirement prerequisite

- Remove the legacy Plugin runtime and user surface.
- Confirm no old workers, jobs, webhooks, UI slots, or Plugin tool dispatch
  remain authoritative.
- Preserve unrelated Apps, Skills, MCP, Goals, Automations, and Agent behavior.

### Phase 1: Package and compatibility foundation

- Add immutable package snapshots, import reports, and Organization
  installations.
- Support local folder and archive import.
- Parse current Codex manifest, Skills, `.mcp.json`, `.app.json`, assets, and
  unknown fields. Treat `.app.json` ids as preserved unsupported references.
- Deliver security preflight and compatibility reporting without activation.

### Phase 2: Supported component activation

- Materialize read-only package-managed Skill projections with provenance and
  explicit editable-fork behavior.
- Connect imported MCP definitions through managed MCP flows.
- Support MCP UI resources returned by connected MCP servers without using
  `.app.json` as endpoint discovery.
- Migrate existing Rudder Local Apps into one-to-one Rudder-native App Plugins.
- Add setup, disable, update, and uninstall reconciliation.

### Phase 3: Plugins product surface

- Replace Enable Apps with Enable Plugins.
- Replace Apps Primary Rail with Plugins.
- Ship Discover, Yours, Build, details, compatibility review, and state-derived
  actions.
- Preserve direct Local App launch, tabs, Chat continuation, source, runtime,
  and data actions.

### Phase 4: Marketplace sources

- Import local and Git-backed Codex marketplaces with pinned provenance.
- Add update checks and marketplace policy presentation.
- Add a public OpenAI directory source only through a documented permitted API.

## Success Criteria

1. A current valid Codex Skills-only Plugin imports without package edits and
   can be enabled for one selected Rudder Agent.
2. A current valid Codex MCP Plugin imports without package edits, produces an
   accurate permission/setup review, and uses the existing managed MCP runtime.
3. A combined Skills + MCP Plugin preserves package identity and attribution
   across Chat, Agent Run, Skill, and MCP evidence.
4. A Codex `.app.json` is preserved but never executed or misrepresented as an
   MCP endpoint, MCP UI resource, or Rudder Local App. MCP UI works only when a
   separately configured MCP server returns a supported UI resource.
5. Hooks, browser extensions, scheduled templates, and unknown fields are
   preserved but not executed in V1.
6. No import analysis step executes package code, starts MCP, starts an App, or
   contacts an undeclared endpoint.
7. Organization A cannot see, enable, bind, update, or uninstall Organization
   B's Plugin installation or credentials.
8. Installation never silently creates an Agent, Goal, Automation, Chat,
   Issue, or Document.
9. Existing Rudder Apps migrate one-to-one into Rudder-native app-only Plugins
   and remain directly discoverable and launchable from Plugins > Yours with
   existing Desktop safety and data behavior.
10. Disabling Plugins removes Plugin-provided runtime capability and stops
    Plugin Local Apps without deleting packages, source, connections, or data.
11. Updating a package with new permissions or a conflicting digest requires
    review and preserves a safe recovery path.
12. The implementation contains no replacement Plugin worker, job, webhook,
    generic state, UI slot, or host tool RPC system.
13. A new user can import, review, set up, and try a compatible local Codex
    Plugin in under five minutes without understanding its filesystem layout.
14. Customizing a package-managed Skill creates an independent editable fork;
    later Plugin update, disable, or uninstall cannot overwrite or remove it.
15. Selecting Plugins restores the last active App when one was open, so the
    new rail does not add a required directory step to normal App use.

## Testing And Acceptance Plan

### Conformance fixtures

Maintain source-preserving fixtures for:

- minimal Skills-only Plugin;
- MCP-only Plugin using companion `.mcp.json`;
- combined Skills + MCP Plugin;
- connected MCP server returning a supported UI resource;
- `.app.json` containing valid OpenAI registered ids, preserved but not run;
- assets, screenshots, marketplace metadata, and auth policies;
- unknown optional fields and preserved unsupported components;
- same version with changed digest;
- malformed and malicious archives.

Use current official OpenAI examples such as Figma, Notion, and Build web apps
as external conformance references, but pin exact source revisions before using
them as acceptance fixtures.

### Automated coverage

- parser and compatibility matrix unit tests;
- archive/path/security tests;
- database migration, uniqueness, provenance, and organization isolation tests;
- Skill import, collision, read-only projection, Customize/fork, update,
  enablement, disablement, and uninstall-preservation tests;
- MCP target, auth, discovery, permission, failure-isolation, and reuse tests;
- App-kind dispatch and non-confusion tests;
- feature-flag and Primary Rail tests;
- update, rollback, disable, uninstall, and interrupted reconciliation tests;
- API and UI error-state tests.

### Required E2E journeys

1. Enable Plugins and import a real Skills-only Codex package.
2. Review compatibility, select one Agent, Try in Chat, and observe the Skill
   in the resulting Run.
3. Import a combined package, cancel MCP setup, recover, connect, and use it.
4. Prove another Organization cannot observe or use the installation.
5. Open an existing Rudder Local App from Yours, stop/start it, and verify data
   persistence.
6. Connect an imported MCP server that returns UI and prove the resource follows
   the managed connection boundary.
7. Import `.app.json` plus another unsupported component and prove both remain
   visible but are not executed or used for endpoint inference.
8. Review and apply an update, then exercise permission expansion and digest
   conflict cases.
9. Disable Plugins and prove capability removal is non-destructive; re-enable
   and recover the previous setup.
10. Uninstall and prove user Goals, Automations, Documents, shared connections,
    App source, and App business data are not silently deleted.
11. Install a Plugin with multiple Skills and prove composer `@` search shows
    one Plugin result, hides its component Skills, and still shows an enabled
    independent Skill.

Desktop-affecting implementation must run packaged Desktop verification in
addition to browser E2E. Final acceptance requires independent reviewer and
black-box verifier verdicts for the same frozen candidate.

## Product Logic Registry Delta Required After Approval

If this proposal is approved for Product Logic Registry synchronization, the
implementation should explicitly retire:

- `PLUGIN.LIFECYCLE.001`
- `PLUGIN.CAPABILITY.001`
- `PLUGIN.JOBS.WEBHOOKS.001`

and introduce or redefine contracts covering:

- Plugin package identity, source, provenance, and immutable version snapshots;
- Codex package import and compatibility reporting;
- organization-scoped installation and component lifecycle;
- package-managed read-only Skill ownership and editable-fork boundaries;
- managed MCP, MCP UI resource, and Rudder Local App activation boundaries;
- experimental Plugins flag, Primary Rail, and non-destructive disablement;
- update and uninstall preservation rules.

Related current contracts that will need an explicitly approved delta:

- `AGENT.SKILLS.001`
- `AGENT.CUSTOM.INTEGRATIONS.001`
- `AGENT.RUNTIME.PERMISSIONS.001`
- `APP.BUILDER.001`

No `doc/product/**` changes should occur from implementation approval alone.

## Documentation Changes After Approval

- Replace `doc/engineering/PLUGIN_AUTHORING_GUIDE.md` with Codex-compatible
  package authoring and Rudder compatibility guidance.
- Replace `doc/engineering/PLUGIN_RUNTIME_CONTRACT.md` with an import,
  installation, and component-activation contract; remove worker/runtime
  language.
- Update public Plugins documentation and remove legacy worker, jobs, webhook,
  slot, and SDK guidance.
- Update App Builder documentation so Apps lives under Plugins while retaining
  its current runtime and data boundaries.
- Document the compatibility matrix and unsupported-component behavior.
- Document local folder, archive, and marketplace import flows.
- Document the Rudder-native Local App sidecar, its non-portable status, and its
  coexistence with the upstream manifest after schema validation.

## Alternatives Rejected

### Reuse the legacy Rudder Plugin runtime

Rejected because the worker/jobs/webhooks/slots abstraction is unrelated to
the new capability acquisition journey and would preserve a second execution
platform.

### Define a Rudder manifest first and write a Codex converter

Rejected because conversion becomes lossy, creates ecosystem fragmentation,
and makes every upstream schema change a migration problem.

### Treat a Codex manifest as executable authority

Rejected because package compatibility cannot override Rudder Organization,
Agent, credential, sandbox, approval, App, and deployment policies.

### Treat `.app.json` as a Rudder Local App

Rejected because Codex `.app.json` contains only registered OpenAI ids,
optional MCP UI is returned separately through a connected MCP server, and a
Rudder Local App is a Desktop-managed local process and data product.

### Make Plugin a workflow runtime

Rejected because Goal, Automation, Chat, Issue, Run, Skill, and App already own
the relevant state and execution responsibilities.

### Copy Codex's technical tabs as the primary IA

Rejected as the default because users seek outcomes and installed capability,
not a taxonomy lesson. Technical component views remain available through
filters, detail, and Settings.

### Auto-create recurring work during install

Rejected because it hides Agent, schedule, output, approval, and side-effect
decisions. The Plugin may prefill the normal Goal or Automation flow instead.

## Resolved V1 Decisions And Deferred Work

1. Option A is the implemented product direction: Plugins in the Primary Rail
   with Discover, Yours, Build, detail review, and direct App continuity.
2. V1 marketplace sources are local folders and HTTPS GitHub repositories
   pinned to a full commit SHA. npm and moving Git refs are not V1 sources.
3. Public catalog synchronization remains deferred until OpenAI documents a
   permitted directory API for third-party hosts.
4. V1 displays factual provenance only: local source, marketplace identity,
   immutable digest, repository, and commit. It does not invent verified
   publisher or signed-package trust levels.

## Official Upstream References

This source was refreshed during implementation and remains the compatibility
baseline because the Plugin format is evolving:

- [Plugins in Codex](https://developers.openai.com/codex/plugins)
