# Local Operations Reference

This file contains local operational details that were previously embedded in `doc/DEVELOPING.md`.

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm rudder run
```

`rudder run` does:

1. auto-onboard if config is missing
2. `rudder doctor` with repair enabled
3. starts the server when checks pass

When no explicit local profile is set, `rudder run` defaults to the persistent local `prod_local` instance (`~/.rudder/instances/default/`).

## Database in Dev (Auto-Handled)

For local development, leave `DATABASE_URL` unset.
The server will automatically use embedded PostgreSQL and persist data at:

- `~/.rudder/instances/dev/db` when using `pnpm dev`
- `~/.rudder/instances/default/db` when using `pnpm rudder run`

`pnpm dev:watch` shares the `dev` database with `pnpm dev`.
Packaged Desktop shares the persistent `prod_local` database with `pnpm rudder run` and default local CLI usage.

Override home and instance:

```sh
RUDDER_HOME=/custom/path RUDDER_INSTANCE_ID=dev pnpm rudder run
```

If you need different database URLs for `dev` and `prod_local`, put them in the instance-adjacent env files:

- `~/.rudder/instances/dev/.env`
- `~/.rudder/instances/default/.env`

Do not rely on the shared repo-root `.env` for environment-specific database separation.

No Docker or external database is required for this mode.

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.rudder/instances/default/data/storage`

In `dev`, the matching storage root is `~/.rudder/instances/dev/data/storage`.

Configure storage provider/settings:

```sh
pnpm rudder configure --section storage
```

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Rudder falls back to an agent home workspace under the org-scoped instance root:

- `~/.rudder/instances/default/organizations/<org-id>/workspaces/agents/<workspaceKey>`

This path honors `RUDDER_HOME` and `RUDDER_INSTANCE_ID` in non-default setups.

For `codex_local`, Rudder also manages a per-organization Codex home under the instance root and seeds it from the shared Codex login/config home (`$CODEX_HOME` or `~/.codex`):

- `~/.rudder/instances/default/organizations/<org-id>/codex-home`

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/orgs
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/orgs` returns a JSON array

## Reset Local Dev Database

To wipe local dev data and start fresh:

```sh
rm -rf ~/.rudder/instances/default/db
pnpm dev
```

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that instead of embedded PostgreSQL.

## Automatic DB Backups

Rudder can run automatic DB backups on a timer. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.rudder/instances/default/data/backups`

Configure these in:

```sh
pnpm rudder configure --section database
```

Run a one-off backup manually:

```sh
pnpm rudder db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `RUDDER_DB_BACKUP_ENABLED=true|false`
- `RUDDER_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `RUDDER_DB_BACKUP_RETENTION_DAYS=<days>`
- `RUDDER_DB_BACKUP_DIR=/absolute/or/~/path`

## Secrets in Dev

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

- Default local key path: `~/.rudder/instances/default/secrets/master.key`
- Override key material directly: `RUDDER_SECRETS_MASTER_KEY`
- Override key file path: `RUDDER_SECRETS_MASTER_KEY_FILE`

Strict mode (recommended outside local trusted machines):

```sh
RUDDER_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

CLI configuration support:

- `pnpm rudder onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm rudder configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm rudder doctor` validates secrets adapter configuration and can create a missing local key file with `--repair`.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Organization Deletion Toggle

Organization deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
RUDDER_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## CLI Client Operations

Rudder CLI now includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
pnpm rudder issue list --org-id <org-id>
pnpm rudder issue create --org-id <org-id> --title "Investigate checkout conflict"
pnpm rudder issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm rudder context set --api-base http://localhost:3100 --org-id <org-id>
```

Then run commands without repeating flags:

```sh
pnpm rudder issue list
pnpm rudder dashboard get
```

See full command reference in `doc/CLI.md`.
