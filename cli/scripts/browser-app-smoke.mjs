import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("[browser-app-smoke] skipped: Windows-only compatibility path");
  process.exit(0);
}

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(cliRoot, "dist", "index.js");
const { version } = JSON.parse(await readFile(path.join(cliRoot, "package.json"), "utf8"));
const testHome = await mkdtemp(path.join(tmpdir(), "rudder-browser-app-smoke."));
const postgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR?.trim()
  || path.join(process.env.USERPROFILE ?? "", ".rudder", "runtime-payloads", "postgres-18.4", "win32-x64", "bin");

assert.ok(existsSync(cliEntry), "build @rudderhq/cli before running browser-app smoke");
assert.ok(
  existsSync(path.join(postgresBinDir, "postgres.exe")),
  `prepared PostgreSQL 18.4 runtime is required at ${postgresBinDir}`,
);

const children = new Set();

async function waitForReady(readyFile, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return JSON.parse(await readFile(readyFile, "utf8"));
    } catch {
      await delay(200);
    }
  }
  throw new Error(`browser-app ready handoff timed out: ${readyFile}`);
}

function startBrowserApp(label) {
  const readyFile = path.join(testHome, `${label}.ready.json`);
  const child = spawn(process.execPath, [
    cliEntry,
    "--local-env",
    "e2e",
    "browser-app",
    "--child",
    "--no-open",
    "--ready-file",
    readyFile,
    "--runtime-version",
    version,
  ], {
    env: {
      ...process.env,
      RUDDER_HOME: testHome,
      RUDDER_POSTGRES_BIN_DIR: postgresBinDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return { child, readyFile, output: () => output };
}

function startBrowserAppParent() {
  const child = spawn(process.execPath, [
    cliEntry,
    "--local-env",
    "e2e",
    "browser-app",
    "--no-open",
    "--runtime-version",
    version,
  ], {
    env: {
      ...process.env,
      RUDDER_HOME: testHome,
      RUDDER_POSTGRES_BIN_DIR: postgresBinDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return { child, output: () => output };
}

async function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    // Windows does not deliver Node's synthetic SIGTERM reliably to a detached
    // process tree. Stop the exact smoke-owned tree so embedded PostgreSQL does
    // not outlive the test and retain a lock on the isolated database.
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, delay(timeoutMs)]);
  if (child.exitCode !== null) return;
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await Promise.race([exited, delay(5_000)]);
}

async function waitForNaturalExit(child, output, timeoutMs = 10_000) {
  if (child.exitCode === null) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`attached browser-app child did not exit naturally:\n${output()}`));
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  assert.equal(child.exitCode, 0, `attached browser-app child failed:\n${output()}`);
}

async function removeTestHomeWithRetry(attempts = 20) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(testHome, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError;
}

function stopEmbeddedPostgres() {
  const dataDir = path.join(testHome, "instances", "e2e", "db");
  const pgCtl = path.join(postgresBinDir, "pg_ctl.exe");
  if (!existsSync(path.join(dataDir, "postmaster.pid")) || !existsSync(pgCtl)) return;
  spawnSync(pgCtl, ["stop", "-D", dataDir, "-m", "immediate", "-w", "-t", "15"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  assert.ok(response.ok, `${init?.method ?? "GET"} ${url} failed (${response.status}): ${body}`);
  return body ? JSON.parse(body) : null;
}

try {
  console.log("[browser-app-smoke] starting isolated browser-app runtime");
  const first = startBrowserApp("first");
  const firstReady = await waitForReady(first.readyFile);
  assert.equal(firstReady.ok, true, firstReady.error ?? first.output());
  assert.equal(firstReady.runtimeMode, "owned");

  const health = await fetchJson(`${firstReady.boardUrl}/api/health`);
  assert.equal(health.status, "ok");
  assert.equal(health.instanceId, "e2e");
  assert.equal(health.localEnv, "e2e");
  assert.equal(health.runtimeOwnerKind, "cli");
  assert.equal(health.deploymentMode, "local_trusted");
  const runtimeCacheKey = health.version === version ? version : "latest";
  const installedRuntimePackage = JSON.parse(await readFile(path.join(
    testHome,
    "runtimes",
    runtimeCacheKey,
    "node_modules",
    "@rudderhq",
    "server",
    "package.json",
  ), "utf8"));
  assert.equal(health.version, installedRuntimePackage.version);
  if (health.version !== version) {
    console.log(
      `[browser-app-smoke] requested prepublish runtime ${version}; observed intentional latest fallback ${health.version}`,
    );
  }

  const page = await fetch(firstReady.boardUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id=["']root["']/u);

  const organizationName = `Browser App Smoke ${Date.now()}`;
  const organization = await fetchJson(`${firstReady.boardUrl}/api/orgs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: organizationName,
      issuePrefix: "BAS",
      description: "Windows browser-app compatibility smoke",
    }),
  });
  assert.equal(organization.name, organizationName);

  console.log("[browser-app-smoke] verifying second launch attaches without replacing the owner");
  const second = startBrowserAppParent();
  await waitForNaturalExit(second.child, second.output);
  assert.match(second.output(), /Rudder browser-app runtime is ready .+ \(attached\)/u);
  const ownerAfterSecondLaunch = await fetchJson(`${firstReady.boardUrl}/api/health`);
  assert.equal(ownerAfterSecondLaunch.runtimeOwnerKind, "cli");

  console.log("[browser-app-smoke] restarting the same local instance");
  await waitForExit(first.child);
  stopEmbeddedPostgres();
  const third = startBrowserApp("third");
  const thirdReady = await waitForReady(third.readyFile);
  assert.equal(thirdReady.ok, true, thirdReady.error ?? third.output());
  assert.equal(thirdReady.runtimeMode, "owned");
  const organizations = await fetchJson(`${thirdReady.boardUrl}/api/orgs`);
  assert.ok(
    organizations.some((candidate) => candidate.id === organization.id && candidate.name === organizationName),
    "browser-app restart must preserve the organization in the same isolated instance",
  );
  await waitForExit(third.child);
} finally {
  for (const child of children) await waitForExit(child);
  stopEmbeddedPostgres();
  await removeTestHomeWithRetry();
}
console.log("[browser-app-smoke] PASS");
