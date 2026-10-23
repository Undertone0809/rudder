import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./migrate.ts", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("./migration-runtime.ts", import.meta.url), "utf8");

describe("db:migrate authority contract", () => {
  it("uses the Rust operator for both the CLI and compatibility migration entry point", () => {
    expect(source).toContain("applyMigrationsWithRust({");
    expect(source).toContain("resolved.recoveryDirectory");
    expect(clientSource).toContain("export async function applyPendingMigrations(url: string)");
    expect(clientSource).toContain("await applyMigrationsWithRust({");
    for (const retiredWriter of [
      "migratePg(", "normalizeLegacyColumnNames(", "reconcilePendingMigrationHistory(",
      "withMigrationAdvisoryLock(", "applyPendingMigrationsManually(",
    ]) {
      expect(clientSource).not.toContain(retiredWriter);
    }
    expect(source).not.toContain("applyPendingMigrations(");
    expect(source).not.toContain("inspectMigrations(");
  });

  it("delegates the local PostgreSQL lifecycle to the Rust owner without a Node fallback", () => {
    expect(runtimeSource).toContain('import { startPostgresOwner } from "./postgres-owner.js"');
    expect(runtimeSource).toContain("await startPostgresOwner({");
    expect(runtimeSource).toContain("connectionString: owner.connection_string");
    expect(runtimeSource).toContain("postgresBinDir: owner.bin_dir");
    for (const retiredLifecycleCall of [
      "ensurePostgresDatabase(", "ensurePostgresRolePassword(", "getPostgresDataDirectory(",
      "createLocalPostgresInstance(", "embeddedPostgres.initialise(", "embeddedPostgres.start(",
    ]) {
      expect(runtimeSource).not.toContain(retiredLifecycleCall);
    }
  });
});
