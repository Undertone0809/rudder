import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/db/src/migrations");
const migrations = [
  "0140_faulty_kitty_pryde.sql",
  "0141_product_analytics_revision_origin.sql",
  "0142_product_analytics_quality_counters.sql",
];

export function splitStatements(content) {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function applyProductAnalyticsMigrations({ databaseUrl, sqlImpl } = {}) {
  if (!databaseUrl && !sqlImpl) throw new Error("DATABASE_URL is required");
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
