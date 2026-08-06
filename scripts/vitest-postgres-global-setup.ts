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
  parentPid: number;
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
    ({ stdout } = await execFile("ps", ["-axo", "pid=,ppid=,command="], { timeout: 2_000 }));
  } catch {
    return [];
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .flatMap((match) => {
      if (!match) return [];
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const dataDirectory = postgresDataDirectory(match[3]);
      return dataDirectory
        && Number.isInteger(pid)
        && pid > 0
        && Number.isInteger(parentPid)
        && parentPid >= 0
        ? [{ pid, parentPid, dataDirectory }]
        : [];
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

async function listProcessTree(rootPid: number): Promise<number[]> {
  let stdout = "";
  try {
    ({ stdout } = await execFile("ps", ["-axo", "pid=,ppid="], { timeout: 2_000 }));
  } catch {
    return [rootPid];
  }

  const parents = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    const children = parents.get(parentPid) ?? [];
    children.push(pid);
    parents.set(parentPid, children);
  }

  const descendants: number[] = [];
  const queue = [rootPid];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (parentPid === undefined) continue;
    for (const childPid of parents.get(parentPid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      descendants.push(childPid);
      queue.push(childPid);
    }
  }
  return [rootPid, ...descendants.reverse()];
}

async function stopProcess(processInfo: PostgresProcess): Promise<boolean> {
  if (!isRunning(processInfo.pid)) return true;
  const processTree = await listProcessTree(processInfo.pid);
  for (const pid of processTree) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (await waitForExit(processInfo.pid, 5_000)) return true;

  for (const pid of processTree) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return waitForExit(processInfo.pid, 2_000);
}

async function cleanupOwnedPostgres(): Promise<void> {
  const processes = await listOwnedPostgresProcesses();
  const results = await Promise.allSettled(processes.map(stopProcess));
  const stopped = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const survivors = results.length - stopped;
  if (stopped > 0) {
    console.log(`Stopped ${stopped} orphaned test PostgreSQL process(es).`);
  }
  if (survivors > 0) {
    throw new Error(`Could not stop ${survivors} test PostgreSQL process(es) during Vitest teardown.`);
  }

  const remaining = await listOwnedPostgresProcesses();
  if (remaining.length > 0) {
    throw new Error(
      `Vitest teardown left ${remaining.length} owned PostgreSQL process(es) running: ${remaining.map(({ pid, dataDirectory }) => `${pid} (${dataDirectory})`).join(", ")}`,
    );
  }

  const { removedIds, skippedIds } = await cleanupStaleSysvSharedMemorySegments();
  if (removedIds.length > 0) {
    console.log(`Removed ${removedIds.length} stale SysV shared-memory segment(s) after Vitest teardown.`);
  }
  if (skippedIds.length > 0) {
    throw new Error(`Could not remove ${skippedIds.length} stale SysV shared-memory segment(s) after Vitest teardown.`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const token = `${process.pid}-${randomUUID()}`;
  await withRegistryLock(async () => {
    const runs = await readRuns();
    if (runs.length === 0) await cleanupOwnedPostgres();
    runs.push({ token, pid: process.pid });
    await writeRuns(runs);
  });

  return async () => {
    await withRegistryLock(async () => {
      const runs = (await readRuns()).filter((run) => run.token !== token);
      await writeRuns(runs);
      if (runs.length === 0) await cleanupOwnedPostgres();
    });
  };
}
