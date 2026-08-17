# Local Development

Use this guide after `AGENTS.md` routes the task to local implementation. It
owns setup, runtime profiles, worktree isolation, contributor Git identity,
dependency-lock behavior, and local browser/E2E execution.

## Prerequisites

- Node.js 20+
- pnpm 9+

Deployment and authentication mode definitions live in
[`DEPLOYMENT-MODES.md`](./DEPLOYMENT-MODES.md).

## Start The Development Runtime

From the repository root:

```sh
pnpm install
pnpm dev
```

This starts the local `dev` runtime without file watching, opens the Desktop
development shell, and serves the API and UI at `http://localhost:3100`.

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/orgs
```

Useful variants:

```sh
pnpm dev:reset
pnpm dev:watch
RUDDER_DESKTOP_AUTH_BYPASS=0 pnpm dev
pnpm dev:ui
pnpm rudder run
```

`pnpm dev` tracks backend-relevant changes and pending migrations. The board
shows `Restart required` when the running backend is stale.

## Local Profiles And Paths

The default disposable development profile uses:

- `RUDDER_LOCAL_ENV=dev`
- `RUDDER_INSTANCE_ID=dev`
- API port `3100`
- embedded PostgreSQL port `54329`
- data under `~/.rudder/instances/dev/`

Agent workspaces live below the active organization storage key under the
profile home. UUID-backed organization storage keys use the first 12 lowercase
hex characters with dashes removed; API and database records keep the full ID.

Rudder-generated project files use the selected project Library. Local trusted
runs expose its root as `$RUDDER_PROJECT_LIBRARY_ROOT` and the selected
Library-relative locator as `$RUDDER_PROJECT_LIBRARY_PATH`.

When a checkout contains `.rudder/.env` and `.rudder/config.json`, `pnpm dev`
uses that worktree-local instance instead of the shared default profile.

## Concurrent Worktrees

Do not run multiple checkouts against the shared `dev` profile. Codex-managed
worktrees under `~/.codex/worktrees/<id>/<repo>` are auto-isolated when no local
`.rudder/` configuration exists. For manually created worktrees, initialize an
isolated instance before starting development:

```sh
pnpm rudder worktree init
pnpm dev
```

The initializer writes worktree-local Rudder configuration and assigns a
separate home, instance ID, API port, database port, and runtime descriptor. If
the server falls back from a busy configured port, the dev runner follows the
runtime descriptor.

For a persistent staging worktree:

```sh
git worktree add ../rudder-staging staging
cd ../rudder-staging
pnpm rudder worktree init
pnpm dev
```

## Contributor Git Identity

Local agent runtimes must not rely on Git hostname fallback identity. Rudder
uses provider-specific state sidecars and sets `user.useConfigOnly=true` so a
missing identity fails closed instead of producing a `*@*.local` commit.

Before asking an agent to commit in a new workspace, set a safe repository
identity when one is available:

```sh
git config user.name "Undertone0809"
git config user.email "72488598+Undertone0809@users.noreply.github.com"
git config user.useConfigOnly true
```

Runtimes keep the operator home available through `RUDDER_OPERATOR_HOME` and
use managed provider state for Codex, Claude, Pi, Gemini, Cursor, and OpenCode.
Do not bypass those state boundaries by repointing a runtime at another
checkout's provider directory.

Codex uses a managed `CODEX_HOME`; Claude and Pi receive explicit allowed skill
paths; Gemini uses its managed home and disables ambient extensions. OpenCode
uses managed XDG/config state plus prompt injection because its CLI does not
expose a verified skill-directory allowlist. Cursor also uses prompt injection
for selected skills until it exposes an equivalent allowlist surface.

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- CI validates dependency resolution when manifests change before broad
  verification jobs run.
- Pull requests and `main` CI install with
  `pnpm install --no-frozen-lockfile --lockfile=false`.
- Pushes to `main` regenerate the lockfile with
  `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`.

## Standalone UI And E2E Isolation

`pnpm dev:ui` reads the worktree-local Rudder configuration and proxies `/api`
to the active runtime descriptor. Use an explicit
`RUDDER_UI_PROXY_TARGET=http://127.0.0.1:<port>` or `RUDDER_UI_PORT=<port>` only
when the task needs an override.

Playwright E2E uses `CODEX_THREAD_ID` for isolation when available. For manual
parallel runs, set `RUDDER_E2E_RUN_ID=<unique-name>` so each run receives a
separate home and port pair.

E2E should exercise the highest-risk production-shaped condition, not only a
small happy path. Include relevant volume, date boundaries, organization or
permission isolation, persistence, async state, external-process failure,
pagination, filtering, scroll continuity, and refresh behavior. If E2E is
impractical, document why and add the closest lower-level regression test.

## Browser Verification

Use `$ego-browser` as the default browser path for local Rudder navigation,
interaction checks, console-aware inspection, and screenshots. Keep temporary
screenshots and ad-hoc artifacts outside the repository tree.

Verification class selection and hand-off gates remain in `AGENTS.md`. Desktop
commands and packaged validation live in [`DESKTOP.md`](./DESKTOP.md).

For authenticated private-network development, follow
[`OPENCLAW_ONBOARDING.md`](./OPENCLAW_ONBOARDING.md) and the allowed-hostname
commands in [`CLI.md`](./CLI.md); do not duplicate deployment trust policy in
this local setup guide.
