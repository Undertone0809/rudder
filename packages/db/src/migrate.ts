import { fileURLToPath } from "node:url";
import { applyMigrationsWithRust } from "./migration-operator.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();

  console.log(`Checking migrations via Rust for ${resolved.source}`);

  try {
    const report = await applyMigrationsWithRust({
      databaseUrl: resolved.connectionString,
      migrationsDir: fileURLToPath(new URL("./migrations", import.meta.url)),
      journalFile: fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
      recoveryDirectory: resolved.recoveryDirectory,
      postgresBinDir: resolved.postgresBinDir,
    });
    if (report.alreadyCurrent) {
      console.log("No pending migrations");
    } else {
      console.log(`Migrations complete (${report.appliedMigrations.length} applied)`);
    }
  } finally {
    await resolved.stop();
  }
}

await main();
