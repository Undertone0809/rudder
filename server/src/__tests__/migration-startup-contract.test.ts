import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const startupSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const ensureStart = startupSource.indexOf("async function ensureMigrations(");
const ensureEnd = startupSource.indexOf("function isLoopbackHost", ensureStart);
const ensureSource = startupSource.slice(ensureStart, ensureEnd);
const databaseStart = startupSource.indexOf('options.onEvent?.({ stage: "database", message: "Preparing database" });');
const databaseEnd = startupSource.indexOf('supervisor.own("database-pool"', databaseStart);
const databaseSource = startupSource.slice(databaseStart, databaseEnd);

describe("migration startup authority contract", () => {
  it("delegates the startup decision and migration mutation to Rust", () => {
    expect(ensureStart).toBeGreaterThanOrEqual(0);
    expect(ensureEnd).toBeGreaterThan(ensureStart);
    expect(ensureSource).toContain("await runNativeMigrationStartup(");
    expect(ensureSource).toContain("startupGate: { facts: startupFacts");
    expect(ensureSource).toContain('case "approval-required":');
    expect(ensureSource).toContain('case "stale-approval":');
    expect(ensureSource).toContain("approval = undefined;");
    for (const retiredCall of [
      "applyPendingMigrations(", "inspectMigrations(", "normalizeLegacyColumnNames(",
      "reconcilePendingMigrationHistory(", "createMigrationRecoveryPoint(",
      "withMigrationAdvisoryLock(", "runMigrationPreflightBeforeNodeInspection(",
      "await runMigrationPreflight(", "await runNativeMigrationApply(",
    ]) {
      expect(startupSource).not.toContain(retiredCall);
    }
    for (const databaseDecision of [
      'report.status === "current"', "report.pendingMigrations", "report.legacyColumnConflicts",
      "validateOnly", "error.code === \"requires_apply\"",
    ]) {
      expect(ensureSource).not.toContain(databaseDecision);
    }
    expect(ensureSource).not.toContain("const policy =");
  });

  it("passes source and recovery configuration and bounds approval-state retries", () => {
    expect(ensureSource).toContain("expectedFingerprint: manifest.fingerprint");
    expect(ensureSource).toContain("recoveryDirectory: resolve(opts.recoveryPointDir)");
    expect(ensureSource).toContain("while (staleApprovals < 3)");
    expect(ensureSource).toContain("staleApprovals += 1");
    expect(ensureSource).toContain('promptNever: process.env.RUDDER_MIGRATION_PROMPT === "never"');
    expect(ensureSource).toContain("interactive: stdin.isTTY === true && stdout.isTTY === true");
    expect(ensureSource).toContain('autoApplyRequested: process.env.RUDDER_MIGRATION_AUTO_APPLY === "true"');
    expect(ensureSource).toContain("embeddedClusterInitializedBeforeStartup: opts.embeddedBootstrapFacts.clusterInitializedBeforeStartup");
    expect(ensureSource).toContain("applicationDatabaseCreated: opts.embeddedBootstrapFacts.applicationDatabaseCreated");
    expect(ensureSource).not.toContain("shouldAutoApplyFirstRunMigrations");
    expect(ensureSource).toContain('approved: await promptApplyMigrations(outcome.pendingMigrations)');
  });

  it("uses the Rust PostgreSQL owner in the default local database path", () => {
    expect(databaseStart).toBeGreaterThanOrEqual(0);
    expect(databaseEnd).toBeGreaterThan(databaseStart);
    expect(databaseSource).toContain("await startPostgresOwner({");
    expect(databaseSource).toContain("supervisor.own(\"embedded-postgres\", owner.stop, { critical: true })");
    expect(databaseSource).toContain("applicationDatabaseCreated: owner.database_created");
    expect(databaseSource).toContain("postgresBinDir: owner.bin_dir");
    expect(databaseSource).not.toContain("createLocalPostgresInstance(");
    expect(databaseSource).not.toContain("ensurePostgresDatabase(");
    expect(databaseSource).not.toContain("ensurePostgresRolePassword(");
    expect(databaseSource).not.toContain("readLivePostmasterPidFile(");
    expect(startupSource).toContain("const startupAbort = new AbortController()");
    expect(startupSource).toContain("await runNativeMigrationStartup(");
  });
});
