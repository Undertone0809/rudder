import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  E2E_BASE_URL,
  E2E_BIN_DIR,
  E2E_CONFIG_PATH,
  E2E_HOME,
  E2E_INSTANCE_ID,
  E2E_ROOT,
  E2E_SERVER_PID_PATH,
} from "./e2e-env";

const REPO_ROOT = path.resolve(E2E_ROOT, "../..");
let restartedServer: ChildProcess | null = null;

async function isHealthy() {
  try {
    const response = await fetch(`${E2E_BASE_URL}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(expected: boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for E2E server health=${expected}`);
}

function serverEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "HOST",
    "PORT",
    "RUDDER_API_URL",
    "RUDDER_EMBEDDED_POSTGRES_PORT",
    "RUDDER_LISTEN_HOST",
    "RUDDER_LISTEN_PORT",
    "RUDDER_LOCAL_ENV",
    "RUDDER_RUNTIME_OWNER_KIND",
  ]) delete environment[name];
  return {
    ...environment,
    PATH: `${E2E_BIN_DIR}:${environment.PATH ?? ""}`,
    RUDDER_HOME: E2E_HOME,
    RUDDER_CONFIG: E2E_CONFIG_PATH,
    RUDDER_INSTANCE_ID: E2E_INSTANCE_ID,
    RUDDER_LOCAL_ENV: "e2e",
    RUDDER_E2E_HOME: E2E_HOME,
    RUDDER_E2E_INSTANCE_ID: E2E_INSTANCE_ID,
    RUDDER_E2E_PORT: new URL(E2E_BASE_URL).port,
    RUDDER_E2E_BASE_URL: E2E_BASE_URL,
    RUDDER_FEISHU_APP_REGISTRATION_MOCK: "instant",
    RUDDER_FEISHU_LONG_CONNECTION_ENABLED: "false",
    RUDDER_UI_DEV_MIDDLEWARE: "true",
  };
}

export async function restartE2eServer() {
  const pid = Number((await fs.readFile(E2E_SERVER_PID_PATH, "utf8")).trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("E2E server PID file is invalid");
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForHealth(false, 30_000);

  restartedServer = spawn("pnpm", ["--filter", "@rudderhq/server", "dev"], {
    cwd: REPO_ROOT,
    env: serverEnvironment(),
    stdio: "ignore",
  });
  await fs.writeFile(E2E_SERVER_PID_PATH, String(restartedServer.pid), "utf8");
  await waitForHealth(true, 120_000);
}

export async function stopRestartedE2eServer() {
  const child = restartedServer;
  restartedServer = null;
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
