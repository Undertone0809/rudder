# Worktree-local Instances

When developing from multiple git worktrees, do not point two Rudder servers at the same embedded PostgreSQL data directory.

Instead, create a repo-local Rudder config plus an isolated instance for the worktree:

```sh
rudder worktree init
# or create the git worktree and initialize it in one step:
pnpm rudder worktree:make rudder-pr-432
```

This command:

- writes repo-local files at `.rudder/config.json` and `.rudder/.env`
- creates an isolated instance under `~/.rudder-worktrees/instances/<worktree-id>/`
- when run inside a linked git worktree, mirrors the effective git hooks into that worktree's private git dir
- picks a free app port and embedded PostgreSQL port
- by default seeds the isolated DB in `minimal` mode from the current effective Rudder instance/config (repo-local worktree config when present, otherwise the default instance) via a logical SQL snapshot

Seed modes:

- `minimal` keeps core app state like organizations, projects, issues, comments, approvals, and auth state, preserves schema for all tables, but omits row data from heavy operational history such as heartbeat runs, wake requests, activity logs, runtime services, and agent session state
- `full` makes a full logical clone of the source instance
- `--no-seed` creates an empty isolated instance

After `worktree init`, both the server and the CLI auto-load the repo-local `.rudder/.env` when run inside that worktree, so normal commands like `pnpm dev`, `rudder doctor`, and `rudder db:backup` stay scoped to the worktree instance.

This is the recommended way to run a personal staging sandbox.
For example, a `staging` branch worktree should use its own worktree-local instance rather than introducing a new global `RUDDER_LOCAL_ENV=staging` profile.

That repo-local env also sets:

- `RUDDER_IN_WORKTREE=true`
- `RUDDER_WORKTREE_NAME=<worktree-name>`
- `RUDDER_WORKTREE_COLOR=<hex-color>`

The server/UI use those values for worktree-specific branding such as the top banner and dynamically colored favicon.

Typical staging flow:

```sh
git worktree add ../rudder-staging staging
cd ../rudder-staging
pnpm rudder worktree init
pnpm dev
```

Inside that worktree, `pnpm dev` will use the repo-local isolated instance and ports from `.rudder/config.json` instead of the shared main-checkout `dev` runtime.

Print shell exports explicitly when needed:

```sh
rudder worktree env
# or:
eval "$(rudder worktree env)"
```

## Worktree CLI Reference

`**pnpm rudder worktree init [options]**` — Create repo-local config/env and an isolated instance for the current worktree.


| Option                   | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `--name <name>`          | Display name used to derive the instance id                       |
| `--instance <id>`        | Explicit isolated instance id                                     |
| `--home <path>`          | Home root for worktree instances (default: `~/.rudder-worktrees`) |
| `--from-config <path>`   | Source config.json to seed from                                   |
| `--from-data-dir <path>` | Source RUDDER_HOME used when deriving the source config           |
| `--from-instance <id>`   | Source instance id (default: `default`)                           |
| `--server-port <port>`   | Preferred server port                                             |
| `--db-port <port>`       | Preferred embedded Postgres port                                  |
| `--seed-mode <mode>`     | Seed profile: `minimal` or `full` (default: `minimal`)            |
| `--no-seed`              | Skip database seeding from the source instance                    |
| `--force`                | Replace existing repo-local config and isolated instance data     |


Examples:

```sh
rudder worktree init --no-seed
rudder worktree init --seed-mode full
rudder worktree init --from-instance default
rudder worktree init --from-data-dir ~/.rudder
rudder worktree init --force
```

`**pnpm rudder worktree:make <name> [options]**` — Create `~/NAME` as a git worktree, then initialize an isolated Rudder instance inside it. This combines `git worktree add` with `worktree init` in a single step.


| Option                   | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `--start-point <ref>`    | Remote ref to base the new branch on (e.g. `origin/main`)         |
| `--instance <id>`        | Explicit isolated instance id                                     |
| `--home <path>`          | Home root for worktree instances (default: `~/.rudder-worktrees`) |
| `--from-config <path>`   | Source config.json to seed from                                   |
| `--from-data-dir <path>` | Source RUDDER_HOME used when deriving the source config           |
| `--from-instance <id>`   | Source instance id (default: `default`)                           |
| `--server-port <port>`   | Preferred server port                                             |
| `--db-port <port>`       | Preferred embedded Postgres port                                  |
| `--seed-mode <mode>`     | Seed profile: `minimal` or `full` (default: `minimal`)            |
| `--no-seed`              | Skip database seeding from the source instance                    |
| `--force`                | Replace existing repo-local config and isolated instance data     |


Examples:

```sh
pnpm rudder worktree:make rudder-pr-432
pnpm rudder worktree:make my-feature --start-point origin/main
pnpm rudder worktree:make experiment --no-seed
```

`**pnpm rudder worktree env [options]**` — Print shell exports for the current worktree-local Rudder instance.


| Option                | Description                         |
| --------------------- | ----------------------------------- |
| `-c, --config <path>` | Path to config file                 |
| `--json`              | Print JSON instead of shell exports |


Examples:

```sh
pnpm rudder worktree env
pnpm rudder worktree env --json
eval "$(pnpm rudder worktree env)"
```

For project execution worktrees, Rudder can also run a project-defined provision command after it creates or reuses an isolated git worktree. Configure this on the project's execution workspace policy (`workspaceStrategy.provisionCommand`). The command runs inside the derived worktree and receives `RUDDER_WORKSPACE_*`, `RUDDER_PROJECT_ID`, `RUDDER_AGENT_ID`, and `RUDDER_ISSUE_*` environment variables so each repo can bootstrap itself however it wants.
