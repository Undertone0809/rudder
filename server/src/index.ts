/// <reference path="./types/express.d.ts" />
import {
  applyPendingMigrations,
  assertPostMigrationInvariants,
  authUsers,
  cleanupStaleSysvSharedMemorySegments,
  createDb,
  createEmbeddedPostgresStartupError,
  createLocalPostgresInstance,
  ensurePostgresDatabase,
  ensurePostgresRolePassword,
  getPostgresDataDirectory,
  inspectMigrations,
  instanceUserRoles,
  invites,
  isEmbeddedPostgresSharedMemoryError,
  listLegacyColumnRenames,
  normalizeLegacyColumnNames,
  organizationMemberships,
  organizations,
  readPostmasterPidFile,
  reconcilePendingMigrationHistory,
  removeStalePostmasterPidFile,
  RUDDER_PRODUCTION_POSTGRES_VERSION,
  runDatabaseBackup,
  withMigrationAdvisoryLock,
  type Db,
  type LocalPostgresInstance,
} from "@rudderhq/db";
import {
  WORKSPACE_BACKUP_DEFAULT_INTERVAL_HOURS,
  WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS,
  type DeploymentExposure,
  type DeploymentMode,
} from "@rudderhq/shared";
import detectPort from "detect-port";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { createRudderApp } from "./app.js";
import { shouldStartAutomaticBackupSchedulers } from "./backup-scheduler-policy.js";
import { getBoardClaimWarningUrl } from "./board-claim.js";
import {
  createAuthRuntime,
  type LocalAccountAuthOptions,
} from "./bootstrap/auth-runtime.js";
import { loadConfig, type Config } from "./config.js";
import { runScheduledDatabaseBackupOnce } from "./database-backup-scheduler.js";
import {
  reconcileOrganizationStorageRoots,
  resolveRudderHomeDir,
  resolveRudderInstanceId,
  resolveRudderInstanceRoot,
} from "./home-paths.js";
import {
  gracefullyStopRuntime,
  probeLocalRuntime,
  removeLocalRuntimeDescriptorIfOwned,
  resolveEffectiveLocalEnvName,
  resolveLocalRuntimePaths,
  resolveManagedPostgresRuntimeKey,
  resolveRuntimeOwnerKind,
  withRuntimeStartLock,
  writeLocalRuntimeDescriptor,
  type LocalRuntimeOwnerKind,
} from "./local-runtime.js";
import { logger } from "./middleware/logger.js";
import { resolveRudderConfigPath, resolveRudderEnvPath } from "./paths.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { createHttpServerShutdown } from "./runtime/http-server-shutdown.js";
import { RuntimeSupervisor, supervisedStart } from "./runtime/runtime-supervisor.js";
import {
  automationService,
  heartbeatService,
  logActivity,
  reconcilePersistedRuntimeServicesOnStartup,
  reconcileWorkspaceBackupArtifactStorage,
  reconcileWorkspaceRestoreReceipts,
  WORKSPACE_BACKUP_OFFLINE_INTERVAL_MS,
  WORKSPACE_BACKUP_RUNNING_INTERVAL_MS,
  workspaceBackupService,
} from "./services/index.js";
import {
  configureFeishuIntegrationRuntime,
  isFeishuLongConnectionEnabled,
} from "./services/integrations/feishu/runtime-registry.js";
import { feishuIntegrationRuntimeService } from "./services/integrations/feishu/runtime.js";
import { startManagedMcpOAuthSessionGc } from "./services/mcp/oauth-session-gc.js";
import { managedMcpOAuthService } from "./services/mcp/oauth.js";
import { printStartupBanner } from "./startup-banner.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { serverVersion } from "./version.js";

const WORKSPACE_BACKUP_SCHEDULER_TICK_MS = 60 * 60 * 1000;

export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
  instancePaths: {
    homeDir: string;
    instanceRoot: string;
    configPath: string;
    envPath: string;
  };
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ManagedStartedServer {
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string | null;
  instancePaths: StartedServer["instancePaths"];
  runtime: {
    mode: "owned" | "attached";
    instanceId: string;
    localEnv: string | null;
    ownerKind: LocalRuntimeOwnerKind | null;
    version: string;
    descriptorPath: string;
    lockPath: string;
    startedAt: string | null;
  };
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export type ServerBootstrapStage =
  | "config"
  | "database"
  | "app"
  | "listening"
  | "ready"
  | "shutdown";

export interface ServerBootstrapEvent {
  stage: ServerBootstrapStage;
  message: string;
}

export interface ServerRuntimeOverrides {
  host?: string;
  port?: number;
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  serveUi?: boolean;
  uiDevMiddleware?: boolean;
  heartbeatSchedulerEnabled?: boolean;
  databaseBackupEnabled?: boolean;
}

export interface StartServerOptions {
  runtimeOverrides?: ServerRuntimeOverrides;
  openOnListen?: boolean;
  printBanner?: boolean;
  onEvent?: (event: ServerBootstrapEvent) => void;
  runtimeOwnerKind?: LocalRuntimeOwnerKind | null;
  localAccountAuth?: LocalAccountAuthOptions;
}

export interface BootstrapCeoInviteOptions {
  dbUrl: string;
  force?: boolean;
  expiresHours?: number;
}

export interface BootstrapCeoInviteResult {
  token: string;
  expiresAt: Date;
}

export async function checkDatabaseConnection(dbUrl: string): Promise<void> {
  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    await db.execute("SELECT 1");
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

function hashBootstrapInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createBootstrapInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
}

export async function createBootstrapCeoInvite(
  options: BootstrapCeoInviteOptions,
): Promise<BootstrapCeoInviteResult | null> {
  const db = createDb(options.dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    const existingAdminCount = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows.length);

    if (existingAdminCount > 0 && !options.force) {
      return null;
    }

    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(invites.inviteType, "bootstrap_ceo"),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
        ),
      );

    const token = createBootstrapInviteToken();
    const expiresHours = Math.max(1, Math.min(24 * 30, options.expiresHours ?? 72));
    const created = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        tokenHash: hashBootstrapInviteToken(token),
        allowedJoinTypes: "human",
        expiresAt: new Date(Date.now() + expiresHours * 60 * 60 * 1000),
        invitedByUserId: "system",
      })
      .returning()
      .then((rows) => rows[0]);

    return { token, expiresAt: created.expiresAt };
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

export interface StartManagedLocalServerOptions extends StartServerOptions {
  ownerKind: LocalRuntimeOwnerKind;
  takeoverOnVersionMismatch?: boolean;
  preferredOwner?: boolean;
  runtimeStartupLockTimeoutMs?: number;
  gracefulStopTimeoutMs?: number;
}

function mergeRuntimeConfig(baseConfig: Config, overrides?: ServerRuntimeOverrides): Config {
  if (!overrides) return baseConfig;
  return {
    ...baseConfig,
    ...overrides,
    deploymentExposure:
      (overrides.deploymentMode ?? baseConfig.deploymentMode) === "local_trusted"
        ? "private"
        : (overrides.deploymentExposure ?? baseConfig.deploymentExposure),
  };
}

export async function startManagedLocalServer(
  options: StartManagedLocalServerOptions,
): Promise<ManagedStartedServer> {
  const instanceId = resolveRudderInstanceId();
  const localEnv = resolveEffectiveLocalEnvName(instanceId);
  const runtimePaths = resolveLocalRuntimePaths(instanceId);
  const takeoverOnVersionMismatch = options.takeoverOnVersionMismatch ?? true;
  const preferredOwner = options.preferredOwner ?? false;
  const gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? 10_000;

  return await withRuntimeStartLock(
    {
      instanceId,
      ownerKind: options.ownerKind,
      timeoutMs: options.runtimeStartupLockTimeoutMs,
    },
    async () => {
      const probe = await probeLocalRuntime({
        instanceId,
        localEnv,
        expectedVersion: serverVersion,
      });

      if (probe.kind === "healthy") {
        const runtimeOwnerKind = probe.health.runtimeOwnerKind ?? probe.descriptor.ownerKind;
        const shouldTakeOverForOwner = preferredOwner && runtimeOwnerKind !== options.ownerKind;
        const shouldTakeOverForVersion = !probe.versionMatches && takeoverOnVersionMismatch;

        if (shouldTakeOverForOwner || shouldTakeOverForVersion) {
          const stopped = await gracefullyStopRuntime(probe.descriptor, gracefulStopTimeoutMs);
          if (!stopped) {
            const why = shouldTakeOverForOwner
              ? `preferred owner '${options.ownerKind}'`
              : `version ${serverVersion}`;
            throw new Error(
              `Unable to take over local instance '${instanceId}' for ${why}. ` +
                `Existing runtime pid ${probe.descriptor.pid} did not exit after SIGTERM.`,
            );
          }
        } else if (probe.versionMatches) {
          return {
            host: new URL(probe.descriptor.apiUrl).hostname,
            listenPort: probe.descriptor.listenPort,
            apiUrl: probe.descriptor.apiUrl,
            databaseUrl: null,
            instancePaths: {
              homeDir: resolveRudderHomeDir(),
              instanceRoot: resolveRudderInstanceRoot(),
              configPath: resolveRudderConfigPath(),
              envPath: resolveRudderEnvPath(),
            },
            runtime: {
              mode: "attached",
              instanceId,
              localEnv,
              ownerKind: runtimeOwnerKind,
              version: probe.health.version ?? probe.descriptor.version,
              descriptorPath: runtimePaths.descriptorPath,
              lockPath: runtimePaths.lockPath,
              startedAt: probe.descriptor.startedAt,
            },
            stop: async () => {},
            dispose: async () => {},
          };
        } else {
          throw new Error(
            `Local instance '${instanceId}' is already running version ${probe.health.version ?? probe.descriptor.version}. ` +
              `Current server version is ${serverVersion}. Stop the running instance or allow takeover.`,
          );
        }
      }

      const started = await startServer({
        ...options,
        runtimeOwnerKind: options.ownerKind,
      });

      return {
        host: started.host,
        listenPort: started.listenPort,
        apiUrl: started.apiUrl,
        databaseUrl: started.databaseUrl,
        instancePaths: started.instancePaths,
        runtime: {
          mode: "owned",
          instanceId,
          localEnv,
          ownerKind: options.ownerKind,
          version: serverVersion,
          descriptorPath: runtimePaths.descriptorPath,
          lockPath: runtimePaths.lockPath,
          startedAt: new Date().toISOString(),
        },
        stop: started.stop,
        dispose: started.dispose,
      };
    },
  );
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const supervisor = new RuntimeSupervisor({
    onDisposeError: ({ name, error }) => {
      logger.warn({ err: error, resource: name }, "Runtime resource cleanup failed");
    },
  });
  return supervisedStart(supervisor, () => startServerRuntime(options, supervisor));
}

async function startServerRuntime(
  options: StartServerOptions,
  supervisor: RuntimeSupervisor,
): Promise<StartedServer> {
  options.onEvent?.({ stage: "config", message: "Loading Rudder configuration" });
  const instanceId = resolveRudderInstanceId();
  const localEnv = resolveEffectiveLocalEnvName(instanceId);
  const runtimeOwnerKind = options.runtimeOwnerKind ?? resolveRuntimeOwnerKind();
  let ownedRuntimeDescriptor: { instanceId: string; pid: number; apiUrl: string } | null = null;
  supervisor.own("runtime-descriptor", async () => {
    if (!ownedRuntimeDescriptor) return;
    await removeLocalRuntimeDescriptorIfOwned(ownedRuntimeDescriptor);
  });
  if (runtimeOwnerKind) {
    process.env.RUDDER_RUNTIME_OWNER_KIND = runtimeOwnerKind;
  }
  const config = mergeRuntimeConfig(loadConfig(), options.runtimeOverrides);
  if (process.env.RUDDER_SECRETS_PROVIDER === undefined) {
    process.env.RUDDER_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.RUDDER_SECRETS_STRICT_MODE === undefined) {
    process.env.RUDDER_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.RUDDER_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.RUDDER_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.RUDDER_MIGRATION_PROMPT === "never") return false;
    if (process.env.RUDDER_MIGRATION_AUTO_APPLY === "true") return true;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
    recoveryPointDir?: string;
    recoveryPointRetentionDays?: number;
  };

  async function createMigrationRecoveryPoint(
    connectionString: string,
    label: string,
    opts: EnsureMigrationsOptions,
  ): Promise<string> {
    const backupDir = opts.recoveryPointDir;
    if (!backupDir) {
      throw new Error(
        `${label} requires a migration recovery point, but no database backup directory is configured. ` +
          "Refusing to migrate without a restorable pre-migration backup.",
      );
    }

    try {
      const result = await runDatabaseBackup({
        connectionString,
        backupDir,
        retentionDays: Math.max(1, opts.recoveryPointRetentionDays ?? 30),
        filenamePrefix: "rudder-pre-migration",
        includeMigrationJournal: true,
      });
      logger.info(
        {
          label,
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
        },
        `${label} migration recovery point created before schema upgrade`,
      );
      return result.backupFile;
    } catch (error) {
      throw new Error(
        `${label} migration recovery point failed; refusing to apply schema changes: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async function applyMigrationsWithRecoveryPoint(
    connectionString: string,
    label: string,
    pendingMigrations: string[],
    opts: EnsureMigrationsOptions,
    requiresRecoveryPoint = true,
    existingRecoveryPoint?: string | null,
  ): Promise<void> {
    const recoveryPoint = existingRecoveryPoint ?? (requiresRecoveryPoint
      ? await createMigrationRecoveryPoint(connectionString, label, opts)
      : null);
    logger.info(
      { label, pendingMigrations, ...(recoveryPoint ? { recoveryPoint } : {}) },
      `Applying ${pendingMigrations.length} pending migrations for ${label}`,
    );
    await applyPendingMigrations(connectionString, { advisoryLockHeld: true });
    try {
      await assertPostMigrationInvariants(connectionString);
    } catch (error) {
      throw new Error(
        `${label} migration completed without passing post-migration invariants. ` +
          `${recoveryPoint ? `Recovery point: ${recoveryPoint}. ` : ""}` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  
  async function ensureMigrationsUnlocked(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    // Drift detection is read-only. The recovery point must be captured before
    // normalization, journal reconciliation, or SQL migrations can mutate the
    // schema or migration history.
    const legacyColumnRenames = await listLegacyColumnRenames(connectionString);
    const initialState = await inspectMigrations(connectionString);
    let recoveryPoint: string | null = null;
    if (
      initialState.tableCount > 0
      && (legacyColumnRenames.length > 0 || initialState.status === "needsMigrations")
    ) {
      recoveryPoint = await createMigrationRecoveryPoint(connectionString, label, opts ?? {});
    }

    const normalizedLegacyColumns = await normalizeLegacyColumnNames(connectionString);
    if (normalizedLegacyColumns.length > 0) {
      logger.warn(
        { normalizedLegacyColumns },
        `${label} had legacy schema drift; normalized columns before migration inspection.`,
      );
    }

    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") {
          await assertPostMigrationInvariants(connectionString);
          return "already applied";
        }
      }
    }
    if (state.status === "upToDate") {
      await assertPostMigrationInvariants(connectionString);
      return "already applied";
    }
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set RUDDER_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      await applyMigrationsWithRecoveryPoint(connectionString, label, state.pendingMigrations, opts ?? {}, true);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set RUDDER_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    await applyMigrationsWithRecoveryPoint(
      connectionString,
      label,
      state.pendingMigrations,
      opts ?? {},
      state.tableCount > 0,
      recoveryPoint,
    );
    return "applied (pending migrations)";
  }

  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    return withMigrationAdvisoryLock(
      connectionString,
      () => ensureMigrationsUnlocked(connectionString, label, opts),
    );
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@rudder.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: organizations.id }).from(organizations);
    for (const organization of companyRows) {
      const membership = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.orgId, organization.id),
            eq(organizationMemberships.principalType, "user"),
            eq(organizationMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(organizationMemberships).values({
        orgId: organization.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db: Db;
  let embeddedPostgres: LocalPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  supervisor.own("embedded-postgres", async () => {
    if (!embeddedPostgres || !embeddedPostgresStartedByThisProcess) return;
    await embeddedPostgres.stop();
  });
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; provider: string; dataDir: string; port: number; postgresBinDir?: string };
  options.onEvent?.({ stage: "database", message: "Preparing database" });
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL", {
      recoveryPointDir: config.databaseBackupDir,
      recoveryPointRetentionDays: config.databaseBackupRetentionDays,
    });
  
    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    let localPostgresProvider = "embedded-postgres";
    let localPostgresBinDir: string | undefined;
    const embeddedPostgresLogBuffer: string[] = [];
    const EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT = 120;
    const verboseEmbeddedPostgresLogs = process.env.RUDDER_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
      for (const lineRaw of text.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line) continue;
        embeddedPostgresLogBuffer.push(line);
        if (embeddedPostgresLogBuffer.length > EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT) {
          embeddedPostgresLogBuffer.splice(0, embeddedPostgresLogBuffer.length - EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT);
        }
        if (verboseEmbeddedPostgresLogs) {
          logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
        }
      }
    };
    const recordEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown): Error => {
      const startupError = createEmbeddedPostgresStartupError(
        err,
        `Embedded PostgreSQL failed during ${phase}`,
        embeddedPostgresLogBuffer,
      );
      if (embeddedPostgresLogBuffer.length > 0) {
        logger.error(
          {
            phase,
            recentLogs: embeddedPostgresLogBuffer,
            err: err instanceof Error ? err : startupError,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
      return startupError;
    };
    const resolveEmbeddedAdminConnectionString = async (candidatePort: number): Promise<string> => {
      const result = await ensurePostgresRolePassword({
        host: "127.0.0.1",
        port: candidatePort,
        user: "rudder",
        database: "postgres",
        preferredPassword: "rudder",
        fallbackPasswords: ["password"],
        expectedDataDir: dataDir,
      });
      if (result.normalized) {
        logger.warn(
          `Normalized legacy embedded PostgreSQL password for ${dataDir}; old desktop data dir was using a previous default password`,
        );
      }
      return result.connectionString;
    };
    const createEmbeddedPostgresInstance = async (candidatePort: number) => {
      const selection = await createLocalPostgresInstance({
        databaseDir: dataDir,
        user: "rudder",
        password: "rudder",
        port: candidatePort,
        persistent: true,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
        onLog: appendEmbeddedPostgresLog,
        onError: appendEmbeddedPostgresLog,
      });
      localPostgresProvider = selection.provider === "official-postgres"
        ? `postgresql-${RUDDER_PRODUCTION_POSTGRES_VERSION}`
        : "embedded-postgres";
      localPostgresBinDir = selection.postgresBinDir;
      return selection.instance;
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const getRunningPid = (): number | null => {
      const postmaster = readPostmasterPidFile(postmasterPidFile);
      if (!postmaster?.pid) return null;
      try {
        process.kill(postmaster.pid, 0);
        return postmaster.pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      try {
        const configuredAdminConnectionString = await resolveEmbeddedAdminConnectionString(configuredPort);
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "rudder");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        embeddedPostgres = await createEmbeddedPostgresInstance(port);
        logger.info(`Using local PostgreSQL because no DATABASE_URL set (provider=${localPostgresProvider}, dataDir=${dataDir}, port=${port})`);

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            throw recordEmbeddedPostgresFailure("initialise", err);
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        const removedPostmaster = removeStalePostmasterPidFile({
          postmasterPidFile,
          expectedDataDir: dataDir,
        });
        if (removedPostmaster) {
          logger.warn(
            {
              stalePid: removedPostmaster.pid,
              stalePort: removedPostmaster.port,
              dataDir,
            },
            "Removed stale embedded PostgreSQL pid file before startup",
          );
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          if (isEmbeddedPostgresSharedMemoryError(err, embeddedPostgresLogBuffer)) {
            const recovered = await cleanupStaleSysvSharedMemorySegments();
            if (recovered.removedIds.length > 0) {
              logger.warn(
                { removedSegmentIds: recovered.removedIds },
                "Recovered stale SysV shared memory segments after embedded PostgreSQL startup failure; retrying once",
              );
              embeddedPostgres = await createEmbeddedPostgresInstance(port);
              try {
                await embeddedPostgres.start();
              } catch (retryErr) {
                throw recordEmbeddedPostgresFailure("start", retryErr);
              }
            } else {
              throw recordEmbeddedPostgresFailure("start", err);
            }
          } else {
            throw recordEmbeddedPostgresFailure("start", err);
          }
        }
        embeddedPostgresStartedByThisProcess = true;
      }
    }
  
    const embeddedAdminConnectionString = await resolveEmbeddedAdminConnectionString(port);
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "rudder");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: rudder");
    }
  
    const embeddedConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
      recoveryPointDir: config.databaseBackupDir,
      recoveryPointRetentionDays: config.databaseBackupRetentionDays,
    });
  
    db = createDb(embeddedConnectionString);
    if (localPostgresProvider === `postgresql-${RUDDER_PRODUCTION_POSTGRES_VERSION}`) {
      logger.info({ postgresBinDir: localPostgresBinDir }, `PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} production runtime ready`);
    } else {
      logger.info("Embedded PostgreSQL ready");
    }
    activeDatabaseConnectionString = embeddedConnectionString;
    startupDbInfo = { mode: "embedded-postgres", provider: localPostgresProvider, dataDir, port, ...(localPostgresBinDir ? { postgresBinDir: localPostgresBinDir } : {}) };
  }

  supervisor.own("database-pool", async () => {
    await db.$client.end({ timeout: 5 });
  });
  
  const liveOrganizationRows = await db
    .select({ id: organizations.id, name: organizations.name, urlKey: organizations.urlKey })
    .from(organizations);
  const liveOrganizations = liveOrganizationRows.map((row) => ({
    id: row.id,
    name: row.name,
    urlKey: row.urlKey,
  }));
  const organizationStorageReconciliation = await reconcileOrganizationStorageRoots(liveOrganizations);
  const organizationStorageMigrations = organizationStorageReconciliation.migrations;
  const workspaceAvailableOrganizationIds = organizationStorageReconciliation.workspaceAvailableOrganizationIds;
  const migratedOrganizationStorage = organizationStorageMigrations.filter((result) => result.migrated);
  const skippedOrganizationStorageMigrations = organizationStorageMigrations.filter((result) =>
    result.skippedBecauseTargetExists
  );
  if (organizationStorageReconciliation.workspacePermissionFailures.length > 0) {
    logger.warn(
      {
        workspacePermissionFailures: organizationStorageReconciliation.workspacePermissionFailures,
      },
      "organization Library workspaces are unavailable until filesystem permissions are repaired",
    );
  }
  if (migratedOrganizationStorage.length > 0) {
    logger.info(
      {
        migratedOrganizationStorage: migratedOrganizationStorage.map((result) => ({
          from: result.legacyRootPath,
          to: result.canonicalRootPath,
          mergedIntoExistingTarget: result.mergedIntoExistingTarget,
        })),
      },
      "migrated organization storage root paths",
    );
  }
  if (skippedOrganizationStorageMigrations.length > 0) {
    logger.warn(
      {
        skippedOrganizationStorageMigrations: skippedOrganizationStorageMigrations.map((result) => ({
          legacyRootPath: result.legacyRootPath,
          canonicalRootPath: result.canonicalRootPath,
        })),
      },
      "skipped organization storage root migration because target already exists",
    );
  }
  const prunedOrganizationStorage = organizationStorageReconciliation.pruned;
  if (
    prunedOrganizationStorage.removedOrganizationDirNames.length > 0
    || prunedOrganizationStorage.removedLegacyProjectDirNames.length > 0
    || prunedOrganizationStorage.removedLegacyProjectsRoot
  ) {
    logger.warn(
      {
        removedOrganizationDirNames: prunedOrganizationStorage.removedOrganizationDirNames,
        removedLegacyProjectDirNames: prunedOrganizationStorage.removedLegacyProjectDirNames,
        removedLegacyProjectsRoot: prunedOrganizationStorage.removedLegacyProjectsRoot,
      },
      "reconciled local organization storage on startup",
    );
  }
  const workspaceBackupArtifactReconciliation = await reconcileWorkspaceBackupArtifactStorage(
    db,
    workspaceAvailableOrganizationIds,
  );
  const workspaceRestoreReconciliation = await reconcileWorkspaceRestoreReceipts(db);
  if (workspaceRestoreReconciliation.recovered.length > 0) {
    logger.warn({ operationIds: workspaceRestoreReconciliation.recovered }, "reconciled workspace restore receipts on startup");
  }
  if (workspaceRestoreReconciliation.blocked.length > 0) {
    logger.error({ receipts: workspaceRestoreReconciliation.blocked }, "workspace restore recovery required on startup");
  }
  if (workspaceBackupArtifactReconciliation.migrated.length > 0) {
    logger.info(
      {
        migratedWorkspaceBackupArtifacts: workspaceBackupArtifactReconciliation.migrated.map((result) => ({
          backupId: result.backupId,
          from: result.from,
          to: result.to,
          movedArtifact: result.movedArtifact,
          updatedArtifact: result.updatedArtifact,
        })),
      },
      "migrated workspace backup artifact paths",
    );
  }
  if (workspaceBackupArtifactReconciliation.skipped.length > 0) {
    logger.warn(
      {
        skippedWorkspaceBackupArtifactMigrations: workspaceBackupArtifactReconciliation.skipped,
      },
      "skipped workspace backup artifact path migration",
    );
  }
  const workspaceBackupRepairService = workspaceBackupService(db);
  for (const orgId of workspaceAvailableOrganizationIds) {
    try {
      const recovery = await workspaceBackupRepairService.recoverSparseWorkspaceFromLatestBackup(orgId);
      if (!recovery.recovered) continue;
      logger.warn(
        {
          orgId: recovery.orgId,
          backupId: recovery.backupId,
          currentFileCount: recovery.currentFileCount,
          backupFileCount: recovery.backupFileCount,
          restoredFileCount: recovery.restoredFileCount,
          skippedConflictingFiles: recovery.skippedConflictingFiles,
        },
        "repaired sparse organization workspace from latest backup",
      );
      try {
        await logActivity(db as any, {
          orgId,
          actorType: "system",
          actorId: "workspace-backup-repair",
          action: "organization.workspace_backup.sparse_repair",
          entityType: "workspace_backup",
          entityId: recovery.backupId ?? orgId,
          details: {
            triggerSource: "startup",
            currentFileCount: recovery.currentFileCount,
            backupFileCount: recovery.backupFileCount,
            restoredFileCount: recovery.restoredFileCount,
            skippedConflictingFiles: recovery.skippedConflictingFiles,
          },
        });
      } catch (error) {
        logger.warn(
          { orgId, err: error instanceof Error ? error.message : String(error) },
          "failed to log sparse organization workspace startup repair activity",
        );
      }
    } catch (error) {
      logger.warn(
        { orgId, err: error instanceof Error ? error.message : String(error) },
        "sparse organization workspace repair failed during startup",
      );
    }
  }

  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }
  
  const {
    authReady,
    betterAuthHandler,
    resolveSession,
    resolveSessionFromHeaders,
    localAccountExchangePolicy,
    localAccountSessionRevocation,
  } = await createAuthRuntime({
    db: db as any,
    config,
    instanceId,
    localAccountAuth: options.localAccountAuth,
    ensureLocalTrustedBoardPrincipal: () => ensureLocalTrustedBoardPrincipal(db as any),
  });
  
  const listenPort = await detectPort(config.port);
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  options.onEvent?.({ stage: "app", message: "Creating Rudder app" });
  const appHandle = await createRudderApp(db as any, {
    uiMode,
    serverPort: listenPort,
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    storageService,
    deploymentMode: config.deploymentMode,
    authRequirement: options.localAccountAuth ? "required" : undefined,
    localRuntimeTrust: options.localAccountAuth ? "trusted" : undefined,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    workspacePreviewOrigin: config.workspacePreviewOrigin,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    mcpDeploymentAllowlists: config.mcpDeploymentAllowlists,
    instanceId,
    localEnv,
    runtimeOwnerKind,
    betterAuthHandler,
    resolveSession,
    localAccountExchangePolicy,
    localAccountSessionRevocation,
  });
  supervisor.own("app", () => appHandle.close());
  const server = createServer(appHandle.app as unknown as Parameters<typeof createServer>[0]);
  const beginHttpClose = createHttpServerShutdown(server, {
    onCloseError: (err) => {
      logger.warn({ err }, "HTTP server close reported an error during shutdown");
    },
    onForceClose: () => {
      logger.warn("HTTP server graceful shutdown timed out; closing active connections");
    },
  });
  supervisor.own("http-server-drain", beginHttpClose);
  
  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.RUDDER_LISTEN_HOST = runtimeListenHost;
  process.env.RUDDER_LISTEN_PORT = String(listenPort);
  process.env.RUDDER_API_URL = `http://${runtimeApiHost}:${listenPort}`;
  
  const liveEventsRuntime = setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    authRequirement: options.localAccountAuth ? "required" : undefined,
    resolveSessionFromHeaders,
    sessionRevocation: localAccountSessionRevocation,
  });
  supervisor.own("live-events-websocket", () => liveEventsRuntime.close());

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });
  
  const ownInterval = (name: string, handle: ReturnType<typeof setInterval>) => {
    supervisor.own(name, () => clearInterval(handle));
  };
  const managedMcpOAuthSessionGc = startManagedMcpOAuthSessionGc(
    managedMcpOAuthService(db as any, {
      deploymentMode: config.deploymentMode,
      serverPort: listenPort,
      authPublicBaseUrl: config.authPublicBaseUrl ?? null,
      allowlists: config.mcpDeploymentAllowlists,
    }),
    {
      onError: (error) => {
        logger.warn(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Managed MCP OAuth session cleanup failed",
        );
      },
    },
  );
  supervisor.own(
    "managed-mcp-oauth-session-gc",
    () => managedMcpOAuthSessionGc.stop(),
  );
  const feishuRuntime = feishuIntegrationRuntimeService(db as any, { storage: storageService });
  supervisor.own("feishu-runtime", () => feishuRuntime.stop());
  const feishuLongConnectionEnabled = isFeishuLongConnectionEnabled();
  configureFeishuIntegrationRuntime({
    runtime: feishuRuntime,
    enabled: feishuLongConnectionEnabled,
  });
  supervisor.own("feishu-runtime-registry", () => {
    configureFeishuIntegrationRuntime({ runtime: null, enabled: false });
  });

  const heartbeat = heartbeatService(db as any);
  // Terminal ownership recovery is a startup invariant, independent of
  // whether interval-based heartbeat scheduling is enabled.
  const startupRecoveryCutoff = new Date();
  void heartbeat
    .reapTimedOutRuns({ maxRuntimeMs: config.heartbeatRunTimeoutMs, recoveryCutoff: startupRecoveryCutoff })
    .then(() => heartbeat.reapInactiveRuns({
      maxInactivityMs: config.heartbeatRunInactivityTimeoutMs,
      recoveryCutoff: startupRecoveryCutoff,
    }))
    .then(() => heartbeat.reapOrphanedRuns({ recoveryCutoff: startupRecoveryCutoff }))
    .then(() => heartbeat.resumePendingWakeupRequests())
    .then(() => heartbeat.resumeQueuedRuns())
    .catch((err) => {
      logger.error({ err }, "startup heartbeat recovery failed");
    });
  ownInterval("heartbeat-recovery-interval", setInterval(() => {
    void heartbeat
      .reapTimedOutRuns({ maxRuntimeMs: config.heartbeatRunTimeoutMs })
      .then(() => heartbeat.reapInactiveRuns({ maxInactivityMs: config.heartbeatRunInactivityTimeoutMs }))
      .then(() => heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 }))
      .then(() => heartbeat.resumePendingWakeupRequests())
      .then(() => heartbeat.resumeQueuedRuns())
      .catch((err) => {
        logger.error({ err }, "periodic heartbeat recovery failed");
      });
  }, config.heartbeatSchedulerIntervalMs));

  if (config.heartbeatSchedulerEnabled) {
    const automations = automationService(db as any);
    ownInterval("heartbeat-scheduler-interval", setInterval(() => {
      void heartbeat
        .tickTimers(new Date())
        .then((result) => {
          if (result.enqueued > 0) {
            logger.info({ ...result }, "heartbeat timer tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "heartbeat timer tick failed");
        });

      void automations
        .tickScheduledTriggers(new Date())
        .then((result) => {
          if (result.triggered > 0) {
            logger.info({ ...result }, "automation scheduler tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "automation scheduler tick failed");
        });
    }, config.heartbeatSchedulerIntervalMs));
  }

  if (feishuLongConnectionEnabled) {
    void feishuRuntime
      .start()
      .then((result) => {
        logger.info({ started: result.started }, "Feishu long-connection runtime started");
      })
      .catch((err) => {
        logger.error({ err }, "Feishu long-connection runtime startup failed");
      });
  }
  
  const automaticBackupSchedulersEnabled = shouldStartAutomaticBackupSchedulers(localEnv);

  if (config.databaseBackupEnabled && automaticBackupSchedulersEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    let backupInFlight = false;
  
    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }
  
      backupInFlight = true;
      try {
        await runScheduledDatabaseBackupOnce({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          maxEstimatedBytes: config.databaseBackupMaxEstimatedBytes,
        });
      } catch (err) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };
  
    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionDays: config.databaseBackupRetentionDays,
        backupDir: config.databaseBackupDir,
        maxEstimatedBytes: config.databaseBackupMaxEstimatedBytes,
      },
      "Automatic database backups enabled",
    );
    ownInterval("database-backup-interval", setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs));
  }

  if (automaticBackupSchedulersEnabled) {
    const workspaceBackups = workspaceBackupService(db as any);
    let workspaceBackupInFlight = false;

    const runScheduledWorkspaceBackups = async (mode: "startup" | "running") => {
      if (workspaceBackupInFlight) {
        logger.warn("Skipping scheduled workspace backup tick because a previous tick is still running");
        return;
      }

      workspaceBackupInFlight = true;
      try {
        const result = await workspaceBackups.runScheduledBackups({
          intervalMs: mode === "startup" ? WORKSPACE_BACKUP_OFFLINE_INTERVAL_MS : WORKSPACE_BACKUP_RUNNING_INTERVAL_MS,
        });
        for (const recovery of result.sparseRecoveries) {
          try {
            await logActivity(db as any, {
              orgId: recovery.orgId,
              actorType: "system",
              actorId: "workspace-backup-scheduler",
              action: recovery.recovered
                ? "organization.workspace_backup.sparse_repair"
                : "organization.workspace_backup.sparse_repair_failed",
              entityType: "workspace_backup",
              entityId: recovery.backupId ?? recovery.orgId,
              details: {
                triggerSource: "scheduled",
                currentFileCount: recovery.currentFileCount,
                backupFileCount: recovery.backupFileCount,
                restoredFileCount: recovery.restoredFileCount,
                skippedConflictingFiles: recovery.skippedConflictingFiles,
                reason: recovery.reason,
                error: recovery.error,
              },
            });
          } catch (error) {
            logger.warn(
              { orgId: recovery.orgId, err: error instanceof Error ? error.message : String(error) },
              "failed to log scheduled sparse organization workspace repair activity",
            );
          }
        }
        for (const backup of [...result.created, ...result.failed]) {
          await logActivity(db as any, {
            orgId: backup.orgId,
            actorType: "system",
            actorId: "workspace-backup-scheduler",
            action: backup.status === "succeeded"
              ? "organization.workspace_backup.created"
              : "organization.workspace_backup.failed",
            entityType: "workspace_backup",
            entityId: backup.id,
            details: {
              status: backup.status,
              fileCount: backup.fileCount,
              byteSize: backup.byteSize,
              warnings: backup.warnings,
              error: backup.error,
              triggerSource: backup.triggerSource,
              expiresAt: backup.expiresAt,
            },
          });
        }
        for (const backup of result.deleted) {
          await logActivity(db as any, {
            orgId: backup.orgId,
            actorType: "system",
            actorId: "workspace-backup-scheduler",
            action: "organization.workspace_backup.deleted",
            entityType: "workspace_backup",
            entityId: backup.id,
            details: {
              fileCount: backup.fileCount,
              byteSize: backup.byteSize,
              expiresAt: backup.expiresAt,
              reason: "retention_expired",
            },
          });
        }
        const skippedUnchanged = result.skippedDetails.filter((detail) => detail.reason === "unchanged");
        if (skippedUnchanged.length > 0) {
          logger.info(
            {
              skippedUnchanged: skippedUnchanged.map((detail) => ({
                orgId: detail.orgId,
                comparedBackupId: detail.comparedBackupId,
                treeSha256: detail.treeSha256,
              })),
            },
            "Scheduled workspace backups skipped unchanged workspaces",
          );
        }
        if (
          result.created.length > 0
          || result.failed.length > 0
          || result.deleted.length > 0
          || skippedUnchanged.length > 0
          || result.errors.length > 0
        ) {
          logger.info(
            {
              created: result.created.length,
              failed: result.failed.length,
              deleted: result.deleted.length,
              skipped: result.skipped,
              errors: result.errors,
            },
            "Scheduled workspace backup tick complete",
          );
        }
      } catch (err) {
        logger.error({ err }, "Scheduled workspace backup tick failed");
      } finally {
        workspaceBackupInFlight = false;
      }
    };

    logger.info(
      {
        intervalHours: WORKSPACE_BACKUP_DEFAULT_INTERVAL_HOURS,
        runningIntervalHours: WORKSPACE_BACKUP_RUNNING_INTERVAL_MS / (60 * 60 * 1000),
        offlineIntervalHours: WORKSPACE_BACKUP_OFFLINE_INTERVAL_MS / (60 * 60 * 1000),
        retentionDays: WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS,
      },
      "Automatic workspace backups enabled",
    );
    void runScheduledWorkspaceBackups("startup");
    ownInterval("workspace-backup-interval", setInterval(() => {
      void runScheduledWorkspaceBackups("running");
    }, WORKSPACE_BACKUP_SCHEDULER_TICK_MS));
  }
  
  options.onEvent?.({ stage: "listening", message: "Starting local HTTP server" });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      const shouldOpenOnListen = options.openOnListen ?? process.env.RUDDER_OPEN_ON_LISTEN === "true";
      if (shouldOpenOnListen) {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
      if (options.printBanner ?? true) {
        printStartupBanner({
          host: config.host,
          deploymentMode: config.deploymentMode,
          deploymentExposure: config.deploymentExposure,
          authReady,
          requestedPort: config.port,
          listenPort,
          uiMode,
          db: startupDbInfo,
          migrationSummary,
          heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
          heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
          databaseBackupEnabled: config.databaseBackupEnabled && automaticBackupSchedulersEnabled,
          databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
          databaseBackupRetentionDays: config.databaseBackupRetentionDays,
          databaseBackupDir: config.databaseBackupDir,
        });
      }

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  supervisor.own("http-ingress", () => {
    void beginHttpClose();
  });

  if (runtimeOwnerKind) {
    const descriptorPostgresBinDir = startupDbInfo.mode === "embedded-postgres"
      ? startupDbInfo.postgresBinDir
      : undefined;
    const postgresRuntimeKey = descriptorPostgresBinDir
      ? resolveManagedPostgresRuntimeKey(descriptorPostgresBinDir)
      : null;
    const runtimeDescriptor = {
      instanceId,
      localEnv,
      pid: process.pid,
      listenPort,
      apiUrl: process.env.RUDDER_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
      version: serverVersion,
      ownerKind: runtimeOwnerKind,
      startedAt: new Date().toISOString(),
      ...(descriptorPostgresBinDir
        ? {
            postgresBinDir: descriptorPostgresBinDir,
            ...(postgresRuntimeKey ? { postgresRuntimeKey } : {}),
          }
        : {}),
    };
    ownedRuntimeDescriptor = {
      instanceId: runtimeDescriptor.instanceId,
      pid: runtimeDescriptor.pid,
      apiUrl: runtimeDescriptor.apiUrl,
    };
    await writeLocalRuntimeDescriptor(runtimeDescriptor);
  }

  let shutdownEventSent = false;
  const stop = () => {
    if (!shutdownEventSent) {
      shutdownEventSent = true;
      options.onEvent?.({ stage: "shutdown", message: "Stopping Rudder server" });
    }
    return supervisor.dispose();
  };

  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    void stop()
      .catch((err) => {
        logger.error({ err, signal }, "Rudder shutdown failed");
      })
      .finally(() => {
        process.exit(0);
      });
  };

  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  supervisor.own("process-signal-listeners", () => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  });

  options.onEvent?.({ stage: "ready", message: "Rudder server is ready" });

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: process.env.RUDDER_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
    databaseUrl: activeDatabaseConnectionString,
    instancePaths: {
      homeDir: resolveRudderHomeDir(),
      instanceRoot: resolveRudderInstanceRoot(),
      configPath: resolveRudderConfigPath(),
      envPath: resolveRudderEnvPath(),
    },
    stop,
    dispose: stop,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Rudder server failed to start");
    process.exit(1);
  });
}
