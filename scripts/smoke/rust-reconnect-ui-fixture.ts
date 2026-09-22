import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// A real disposable UI/API/Actix/database runtime for reconnect acceptance.
// SIGTERM/SIGINT stops only this fixture and removes only its temporary data.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const expectedUi = await readFile(path.join(repoRoot, "ui/dist/index.html"), "utf8");
try {
  const preferredUi = await readFile(path.join(repoRoot, "server/ui-dist/index.html"), "utf8");
  assert.equal(preferredUi, expectedUi, "server/ui-dist must match the current ui/dist build before acceptance");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
// Vitest's orphan-Postgres sweeper reserves the rudder-* temp prefix. This
// independently owned long-lived fixture must not be swept between suites.
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codex-rust-reconnect-ui-"));
const port = await availablePort();
Object.assign(process.env, {
  DATABASE_URL: "",
  RUDDER_HOME: fixtureRoot,
  RUDDER_INSTANCE_ID: `rust-reconnect-ui-${process.pid}`,
  RUDDER_AGENT_JWT_SECRET: `disposable-reconnect-${process.pid}-${Date.now()}`,
  RUDDER_EMBEDDED_POSTGRES_PORT: String(await availablePort()),
  RUDDER_MIGRATION_AUTO_APPLY: "true",
  RUDDER_MIGRATION_PROMPT: "never",
  RUDDER_NATIVE_MODE: "required",
  RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: path.join(repoRoot, "native/target/debug/migration-preflight"),
  RUDDER_SERVER_FOUNDATION_PATH: path.join(repoRoot, "native/target/debug/rudder-server-foundation"),
  RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: `disposable-envelope-${process.pid}-${Date.now()}`,
  RUDDER_DEPLOYMENT_MODE: "local_trusted",
  RUDDER_RUST_ORGANIZATION_BRANDING_MODE: "required",
  RUDDER_RUST_PROJECT_GOAL_SET_MODE: "off",
  RUDDER_OPEN_ON_LISTEN: "false",
});
const { startServer } = await import("../../server/src/index.js");
const start = () => startServer({
  runtimeOwnerKind: "server", openOnListen: false, printBanner: false,
  runtimeOverrides: {
    host: "127.0.0.1", port, serveUi: true, uiDevMiddleware: false,
    heartbeatSchedulerEnabled: false, databaseBackupEnabled: false,
  },
});
let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  runtime = await start();
  const create = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${runtime!.apiUrl}/api${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json() as Record<string, string>;
    assert.equal(response.status, 201, JSON.stringify(result));
    return result;
  };
  const org = await create("/orgs", { name: "Rust reconnect acceptance", issuePrefix: "RCU" });
  const goalA = await create(`/orgs/${org.id}/goals`, { title: "Original persisted goal" });
  const goalB = await create(`/orgs/${org.id}/goals`, { title: "Reconnected persisted goal" });
  const project = await create(`/orgs/${org.id}/projects`, { name: "Reconnect goal project", goalIds: [goalA.id] });
  await runtime.dispose();
  runtime = undefined;
  process.env.RUDDER_RUST_PROJECT_GOAL_SET_MODE = "required";
  process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = project.id;
  runtime = await start();
  console.log(JSON.stringify({ marker: "RUST_RECONNECT_UI_READY", apiUrl: runtime.apiUrl, fixtureRoot, pid: process.pid, org, project, goalA, goalB }));
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
} finally {
  await runtime?.dispose();
  await rm(fixtureRoot, { recursive: true, force: true });
}
