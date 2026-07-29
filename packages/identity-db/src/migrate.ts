import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createIdentityDb } from "./client.js";

const url = process.env.IDENTITY_MIGRATION_DATABASE_URL;
if (!url) throw new Error("IDENTITY_MIGRATION_DATABASE_URL is required");

const connection = createIdentityDb(url);
try {
  await migrate(connection.db, {
    migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)),
    migrationsSchema: "rudder_identity",
    migrationsTable: "__drizzle_migrations",
  });
} finally {
  await connection.close();
}
