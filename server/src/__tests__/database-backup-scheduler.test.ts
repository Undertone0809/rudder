import { describe, expect, it, vi } from "vitest";
import { runScheduledDatabaseBackupOnce } from "../database-backup-scheduler.js";
import type { RunDatabaseBackupResult } from "@rudderhq/db";

vi.mock("@rudderhq/db", () => ({
  estimateDatabaseBackupSize: vi.fn(),
  getDatabaseBackupSizeGuardDecision: vi.fn(),
  runDatabaseBackup: vi.fn(),
  formatDatabaseBackupResult: vi.fn(),
}));

function createDeps() {
  return {
    estimateDatabaseBackupSize: vi.fn(),
    getDatabaseBackupSizeGuardDecision: vi.fn(),
    runDatabaseBackup: vi.fn(),
    formatDatabaseBackupResult: vi.fn((result: RunDatabaseBackupResult) => `${result.backupFile} (${result.sizeBytes})`),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

describe("runScheduledDatabaseBackupOnce", () => {
  it("skips before running the in-process dump when the database estimate exceeds the guard", async () => {
    const deps = createDeps();
    deps.estimateDatabaseBackupSize.mockResolvedValue({
      databaseSizeBytes: 300,
      includedTableTotalBytes: 280,
      tableCount: 2,
      largestTables: [{ schemaName: "public", tableName: "heartbeat_runs", totalBytes: 220, rowEstimate: 1000 }],
    });
    deps.getDatabaseBackupSizeGuardDecision.mockReturnValue({
      shouldSkip: true,
      reason: "database_too_large_for_in_process_backup",
      estimatedBytes: 300,
      maxEstimatedBytes: 256,
    });

    await expect(
      runScheduledDatabaseBackupOnce(
        {
          connectionString: "postgres://rudder@example.invalid/rudder",
          backupDir: "/tmp/backups",
          retentionDays: 30,
          maxEstimatedBytes: 256,
        },
        deps,
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "database_too_large_for_in_process_backup",
      estimatedBytes: 300,
      maxEstimatedBytes: 256,
    });

    expect(deps.runDatabaseBackup).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        reason: "database_too_large_for_in_process_backup",
        estimatedBytes: 300,
        maxEstimatedBytes: 256,
        backupDir: "/tmp/backups",
      }),
      expect.stringContaining("Skipping scheduled database backup"),
    );
  });

  it("runs and logs the scheduled backup when the estimate is within the guard", async () => {
    const deps = createDeps();
    const backupResult = {
      backupFile: "/tmp/backups/rudder.sql",
      sizeBytes: 120,
      prunedCount: 1,
    };
    deps.estimateDatabaseBackupSize.mockResolvedValue({
      databaseSizeBytes: 120,
      includedTableTotalBytes: 110,
      tableCount: 1,
      largestTables: [],
    });
    deps.getDatabaseBackupSizeGuardDecision.mockReturnValue({
      shouldSkip: false,
      reason: null,
      estimatedBytes: 120,
      maxEstimatedBytes: 256,
    });
    deps.runDatabaseBackup.mockResolvedValue(backupResult);

    await expect(
      runScheduledDatabaseBackupOnce(
        {
          connectionString: "postgres://rudder@example.invalid/rudder",
          backupDir: "/tmp/backups",
          retentionDays: 30,
          maxEstimatedBytes: 256,
        },
        deps,
      ),
    ).resolves.toEqual({ status: "completed", result: backupResult });

    expect(deps.runDatabaseBackup).toHaveBeenCalledWith({
      connectionString: "postgres://rudder@example.invalid/rudder",
      backupDir: "/tmp/backups",
      retentionDays: 30,
      filenamePrefix: "rudder",
    });
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        backupFile: "/tmp/backups/rudder.sql",
        sizeBytes: 120,
        prunedCount: 1,
      }),
      expect.stringContaining("Automatic database backup complete"),
    );
  });
});
