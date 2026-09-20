import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const childScript = path.join(repoRoot, "scripts/smoke/server-runtime-lifecycle-child.ts");
const binaryName = process.platform === "win32" ? "migration-preflight.exe" : "migration-preflight";
const migrationPreflightBinary = path.join(repoRoot, "native", "target", "debug", binaryName);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";

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
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  const { port } = address;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function buildMigrationPreflight() {
  const result = await run(cargo, [
    "build",
    "--locked",
    "--manifest-path",
    path.join(repoRoot, "native/Cargo.toml"),
    "--package",
    "rudder-migration-service",
    "--bin",
    "migration-preflight",
  ]);
  assert.equal(result.code, 0, `migration-preflight build failed:\n${result.stderr}`);
  assert.equal(result.signal, null, "migration-preflight build was signalled");
  await access(migrationPreflightBinary);
}

async function main() {
  await buildMigrationPreflight();
  const rudderHome = await mkdtemp(path.join(tmpdir(), "rudder-migration-preflight-startup."));
  const apiPort = await getFreePort();
  const databasePort = await getFreePort();

  try {
    const result = await run(pnpm, ["--filter", "@rudderhq/server", "exec", "tsx", childScript], {
      env: {
        ...process.env,
        DATABASE_URL: "",
        RUDDER_HOME: rudderHome,
        RUDDER_INSTANCE_ID: "migration-preflight-startup",
        RUDDER_AGENT_JWT_SECRET: "migration-preflight-startup-jwt-secret",
        RUDDER_EMBEDDED_POSTGRES_PORT: String(databasePort),
        RUDDER_LIFECYCLE_API_PORT: String(apiPort),
        RUDDER_MIGRATION_AUTO_APPLY: "true",
        RUDDER_MIGRATION_PROMPT: "never",
        RUDDER_NATIVE_MODE: "required",
        RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: migrationPreflightBinary,
        RUDDER_OPEN_ON_LISTEN: "false",
      },
    });
    assert.equal(result.code, 0, `startup verifier failed:\n${result.stderr}`);
    assert.equal(result.signal, null, "startup verifier was signalled");
    assert.match(result.stdout, /Rust migration preflight completed before Node migration inspection/);
    assert.match(result.stdout, /"status":"bootstrap"/);
    assert.match(result.stdout, /"status":"current"/);
    assert.match(result.stdout, /SERVER_RUNTIME_LIFECYCLE_OK/);
    console.log("PASS migration-preflight real server startup verifier");
  } finally {
    await rm(rudderHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
