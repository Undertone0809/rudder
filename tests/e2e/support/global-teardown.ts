import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2E_INSTANCE_ROOT,
  E2E_LOCK_PATH,
  E2E_ROOT,
  E2E_RUNTIME_DESCRIPTOR_PATH,
  E2E_SERVER_PID_PATH,
} from "./e2e-env";
import { cleanupE2EPostgres, stopOwnedE2EServer } from "./e2e-postgres-cleanup";

const CLEANUP_EXISTING_SERVER = process.env.RUDDER_E2E_CLEANUP_EXISTING_SERVER === "1";
const USE_EXISTING_SERVER = process.env.RUDDER_E2E_USE_EXISTING_SERVER === "1";
const SHOULD_CLEANUP = !USE_EXISTING_SERVER || CLEANUP_EXISTING_SERVER;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function removeExitedE2ELock(): Promise<void> {
  const ownerPidPath = path.join(E2E_LOCK_PATH, "pid");
  let rawOwnerPid: string;
  try {
    rawOwnerPid = await fs.readFile(ownerPidPath, "utf8");
  } catch {
    return;
  }
  const ownerPid = Number(rawOwnerPid.trim());
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return;
  try {
    process.kill(ownerPid, 0);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
  }
  await fs.rm(E2E_LOCK_PATH, { force: true, recursive: true }).catch(() => undefined);
}

export default async function globalTeardown(): Promise<void> {
  if (!SHOULD_CLEANUP) return;

  const failures: string[] = [];
  let stoppedServers: string[] = [];
  try {
    stoppedServers = await stopOwnedE2EServer({
      instanceRoot: E2E_INSTANCE_ROOT,
      repositoryRoot: REPOSITORY_ROOT,
    });
  } catch (error) {
    failures.push(`server cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await cleanupE2EPostgres({
    e2eRoot: E2E_ROOT,
    currentInstanceRoot: E2E_INSTANCE_ROOT,
    repositoryRoot: REPOSITORY_ROOT,
    includeStaleInstances: false,
    includeCurrentInstance: true,
  }).catch((error) => {
    failures.push(`PostgreSQL cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (stoppedServers.length > 0) console.log(`Stopped E2E server process(es): ${stoppedServers.join(", ")}.`);
  if (result?.stopped) console.log(`Stopped ${result.stopped} E2E PostgreSQL process(es) after tests.`);
  if (result?.skipped.length) {
    failures.push(`could not stop E2E PostgreSQL process(es): ${result.skipped.join("; ")}`);
  }
  if (result?.sharedMemory.removedIds.length) {
    console.log(`Removed ${result.sharedMemory.removedIds.length} stale SysV shared-memory segment(s) after E2E teardown.`);
  }
  if (result?.sharedMemory.skippedIds.length) {
    failures.push(
      `could not remove ${result.sharedMemory.skippedIds.length} stale SysV shared-memory segment(s) after E2E teardown`,
    );
  }
  if (failures.length === 0) {
    await fs.rm(E2E_RUNTIME_DESCRIPTOR_PATH, { force: true });
    await fs.rm(E2E_SERVER_PID_PATH, { force: true });
    await removeExitedE2ELock();
  }
  if (failures.length > 0) {
    throw new Error(`E2E teardown incomplete; ownership receipts were preserved: ${failures.join("; ")}`);
  }
}
