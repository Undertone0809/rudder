export {
  estimateDatabaseBackupSize, formatDatabaseBackupResult, getDatabaseBackupSizeGuardDecision,
  runDatabaseBackup,
  runDatabaseRestore, type DatabaseBackupSizeEstimate,
  type DatabaseBackupSizeGuardDecision,
  type DatabaseBackupTableSizeEstimate,
  type EstimateDatabaseBackupSizeOptions,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions
} from "./backup-lib.js";
export {
  applyPendingMigrations, createDb, ensurePostgresDatabase,
  ensurePostgresRolePassword, getPostgresDataDirectory, inspectMigrations, migratePostgresIfEmpty, normalizeLegacyColumnNames, reconcilePendingMigrationHistory, type Db, type EnsurePostgresRolePasswordOptions,
  type EnsurePostgresRolePasswordResult, type MigrationBootstrapResult, type MigrationHistoryReconcileResult, type MigrationState
} from "./client.js";
export {
  cleanupStaleSysvSharedMemorySegments,
  isEmbeddedPostgresSharedMemoryError,
  parseSysvSharedMemorySegments,
  type CleanupStaleSysvSharedMemoryResult,
  type SysvSharedMemorySegment
} from "./embedded-postgres-recovery.js";
export * from "./schema/index.js";
