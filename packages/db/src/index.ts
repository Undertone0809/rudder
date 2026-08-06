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
  MIGRATION_ADVISORY_LOCK_NAME, applyPendingMigrations, assertPostMigrationInvariants, createDb, ensurePostgresDatabase,
  ensurePostgresRolePassword, getPostgresDataDirectory, inspectMigrations, migratePostgresIfEmpty, normalizeLegacyColumnNames, reconcilePendingMigrationHistory, validatePostMigrationInvariants, type Db, type EnsurePostgresRolePasswordOptions, type EnsurePostgresRolePasswordResult, type MigrationBootstrapResult, type MigrationHistoryReconcileResult, type MigrationState, type PostMigrationInvariantIssue, type PostMigrationInvariantReport
} from "./client.js";
export {
  cleanupStaleSysvSharedMemorySegments,
  createEmbeddedPostgresStartupError,
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
export {
  assertMigrationManifestCompatible,
  createMigrationManifest,
  validateMigrationManifestCompatibility,
  validateMigrationManifestIntegrity,
  type MigrationManifest,
  type MigrationManifestEntry,
  type MigrationManifestValidation
} from "./migration-manifest.js";
export * from "./schema/index.js";
