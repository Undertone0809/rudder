# Database

Rudder uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates the current instance database directory for storage
2. Ensures the `rudder` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in the current instance database directory. To reset local dev data, delete that instance's `db/` directory.

With the current local environment presets:

- `pnpm dev` uses `~/.rudder/instances/dev/db/`
- `pnpm dev:watch` uses the same `~/.rudder/instances/dev/db/`
- `pnpm rudder run` uses `~/.rudder/instances/default/db/`
- packaged Desktop uses the same `~/.rudder/instances/default/db/`
- `pnpm test:e2e` uses `~/.rudder/instances/e2e/db/`

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active Rudder config/instance.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/rudder` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://rudder:rudder@localhost:5432/rudder
```

Run migrations (once the migration generation issue is fixed) or use `drizzle-kit push`:

```sh
DATABASE_URL=postgres://rudder:rudder@localhost:5432/rudder \
  npx drizzle-kit push
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

Set `DATABASE_URL` in your `.env`:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

If using connection pooling (port 6543), the `postgres` client must disable prepared statements. Update `packages/db/src/client.ts`:

```ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  npx drizzle-kit push
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL for the active local instance (`~/.rudder/instances/<instance>/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Local environment separation

Rudder now supports separate local profiles for development and persistent local usage.

- `dev`: disposable local development data
- `prod_local`: persistent local data, backed by the existing `default` instance
- `e2e`: isolated automated test data

If you need different external PostgreSQL targets per local profile, set `DATABASE_URL` in each instance-adjacent `.env` instead of the shared repo-root `.env`:

- `~/.rudder/instances/dev/.env`
- `~/.rudder/instances/default/.env`
- `~/.rudder/instances/e2e/.env`

When `RUDDER_LOCAL_ENV` is set, Rudder intentionally ignores `DATABASE_URL` from the repo-root `.env` so local profiles do not accidentally share one external database.

Desktop shells no longer use a separate app-managed Rudder database root. They attach to the same shared local instance data as browser and CLI surfaces for the selected profile.

## Secret storage

Rudder stores secret metadata and versions in:

- `company_secrets`
- `company_secret_versions`

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.rudder/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.rudder/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.

Optional overrides:

- `RUDDER_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `RUDDER_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
RUDDER_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm rudder configure --section secrets
```

Inline secret migration command:

```sh
pnpm secrets:migrate-inline-env --apply
```
