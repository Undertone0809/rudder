import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const startupSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const ensureStart = startupSource.indexOf("async function ensureMigrationsUnlocked");
const ensureSource = startupSource.slice(ensureStart);

describe("migration startup safety contract", () => {
  it("captures recovery before legacy normalization and keeps the full flow locked", () => {
    expect(ensureStart).toBeGreaterThanOrEqual(0);

    const driftProbeIndex = ensureSource.indexOf("listLegacyColumnRenames(connectionString)");
    const initialStateIndex = ensureSource.indexOf("const initialState = await inspectMigrations(connectionString)");
    const recoveryIndex = ensureSource.indexOf("createMigrationRecoveryPoint(connectionString, label");
    const normalizeIndex = ensureSource.indexOf("normalizeLegacyColumnNames(connectionString)");
    const reconcileIndex = ensureSource.indexOf("reconcilePendingMigrationHistory(connectionString)");
    const migrationIndex = ensureSource.indexOf("applyMigrationsWithRecoveryPoint(");

    expect(driftProbeIndex).toBeGreaterThanOrEqual(0);
    expect(initialStateIndex).toBeGreaterThan(driftProbeIndex);
    expect(recoveryIndex).toBeGreaterThan(initialStateIndex);
    expect(normalizeIndex).toBeGreaterThan(recoveryIndex);
    expect(reconcileIndex).toBeGreaterThan(normalizeIndex);
    expect(migrationIndex).toBeGreaterThan(reconcileIndex);
    expect(startupSource).toContain("return withMigrationAdvisoryLock(");
    expect(startupSource).toContain("estimateDatabaseBackupSize");
    expect(startupSource).toContain("statfsSync(backupDir)");
    expect(startupSource).toContain('format: useCustomFormat ? "custom" : "sql"');
    expect(startupSource).toContain("MIGRATION_BACKUP_CUSTOM_SPACE_MULTIPLIER");
    expect(startupSource).toContain("const availableBytes = readAvailableBytes()");
    expect(startupSource).toContain("recoveryPointMaxEstimatedBytes");
  });

  it("asserts invariants even when migration state is already current", () => {
    const upToDateBranch = ensureSource.indexOf('if (state.status === "upToDate")');
    expect(upToDateBranch).toBeGreaterThanOrEqual(0);
    expect(ensureSource.slice(upToDateBranch, upToDateBranch + 220)).toContain(
      "await assertPostMigrationInvariants(connectionString)",
    );
  });
});
