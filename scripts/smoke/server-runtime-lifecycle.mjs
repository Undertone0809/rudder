import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SUCCESS_MARKER = "SERVER_RUNTIME_LIFECYCLE_OK";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const { port } = address;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const rudderHome = await mkdtemp(path.join(tmpdir(), "rudder-runtime-lifecycle."));
const apiPort = await getFreePort();
const databasePort = await getFreePort();
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const childScript = path.join(scriptDir, "server-runtime-lifecycle-child.ts");
let stdout = "";
let stderr = "";
let timedOut = false;

try {
  const child = spawn(pnpm, ["--filter", "@rudderhq/server", "exec", "tsx", childScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: "",
      RUDDER_HOME: rudderHome,
      RUDDER_INSTANCE_ID: "runtime-lifecycle-smoke",
      RUDDER_AGENT_JWT_SECRET: "runtime-lifecycle-smoke-jwt-secret",
      RUDDER_EMBEDDED_POSTGRES_PORT: String(databasePort),
      RUDDER_LIFECYCLE_API_PORT: String(apiPort),
      RUDDER_MIGRATION_AUTO_APPLY: "true",
      RUDDER_MIGRATION_PROMPT: "never",
      RUDDER_OPEN_ON_LISTEN: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(text);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 90_000);

  const [code, signal] = await once(child, "exit");
  clearTimeout(timeout);

  if (timedOut) throw new Error("Server runtime lifecycle child timed out");
  if (code !== 0) {
    throw new Error(`Server runtime lifecycle child failed (code=${code}, signal=${signal})\n${stderr}`);
  }
  if (!stdout.includes(SUCCESS_MARKER)) {
    throw new Error("Server runtime lifecycle child exited without the success marker");
  }

  console.log("server-runtime-lifecycle: passed");
} finally {
  await rm(rudderHome, { recursive: true, force: true });
}
