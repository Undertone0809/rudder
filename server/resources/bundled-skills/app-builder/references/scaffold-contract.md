# Scaffold Contract

## Purpose

The maintained scaffold is the default foundation for non-technical users. Do
not offer a framework chooser. It is not a requirement for existing websites
that will be loaded as Rudder Apps.

## Existing Web Projects

When the user already has a local web project, preserve its framework, package
manager, data model, scripts, and test conventions. Do not copy scaffold files
or add `rudder.app.json` to make an independently authored project appear
managed.

Rudder Desktop discovers a direct `dev`, `start`, `serve`, or `preview` script
from `package.json`. It recognizes common direct framework commands for Next.js,
Vite-based React or Vue, Astro, SvelteKit, Nuxt, Vue CLI, and `react-scripts`.
When the ordinary inference is insufficient, the project may add a `rudder`
object to `package.json` with `readiness.path`, `readiness.timeoutMs`, or
`openPath`. The operator still reviews the complete structured launch
definition through **Apps + > Add local web project** before anything runs.

## Fixed Foundation

- Next.js App Router, React, and TypeScript
- Tailwind CSS with shadcn-style component source owned by the project
- a versioned Rudder UI preset with semantic light/dark tokens and compact
  operator-tool primitives
- SQLite with Drizzle ORM
- Zod at API, import, and form boundaries
- Vitest for unit tests and Playwright for browser tests
- one loopback web entry point and an in-process durable job runner

The scaffold may internally create child processes. Process topology is an
implementation detail and must not become a user decision.

## Required Files And Behaviors

- `rudder.app.json` uses schema version 1 and a maintained template revision.
- `rudder.ui.json` identifies the source-owned Rudder UI preset revision;
  `components.json` keeps the project compatible with the normal shadcn CLI.
- `/api/__rudder/health` returns readiness only after the app can open its
  selected database.
- `RUDDER_APP_DATA_MODE=development|production` selects the database without
  embedding an absolute path in source.
- `RUDDER_APP_DATA_DIR` may override the default `data/` directory.
- `data/development/dev.sqlite` is for development;
  `data/production/app.sqlite` is reserved for formal app data.
- `migrations/` is committed source. SQLite files, snapshots, uploads, exports,
  and secrets are ignored by Git.
- `/api/data/export` returns a versioned JSON envelope.
- `/api/data/import` validates the complete envelope with Zod before a
  transaction changes data.
- background jobs persist their schedule, idempotency key, status, attempts,
  and catch-up policy.

## Manifest Authority

For maintained apps, the template id and revision determine the executable
recipe. Do not add arbitrary executable paths or shell commands to
`rudder.app.json`. Changes to runtime, readiness, data paths, inherited
environment names, or template revision require a new runtime review.

Run `scripts/validate-manifest.mjs <app-root>/rudder.app.json` after editing the
manifest.

## Commands

- `pnpm dev`: migrate the development database, then run loopback development.
- `pnpm typecheck`: TypeScript validation.
- `pnpm test`: unit and API-contract tests.
- `pnpm build`: production build.
- `pnpm test:e2e`: Playwright against a prepared preview.
- `pnpm db:generate`: generate migrations after a schema change.
- `pnpm db:migrate`: apply committed migrations to the selected data mode.
- `pnpm data:snapshot`: copy the selected SQLite database to `data/snapshots/`
  using SQLite's backup API.
- `pnpm verify`: typecheck, tests, and build.
- `pnpm ui:check`: validate the maintained Rudder UI preset files and semantic
  token contract.

Formal app start must not silently migrate real data. Promotion owns that step.
