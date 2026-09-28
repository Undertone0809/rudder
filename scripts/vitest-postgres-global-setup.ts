import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const execFile = promisify(execFileCallback);
const temporaryDirectory = path.resolve(os.tmpdir());

type PostgresProcess = {
  pid: number;
  parentPid: number;
  dataDirectory: string;
};

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function postgresDataDirectory(command: string, ownedRoot: string): string | null {
  if (!/(?:^|\s)(?:\S+\/)?postgres(?:\s|$)/.test(command)) return null;
  const match = command.match(/\s-D\s+(\S+)/);
  const dataDirectory = match?.[1];
  if (!dataDirectory || !dataDirectory.startsWith(`${ownedRoot}${path.sep}`)) return null;
  return dataDirectory;
}

async function listOwnedPostgresProcesses(ownedRoot: string): Promise<PostgresProcess[]> {
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
      const dataDirectory = postgresDataDirectory(match[3], ownedRoot);
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

async function cleanupOwnedPostgres(ownedRoot: string): Promise<void> {
  const processes = await listOwnedPostgresProcesses(ownedRoot);
  const results = await Promise.allSettled(processes.map(stopProcess));
  const stopped = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const survivors = results.length - stopped;
  if (stopped > 0) {
    console.log(`Stopped ${stopped} orphaned test PostgreSQL process(es).`);
  }
  if (survivors > 0) {
    throw new Error(`Could not stop ${survivors} test PostgreSQL process(es) during Vitest teardown.`);
  }

  const remaining = await listOwnedPostgresProcesses(ownedRoot);
  if (remaining.length > 0) {
    throw new Error(
      `Vitest teardown left ${remaining.length} owned PostgreSQL process(es) running: ${remaining.map(({ pid, dataDirectory }) => `${pid} (${dataDirectory})`).join(", ")}`,
    );
  }

}

export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  // Each project owns a fresh directory. A shared "rudder-*" prefix is not
  // ownership: concurrently running E2E, acceptance, and dev databases use it.
  const ownedRoot = await realpath(await mkdtemp(path.join(temporaryDirectory, "rudder-vitest-")));
  // Configure workers rather than mutating the coordinator's environment, so
  // parallel Vitest projects cannot inherit one another's temporary root.
  project.config.env = { ...project.config.env, TMPDIR: ownedRoot, TMP: ownedRoot, TEMP: ownedRoot };

  return async () => {
    await cleanupOwnedPostgres(ownedRoot);
    // Preserve test evidence and any remaining data. Only remove an empty root.
    await rmdir(ownedRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
    });
  };
}
