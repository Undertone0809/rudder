import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanupStaleSysvSharedMemorySegments } from "../packages/db/src/embedded-postgres-recovery.js";

const execFile = promisify(execFileCallback);
const temporaryDirectory = path.resolve(os.tmpdir());
const ownedDataDirectoryPrefix = `${temporaryDirectory}${path.sep}rudder-`;
const registryPath = path.join(temporaryDirectory, "rudder-vitest-postgres-runs.json");
const registryLockPath = `${registryPath}.lock`;

type PostgresProcess = {
  pid: number;
  dataDirectory: string;
};

type VitestRun = {
  token: string;
  pid: number;
};

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readRuns(): Promise<VitestRun[]> {
  try {
    const value = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (run): run is VitestRun =>
        typeof run === "object" &&
        run !== null &&
        typeof (run as VitestRun).token === "string" &&
        Number.isInteger((run as VitestRun).pid) &&
        (run as VitestRun).pid > 0 &&
        isRunning((run as VitestRun).pid),
    );
  } catch {
    return [];
  }
}

async function writeRuns(runs: VitestRun[]): Promise<void> {
  if (runs.length === 0) {
    await rm(registryPath, { force: true });
    return;
  }
  await writeFile(registryPath, `${JSON.stringify(runs)}\n`, "utf8");
}

async function withRegistryLock<T>(action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(registryLockPath);
      await writeFile(path.join(registryLockPath, "pid"), String(process.pid), "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const lockPid = Number(await readFile(path.join(registryLockPath, "pid"), "utf8"));
        stale = !isRunning(lockPid);
      } catch {
        try {
          const lockStats = await stat(registryLockPath);
          stale = Date.now() - lockStats.mtimeMs > 10_000;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        await rm(registryLockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Vitest PostgreSQL cleanup lock");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await action();
  } finally {
    await rm(registryLockPath, { recursive: true, force: true });
  }
}

function postgresDataDirectory(command: string): string | null {
  if (!/(?:^|\s)(?:\S+\/)?postgres(?:\s|$)/.test(command)) return null;
  const match = command.match(/\s-D\s+(\S+)/);
  const dataDirectory = match?.[1];
  if (!dataDirectory || !dataDirectory.startsWith(ownedDataDirectoryPrefix)) return null;
  return dataDirectory;
}

async function listOwnedPostgresProcesses(): Promise<PostgresProcess[]> {
  let stdout = "";
  try {
    ({ stdout } = await execFile("ps", ["-axo", "pid=,command="], { timeout: 2_000 }));
  } catch {
    return [];
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .flatMap((match) => {
      if (!match) return [];
      const pid = Number(match[1]);
      const dataDirectory = postgresDataDirectory(match[2]);
      return dataDirectory && Number.isInteger(pid) && pid > 0 ? [{ pid, dataDirectory }] : [];
    });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isRunning(pid);
}

async function stopProcess(processInfo: PostgresProcess): Promise<boolean> {
  if (!isRunning(processInfo.pid)) return true;
  try {
    process.kill(processInfo.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  if (await waitForExit(processInfo.pid, 5_000)) return true;

  process.kill(processInfo.pid, "SIGKILL");
  return waitForExit(processInfo.pid, 2_000);
}

async function cleanupOwnedPostgres(): Promise<void> {
  const processes = await listOwnedPostgresProcesses();
  if (processes.length === 0) return;

  const results = await Promise.allSettled(processes.map(stopProcess));
  const stopped = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const survivors = results.length - stopped;
  if (stopped > 0) {
    console.log(`Stopped ${stopped} orphaned test PostgreSQL process(es).`);
    await cleanupStaleSysvSharedMemorySegments()
      .then(({ removedIds, skippedIds }) => {
        if (removedIds.length > 0) {
          console.log(`Removed ${removedIds.length} stale SysV shared-memory segment(s) after Vitest teardown.`);
        }
        if (skippedIds.length > 0) {
          console.warn(`Could not remove ${skippedIds.length} stale SysV shared-memory segment(s) after Vitest teardown.`);
        }
      })
      .catch((error) => {
        console.warn(
          `Vitest SysV shared-memory cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
  if (survivors > 0) {
    console.warn(`Could not stop ${survivors} test PostgreSQL process(es) during Vitest teardown.`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const token = `${process.pid}-${randomUUID()}`;
  let shouldCleanBeforeRun = false;
  await withRegistryLock(async () => {
    const runs = await readRuns();
    shouldCleanBeforeRun = runs.length === 0;
    runs.push({ token, pid: process.pid });
    await writeRuns(runs);
  });

  // Recover residue from an interrupted or failed previous Vitest run before
  // starting more embedded clusters.
  if (shouldCleanBeforeRun) await cleanupOwnedPostgres();

  return async () => {
    let shouldCleanAfterRun = false;
    await withRegistryLock(async () => {
      const runs = (await readRuns()).filter((run) => run.token !== token);
      shouldCleanAfterRun = runs.length === 0;
      await writeRuns(runs);
    });
    if (shouldCleanAfterRun) await cleanupOwnedPostgres();
  };
}
