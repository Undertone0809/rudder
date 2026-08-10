import { fileURLToPath } from "node:url";
import {
  E2E_INSTANCE_ROOT,
  E2E_ROOT,
} from "./e2e-env";
import { cleanupE2EPostgres, stopOwnedE2EServer } from "./e2e-postgres-cleanup";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const stoppedServers = await stopOwnedE2EServer({
  instanceRoot: E2E_INSTANCE_ROOT,
  repositoryRoot: REPOSITORY_ROOT,
});
const result = await cleanupE2EPostgres({
  e2eRoot: E2E_ROOT,
  currentInstanceRoot: E2E_INSTANCE_ROOT,
  repositoryRoot: REPOSITORY_ROOT,
  includeStaleInstances: true,
  includeCurrentInstance: true,
});

if (stoppedServers.length > 0) {
  console.log(`Stopped stale E2E server process(es): ${stoppedServers.join(", ")}.`);
}
if (result.stopped > 0) {
  console.log(`Stopped ${result.stopped} orphaned E2E PostgreSQL process(es) before starting tests.`);
}
if (result.skipped.length > 0) {
  throw new Error(`Could not stop orphaned E2E PostgreSQL process(es): ${result.skipped.join("; ")}`);
}
if (result.sharedMemory.skippedIds.length > 0) {
  throw new Error(
    `Could not remove stale SysV shared-memory segment(s) before E2E tests: ${result.sharedMemory.skippedIds.join(", ")}`,
  );
}
