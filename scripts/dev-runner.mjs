#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import {
  readLocalRuntimeDescriptor,
  gracefullyStopRuntime,
  probeLocalRuntime,
  withRuntimeStartLock,
} from "../server/src/local-runtime.ts";
import { serverVersion } from "../server/src/version.ts";
import { resolveDevScriptEnvironment } from "./dev-local-env.mjs";
import { shouldTrackDevServerPath } from "./dev-runner-paths.mjs";

const mode = process.argv[2] === "watch" ? "watch" : "dev";
const cliArgs = process.argv.slice(3);
const scanIntervalMs = 1500;
const gracefulShutdownTimeoutMs = 10_000;
const startupReadyTimeoutMs = 30_000;
const changedPathSampleLimit = 5;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devServerStatusFilePath = path.join(repoRoot, ".rudder", "dev-server-status.json");

const watchedDirectories = [
  "cli",
  "scripts",
  "server",
  "packages/agent-runtimes",
  "packages/agent-runtime-utils",
  "packages/adapters",
  "packages/db",
  "packages/plugins/sdk",
  "packages/shared",
].map((relativePath) => path.join(repoRoot, relativePath));

const watchedFiles = [
  ".env",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
].map((relativePath) => path.join(repoRoot, relativePath));

const ignoredDirectoryNames = new Set([
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "ui-dist",
]);

const ignoredRelativePaths = new Set([
  ".rudder/dev-server-status.json",
]);

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
const forwardedArgs = [];

for (const arg of cliArgs) {
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}

const { env, localEnvName } = resolveDevScriptEnvironment({
  repoRoot,
  baseEnv: process.env,
  extraEnv: {
    RUDDER_RUNTIME_OWNER_KIND: "dev_runner",
  },
});

if (mode === "dev") {
  env.RUDDER_DEV_SERVER_STATUS_FILE = devServerStatusFilePath;
  env.RUDDER_UI_DEV_MIDDLEWARE ??= "true";
}

if (mode === "watch") {
  env.RUDDER_UI_DEV_MIDDLEWARE ??= "true";
  env.RUDDER_MIGRATION_PROMPT ??= "never";
  env.RUDDER_MIGRATION_AUTO_APPLY ??= "true";
}

if (tailscaleAuth) {
  env.RUDDER_DEPLOYMENT_MODE = "authenticated";
  env.RUDDER_DEPLOYMENT_EXPOSURE = "private";
  env.RUDDER_AUTH_BASE_URL_MODE = "auto";
  env.HOST = "0.0.0.0";
  console.log("[rudder] dev mode: authenticated/private (tailscale-friendly) on 0.0.0.0");
} else {
  console.log("[rudder] dev mode: local_trusted (default)");
}
console.log(
  `[rudder] local env: ${localEnvName} (instance=${env.RUDDER_INSTANCE_ID}, port=${env.PORT}, embedded-pg=${env.RUDDER_EMBEDDED_POSTGRES_PORT})`,
);

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let previousSnapshot = collectWatchedSnapshot();
let dirtyPaths = new Set();
let pendingMigrations = [];
let lastChangedAt = null;
let lastRestartAt = null;
let scanInFlight = false;
let shuttingDown = false;
let childExitWasExpected = false;
let child = null;
let childExitPromise = null;
let scanTimer = null;

function toError(error, context = "Dev runner command failed") {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

process.on("uncaughtException", (error) => {
  const err = toError(error, "Uncaught exception in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = toError(reason, "Unhandled promise rejection in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

function formatPendingMigrationSummary(migrations) {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

function exitForSignal(signal) {
  if (signal === "SIGINT") {
    process.exit(130);
  }
  if (signal === "SIGTERM") {
    process.exit(143);
  }
  process.exit(1);
}

function toRelativePath(absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function readSignature(absolutePath) {
  const stats = statSync(absolutePath);
  return `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
}

function addFileToSnapshot(snapshot, absolutePath) {
  const relativePath = toRelativePath(absolutePath);
  if (ignoredRelativePaths.has(relativePath)) return;
  if (!shouldTrackDevServerPath(relativePath)) return;
  snapshot.set(relativePath, readSignature(absolutePath));
}

function walkDirectory(snapshot, absoluteDirectory) {
  if (!existsSync(absoluteDirectory)) return;

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (ignoredDirectoryNames.has(entry.name)) continue;

    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(snapshot, absolutePath);
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      addFileToSnapshot(snapshot, absolutePath);
    }
  }
}

function collectWatchedSnapshot() {
  const snapshot = new Map();

  for (const absoluteDirectory of watchedDirectories) {
    walkDirectory(snapshot, absoluteDirectory);
  }
  for (const absoluteFile of watchedFiles) {
    if (!existsSync(absoluteFile)) continue;
    addFileToSnapshot(snapshot, absoluteFile);
  }

  return snapshot;
}

function diffSnapshots(previous, next) {
  const changed = new Set();

  for (const [relativePath, signature] of next) {
    if (previous.get(relativePath) !== signature) {
      changed.add(relativePath);
    }
  }
  for (const relativePath of previous.keys()) {
    if (!next.has(relativePath)) {
      changed.add(relativePath);
    }
  }

  return [...changed].sort();
}

function ensureDevStatusDirectory() {
  mkdirSync(path.dirname(devServerStatusFilePath), { recursive: true });
}

function writeDevServerStatus() {
  if (mode !== "dev") return;

  ensureDevStatusDirectory();
  const changedPaths = [...dirtyPaths].sort();
  writeFileSync(
    devServerStatusFilePath,
    `${JSON.stringify({
      dirty: changedPaths.length > 0 || pendingMigrations.length > 0,
      lastChangedAt,
      changedPathCount: changedPaths.length,
      changedPathsSample: changedPaths.slice(0, changedPathSampleLimit),
      envFileChanged: changedPaths.includes(".env"),
      pendingMigrations,
      lastRestartAt,
    }, null, 2)}\n`,
    "utf8",
  );
}

function clearDevServerStatus() {
  if (mode !== "dev") return;
  rmSync(devServerStatusFilePath, { force: true });
}

async function runPnpm(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const spawned = spawn(pnpmBin, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      shell: process.platform === "win32",
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    if (spawned.stdout) {
      spawned.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
      });
    }
    if (spawned.stderr) {
      spawned.stderr.on("data", (chunk) => {
        stderrBuffer += String(chunk);
      });
    }

    spawned.on("error", reject);
    spawned.on("exit", (code, signal) => {
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
      });
    });
  });
}

async function getMigrationStatusPayload() {
  const status = await runPnpm(
    ["--filter", "@rudderhq/db", "exec", "tsx", "src/migration-status.ts", "--json"],
    { env },
  );
  if (status.code !== 0) {
    process.stderr.write(
      status.stderr ||
        status.stdout ||
        `[rudder] Command failed with code ${status.code}: pnpm --filter @rudderhq/db exec tsx src/migration-status.ts --json\n`,
    );
    process.exit(status.code);
  }

  try {
    return JSON.parse(status.stdout.trim());
  } catch (error) {
    process.stderr.write(
      status.stderr ||
        status.stdout ||
        "[rudder] migration-status returned invalid JSON payload\n",
    );
    throw toError(error, "Unable to parse migration-status JSON output");
  }
}

async function refreshPendingMigrations() {
  const payload = await getMigrationStatusPayload();
  pendingMigrations =
    payload.status === "needsMigrations" && Array.isArray(payload.pendingMigrations)
      ? payload.pendingMigrations.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      : [];
  writeDevServerStatus();
  return payload;
}

async function maybePreflightMigrations(options = {}) {
  const interactive = options.interactive ?? mode === "watch";
  const autoApply = options.autoApply ?? env.RUDDER_MIGRATION_AUTO_APPLY === "true";
  const exitOnDecline = options.exitOnDecline ?? mode === "watch";

  const payload = await refreshPendingMigrations();
  if (payload.status !== "needsMigrations" || pendingMigrations.length === 0) {
    return;
  }

  let shouldApply = autoApply;

  if (!autoApply && interactive) {
    if (!stdin.isTTY || !stdout.isTTY) {
      shouldApply = true;
    } else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (
          await prompt.question(
            `Apply pending migrations (${formatPendingMigrationSummary(pendingMigrations)}) now? (y/N): `,
          )
        )
          .trim()
          .toLowerCase();
        shouldApply = answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    }
  }

  if (!shouldApply) {
    if (exitOnDecline) {
      process.stderr.write(
        `[rudder] Pending migrations detected (${formatPendingMigrationSummary(pendingMigrations)}). ` +
          "Refusing to start watch mode against a stale schema.\n",
      );
      process.exit(1);
    }
    return;
  }

  const migrate = spawn(pnpmBin, ["db:migrate"], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  const exit = await new Promise((resolve) => {
    migrate.on("exit", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
  if (exit.signal) {
    exitForSignal(exit.signal);
    return;
  }
  if (exit.code !== 0) {
    process.exit(exit.code);
  }

  await refreshPendingMigrations();
}

async function buildPluginSdk() {
  console.log("[rudder] building plugin sdk...");
  const result = await runPnpm(
    ["--filter", "@rudderhq/plugin-sdk", "build"],
    { stdio: "inherit" },
  );
  if (result.signal) {
    exitForSignal(result.signal);
    return;
  }
  if (result.code !== 0) {
    console.error("[rudder] plugin sdk build failed");
    process.exit(result.code);
  }
}

async function markChildAsCurrent() {
  previousSnapshot = collectWatchedSnapshot();
  dirtyPaths = new Set();
  lastChangedAt = null;
  lastRestartAt = new Date().toISOString();
  await refreshPendingMigrations();
}

async function scanForBackendChanges() {
  if (mode !== "dev" || scanInFlight) return;
  scanInFlight = true;
  try {
    const nextSnapshot = collectWatchedSnapshot();
    const changed = diffSnapshots(previousSnapshot, nextSnapshot);
    previousSnapshot = nextSnapshot;
    if (changed.length === 0) return;

    for (const relativePath of changed) {
      dirtyPaths.add(relativePath);
    }
    lastChangedAt = new Date().toISOString();
    await refreshPendingMigrations();
  } finally {
    scanInFlight = false;
  }
}

async function fetchHealthPayload(apiUrl) {
  const response = await fetch(`${String(apiUrl).replace(/\/+$/, "")}/api/health`);
  if (!response.ok) {
    throw new Error(`Health request failed (${response.status})`);
  }
  return await response.json();
}

async function getDevHealthPayload() {
  const descriptor = await readLocalRuntimeDescriptor(env.RUDDER_INSTANCE_ID);
  if (
    descriptor?.apiUrl
    && descriptor.ownerKind === "dev_runner"
    && descriptor.instanceId === env.RUDDER_INSTANCE_ID
    && descriptor.localEnv === env.RUDDER_LOCAL_ENV
  ) {
    try {
      const health = await fetchHealthPayload(descriptor.apiUrl);
      if (
        health?.status === "ok"
        && health?.instanceId === env.RUDDER_INSTANCE_ID
        && health?.localEnv === env.RUDDER_LOCAL_ENV
        && health?.runtimeOwnerKind === "dev_runner"
      ) {
        return health;
      }
    } catch {
      // The descriptor is written only after listen succeeds, but it can still
      // briefly point at a process that is shutting down during takeover.
    }
  }

  const serverPort = env.PORT ?? process.env.PORT ?? "3100";
  return await fetchHealthPayload(`http://127.0.0.1:${serverPort}`);
}

async function waitForChildHealthReady() {
  const deadline = Date.now() + startupReadyTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (!child) {
      throw new Error("Server child exited before becoming healthy.");
    }
    try {
      const health = await getDevHealthPayload();
      if (
        health?.status === "ok"
        && health?.instanceId === env.RUDDER_INSTANCE_ID
        && health?.localEnv === env.RUDDER_LOCAL_ENV
        && health?.runtimeOwnerKind === "dev_runner"
      ) {
        return;
      }
      lastError = new Error("Health payload did not match the expected dev runtime metadata yet.");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for ${env.RUDDER_LOCAL_ENV} runtime to become healthy. ` +
      `${lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown error")}`,
  );
}

async function waitForChildExit() {
  if (!childExitPromise) {
    return { code: 0, signal: null };
  }
  return await childExitPromise;
}

async function startServerChild() {
  await withRuntimeStartLock(
    {
      instanceId: env.RUDDER_INSTANCE_ID,
      ownerKind: "dev_runner",
      timeoutMs: gracefulShutdownTimeoutMs * 2,
    },
    async () => {
      const probe = await probeLocalRuntime({
        instanceId: env.RUDDER_INSTANCE_ID,
        localEnv: env.RUDDER_LOCAL_ENV,
        expectedVersion: serverVersion,
      });
      if (probe.kind === "healthy") {
        console.log(
          `[rudder] taking over ${env.RUDDER_LOCAL_ENV} runtime from ${probe.health.runtimeOwnerKind ?? probe.descriptor.ownerKind} ` +
            `at ${probe.descriptor.apiUrl}`,
        );
        const stopped = await gracefullyStopRuntime(probe.descriptor, gracefulShutdownTimeoutMs);
        if (!stopped) {
          throw new Error(
            `Unable to take over ${env.RUDDER_LOCAL_ENV} runtime. ` +
              `Existing pid ${probe.descriptor.pid} did not exit after SIGTERM.`,
          );
        }
      }

      await buildPluginSdk();

      const serverScript = mode === "watch" ? "dev:watch" : "dev";
      child = spawn(
        pnpmBin,
        ["--filter", "@rudderhq/server", serverScript, ...forwardedArgs],
        { stdio: "inherit", env, shell: process.platform === "win32" },
      );

      childExitPromise = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          const expected = childExitWasExpected;
          childExitWasExpected = false;
          child = null;
          childExitPromise = null;
          resolve({ code: code ?? 0, signal });

          if (expected || shuttingDown) {
            return;
          }
          if (signal) {
            exitForSignal(signal);
            return;
          }
          process.exit(code ?? 0);
        });
      });

      await waitForChildHealthReady();
    },
  );
  await markChildAsCurrent();
}

function installDevIntervals() {
  if (mode !== "dev") return;

  scanTimer = setInterval(() => {
    void scanForBackendChanges();
  }, scanIntervalMs);
}

function clearDevIntervals() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearDevIntervals();
  clearDevServerStatus();

  if (!child) {
    if (signal) {
      exitForSignal(signal);
      return;
    }
    process.exit(0);
  }

  childExitWasExpected = true;
  child.kill(signal);
  const exit = await waitForChildExit();
  if (exit.signal) {
    exitForSignal(exit.signal);
    return;
  }
  process.exit(exit.code ?? 0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await maybePreflightMigrations();
await startServerChild();
installDevIntervals();

if (mode === "watch") {
  const exit = await waitForChildExit();
  if (exit.signal) {
    exitForSignal(exit.signal);
  }
  process.exit(exit.code ?? 0);
}
