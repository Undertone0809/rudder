# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Rudder is an orchestration and control platform for agent work, and the operating layer for agent teams. It organizes goals, tasks, knowledge, and workflows into an executable structure, enabling agents to work within clear boundaries, collaborate, and move work forward.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.
The product north-star metric is the weekly count of real agent-work loops successfully completed through Rudder end-to-end.

## 1.1 Repository Identity

- This repository began as a Rudder fork/derivative of an early version of Paperclip. When renaming or rebranding internals, prefer compatibility-preserving changes for legacy `paperclip*` identifiers, config keys, and protocol values unless a deliberate breaking migration is planned.
- Treat the product description above as the current canonical short introduction when updating README, product docs, and onboarding copy.

## 2. Read This First

Read docs in layers instead of scanning the whole `doc/` tree.

Start here for almost every task:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`

Then choose the route that matches the work:

- Desktop app, packaging, installer, local prod startup:
  - `doc/README.md`
  - `doc/DESKTOP.md`
  - `doc/DEVELOPING.md`
  - `desktop/scripts/smoke.mjs`
  - `scripts/prod-desktop.mjs`
- Server/runtime/database work:
  - `doc/README.md`
  - `doc/DEVELOPING.md`
  - `doc/DATABASE.md`
  - `doc/DEPLOYMENT-MODES.md`
- CLI/task-surface work:
  - `doc/README.md`
  - `doc/CLI.md`
  - `doc/TASKS.md`
  - `doc/TASKS-mcp.md`
- Visible UI or interaction design work:
  - `doc/README.md`
  - `doc/PRODUCT.md`
  - `doc/DESIGN.md`
- Release/publishing work:
  - `doc/README.md`
  - `doc/RELEASING.md`
  - `doc/PUBLISHING.md`
  - `doc/RELEASE-AUTOMATION-SETUP.md`
- Plugin work:
  - `doc/README.md`
  - `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
  - `doc/plugins/PLUGIN_SPEC.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.
`doc/README.md` is the navigation hub for choosing the right doc route.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `server/resources/bundled-skills/`: built-in Rudder runtime skills and their sibling reference docs
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PostgreSQL in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/orgs
```

Reset local dev instance:

```sh
rm -rf ~/.rudder/instances/dev
pnpm dev
```

## 4.1 Desktop Validation Workflow

For Desktop-specific work, development-shell verification is necessary but not sufficient.
Any change that can affect packaged boot, local profile isolation, startup migrations, installer assets, or prod-local data paths must run packaged verification before hand-off.

Preferred contributor workflow:

```sh
pnpm desktop:verify
```

Notes:

- `pnpm desktop:verify` runs:
  - `pnpm --filter @rudderhq/desktop smoke`
  - `pnpm desktop:dist`
  - `node desktop/scripts/smoke.mjs --mode=packaged`
- `pnpm prod` is a convenience command for humans. It builds the installer, verifies packaged boot, and opens the installer. Do not treat it as the only validation step while developing.
- If you touched Desktop startup, migrations, profile routing, or packaging, do not hand off after dev-shell checks alone.
- The Desktop CI workflow should continue to run packaged smoke after packaging, but local contributors must also run the packaged path before claiming the issue is done.

## 5. Core Engineering Rules

1. Start feature work in an isolated git worktree and branch.

   For new feature development, create a fresh worktree and a new branch before editing code. Do not develop new features directly on `main` or inside an existing dirty worktree. Use the repository branch prefix unless the task asks for another name:

   ```sh
   git worktree add -b zeelandc/<short-feature-name> ../rudder-oss-<short-feature-name> main
   cd ../rudder-oss-<short-feature-name>
   ```

2. Keep changes organization-scoped.

   Every domain entity should be scoped to an organization and organization boundaries must be enforced in routes/services.

3. Keep contracts synchronized.

   If you change schema/API behavior, update all impacted layers:

   - `packages/db` schema and exports
   - `packages/shared` types/constants/validators
   - `server` routes/services
   - `ui` API clients and pages

4. Preserve control-plane invariants.

   - Single-assignee task model
   - Atomic issue checkout semantics
   - Approval gates for governed actions
   - Budget hard-stop auto-pause behavior
   - Activity logging for mutating actions

5. Do not replace strategic docs wholesale unless asked.

   Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

6. Keep bundled skill docs synchronized.

   If you change a built-in Rudder skill under `server/resources/bundled-skills/<slug>/`, update the sibling `references/` docs and any contributor-facing docs that describe the bundled-skill location or behavior when they are affected. Do not leave `SKILL.md` content on a newer API contract than the docs that point to it.

7. Keep plan docs dated and centralized.

   New plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. Plan docs must be written in English.
   When using plan mode, write the plan in `doc/plans/` before starting implementation work.
   New plan docs should start with the standard YAML frontmatter described in `doc/DEVELOPING.md`, use the most specific supported `kind`, and choose `area` / `entities` using `doc/plans/_taxonomy.md` plus relevant prior plans.

8. Require end-to-end coverage for feature work.

   Any shipped feature or user-visible workflow change must add or update automated E2E coverage for the path being introduced or changed.
   If no suitable E2E suite exists yet for that area, create it as part of the feature work.
   Do not treat unit, integration, or smoke coverage as a substitute unless the user explicitly approves that exception.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

   ```sh
   pnpm db:generate
   ```

4. Validate compile:

   ```sh
   pnpm -r typecheck
   ```

Notes:

- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

Task-specific additions:

- Desktop or packaged-app changes:
  - `pnpm desktop:verify`
- Feature work or workflow changes:
  - add or update the relevant automated E2E test coverage before hand-off
  - run the relevant E2E suite (`pnpm test:e2e`, `pnpm test:release-smoke`, or another feature-specific E2E path) when that area is affected
- Visible UI changes:
  - verify the rendered result in a browser or desktop shell, not just by tests
  - when browser verification is needed, prefer `@browser-use` for local navigation, inspection, interaction checks, and screenshots before falling back to other browser automation paths
  - store temporary screenshots and other ad-hoc verification artifacts outside the repository tree (for example under `/tmp` or the system temp dir), not in the project root

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other organizations

When adding endpoints:

- apply organization access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use organization selection context for organization-scoped pages
- Surface failures clearly; do not silently ignore API errors
- Follow `doc/DESIGN.md` for visible UI defaults, especially density, hierarchy, dialog structure, copy style, and progressive disclosure
- For desktop-shell UI changes, preserve the `Desktop Shell` contract and review checklist in `doc/DESIGN.md`; do not revert the shell to raw-wallpaper transparency or push glass treatment into the work cards.
- For visible UI changes, verify the rendered result before hand-off using a browser, screenshot, or equivalent visual inspection. Prefer `@browser-use` when that verification uses a browser. Do not rely on code review, typecheck, or tests alone for layout-sensitive changes.
- If a change affects user-visible functionality, include the relevant final screenshots in the hand-off response so the reviewer can see the shipped result, not just read about it.

## 10. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. Git commit rules are followed:

   - After completing a feature, small functionality, test change, or bug fix, and after the necessary validation passes, default to running `git commit` and `git push` to the current remote branch.
   - Continue using the repository's Conventional Commit format for commit messages (for example `feat:`, `fix:`, `test:`, `chore:`, `pref:`).
   - If there are unrelated dirty changes in the working tree, default to committing only the files changed for the current task instead of asking for confirmation. YOU MUST COMMIT AFTER YOU WORK.
