/// <reference path="./types/express.d.ts" />
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import type { DeploymentExposure, DeploymentMode } from "@rudderhq/shared";
import {
  createDb,
  cleanupStaleSysvSharedMemorySegments,
  ensurePostgresDatabase,
  ensurePostgresRolePassword,
  getPostgresDataDirectory,
  isEmbeddedPostgresSharedMemoryError,
  normalizeLegacyColumnNames,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  organizations,
  organizationMemberships,
  instanceUserRoles,
} from "@rudderhq/db";
import detectPort from "detect-port";
import { createRudderApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { initializeLangfuse, shutdownLangfuse } from "./langfuse.js";
import {
  pruneOrphanedOrganizationStorage,
  resolveRudderHomeDir,
  resolveRudderInstanceId,
  resolveRudderInstanceRoot,
} from "./home-paths.js";
import {
  type LocalRuntimeOwnerKind,
  gracefullyStopRuntime,
  probeLocalRuntime,
  resolveEffectiveLocalEnvName,
  resolveLocalRuntimePaths,
  resolveRuntimeOwnerKind,
  withRuntimeStartLock,
  writeLocalRuntimeDescriptor,
  removeLocalRuntimeDescriptorIfOwned,
} from "./local-runtime.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  heartbeatService,
  reconcilePersistedRuntimeServicesOnStartup,
  automationService,
} from "./services/index.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { resolveRudderConfigPath, resolveRudderEnvPath } from "./paths.js";
import { printStartupBanner } from "./startup-banner.js";
import { serverVersion } from "./version.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


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
  options.onEvent?.({ stage: "config", message: "Loading Rudder configuration" });
  const instanceId = resolveRudderInstanceId();
  const localEnv = resolveEffectiveLocalEnvName(instanceId);
  const runtimeOwnerKind = options.runtimeOwnerKind ?? resolveRuntimeOwnerKind();
  if (runtimeOwnerKind) {
    process.env.RUDDER_RUNTIME_OWNER_KIND = runtimeOwnerKind;
  }
  const config = mergeRuntimeConfig(loadConfig(), options.runtimeOverrides);
  initializeLangfuse({
    enabled: config.langfuse.enabled,
    baseUrl: config.langfuse.baseUrl,
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    environment: config.langfuse.environment,
    instanceId,
    deploymentMode: config.deploymentMode,
    localEnv,
    release: serverVersion,
  });
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
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
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
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
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
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set RUDDER_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
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
  
  let db;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let appHandle: Awaited<ReturnType<typeof createRudderApp>> | null = null;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  options.onEvent?.({ stage: "database", message: "Preparing database" });
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
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
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      if (embeddedPostgresLogBuffer.length > 0) {
        logger.error(
          {
            phase,
            recentLogs: embeddedPostgresLogBuffer,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
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
    const createEmbeddedPostgresInstance = (candidatePort: number) =>
      new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "rudder",
        password: "rudder",
        port: candidatePort,
        persistent: true,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
        onLog: appendEmbeddedPostgresLog,
        onError: appendEmbeddedPostgresLog,
      });
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
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
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = createEmbeddedPostgresInstance(port);

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw err;
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        if (existsSync(postmasterPidFile)) {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
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
              embeddedPostgres = createEmbeddedPostgresInstance(port);
              try {
                await embeddedPostgres.start();
              } catch (retryErr) {
                logEmbeddedPostgresFailure("start", retryErr);
                throw retryErr;
              }
            } else {
              logEmbeddedPostgresFailure("start", err);
              throw err;
            }
          } else {
            logEmbeddedPostgresFailure("start", err);
            throw err;
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
    });
  
    db = createDb(embeddedConnectionString);
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }
  
  const liveOrganizationRows = await db
    .select({ id: organizations.id })
    .from(organizations);
  const prunedOrganizationStorage = await pruneOrphanedOrganizationStorage(
    liveOrganizationRows.map((row) => row.id),
  );
  if (
    prunedOrganizationStorage.removedOrganizationDirNames.length > 0
    || prunedOrganizationStorage.removedLegacyProjectDirNames.length > 0
  ) {
    logger.warn(
      {
        removedOrganizationDirNames: prunedOrganizationStorage.removedOrganizationDirNames,
        removedLegacyProjectDirNames: prunedOrganizationStorage.removedLegacyProjectDirNames,
      },
      "pruned orphaned organization storage on startup",
    );
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
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const betterAuthSecret =
      process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.RUDDER_AGENT_JWT_SECRET?.trim();
    if (!betterAuthSecret) {
      throw new Error(
        "authenticated mode requires BETTER_AUTH_SECRET (or RUDDER_AGENT_JWT_SECRET) to be set",
      );
    }
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }
  
  const listenPort = await detectPort(config.port);
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  options.onEvent?.({ stage: "app", message: "Creating Rudder app" });
  appHandle = await createRudderApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    instanceId,
    localEnv,
    runtimeOwnerKind,
    betterAuthHandler,
    resolveSession,
  });
  const server = createServer(appHandle.app as unknown as Parameters<typeof createServer>[0]);
  
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
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

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
  
  const intervalHandles: Array<ReturnType<typeof setInterval>> = [];

  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any);
    const automations = automationService(db as any);
  
    // Reap orphaned running runs at startup while in-memory execution state is empty,
    // then resume any persisted queued runs that were waiting on the previous process.
    void heartbeat
      .reapOrphanedRuns()
      .then(() => heartbeat.resumeQueuedRuns())
      .catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });
    intervalHandles.push(setInterval(() => {
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
  
      // Periodically reap orphaned runs (5-min staleness threshold) and make sure
      // persisted queued work is still being driven forward.
      void heartbeat
        .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
        .then(() => heartbeat.resumeQueuedRuns())
        .catch((err) => {
          logger.error({ err }, "periodic heartbeat recovery failed");
        });
    }, config.heartbeatSchedulerIntervalMs));
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    let backupInFlight = false;
  
    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }
  
      backupInFlight = true;
      try {
        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          filenamePrefix: "rudder",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retentionDays: config.databaseBackupRetentionDays,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
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
      },
      "Automatic database backups enabled",
    );
    intervalHandles.push(setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs));
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
          databaseBackupEnabled: config.databaseBackupEnabled,
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

  if (runtimeOwnerKind) {
    await writeLocalRuntimeDescriptor({
      instanceId,
      localEnv,
      pid: process.pid,
      listenPort,
      apiUrl: process.env.RUDDER_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
      version: serverVersion,
      ownerKind: runtimeOwnerKind,
      startedAt: new Date().toISOString(),
    });
  }

  let stopInFlight: Promise<void> | null = null;
  const stop = async () => {
    if (stopInFlight) return stopInFlight;
    options.onEvent?.({ stage: "shutdown", message: "Stopping Rudder server" });
    stopInFlight = (async () => {
      for (const handle of intervalHandles) {
        clearInterval(handle);
      }
      await new Promise<void>((resolveClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close((err) => {
          if (err) {
            logger.warn({ err }, "HTTP server close reported an error during shutdown");
          }
          resolveClose();
        });
      });
      try {
        await appHandle?.close();
      } catch (err) {
        logger.warn({ err }, "App cleanup failed during shutdown");
      }
      try {
        await shutdownLangfuse();
      } catch (err) {
        logger.warn({ err }, "Langfuse cleanup failed during shutdown");
      }
      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        try {
          await embeddedPostgres.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }
      if (runtimeOwnerKind) {
        await removeLocalRuntimeDescriptorIfOwned({
          instanceId,
          pid: process.pid,
          apiUrl: process.env.RUDDER_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
        });
      }
    })();
    return stopInFlight;
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

  process.once("SIGINT", () => {
    handleSignal("SIGINT");
  });
  process.once("SIGTERM", () => {
    handleSignal("SIGTERM");
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
