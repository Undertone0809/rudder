---
title: App Builder implementation
date: 2026-07-29
kind: implementation
status: completed
area: workspace
entities:
  - app_builder
  - desktop_local_apps
  - organization_workspace
  - app_preview
issue:
related_plans:
  - 2026-07-29-app-builder-prd.md
  - 2026-07-23-messenger-work-packages-local-apps.md
supersedes: []
related_code:
  - server/resources/bundled-skills/app-builder
  - packages/db/src/schema/app_builder_apps.ts
  - packages/shared/src/types/app-builder.ts
  - server/src/services/app-builder.ts
  - desktop/src/app-builder-ipc.ts
  - ui/src/pages/Apps.tsx
  - ui/src/pages/InstanceExperimentalSettings.tsx
commit_refs: []
updated_at: 2026-07-29
---

# App Builder Implementation

## Scope

Deliver the approved App Builder workflow on `main` without creating a feature
branch. Preserve unrelated working-tree changes and commit only App Builder
files and narrow integration hunks.

## Product Logic Alignment

- Add `APP.BUILDER.001`.
- Add a managed-session exception to `DESKTOP.LOCAL.APPS.001`; manual Local
  Apps keep direct operator review and start semantics.
- Extend `WORKSPACE.ORG.001` with the normalized `apps/<slug>` source root and
  split source/data authority without a backing Project.
- Extend `AGENT.SKILLS.001` with the Sites-gated `app-builder` Skill.
- Keep Browser verification on the existing operator/Agent surfaces; V1 adds no
  App-specific Agent Browser lease.

## Workstreams

### 1. Shared, database, and Server

- add organization-scoped `app_builder_apps` and version/evidence state needed
  by the first complete workflow;
- add normalized relative-path validators and narrow lifecycle validators;
- add organization-scoped App endpoints and mutation activity;
- persist only safe state and opaque Desktop identities;
- add service/route/organization-boundary tests and migration.

### 2. Built-in Skill and scaffold

- create the repo-owned Skill with `skill-creator`;
- add the versioned Next.js/React/TypeScript/Tailwind/SQLite/Drizzle/Zod
  scaffold;
- include health, isolated development/reserved-formal data paths, migration,
  JSON export/import, Vitest, and Playwright conventions;
- validate Skill metadata, resources, trigger behavior, and scaffold manifest.

### 3. Desktop runtime

- validate the App manifest and safe roots;
- use Rudder-owned structured commands and a managed toolchain;
- reuse Local Apps process/runtime/guest ownership rather than adding another
  general process manager;
- add platform process adapters and development-data snapshot/import/restore;
- stop Apps/jobs on explicit Desktop quit and never on passive view lifecycle.

### 4. Experimental gate, Chat, and Apps UI

- add an instance-level Experimental → Enable Sites setting;
- gate App Builder Skill materialization and Primary Rail visibility;
- make Apps Home the creation entry and start a normal Chat whose first message
  explicitly invokes `$app-builder`;
- add a top-level Apps workspace with a Home request composer, registered App
  navigation, embedded webpages, contextual runtime actions, and multiple tabs;
- move build, preview, run, stop, source, continue, loopback-link, and
  development-data recovery states out of Project and into Apps;
- keep manual Local Apps available to technical users;
- show honest unavailable and data-mode states.

## Verification

- unit and integration tests for validators, service/routes, Skill/scaffold,
  Desktop manifest/runtime/data, and UI states;
- real E2E from Apps Home through Chat plus scaffold/runtime black-box coverage
  for build, preview, CRUD persistence, failure, export/import, and cleanup;
- Desktop packaged smoke including owned-process cleanup;
- rendered UI inspection with screenshots;
- `pnpm product-logic:check`;
- `pnpm lint`;
- `pnpm -r typecheck`;
- `pnpm test:run`;
- `pnpm build`;
- `pnpm desktop:verify`;
- independent adversarial review;
- independent black-box acceptance using a real local Desktop environment.

## Handoff

After all checks pass:

1. record validation and screenshots;
2. mark this plan completed and add the commit reference;
3. commit only App Builder changes with Conventional Commit format;
4. push `main`;
5. report exact checks, product-contract alignment, data/migration impact, and
   any honest platform availability limits.
