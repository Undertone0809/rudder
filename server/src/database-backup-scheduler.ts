import {
  estimateDatabaseBackupSize,
  formatDatabaseBackupResult,
  getDatabaseBackupSizeGuardDecision,
  runDatabaseBackup,
  type DatabaseBackupSizeEstimate,
  type RunDatabaseBackupResult,
} from "@rudderhq/db";
import { logger as defaultLogger } from "./middleware/logger.js";

type BackupLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

type ScheduledDatabaseBackupDeps = {
  estimateDatabaseBackupSize: (opts: { connectionString: string }) => Promise<DatabaseBackupSizeEstimate>;
  getDatabaseBackupSizeGuardDecision: typeof getDatabaseBackupSizeGuardDecision;
  runDatabaseBackup: (opts: {
    connectionString: string;
    backupDir: string;
    retentionDays: number;
    filenamePrefix: string;
  }) => Promise<RunDatabaseBackupResult>;
  formatDatabaseBackupResult: typeof formatDatabaseBackupResult;
  logger: BackupLogger;
};

export type ScheduledDatabaseBackupConfig = {
  connectionString: string;
  backupDir: string;
  retentionDays: number;
  maxEstimatedBytes: number;
};

export type ScheduledDatabaseBackupRunResult =
  | { status: "completed"; result: RunDatabaseBackupResult }
  | { status: "skipped"; reason: "database_too_large_for_in_process_backup"; estimatedBytes: number; maxEstimatedBytes: number };

const defaultDeps: ScheduledDatabaseBackupDeps = {
  estimateDatabaseBackupSize,
  getDatabaseBackupSizeGuardDecision,
  runDatabaseBackup,
  formatDatabaseBackupResult,
  logger: defaultLogger,
};

export async function runScheduledDatabaseBackupOnce(
  config: ScheduledDatabaseBackupConfig,
  deps: ScheduledDatabaseBackupDeps = defaultDeps,
): Promise<ScheduledDatabaseBackupRunResult> {
  const estimate = await deps.estimateDatabaseBackupSize({
    connectionString: config.connectionString,
  });
  const guardDecision = deps.getDatabaseBackupSizeGuardDecision(
    estimate,
    config.maxEstimatedBytes,
  );
  if (guardDecision.shouldSkip) {
    deps.logger.warn(
      {
        status: "skipped",
        reason: guardDecision.reason,
        estimatedBytes: guardDecision.estimatedBytes,
        maxEstimatedBytes: guardDecision.maxEstimatedBytes,
        databaseSizeBytes: estimate.databaseSizeBytes,
        includedTableTotalBytes: estimate.includedTableTotalBytes,
        tableCount: estimate.tableCount,
        largestTables: estimate.largestTables,
        backupDir: config.backupDir,
      },
      "Skipping scheduled database backup because database is too large for the current in-process backup implementation",
    );
    return {
      status: "skipped",
      reason: "database_too_large_for_in_process_backup",
      estimatedBytes: guardDecision.estimatedBytes,
      maxEstimatedBytes: guardDecision.maxEstimatedBytes,
    };
  }

  const result = await deps.runDatabaseBackup({
    connectionString: config.connectionString,
    backupDir: config.backupDir,
    retentionDays: config.retentionDays,
    filenamePrefix: "rudder",
  });
  deps.logger.info(
    {
      status: "completed",
      backupFile: result.backupFile,
      sizeBytes: result.sizeBytes,
      prunedCount: result.prunedCount,
      backupDir: config.backupDir,
      retentionDays: config.retentionDays,
    },
    `Automatic database backup complete: ${deps.formatDatabaseBackupResult(result)}`,
  );

  return { status: "completed", result };
}
