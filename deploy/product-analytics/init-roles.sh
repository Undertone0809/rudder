#!/usr/bin/env bash
set -euo pipefail

psql_args=(--username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-password)

ensure_role() {
  local role_name="$1"
  local role_password="$2"
  psql "${psql_args[@]}" -v ON_ERROR_STOP=1 -v role_name="$role_name" -v role_password="$role_password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')\gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')\gexec
SQL
}

ensure_role "$TELEMETRY_MIGRATION_USER" "$TELEMETRY_MIGRATION_PASSWORD"
ensure_role "$TELEMETRY_COLLECTOR_USER" "$TELEMETRY_COLLECTOR_PASSWORD"
ensure_role "$TELEMETRY_ROLLUP_USER" "$TELEMETRY_ROLLUP_PASSWORD"
ensure_role "${TELEMETRY_READER_USER:-rudder_analytics_reader}" "${TELEMETRY_READER_PASSWORD:-reader-placeholder}"
