#!/usr/bin/env node
// Isolate configuration before Vitest imports any server module (logger/config
// have import-time effects). This runs only the API fixture, never Desktop/prod.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const file of [".env", "server/.env", ".rudder/.env"]) {
  if (existsSync(path.join(root, file))) throw new Error(`Run from an isolated checkout without ${file}`);
}
const suppliedBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH;
if (!suppliedBinary || !path.isAbsolute(suppliedBinary)) {
  throw new Error("Set RUDDER_SERVER_FOUNDATION_PATH to the exact freshly built candidate binary");
}
const binary = realpathSync(suppliedBinary);
const qaRoot = mkdtempSync(path.join(tmpdir(), "rudder-activity-read-qa-"));
const env = {
  ...process.env,
  RUDDER_ACTIVITY_READ_QA_ROOT: qaRoot,
  RUDDER_HOME: qaRoot,
  RUDDER_CONFIG: path.join(qaRoot, "config.json"),
  RUDDER_INSTANCE_ID: "activity-read-qa",
  RUDDER_LOCAL_ENV: "e2e",
  RUDDER_LOG_DIR: path.join(qaRoot, "logs"),
  RUN_LOG_BASE_PATH: path.join(qaRoot, "run-logs"),
  RUDDER_STORAGE_PROVIDER: "local_disk",
  RUDDER_STORAGE_LOCAL_DIR: path.join(qaRoot, "storage"),
  RUDDER_ORGANIZATION_WORKSPACE_HOME: path.join(qaRoot, "workspaces"),
  RUDDER_SERVER_FOUNDATION_PATH: binary,
};
delete env.DATABASE_URL;
const require = createRequire(import.meta.url);
const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
console.log(JSON.stringify({ qaRoot, binary, binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }));
const child = spawn(process.execPath, [vitest, "run", "--root", "server", "--config", "vitest.config.ts", "src/__tests__/activity-read-real-entry.test.ts"], { cwd: root, env, stdio: "inherit" });
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
// Keep the disposable root and its diagnostics for acceptance review.
