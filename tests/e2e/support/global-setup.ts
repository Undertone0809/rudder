import { fileURLToPath } from "node:url";
import {
  E2E_INSTANCE_ROOT,
  E2E_ROOT,
} from "./e2e-env";
import { cleanupE2EPostgres } from "./e2e-postgres-cleanup";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default async function globalSetup(): Promise<void> {
  const result = await cleanupE2EPostgres({
    e2eRoot: E2E_ROOT,
    currentInstanceRoot: E2E_INSTANCE_ROOT,
    repositoryRoot: REPOSITORY_ROOT,
    includeStaleInstances: true,
    includeCurrentInstance: false,
  });
  if (result.stopped > 0) {
    console.log(`Stopped ${result.stopped} orphaned E2E PostgreSQL process(es) before starting tests.`);
  }
  if (result.skipped.length > 0) {
    console.warn(`Could not stop orphaned E2E PostgreSQL process(es): ${result.skipped.join("; ")}`);
  }
  if (result.sharedMemory.removedIds.length > 0) {
    console.log(`Removed ${result.sharedMemory.removedIds.length} stale SysV shared-memory segment(s) before E2E tests.`);
  }
}
