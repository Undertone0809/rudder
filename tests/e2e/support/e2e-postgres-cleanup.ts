import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cleanupStaleSysvSharedMemorySegments } from "../../../packages/db/src/embedded-postgres-recovery.js";

const execFileAsync = promisify(execFile);

type ProcessInfo = {
  pid: number;
  parentPid: number;
  command: string;
};

type ServerLease = {
  pid: number;
  configPath: string;
  instanceRoot: string;
  port: number;
};

export type E2EPostgresCleanupResult = {
  stopped: number;
  skipped: string[];
  sharedMemory: { removedIds: number[]; skippedIds: number[] };
};

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(filePath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = Number(raw.trim());
    const pid = Number.isInteger(parsed)
      ? parsed
      : Number((JSON.parse(raw) as { pid?: unknown }).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readServerLease(
  filePath: string,
  expectedInstanceRoot: string,
  expectedConfigPath: string,
  expectedPort: number | null,
): Promise<ServerLease | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (typeof record.instanceRoot !== "string" || path.resolve(record.instanceRoot) !== path.resolve(expectedInstanceRoot)) {
      return null;
    }
    if (typeof record.configPath !== "string" || path.resolve(record.configPath) !== path.resolve(expectedConfigPath)) {
      return null;
    }
    const leasePort = Number(record.port);
    if (expectedPort === null || !Number.isInteger(leasePort) || leasePort !== expectedPort) return null;
    return {
      pid,
      configPath: path.resolve(record.configPath),
      instanceRoot: path.resolve(record.instanceRoot),
      port: leasePort,
    };
  } catch {
    return null;
  }
}

async function commandLine(pid: number): Promise<string> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeout: 2_000 });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function listeningPids(port: number): Promise<number[]> {
  try {
    const result = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 2_000 });
    return result.stdout
      .split(/\r?\n/)
      .map((value) => Number(value.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function listProcesses(): Promise<ProcessInfo[] | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { timeout: 2_000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
      .flatMap((match) => {
        if (!match) return [];
        const pid = Number(match[1]);
        const parentPid = Number(match[2]);
        return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0
          ? [{ pid, parentPid, command: match[3] }]
          : [];
      });
  } catch {
    return null;
  }
}

function postgresDataDirectory(command: string): string | null {
  if (!/(?:^|\s)(?:\S+\/)?postgres(?:\s|$)/.test(command)) return null;
  return command.match(/\s-D\s+(\S+)/)?.[1] ?? null;
}

function commandOwnsPostgresData(command: string, dataDirectory: string): boolean {
  const commandDataDirectory = postgresDataDirectory(command);
  return commandDataDirectory === dataDirectory;
}

function commandOwnsServer(command: string, repositoryRoot: string): boolean {
  const serverDirectory = path.resolve(repositoryRoot, "server");
  const serverPathPrefix = `${serverDirectory}${path.sep}`;
  const tokens = command.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""));
  return tokens.some((token) => token === serverDirectory || token.startsWith(serverPathPrefix))
    || command.split(/\s+/).some((token, index, all) => token === serverDirectory && all[index - 1] === "--dir");
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isRunning(pid);
}

async function processTree(rootPid: number, processes: ProcessInfo[]): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const processInfo of processes) {
    const siblings = children.get(processInfo.parentPid) ?? [];
    siblings.push(processInfo.pid);
    children.set(processInfo.parentPid, siblings);
  }

  const result: number[] = [];
  const queue = [rootPid];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (parentPid === undefined) continue;
    for (const childPid of children.get(parentPid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      result.push(childPid);
      queue.push(childPid);
    }
  }
  return [rootPid, ...result.reverse()];
}

async function signalMatchingProcesses(
  pids: number[],
  processes: ProcessInfo[],
  signal: NodeJS.Signals,
  rootMatcher?: (command: string) => boolean,
): Promise<void> {
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  for (const pid of pids) {
    const expected = byPid.get(pid);
    if (!expected) continue;
    const currentCommand = await commandLine(pid);
    const matchesExpectedCommand = currentCommand === expected.command;
    const matchesRootOwnership = pid === pids[0] && rootMatcher?.(currentCommand) === true;
    if (!currentCommand || (!matchesExpectedCommand && !matchesRootOwnership)) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function stopProcess(
  pid: number,
  processes: ProcessInfo[],
  rootMatcher?: (command: string) => boolean,
): Promise<boolean> {
  if (!isRunning(pid)) return true;
  const pids = await processTree(pid, processes);
  await signalMatchingProcesses(pids, processes, "SIGTERM", rootMatcher);
  if (await waitForExit(pid, 5_000)) return true;
  await signalMatchingProcesses(pids, processes, "SIGKILL", rootMatcher);
  return waitForExit(pid, 2_000);
}

async function databaseDirectories(e2eRoot: string, currentInstanceRoot: string): Promise<string[]> {
  const candidates = new Set<string>([path.join(currentInstanceRoot, "db")]);
  const tempRoot = path.join(e2eRoot, ".tmp");
  try {
    const homes = await fs.readdir(tempRoot, { withFileTypes: true });
    for (const home of homes) {
      if (!home.isDirectory() || !home.name.startsWith("rudder-e2e-home-")) continue;
      const instancesRoot = path.join(tempRoot, home.name, "instances");
      const instances = await fs.readdir(instancesRoot, { withFileTypes: true }).catch(() => []);
      for (const instance of instances) {
        if (instance.isDirectory()) candidates.add(path.join(instancesRoot, instance.name, "db"));
      }
    }
  } catch {
    // A missing E2E temp root is a clean state.
  }
  return [...candidates].map((directory) => path.resolve(directory));
}

async function worktreeE2ERoots(repositoryRoot: string, currentE2ERoot: string): Promise<string[]> {
  const roots = new Set<string>([currentE2ERoot]);
  try {
    const { stdout } = await execFileAsync("git", ["-C", repositoryRoot, "worktree", "list", "--porcelain"], {
      timeout: 2_000,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const worktree = line.match(/^worktree (.+)$/)?.[1]?.trim();
      if (worktree) roots.add(path.join(worktree, "tests", "e2e"));
    }
  } catch {
    // The current E2E root is still safe to clean when git is unavailable.
  }
  return [...roots];
}

function repositoryRootForInstance(instanceRoot: string, fallback: string): string {
  const marker = `${path.sep}tests${path.sep}e2e${path.sep}.tmp${path.sep}`;
  const markerIndex = path.resolve(instanceRoot).indexOf(marker);
  return markerIndex >= 0 ? path.resolve(instanceRoot).slice(0, markerIndex) : fallback;
}

function hasServerAncestor(
  pid: number,
  processes: ProcessInfo[],
  repositoryRoot: string,
): boolean {
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const visited = new Set<number>();
  let current = byPid.get(pid);
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    if (commandOwnsServer(current.command, repositoryRoot)) return true;
    current = byPid.get(current.parentPid);
  }
  return false;
}

async function instanceHasLiveServer(
  instanceRoot: string,
  repositoryRoot: string,
  processes?: ProcessInfo[],
): Promise<boolean> {
  const processSnapshot = processes ?? await listProcesses();
  if (!processSnapshot) return true;
  const instanceRepositoryRoot = repositoryRootForInstance(instanceRoot, repositoryRoot);
  const configPath = path.join(instanceRoot, "config.json");
  let port: number | null = null;
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { server?: { port?: unknown } };
    const parsedPort = Number(config.server?.port);
    port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null;
  } catch {
    // A missing config cannot identify an E2E server by port.
  }
  const pids = [
    await readServerLease(path.join(instanceRoot, "server.pid"), instanceRoot, configPath, port)
      .then((lease) => lease?.pid ?? null),
    await readPid(path.join(instanceRoot, "runtime", "server.json")),
    ...(port === null ? [] : await listeningPids(port)),
  ].filter((pid): pid is number => pid !== null && isRunning(pid));
  for (const pid of new Set(pids)) {
    const command = await commandLine(pid);
    if (commandOwnsServer(command, instanceRepositoryRoot)) return true;
  }

  const dataDirectory = path.join(instanceRoot, "db");
  for (const processInfo of processSnapshot) {
    if (commandOwnsPostgresData(processInfo.command, dataDirectory)
      && hasServerAncestor(processInfo.pid, processSnapshot, instanceRepositoryRoot)) {
      return true;
    }
  }
  return false;
}

async function cleanupDatabase(dataDirectory: string): Promise<{ stopped: number; skipped: string | null }> {
  const processes = await listProcesses();
  if (!processes) {
    return { stopped: 0, skipped: `${dataDirectory}: process listing unavailable; cleanup skipped` };
  }
  const owned = processes.filter((processInfo) => commandOwnsPostgresData(processInfo.command, dataDirectory));
  if (owned.length === 0) {
    await fs.rm(path.join(dataDirectory, "postmaster.pid"), { force: true }).catch(() => undefined);
    return { stopped: 0, skipped: null };
  }

  const roots = owned.filter((processInfo) => processInfo.command.includes(" -D "));
  const targets = roots.length > 0 ? roots : owned;
  const results = await Promise.allSettled(targets.map((processInfo) => stopProcess(processInfo.pid, processes)));
  const stopped = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const remainingProcesses = await listProcesses();
  if (!remainingProcesses) {
    return { stopped, skipped: `${dataDirectory}: final process listing unavailable; cleanup not confirmed` };
  }
  const remaining = remainingProcesses.filter((processInfo) => commandOwnsPostgresData(processInfo.command, dataDirectory));
  if (remaining.length > 0) {
    return {
      stopped,
      skipped: `${dataDirectory}: ${remaining.map((processInfo) => processInfo.pid).join(", ")}`,
    };
  }
  await fs.rm(path.join(dataDirectory, "postmaster.pid"), { force: true }).catch(() => undefined);
  return { stopped, skipped: null };
}

export async function cleanupE2EPostgres(options: {
  e2eRoot: string;
  currentInstanceRoot: string;
  repositoryRoot: string;
  includeStaleInstances: boolean;
  includeCurrentInstance: boolean;
  e2eRoots?: string[];
}): Promise<E2EPostgresCleanupResult> {
  const currentDb = path.resolve(path.join(options.currentInstanceRoot, "db"));
  const roots = options.e2eRoots ?? await worktreeE2ERoots(options.repositoryRoot, options.e2eRoot);
  const allDirectories = options.includeStaleInstances
    ? (await Promise.all(roots.map((e2eRoot) => databaseDirectories(e2eRoot, options.currentInstanceRoot)))
      ).flat()
    : [currentDb];
  const directories = options.includeCurrentInstance
    ? [...new Set(allDirectories)]
    : [...new Set(allDirectories)].filter((dataDirectory) => dataDirectory !== currentDb);
  const initialProcesses = await listProcesses();
  if (!initialProcesses) {
    return {
      stopped: 0,
      skipped: ["process listing unavailable; E2E PostgreSQL cleanup skipped"],
      sharedMemory: await cleanupStaleSysvSharedMemorySegments(),
    };
  }
  let stopped = 0;
  const skipped: string[] = [];
  for (const dataDirectory of directories) {
    const instanceRoot = path.dirname(dataDirectory);
    const hasPostgres = initialProcesses.some((processInfo) => commandOwnsPostgresData(processInfo.command, dataDirectory));
    if (!hasPostgres) {
      const result = await cleanupDatabase(dataDirectory);
      if (result.skipped) skipped.push(result.skipped);
      continue;
    }
    if (await instanceHasLiveServer(instanceRoot, options.repositoryRoot, initialProcesses)) {
      if (dataDirectory === currentDb) {
        skipped.push(`${dataDirectory}: active or unidentified E2E server; cleanup skipped`);
      }
      continue;
    }
    const result = await cleanupDatabase(dataDirectory);
    stopped += result.stopped;
    if (result.skipped) skipped.push(result.skipped);
  }

  const sharedMemory = await cleanupStaleSysvSharedMemorySegments();
  return { stopped, skipped, sharedMemory };
}

export async function stopOwnedE2EServer(options: {
  instanceRoot: string;
  repositoryRoot: string;
}): Promise<string[]> {
  const configPath = path.join(options.instanceRoot, "config.json");
  let port: number | null = null;
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { server?: { port?: unknown } };
    const parsedPort = Number(config.server?.port);
    port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null;
  } catch {
    // A missing config cannot identify a server by its listening port.
  }
  // Playwright can terminate the webServer wrapper before global teardown runs;
  // retain the runtime and port candidates so owned child servers are still reclaimed.
  const candidatePids = [
    await readServerLease(path.join(options.instanceRoot, "server.pid"), options.instanceRoot, configPath, port)
      .then((lease) => lease?.pid ?? null),
    await readPid(path.join(options.instanceRoot, "runtime", "server.json")),
    ...(port === null ? [] : await listeningPids(port)),
  ].filter((pid): pid is number => pid !== null && isRunning(pid));
  const processes = await listProcesses();
  if (!processes) throw new Error("E2E server cleanup could not list processes");
  const stopped: string[] = [];
  for (const pid of new Set(candidatePids)) {
    const command = processes.find((processInfo) => processInfo.pid === pid)?.command ?? await commandLine(pid);
    if (!commandOwnsServer(command, options.repositoryRoot)) continue;
    if (await stopProcess(pid, processes, (currentCommand) => commandOwnsServer(currentCommand, options.repositoryRoot))) {
      stopped.push(String(pid));
    }
  }
  for (const pid of new Set(candidatePids)) {
    if (!isRunning(pid)) continue;
    const command = await commandLine(pid);
    if (commandOwnsServer(command, options.repositoryRoot)) {
      throw new Error(`E2E server process ${pid} remained after cleanup`);
    }
  }
  if (await instanceHasLiveServer(options.instanceRoot, options.repositoryRoot)) {
    throw new Error(`E2E server for ${options.instanceRoot} remained after cleanup`);
  }
  return stopped;
}
