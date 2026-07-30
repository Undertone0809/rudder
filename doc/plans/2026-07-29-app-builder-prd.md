---
title: App Builder product requirements
date: 2026-07-29
kind: proposal
status: completed
area: workspace
entities:
  - app_builder
  - desktop_local_apps
  - organization_workspace
  - app_preview
issue:
related_plans:
  - 2026-07-23-messenger-work-packages-local-apps.md
  - 2026-07-15-isolated-library-website-preview.md
  - 2026-05-19-library-project-context-workspace-proposal.md
supersedes:
  - 2026-07-29-local-app-builder-prd.md
related_code:
  - server/resources/bundled-skills/app-builder
  - packages/db/src/schema/app_builder_apps.ts
  - packages/shared/src/types/app-builder.ts
  - server/src/services/app-builder.ts
  - desktop/src/app-builder-ipc.ts
  - desktop/src/local-apps-runtime.ts
  - ui/src/pages/Apps.tsx
  - ui/src/pages/InstanceExperimentalSettings.tsx
commit_refs: []
updated_at: 2026-07-29
---

# App Builder Product Requirements

## Decision

Rudder will provide **App Builder** for people who want to describe a business
workflow and get a working application without first choosing or learning a web
stack. The experience is an experimental, instance-level **Sites** capability
with a dedicated top-level **Apps** workspace. Its user-facing App Builder name
does not include “Local.”

The App is a normal webpage running on the user's computer. `Open` displays it
inside Rudder's browser. `Copy App link` copies the current attested loopback
URL so another browser on the same computer can open it while the App process
is running.

V1 includes no cloud build, hosting, publishing, public link, tunnel, hosted
database, or cross-device sync. Model providers, dependency downloads, and
requested integrations may still use the network.

## Users And Jobs

The primary user is a non-technical operator asking for a cold-email manager,
CRM, marketing-data system, dashboard, tracker, or internal operations tool.
Rudder chooses the maintained technical stack.

Existing data is a normal case. The App owns its database and services; Rudder
does not copy business rows into its own database. The Skill asks about
synthetic, copied, redacted, or directly accessed data only when the choice
materially changes risk or expected behavior.

Technical users may inspect and edit all generated source or use their own
terminal, IDE, stack, and manual Local App definition.

## V1 Product Boundary

V1 delivers:

- an instance-level `Enable Sites` experimental setting, off by default;
- an `Apps` Primary Rail destination that appears only while Sites is enabled;
- one durable, organization-scoped App Builder record without creating or
  exposing a backing Project;
- an Apps Home input that opens a normal Chat and automatically invokes the
  `app-builder` Skill;
- an Apps three-column workspace with Home, search, registered Apps, an
  embedded App surface, contextual controls, and multiple closable tabs;
- manual Local App loading from the Apps workspace;
- one bundled `app-builder` Skill;
- one versioned full-stack scaffold;
- a Desktop-owned fixed runner that installs dependencies, runs typecheck,
  unit tests, production build, and a real loopback readiness check;
- a reviewed, opaque installation-local App binding;
- Start, Stop, Open, Copy App link, Continue in Chat, and Open source;
- development-data Backup, Export, Import, and Restore;
- clear unavailable and failure states;
- macOS, Linux, and Windows process-ownership adapters.

V1 does not claim:

- immutable release promotion or production rollback;
- a Rudder-managed production migration service;
- a Rudder job scheduler or missed-job confirmation UI;
- Rudder Secret vault/binding UI;
- an Agent Browser verification lease or automatically persisted screenshot
  evidence;
- OS daemon behavior or automatic start on login.

The scaffold may include conventions that support later application work, and
Desktop may contain lower-level recovery primitives. Those do not become
user-facing promises until their full UI/runtime/E2E contracts ship.

## Maintained Scaffold

The supported scaffold uses:

- Next.js App Router, React, TypeScript, and Tailwind CSS;
- Rudder-curated shadcn-style source components;
- application-owned SQLite, Drizzle migrations, and Zod validation;
- Vitest and Playwright;
- a fixed `/api/__rudder/health` endpoint;
- JSON import/export conventions;
- a versioned `rudder.app.json`;
- Rudder-managed Node and pnpm execution.

The scaffold is ordinary, inspectable source. App Builder hides unnecessary
technical choices from the default flow without locking technical users out.

## Entry Flow

### Enable Sites

An instance administrator opens **Settings → Experimental** and enables
**Sites**. This makes the App Builder Skill available to Agent runs, enables
Local App loading, and adds **Apps** to the Primary Rail. Disabling Sites first
stops running Apps, then hides the workspace and prevents new App Builder work
without deleting App source, definitions, or business data already stored on
the device.

### Apps Home

Apps is a Rudder-native three-column workspace. The left column contains Home,
search, and registered Apps. Home's main content says **Turn ideas into
applications** and provides a focused request composer. Sending a request:

1. creates a normal Chat using the selected organization's available Agent;
2. atomically sends the user's brief with `$app-builder` and the assigned
   organization-workspace App source root already attached;
3. creates the durable App Builder record from the acknowledged Chat; and
4. navigates to that Chat so requirements and implementation remain visible.

When source work is ready, the App entry offers **Register & preview**. The
explicit execution disclosure remains required before Desktop verifies,
registers, and starts the App.

### Chat

The created Chat is an ordinary Rudder Chat with the App Builder Skill
explicitly attached to its first request. Continued requirements and
implementation work happen there. App creation does not add a Project card,
create a hidden Project, or require Project context.

### Registered App

The Apps workspace shows durable build and binding state:

- source work pending: `Continue in Chat`;
- source exists: `Register & preview`;
- running: `Open`, `Copy App link`, `Stop`, `Continue in Chat`, `Open source`;
- bound App: development-data Backup, Import, and Restore;
- failed or unavailable: causal error and recovery direction.

`Register & preview` does not create generic source. If Chat/Skill work has not
produced a valid manifest at the assigned root, the action fails and directs
the operator back to Chat.

## Build And Runtime Contract

Build state is:

`preparing -> building -> verifying -> ready | failed`.

The first exact managed build requires an explicit disclosure that Rudder will
install packages, execute the fixed scaffold lifecycle scripts, run typecheck,
tests, and build, and start a loopback process. Canceling runs nothing.

`verifying` means the real Desktop runner is executing those checks plus live
readiness and listener-ownership attestation. `ready` is written only after all
of them pass. It does not mean that an Agent Browser workflow or production
promotion occurred.

The runtime listener binds to `127.0.0.1`, uses a Rudder-selected port, and must
belong to the owned process generation. Foreign or unprovable listeners fail
closed. Opening Chat, Apps, an App tab, or Rudder never passively
starts an App.

Explicit Stop and explicit Rudder quit terminate the owned process tree.
Closing a view or window while Rudder remains resident does not implicitly
delete the App or its data.

## Browser Behavior

Opening a registered App adds or activates a closable tab in the Apps header.
Its webpage renders in the Apps main content using the App's opaque Desktop
binding and App-specific browser partition. Switching tabs does not imply
process authority, and a stopped App always requires an explicit start.

While the generation is running, `Copy App link` obtains the attested target
from Desktop and copies its `http://127.0.0.1:<port>/...` URL. The URL:

- works only on the same computer;
- may stop working or change after Stop/restart;
- is never described as stable, public, hosted, or cross-device;
- never weakens loopback binding or listener ownership.

## Data Boundary

The maintained scaffold separates:

- development data: `data/development/`;
- reserved formal data: `data/production/`.

The Apps inspector's V1 data actions first stop the managed App and operate only
on the development-data directory. Backup/export/import/restore cannot replace
the reserved production directory.

The App itself owns its database schema, business records, import behavior,
integrations, and any background work. Real-data or side-effect decisions are
handled in Chat and in the generated App. App Builder V1 does not claim a
universal sandbox or production deployment pipeline.

## Authorization And Safety

The managed exception authorizes only the exact scaffold revision, assigned
App root, fixed Rudder runner, declared package graph, and loopback readiness
contract. It never accepts an Agent-provided shell command, executable, port,
absolute cwd, or environment value.

A changed managed definition loses the initial authorization and returns to
the existing manual Local App review path. Manual Local Apps retain direct
review and start semantics.

The Server stores only the organization relationship, optional originating
Chat, relative source root, scaffold revision, safe lifecycle state, and opaque Desktop ids. Absolute
paths, commands, PIDs, ports, live URLs, App rows, and Secret values stay out of
Server persistence.

## Acceptance

V1 is accepted only when automated and black-box evidence proves:

1. Sites is off by default; enabling it reveals Apps and enables the bundled
   Skill without tying eligibility to a specific desktop operating system.
2. Apps Home creates a normal Chat whose first request invokes App Builder
   without asking the user to choose a stack.
3. App records are organization-scoped and cannot collide on source root in the
   same organization; Apps Home creates no backing Project.
4. Missing source cannot be copied from the generic template and marked Ready.
5. The execution disclosure can be canceled without starting build/runtime.
6. The fixed scaffold passes frozen install, typecheck, tests, build, and App
   E2E.
7. Desktop starts a loopback listener owned by the managed generation and
   writes Ready only after real readiness.
8. Registered Apps appear in the left column; multiple Apps can be opened,
   switched, and closed through header tabs.
9. Open renders the webpage in Rudder and Copy App link reaches the same
   generation from an ordinary browser on the same computer.
10. Opening Chat, Apps, a tab, or Desktop does not passively start it.
11. CRUD persists across Stop/Start.
12. Development Backup/Export/Import/Restore round-trips representative rows
    without touching reserved production data.
13. Explicit Stop and Rudder quit leave no owned App process.
14. Failure and foreign-listener paths fail closed.
15. No UI offers cloud build, hosting, publication, tunnel, or public URL.
16. Claimed platform packages include tested process adapters and the managed
    toolchain.

## Future Increments

Potential separate contracts include immutable release promotion, production
migration and rollback, managed Secret bindings, application job governance,
and Agent Browser verification evidence. They are intentionally excluded from
this V1 acceptance gate.
