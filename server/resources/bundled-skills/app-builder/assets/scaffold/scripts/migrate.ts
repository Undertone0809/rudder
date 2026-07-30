import { closeDatabases, getDatabase } from "@/lib/db/client";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import path from "node:path";

const migrationsFolder = path.resolve("migrations");
const { db, filePath, sqlite } = getDatabase();
try {
  await migrate(db, async (queries) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const query of queries) sqlite.exec(query);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }, { migrationsFolder });
  process.stdout.write(`Applied migrations to ${filePath}\n`);
} finally {
  closeDatabases();
}
