import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "rudder-company-cli-db-"));
  const port = await getAvailablePort();
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const { applyPendingMigrations, ensurePostgresDatabase } = await import("@rudderhq/db");
  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);

  return { connectionString, dataDir, instance };
}

function writeTestConfig(configPath: string, tempRoot: string, port: number, connectionString: string) {
  const config = {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "doctor" },
    database: { mode: "postgres", connectionString, embeddedPostgresDataDir: path.join(tempRoot, "embedded-db"), embeddedPostgresPort: 54329, backup: { enabled: false, intervalMinutes: 60, retentionDays: 30, dir: path.join(tempRoot, "backups") } },
    logging: { mode: "file", logDir: path.join(tempRoot, "logs") },
    server: { deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1", port, allowedHostnames: [], serveUi: false },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: { provider: "local_disk", localDisk: { baseDir: path.join(tempRoot, "storage") }, s3: { bucket: "rudder", region: "us-east-1", prefix: "", forcePathStyle: false } },
    secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(tempRoot, "secrets", "master.key") } },
  };
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function createServerEnv(configPath: string, port: number, connectionString: string, instanceId: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RUDDER_")) delete env[key];
  }
  delete env.DATABASE_URL; delete env.PORT; delete env.HOST; delete env.SERVE_UI; delete env.HEARTBEAT_SCHEDULER_ENABLED;
  env.RUDDER_CONFIG = configPath;
  env.RUDDER_INSTANCE_ID = instanceId;
  env.DATABASE_URL = connectionString;
  env.HOST = "127.0.0.1";
  env.PORT = String(port);
  env.SERVE_UI = "false";
  env.RUDDER_DB_BACKUP_ENABLED = "false";
  env.HEARTBEAT_SCHEDULER_ENABLED = "false";
  env.RUDDER_MIGRATION_AUTO_APPLY = "true";
  env.RUDDER_UI_DEV_MIDDLEWARE = "false";
  return env;
}

async function main() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-org-cli-e2e-"));
  const configPath = path.join(tempRoot, "config", "config.json");
  const instanceId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const db = await startTempDatabase();
  const port = await getAvailablePort();
  writeTestConfig(configPath, tempRoot, port, db.connectionString);
  const apiBase = `http://127.0.0.1:${port}`;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(
    process.execPath,
    ["cli/node_modules/tsx/dist/cli.mjs", "cli/src/index.ts", "run", "--config", configPath],
    { cwd: repoRoot, env: createServerEnv(configPath, port, db.connectionString, instanceId), stdio: ["ignore", "pipe", "pipe"] }
  );

  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  // Wait for health
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) throw new Error("Server exited early");
    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  // Create org
  const orgRes = await fetch(`${apiBase}/api/orgs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `CLI Export Source ${Date.now()}` }) });
  const org = await orgRes.json();
  console.log("ORG:", org);

  // Create agent
  const agentRes = await fetch(`${apiBase}/api/orgs/${org.id}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Export Engineer", role: "engineer", agentRuntimeType: "claude_local", agentRuntimeConfig: { promptTemplate: "You verify organization portability." } }),
  });
  const agentText = await agentRes.text();
  console.log("AGENT STATUS:", agentRes.status, "BODY:", agentText);

  child.kill("SIGTERM");
  await db.instance.stop();
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(db.dataDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
