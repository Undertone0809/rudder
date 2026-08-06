import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import {
  cleanupStaleSysvSharedMemorySegments,
  createEmbeddedPostgresStartupError,
  isEmbeddedPostgresSharedMemoryError,
  readPostmasterPidFile,
  removeStalePostmasterPidFile,
} from "./embedded-postgres-recovery.js";
import {
  createLocalPostgresInstance,
  RUDDER_PRODUCTION_POSTGRES_VERSION,
  type LocalPostgresInstance,
} from "./local-postgres-provider.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  const maxLookahead = 20;
  let port = startPort;
  for (let i = 0; i < maxLookahead; i += 1, port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a free port from ${startPort} to ${startPort + maxLookahead - 1}`,
  );
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const selectedPort = await findAvailablePort(preferredPort);
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const recentLogs: string[] = [];
  const appendLog = (message: unknown) => {
    const text =
      typeof message === "string"
        ? message
        : message instanceof Error
          ? message.message
          : String(message ?? "");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      recentLogs.push(line);
      if (recentLogs.length > 40) recentLogs.shift();
    }
  };
  const formatStartFailure = (error: unknown): Error => {
    return createEmbeddedPostgresStartupError(
      error,
      `Failed to start embedded PostgreSQL on port ${selectedPort}`,
      recentLogs,
    );
  };
  const postmaster = readPostmasterPidFile(postmasterPidFile);
  let runningPid: number | null = null;
  if (postmaster?.pid) {
    try {
      process.kill(postmaster.pid, 0);
      runningPid = postmaster.pid;
    } catch {
      runningPid = null;
    }
  }
  const runningPort = postmaster?.port ?? null;
  const preferredAdminConnectionString = `postgres://rudder:rudder@127.0.0.1:${preferredPort}/postgres`;

  if (!runningPid && existsSync(pgVersionFile)) {
    try {
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      const matchesDataDir =
        typeof actualDataDir === "string" &&
        path.resolve(actualDataDir) === path.resolve(dataDir);
      if (!matchesDataDir) {
        throw new Error("reachable postgres does not use the expected embedded data directory");
      }
      await ensurePostgresDatabase(preferredAdminConnectionString, "rudder");
      process.emitWarning(
        `Adopting an existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} because postmaster.pid is missing.`,
      );
      return {
        connectionString: `postgres://rudder:rudder@127.0.0.1:${preferredPort}/rudder`,
        source: `embedded-postgres@${preferredPort}`,
        stop: async () => {},
      };
    } catch {
      // Fall through and attempt to start the configured embedded cluster.
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "rudder");
    return {
      connectionString: `postgres://rudder:rudder@127.0.0.1:${port}/rudder`,
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  let providerLabel = "embedded-postgres";
  const createInstance = async (): Promise<LocalPostgresInstance> => {
    const selection = await createLocalPostgresInstance({
      databaseDir: dataDir,
      user: "rudder",
      password: "rudder",
      port: selectedPort,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: appendLog,
      onError: appendLog,
    });
    providerLabel = selection.provider === "official-postgres"
      ? `postgresql-${RUDDER_PRODUCTION_POSTGRES_VERSION}`
      : "embedded-postgres";
    return selection.instance;
  };

  const instance = await createInstance();

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    try {
      await instance.initialise();
    } catch (error) {
      throw createEmbeddedPostgresStartupError(
        error,
        `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${selectedPort}`,
        recentLogs,
      );
    }
  }
  removeStalePostmasterPidFile({
    postmasterPidFile,
    expectedDataDir: dataDir,
  });

  let startedInstance = instance;
  try {
    await startedInstance.start();
  } catch (error) {
    if (isEmbeddedPostgresSharedMemoryError(error, recentLogs)) {
      const recovered = await cleanupStaleSysvSharedMemorySegments();
      if (recovered.removedIds.length > 0) {
        process.emitWarning(
          `Recovered ${recovered.removedIds.length} stale SysV shared memory segment(s) before retrying embedded PostgreSQL startup on port ${selectedPort}.`,
        );
        startedInstance = await createInstance();
        try {
          await startedInstance.start();
        } catch (retryError) {
          throw formatStartFailure(retryError);
        }
      } else {
        throw formatStartFailure(error);
      }
    } else {
      throw formatStartFailure(error);
    }
  }

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${selectedPort}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");

  return {
    connectionString: `postgres://rudder:rudder@127.0.0.1:${selectedPort}/rudder`,
    source: `${providerLabel}@${selectedPort}`,
    stop: async () => {
      await startedInstance.stop();
    },
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}
