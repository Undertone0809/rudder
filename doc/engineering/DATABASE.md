# Database

Rudder uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server delegates local PostgreSQL lifecycle to the Rust `rudder-postgres-owner` process and keeps its data in the current instance directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Starts or safely reuses the PostgreSQL cluster for the current instance
2. Ensures the `rudder` database exists
3. Runs the Rust migration startup gate and operator
4. Starts serving requests

Node only sends the typed owner protocol and holds the returned connection
details. Missing Rust owner or migration binaries stop startup; no Node database
creation or migration fallback is available.

Data persists across restarts in the current instance database directory. To reset local dev data, delete that instance's `db/` directory.

With the current local environment presets:

- `pnpm dev` uses `~/.rudder/instances/dev/db/`
- `pnpm dev:watch` uses the same `~/.rudder/instances/dev/db/`
- `pnpm rudder run` uses `~/.rudder/instances/default/db/`
- packaged Desktop uses the same `~/.rudder/instances/default/db/`
- `pnpm test:e2e` uses `~/.rudder/instances/e2e/db/`

When `pnpm dev` runs from a Codex-managed worktree at `~/.codex/worktrees/<id>/<repo>` and that checkout
does not already have `.rudder/.env` or `.rudder/config.json`, the dev scripts auto-isolate it under
`~/.rudder-worktrees/instances/codex-<id>-<repo>/db/` with non-default app and embedded PostgreSQL ports.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active Rudder config/instance.

This mode is ideal for local development and one-command installs.

## Schema upgrade safety

Schema upgrades are treated as a compatibility operation, not as a side effect of
server startup:

- Every migration is append-only. The journal order, SQL contents, and SHA-256
  manifest are immutable after publication. A correction is a new migration;
  editing an old SQL file fails the release compatibility preflight.
- Before applying migrations to a non-empty database, startup writes a complete
  pre-migration SQL recovery point, including the migration journal. If the
  recovery point cannot be written, startup fails closed and no schema change is
  attempted. Keep the recovery file until the upgrade has been verified.
- Migration application uses a database advisory lock and transactional
  statements. Afterward Rudder checks the journal, current migration state,
  core primary keys, foreign-key validation, and index validity before opening
  the application.
- Releases run a real old-version matrix before npm, tag, or GitHub Release
  mutation. The matrix builds the schema from historical stable migrations,
  loads production-shaped rows, upgrades with the candidate, and checks counts,
  relationships, journal state, and restart persistence. A new schema epoch
  must add its historical fixture and fingerprint before release.

Before a long test or packaging run after adding a migration, update the DB
catalog assertions, Rust migration-manifest golden, and current candidate's
release compatibility fingerprint together. Run the focused catalog and
compatibility checks first; keep published fixture fingerprints unchanged.
Pin `RUSTUP_TOOLCHAIN` for test subprocess builds to the same compiler used by
the native checks. Pin `RUDDER_POSTGRES_BIN_DIR` and, when PATH contains another
PostgreSQL version, `RUDDER_NATIVE_MIGRATIONS_PG_DUMP` to the supported runtime;
check `pg_dump --version` before running backup/upgrade fixtures.

The recovery point is a logical PostgreSQL dump produced by the existing backup
library. For large hosted databases, use the provider's physical snapshot or
`pg_dump`/restore workflow as the operational recovery point; do not disable the
startup gate to avoid a backup.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/rudder` to keep DB state across container restarts (see `doc/engineering/DOCKER.md`).

## Chat transcript migration and bloat recovery

Chat generation transcript events are kept in `chat_generation_events`. The
`chat_message_transcript_entries` table stores detached snapshots for legacy
messages and messages copied into a fork. New streaming events do not append a
growing array to `chat_messages.structured_payload`.

For an existing database, migration `0148` only creates the table and adjusts
the bounded `chat_messages` autovacuum settings. It intentionally does not
rewrite historical rows during application startup. Run the backfill as a
separate maintenance operation:

1. Stop the Rudder server, workers, and scheduled jobs that can write the target
   database. Write a recoverable `pg_dump` or provider snapshot to a different
   disk or volume; do not use the nearly full database backup directory.
2. Apply the schema migration and inspect the candidates without changing rows:

   ```sh
   pnpm db:migrate
   DATABASE_URL='postgres://...' pnpm db:backfill-chat-transcripts --dry-run --batch-size 100
   ```

3. Review the JSON report. An exit code of `2` means at least one legacy
   message or old fork was left unresolved. Resolve it from the report rather
   than deleting the source data or forcing a match. Then run the command
   without `--dry-run`; it uses short `FOR UPDATE SKIP LOCKED` batches, inserts
   entries before removing `__chatTranscript`, and validates count, order, and
   payload before each legacy key is cleared. Re-running it is safe.
4. After the readback checks pass, stop every process connected to this
   database and run `VACUUM (FULL, ANALYZE) chat_messages;` using a direct
   PostgreSQL connection. `VACUUM FULL` needs an exclusive lock and temporary
   working space. If the available space cannot cover that temporary need, stop
   and free space elsewhere first; never remove PostgreSQL relation files by
   hand.
5. Check relation and TOAST sizes, the remaining legacy-key count, detached
   entry count, and a transcript read through the fork API. Keep the external
   recovery point until these checks and a restart have passed.

Useful post-maintenance queries are:

```sql
SELECT pg_size_pretty(pg_total_relation_size('chat_messages')) AS chat_messages,
       pg_size_pretty(pg_total_relation_size('chat_message_transcript_entries')) AS transcript_entries;

SELECT c.relname AS toast_relation,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS toast_size
FROM pg_class parent
JOIN pg_class c ON c.oid = parent.reltoastrelid
WHERE parent.relname = 'chat_messages';

SELECT count(*) AS legacy_messages
FROM chat_messages
WHERE structured_payload ? '__chatTranscript';

SELECT count(*) AS detached_entries
FROM chat_message_transcript_entries;
```

Production local and packaged Desktop builds should use PostgreSQL 18.4 production binaries for this managed local database path. Set `RUDDER_POSTGRES_BIN_DIR` to the `bin` directory from a PostgreSQL 18.4 installation or packaged runtime payload:

```sh
RUDDER_POSTGRES_BIN_DIR=/path/to/postgresql-18.4/bin pnpm rudder run
```

When `RUDDER_POSTGRES_BIN_DIR` is set, the Rust owner validates `initdb`,
`pg_ctl`, `postgres`, the initdb templates `postgres.bki` and
`postgresql.conf.sample`, and runtime support files such as the timezone
database; all three binaries must report PostgreSQL 18.4. It then manages the
local cluster with those production binaries. Development can resolve binary
assets from the installed `embedded-postgres` package when no explicit runtime
directory is configured. The Rust owner manages cluster creation, reuse,
application-database creation, and shutdown for this managed startup path. The
legacy worktree initializer still calls the Node `ensurePostgresDatabase` helper;
retiring that separate database-creation entry remains migration debt.

The Rust owner attempts startup once and verifies readiness using the connected
server identity. A log line saying the server is ready does not override a
nonzero child exit or a mismatched data directory. Startup failures include a
bounded, credential-redacted diagnostic tail in the structured owner error.
The legacy Node recovery behavior that scans user-wide SysV shared-memory
segments and retries startup is intentionally not copied: the Rust owner does
not invoke `ipcs` or `ipcrm`, remove shared-memory segments, or retry automatically.
Preserve the existing data directory and use explicit recovery when startup fails.

Rudder owns one verified PostgreSQL 18.4 payload per platform and architecture at
`~/.rudder/runtime-payloads/postgres-18.4/<platform>-<arch>/`. The CLI resolves
an explicit operator `RUDDER_POSTGRES_BIN_DIR` first. Otherwise it reuses the
shared payload, migrates a valid legacy version-local 18.4 payload, or downloads
the official 18.4 archive on macOS and Windows. Runtime version directories keep
only a compatibility symlink (a junction on Windows) to the shared payload, so
installing another Rudder version does not copy PostgreSQL again.
Linux keeps system or explicit PostgreSQL precedence; its embedded fallback is
removed only when a verified shared payload is already available.

The shared payload is prepared under an install lock and published by atomic
rename only after the complete `bin`, `lib`, and `share` directories, all three
binaries, both templates, timezone data, and the exact 18.4 version have been
verified. Existing caches missing runtime support files are rebuilt before use.
Interrupted temporary or previous generations are
recovered or removed under that same lock. Runtime startup through descriptor
publication and post-health cleanup share a separate lifecycle lock, preventing
cleanup from racing a new runtime start. After a packaged Desktop cold start
passes the database and application health checks, Rudder replaces unused
legacy payload copies with compatibility links, records the shared payload in
`runtime.json`, and removes only the current platform's `@embedded-postgres`
fallback package. Other optional native dependencies are not removed. Database
directories and database contents are never migrated by this cleanup.

Desktop release packaging uses the same payload cache. Set
`RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE=1` only when packaging should fail
instead of downloading the payload, or pair it with
`RUDDER_ALLOW_LEGACY_EMBEDDED_POSTGRES=1` for a development fallback package.

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

## Rust-owned migration startup and operator

Both normal server startup and `pnpm db:migrate` send the pinned migration
source to the Rust `migration-service` operator. Node provides the database
connection and trusted runtime facts such as migration and recovery paths,
`pg_dump` path, and whether an interactive prompt is available. Rust inspects
the Drizzle journal and schema and decides whether the database is current,
needs migration, or is unsafe or inconsistent. Node does not plan migrations
from database status and has no SQL-apply or recovery-write fallback.

Startup uses the bounded `rudder.migration-apply/v1` JSON request with
`protocolVersion: 1`, `allowApply: true`, absolute `migrationsDir`,
`recoveryDirectory`, and `pgDumpBinary` paths, and the exact
`expectedFingerprint` from the inspected migration manifest. The source
fingerprint pins the SQL and journal; a changed source fails closed. Credentials
are supplied through the operator environment, never as command-line arguments
or diagnostic output.

Node passes the auto-apply request, `never` preference, TTY availability, and
raw embedded-cluster/database-creation facts. Rust applies the compatibility
priority: explicit auto-apply, then `RUDDER_MIGRATION_PROMPT=never`, then
non-interactive auto-apply. For interactive startup, Rust may also auto-apply a
fresh embedded setup only when those lifecycle facts coincide with Rust's own
preflight finding an empty bootstrap database. Otherwise it returns an approval
request containing its pending migration summary and a token bound to the
configured database and migration snapshot. Node only displays the prompt and
returns the user's choice. Rust does not hold the migration lock while waiting;
after approval it reacquires the lock, rereads the database and source, and
rejects a stale token before backup or mutation. Current databases are validated
without requesting approval or creating a recovery dump. Unsafe legacy
databases, malformed journals, and inconsistent history fail closed.

Before changing a non-empty database, the operator takes the existing
`rudder:database-migrations` advisory lock, rechecks the migration state, and
requires a full recovery dump. The selected PostgreSQL `pg_dump` includes all
schemas and the migration journal. Recovery files are private on Unix,
checksummed, flushed, and published without overwriting existing files. Failed
or interrupted dumps retain `.partial` files and are not accepted as recovery
points. Completed SQL dumps remain available for operator recovery. The native
recovery-file limit is 4 GiB and the dump timeout is ten minutes; exceeding
either stops the operation before migrations are applied.

Each migration retains the existing transaction behavior and Drizzle journal;
the operator does not promise one automatic rollback spanning the full migration
set. Historical SQL and journal identities remain unchanged. Unsupported or
inconsistent legacy states are rejected for explicit recovery rather than
rewritten into a new migration history. The separate identity-database writer
has not yet moved to this operator.

The disposable-PostgreSQL regression in
`native/crates/migration-service/tests/apply_cli.rs` exercises the operator,
including current-state handling, a pending prompt, lock release while waiting,
stale approval rejection after a database change, a fresh approval, and dump
restore/data/journal preservation. This source-level coverage is separate from
verification of normal startup in a real or packaged runtime.
