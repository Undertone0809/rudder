export {
  createDb,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  ensurePostgresRolePassword,
  normalizeLegacyColumnNames,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type EnsurePostgresRolePasswordOptions,
  type EnsurePostgresRolePasswordResult,
  type Db,
} from "./client.js";
export {
  cleanupStaleSysvSharedMemorySegments,
  isEmbeddedPostgresSharedMemoryError,
  parseSysvSharedMemorySegments,
  type CleanupStaleSysvSharedMemoryResult,
  type SysvSharedMemorySegment,
} from "./embedded-postgres-recovery.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export * from "./schema/index.js";
