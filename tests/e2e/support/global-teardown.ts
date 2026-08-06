import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  E2E_INSTANCE_ROOT,
  E2E_ROOT,
  E2E_RUNTIME_DESCRIPTOR_PATH,
  E2E_SERVER_PID_PATH,
} from "./e2e-env";
import { cleanupE2EPostgres, stopOwnedE2EServer } from "./e2e-postgres-cleanup";

const CLEANUP_EXISTING_SERVER = process.env.RUDDER_E2E_CLEANUP_EXISTING_SERVER === "1";
const USE_EXISTING_SERVER = process.env.RUDDER_E2E_USE_EXISTING_SERVER === "1";
const SHOULD_CLEANUP = !USE_EXISTING_SERVER || CLEANUP_EXISTING_SERVER;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default async function globalTeardown(): Promise<void> {
  if (!SHOULD_CLEANUP) return;

  const stoppedServers = await stopOwnedE2EServer({
    instanceRoot: E2E_INSTANCE_ROOT,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const result = await cleanupE2EPostgres({
    e2eRoot: E2E_ROOT,
    currentInstanceRoot: E2E_INSTANCE_ROOT,
    repositoryRoot: REPOSITORY_ROOT,
    includeStaleInstances: false,
    includeCurrentInstance: true,
  }).catch((error) => {
    console.warn(`E2E PostgreSQL cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (stoppedServers.length > 0) console.log(`Stopped E2E server process(es): ${stoppedServers.join(", ")}.`);
  if (result?.stopped) console.log(`Stopped ${result.stopped} E2E PostgreSQL process(es) after tests.`);
  if (result?.skipped.length) console.warn(`Could not stop E2E PostgreSQL process(es): ${result.skipped.join("; ")}`);
  if (result?.sharedMemory.removedIds.length) {
    console.log(`Removed ${result.sharedMemory.removedIds.length} stale SysV shared-memory segment(s) after E2E teardown.`);
  }
  if (result?.sharedMemory.skippedIds.length) {
    console.warn(`Could not remove ${result.sharedMemory.skippedIds.length} stale SysV shared-memory segment(s) after E2E teardown.`);
  }
  await fs.rm(E2E_RUNTIME_DESCRIPTOR_PATH, { force: true }).catch(() => undefined);
  await fs.rm(E2E_SERVER_PID_PATH, { force: true }).catch(() => undefined);
}
