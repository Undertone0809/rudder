import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireFromDbPackage = createRequire(new URL("../packages/db/package.json", import.meta.url));

const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/db/src/migrations");
const migrations = [
  "0140_faulty_kitty_pryde.sql",
  "0141_product_analytics_revision_origin.sql",
  "0142_product_analytics_quality_counters.sql",
];

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function quoteIdentifier(value) {
  if (!identifierPattern.test(value)) throw new Error("invalid_product_analytics_role_name");
  return `"${value}"`;
}

export function splitStatements(content) {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function grantProductAnalyticsRolePrivileges(sql, roles = {}) {
  const collector = quoteIdentifier(roles.collector ?? "rudder_analytics_collector");
  const rollup = quoteIdentifier(roles.rollup ?? "rudder_analytics_rollup");
  const reader = quoteIdentifier(roles.reader ?? "rudder_analytics_reader");
  await sql.unsafe(`
    GRANT USAGE ON SCHEMA "rudder_analytics" TO ${collector};
    GRANT SELECT, INSERT ON "rudder_analytics"."product_analytics_collector_events" TO ${collector};
    GRANT SELECT, INSERT, UPDATE ON "rudder_analytics"."product_analytics_collector_installations" TO ${collector};
    GRANT SELECT, INSERT, UPDATE ON "rudder_analytics"."product_analytics_collector_subjects" TO ${collector};
    GRANT SELECT, INSERT, UPDATE ON "rudder_analytics"."product_analytics_collector_quality_counters" TO ${collector};
    GRANT USAGE ON SCHEMA "rudder_analytics" TO ${rollup};
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_events" TO ${rollup};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "rudder_analytics" TO ${rollup};
    GRANT USAGE ON SCHEMA "rudder_analytics" TO ${reader};
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_daily_rollups" TO ${reader};
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_privacy_aggregates" TO ${reader};
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_quality_counters" TO ${reader};
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_events" FROM ${reader};
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_installations" FROM ${reader};
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_subjects" FROM ${reader};
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_work_loop_revisions" FROM ${reader};
    REVOKE ALL ON "rudder_analytics"."_product_analytics_migrations" FROM ${collector}, ${rollup}, ${reader};
  `);
}

export async function applyProductAnalyticsMigrations({ databaseUrl, sqlImpl } = {}) {
  if (!databaseUrl && !sqlImpl) throw new Error("DATABASE_URL is required");
  const postgres = sqlImpl ? null : requireFromDbPackage("postgres");
  const sql = sqlImpl ?? postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS "rudder_analytics"');
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "rudder_analytics"."_product_analytics_migrations" (
        "tag" text PRIMARY KEY,
        "applied_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
    for (const tag of migrations) {
      const applied = await sql.unsafe(
        'SELECT 1 FROM "rudder_analytics"."_product_analytics_migrations" WHERE "tag" = $1',
        [tag],
      );
      if (applied.length > 0) continue;
      const content = await fs.readFile(path.join(migrationDirectory, tag), "utf8");
      await sql.begin(async (transaction) => {
        for (const statement of splitStatements(content)) await transaction.unsafe(statement);
        await transaction.unsafe(
          'INSERT INTO "rudder_analytics"."_product_analytics_migrations" ("tag") VALUES ($1)',
          [tag],
        );
      });
    }
    await grantProductAnalyticsRolePrivileges(sql, {
      collector: process.env.TELEMETRY_COLLECTOR_USER,
      rollup: process.env.TELEMETRY_ROLLUP_USER,
      reader: process.env.TELEMETRY_READER_USER,
    });
  } finally {
    if (!sqlImpl) await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  applyProductAnalyticsMigrations({ databaseUrl: process.env.DATABASE_URL })
    .then(() => process.stdout.write("Product analytics migrations complete\n"))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
