# Developing

This guide is the entrypoint for local development.
It keeps the shortest path here and routes deep operational details to focused docs.

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

## Prerequisites

- Node.js 20+
- pnpm 9+

## Code Reasoning Comments

For business-critical paths, add concise reasoning comments so decisions are auditable without reopening history.

- Add reasoning comments when flow is policy-driven, ordering-sensitive, or intentionally backward-compatible.
- Place comments at function level near the key branch/assembly logic.
- Explain tradeoffs ("why"), not mechanical operations ("what").
- Add traceability links when behavior comes from a plan or product policy.

Recommended shape:

```ts
/**
 * What this block does and in what order.
 *
 * Reasoning:
 * - Why this order/branching exists.
 * - Which tradeoff is intentional.
 *
 * Traceability:
 * - doc/plans/YYYY-MM-DD-topic.md
 * - doc/DEVELOPING.md
 */
```

For runtime prompt assembly specifically:

- document section ordering (bootstrap, handoff, runtime notes, heartbeat prompt)
- include one concrete prompt example in the comment
- explain why wake-source context is injected for assignment/mention flows
- explain why recovery runs keep context continuity instead of rebuilding a lossy wakeup
- keep the always-loaded prompt limited to invariant rules for that scene/runtime
- inject mode-specific or state-specific prompt sections only when the condition is active
- do not encode dormant branches as "when X, do Y" inside one monolithic always-loaded prompt unless the runtime cannot compose sections cleanly

Prompt authoring rule of thumb:

- routing metadata can say "use when" because its job is discovery
- runtime prompts should prefer base prompt + conditional injections
- examples of conditional injections: `planMode`, recovery mode, operator profile, selected project context, project-attached resources, wake-source-specific context
- do not inject the full organization resource catalog by default; project-attached
  resources are the default run/chat context, while org resources stay queryable
  through the control plane when an agent needs broader background

## Plan Docs

Repo `doc/plans/` is contributor decision memory, not just scratch writing.
New plan docs should be easy for humans and advisor skills to retrieve by topic,
status, and lineage.

Use `doc/plans/_template.md` to choose the right template.
Use `doc/plans/_taxonomy.md` as the source of truth for `area` selection and
`entities` naming.

Plan filenames stay date-prefixed:

```text
doc/plans/YYYY-MM-DD-topic.md
```

New plan docs should start with YAML frontmatter using this standard shape:

```yaml
---
title: Short plan title
date: 2026-04-17
kind: implementation
status: planned
area: workspace
entities:
  - agent_workspace
issue: RUD-102
related_plans:
  - 2026-04-14-agent-workspace-canonicalization.md
supersedes: []
related_code:
  - server/src/services/heartbeat.ts
commit_refs:
  - feat: scope workspaces to organizations
updated_at: 2026-04-17
---
```

Required fields:

- `title`: concise human-readable title
- `date`: creation date in `YYYY-MM-DD`
- `kind`: one of `proposal`, `implementation`, `fix-plan`, `advisory`,
  `postmortem`, `design-note`
- `status`: one of `draft`, `proposed`, `planned`, `in_progress`,
  `completed`, `superseded`, `abandoned`
- `area`: primary product or engineering area from `doc/plans/_taxonomy.md`
- `entities`: stable retrieval nouns chosen using `doc/plans/_taxonomy.md` and
  nearby recent plans

Optional but recommended traceability fields:

- `issue`: Linear or other tracking reference when one exists
- `related_plans`: nearby prior plans that inform this one
- `supersedes`: earlier plans this one replaces or narrows
- `related_code`: code paths most relevant to the plan
- `commit_refs`: commit subjects associated with this plan
- `updated_at`: latest metadata refresh date

Authoring rules:

- Prefer the fixed vocab above over ad hoc status words such as
  `Implemented plan record` or `advisory scaffold`.
- Pick the most specific `kind` that fits the document:
  - `proposal` for new feature or open-ended design/architecture work
  - `implementation` for approved scoped delivery work
  - `fix-plan` for larger regressions or reliability fixes
- Use `related_plans` for adjacent context and `supersedes` only when the new
  document intentionally replaces an earlier direction.
- Do not add free-form tag lists. Prefer one clear `area` plus a focused
  `entities` list.
- Proposal work should use the detailed proposal template rather than a minimal
  outline. Lean templates are for already-decided implementation or fix work.
- Do not bulk-normalize historical plans unless they are active context for the
  current task.
- Update `commit_refs` when a plan leads to concrete repo changes.

When revisiting an existing feature area, inspect plan history in this order:

1. read `doc/plans/_taxonomy.md`
2. map the task to a likely `area`
3. reuse or mint stable `entities`
4. query plans by `area` and `entities`
5. follow `related_plans` and `supersedes`
6. inspect linked `issue`, `related_code`, and `commit_refs`
7. fall back to slug/title keyword search for older unstructured plans

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- CI validates dependency resolution when manifests change before running full verification jobs.
- PR and `main` CI install with `pnpm install --no-frozen-lockfile --lockfile=false`.
- Pushes to `main` regenerate lockfile via `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`.

## Start Dev

From repo root:

```sh
pnpm install
pnpm dev
```

This starts:

- local `dev` runtime without file watching
- Desktop dev shell attached to that runtime
- API server at `http://localhost:3100`
- UI served by API server in dev middleware mode (same origin)

Default disposable profile used by `pnpm dev`:

- `RUDDER_LOCAL_ENV=dev`
- `RUDDER_INSTANCE_ID=dev`
- embedded PostgreSQL on `54329`
- data under `~/.rudder/instances/dev/`
- agent runs start from the per-agent canonical workspace at `~/.rudder/instances/dev/organizations/<org-id>/workspaces/agents/<workspaceKey>`
- managed organization-shared runtime artifacts live under `~/.rudder/instances/dev/organizations/<org-id>/workspaces/`

Repo `doc/plans/` remains contributor planning documentation. Rudder-generated organization plans live under the org workspace `plans/` root, not in the repo.

When the current repo has worktree-local `.rudder/.env` and `.rudder/config.json`,
the same `pnpm dev` entrypoint respects that isolated instance instead of forcing the shared `dev` instance.
Use that path for a personal staging worktree sandbox.

### Concurrent Codex / Worktree Development

Multiple local Codex threads should not run Rudder from separate checkouts with the default shared `dev` profile.
Without a worktree-local `.rudder/` config, every checkout uses `~/.rudder/instances/dev`, API port `3100`,
and embedded PostgreSQL port `54329`.

Before running `pnpm dev` in a second local checkout, initialize an isolated worktree instance:

```sh
pnpm rudder worktree init
pnpm dev
```

This writes `.rudder/.env` and `.rudder/config.json` in that checkout. The dev runner, Desktop shell,
and CLI use the isolated `RUDDER_HOME`, instance id, server port, and database port automatically.
If the server has to bind a fallback port because the configured port is busy, the dev runner follows the
runtime descriptor instead of polling only the requested port.

For a standalone Vite UI process, `pnpm dev:ui` reads the same worktree-local Rudder config and proxies
`/api` to the running runtime descriptor when one exists, otherwise to the configured server port.
Use `RUDDER_UI_PROXY_TARGET=http://127.0.0.1:<port>` or `RUDDER_UI_PORT=<port>` only when you need
an explicit override.

Playwright E2E runs also isolate themselves under `CODEX_THREAD_ID` when Codex provides it. For manual
parallel E2E runs, set `RUDDER_E2E_RUN_ID=<unique-name>` to get a distinct home directory and port pair.

Useful variants:

```sh
pnpm dev:reset   # wipe only dev profile data
pnpm dev:watch   # Desktop shell + watched dev runtime
pnpm dev:ui      # standalone Vite UI; worktree-aware API proxy
pnpm rudder run  # persistent local prod_local instance
```

`pnpm dev` tracks backend-relevant file changes and pending migrations.
When stale, board UI shows a `Restart required` banner.

### Browser Verification

When a task requires browser-based verification, prefer `@browser-use` as the
first testing path for local Rudder URLs. Use it for navigation, interaction
checks, console-aware inspection, and screenshots before falling back to other
browser automation tools.

This preference applies to visible UI checks, workflow smoke tests that need a
browser, and layout-sensitive validation. Keep temporary screenshots and other
ad-hoc verification artifacts outside the repository tree.

### Staging Worktree Sandbox

If you keep a dedicated `staging` branch in a separate git worktree, do not add a new global local env profile for it.
Use a worktree-local isolated instance instead:

```sh
git worktree add ../rudder-staging staging
cd ../rudder-staging
pnpm rudder worktree init
pnpm dev
```

This keeps the staging worktree isolated from the main checkout:

- separate `RUDDER_HOME`
- separate `RUDDER_INSTANCE_ID`
- separate API and embedded PostgreSQL ports
- separate runtime descriptor and local data

## Desktop Dev

Primary desktop commands:

```sh
pnpm dev
pnpm dev:watch
pnpm dev:reset
```

Related commands:

```sh
pnpm prod
pnpm desktop:build
pnpm desktop:dist
pnpm rudder run
pnpm --filter @rudderhq/desktop smoke
```

Notes:

- `pnpm dev` and `pnpm dev:watch` both open the Desktop shell against the same shared `dev` instance.
- The only workflow difference is whether the runtime watches code and auto-restarts.
- Dev desktop is quit-on-close; tray/menu resident lifecycle applies to packaged builds.
- For low-frequency resident-shell debugging, use `RUDDER_DESKTOP_RESIDENT_SHELL=1 pnpm dev:watch`.
- For low-frequency desktop-only debugging, use `pnpm --filter @rudderhq/desktop dev`.
- Use `pnpm rudder ...` for CLI work in development.
- `pnpm prod` builds the portable packaged app, runs packaged smoke boot, then opens the local artifact. It does not replace the persistent local `prod_local` runtime from `pnpm rudder run`.

Tailscale/private-auth dev mode:

```sh
pnpm dev --tailscale-auth
pnpm rudder allowed-hostname dotta-macbook-pro
```

## Docker

Quickstart:

```sh
docker build -t rudder-local -f docker/Dockerfile .
docker run --name rudder \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e RUDDER_HOME=/rudder \
  -v "$(pwd)/data/docker-rudder:/rudder" \
  rudder-local
```

Compose:

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Detailed Docker guidance (providers, persistence, auth): `doc/DOCKER.md`.

For isolated untrusted PR review container workflow: `doc/UNTRUSTED-PR-REVIEW.md`.

## Progressive Deep Dives

Use these focused docs for detailed operations and full command references:

- Langfuse local observability/eval setup and verification: `doc/developing/LANGFUSE.md`
- Local operations (database/storage, backups, secrets, quick checks, CLI client ops): `doc/developing/LOCAL-OPERATIONS.md`
- Worktree-local instances and full worktree CLI option matrix: `doc/developing/WORKTREE.md`
- OpenClaw onboarding endpoints and smoke scripts: `doc/developing/OPENCLAW.md`
- Run recovery contract and case library: `doc/developing/RUN-RECOVERY.md`
- Desktop runtime/packaging behavior: `doc/DESKTOP.md`
- CLI command reference: `doc/CLI.md`
- Database model and migrations: `doc/DATABASE.md`
