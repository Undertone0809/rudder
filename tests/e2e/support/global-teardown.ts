import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { cleanupStaleSysvSharedMemorySegments } from "../../../packages/db/src/embedded-postgres-recovery.js";
import {
  E2E_INSTANCE_ROOT,
  E2E_RUNTIME_DESCRIPTOR_PATH,
  E2E_SERVER_PID_PATH,
} from "./e2e-env";

const execFileAsync = promisify(execFile);
const CLEANUP_EXISTING_SERVER = process.env.RUDDER_E2E_CLEANUP_EXISTING_SERVER === "1";
const USE_EXISTING_SERVER = process.env.RUDDER_E2E_USE_EXISTING_SERVER === "1";
const SHOULD_CLEANUP = !USE_EXISTING_SERVER || CLEANUP_EXISTING_SERVER;

type RuntimeDescriptor = { pid?: unknown };

async function readPid(filePath: string): Promise<number | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as RuntimeDescriptor;
    return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
}

async function readPlainPid(filePath: string): Promise<number | null> {
  try {
    const pid = Number((await fs.readFile(filePath, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isRunning(pid);
}

async function commandLine(pid: number): Promise<string> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeout: 2_000 });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function stopProcess(pid: number, timeoutMs: number): Promise<void> {
  if (!isRunning(pid)) return;
  signal(pid, "SIGTERM");
  if (await waitForExit(pid, timeoutMs)) return;
  signal(pid, "SIGKILL");
  await waitForExit(pid, 2_000);
}

async function stopOwnedPostgres(): Promise<void> {
  const postmasterPath = `${E2E_INSTANCE_ROOT}/db/postmaster.pid`;
  const pid = await readPlainPid(postmasterPath);
  if (!pid || !isRunning(pid)) {
    await fs.rm(postmasterPath, { force: true }).catch(() => undefined);
    return;
  }

  const command = await commandLine(pid);
  if (!command.includes(`${E2E_INSTANCE_ROOT}/db`)) return;
  await stopProcess(pid, 5_000);
  await fs.rm(postmasterPath, { force: true }).catch(() => undefined);
}

export default async function globalTeardown(): Promise<void> {
  if (!SHOULD_CLEANUP) return;

  const runtimePid = await readPid(E2E_RUNTIME_DESCRIPTOR_PATH);
  const wrapperPid = await readPlainPid(E2E_SERVER_PID_PATH);
  const pids = [...new Set([runtimePid, wrapperPid].filter((pid): pid is number => pid !== null))];

  for (const pid of pids) await stopProcess(pid, 10_000);
  await stopOwnedPostgres();
  await cleanupStaleSysvSharedMemorySegments()
    .then(({ removedIds, skippedIds }) => {
      if (removedIds.length > 0) {
        console.log(`Removed ${removedIds.length} stale SysV shared-memory segment(s) after E2E teardown.`);
      }
      if (skippedIds.length > 0) {
        console.warn(`Could not remove ${skippedIds.length} stale SysV shared-memory segment(s) after E2E teardown.`);
      }
    })
    .catch((error) => {
      console.warn(
        `E2E SysV shared-memory cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  await fs.rm(E2E_RUNTIME_DESCRIPTOR_PATH, { force: true }).catch(() => undefined);
  await fs.rm(E2E_SERVER_PID_PATH, { force: true }).catch(() => undefined);
}
