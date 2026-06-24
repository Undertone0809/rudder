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
export {
  RUDDER_POSTGRES_BIN_DIR_ENV,
  RUDDER_PRODUCTION_POSTGRES_VERSION,
  assertOfficialPostgresVersion,
  buildOfficialPostgresInitdbArgs,
  createLocalPostgresInstance,
  createOfficialPostgresInstance,
  resolveOfficialPostgresBinDir,
  resolveOfficialPostgresBinaries,
  validateOfficialPostgresBinDir,
  type LocalPostgresInstance,
  type LocalPostgresInstanceOptions,
  type LocalPostgresInstanceSelection,
  type LocalPostgresProvider,
  type PostgresVersionRunner
} from "./local-postgres-provider.js";
export * from "./schema/index.js";
