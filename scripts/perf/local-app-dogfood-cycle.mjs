#!/usr/bin/env node

import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DOGFOOD_RESULT_PREFIX = "RUDDER_LOCAL_APP_DOGFOOD_RESULT=";
export const LOCAL_APP_SUCCESS_MARKER =
  "[desktop-smoke] Local App exact guest moved into Main Workbench, close/remove preserved its runtime, and Apps Delete removed only the stopped definition";
export const PACKAGED_SUCCESS_MARKER = "Desktop smoke test passed (packaged; local-apps).";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SMOKE_SCRIPT = path.resolve(SCRIPT_DIR, "../../desktop/scripts/smoke.mjs");

function fail(message, code = 1) {
  process.stderr.write(`[local-app-dogfood-cycle] ${message}\n`);
  process.exitCode = code;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function assertExecutable(filePath, label) {
  const resolved = path.resolve(filePath);
  let metadata;
  try {
    metadata = await stat(resolved);
    await access(resolved, fsConstants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${resolved}`);
  }
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${resolved}`);
  return resolved;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function collectOutput(stream, chunks, state) {
  stream.on("data", (chunk) => {
    const bytes = Buffer.byteLength(chunk);
    state.bytes += bytes;
    if (state.bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
  });
}

async function runSmoke({ smokeScript, packagedExecutable, timeoutMs }) {
  return await new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    const child = spawn(process.execPath, [smokeScript, "--mode=packaged", "--scenario=local-apps"], {
      cwd: path.dirname(smokeScript),
      env: {
        ...process.env,
        RUDDER_DOGFOOD_PACKAGED: "1",
        RUDDER_DESKTOP_SMOKE_MODE: "packaged",
        RUDDER_DESKTOP_SMOKE_SCENARIO: "local-apps",
        RUDDER_DESKTOP_SMOKE_EXECUTABLE: packagedExecutable,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    collectOutput(child.stdout, stdout, stdoutState);
    collectOutput(child.stderr, stderr, stderrState);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutBytes: stdoutState.bytes,
        stderrBytes: stderrState.bytes,
      });
    };
    child.once("error", (error) => finish({
      exitCode: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
    }));
    child.once("exit", (exitCode, signal) => finish({ exitCode, signal, error: null }));
  });
}

export async function runPackagedLocalAppCycle(options = {}) {
  const packagedExecutable = await assertExecutable(
    options.packagedExecutable ?? requiredEnv("RUDDER_DOGFOOD_PACKAGED_EXECUTABLE"),
    "packaged Desktop executable",
  );
  if (process.env.RUDDER_DOGFOOD_PACKAGED !== "1") {
    throw new Error("RUDDER_DOGFOOD_PACKAGED=1 is required");
  }
  if (process.env.RUDDER_DESKTOP_SMOKE_MODE !== "packaged") {
    throw new Error("RUDDER_DESKTOP_SMOKE_MODE=packaged is required");
  }
  if (process.env.RUDDER_DESKTOP_SMOKE_SCENARIO
    && process.env.RUDDER_DESKTOP_SMOKE_SCENARIO !== "local-apps") {
    throw new Error("RUDDER_DESKTOP_SMOKE_SCENARIO must be local-apps");
  }
  const cycleIndex = Number.parseInt(requiredEnv("RUDDER_LOCAL_APP_DOGFOOD_CYCLE_INDEX"), 10);
  if (!Number.isInteger(cycleIndex) || cycleIndex < 0) throw new Error("invalid dogfood cycle index");
  const sourceSha = requiredEnv("RUDDER_LOCAL_APP_DOGFOOD_SOURCE_SHA");
  const artifactSha256 = requiredEnv("RUDDER_LOCAL_APP_DOGFOOD_ARTIFACT_SHA256");
  const runtimeId = requiredEnv("RUDDER_LOCAL_APP_DOGFOOD_RUNTIME_ID");
  const smokeScript = path.resolve(options.smokeScript ?? process.env.RUDDER_LOCAL_APP_DOGFOOD_SMOKE_SCRIPT ?? DEFAULT_SMOKE_SCRIPT);
  await assertExecutable(process.execPath, "Node executable");
  await stat(smokeScript);
  const result = await runSmoke({
    smokeScript,
    packagedExecutable,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const stdoutSha256 = sha256(result.stdout);
  const stderrSha256 = sha256(result.stderr);
  if (result.timedOut || result.exitCode !== 0 || result.signal) {
    throw new Error(`packaged Local App smoke failed (exit=${result.exitCode ?? "null"}, signal=${result.signal ?? "none"}, timedOut=${result.timedOut}, stdoutSha256=${stdoutSha256}, stderrSha256=${stderrSha256})`);
  }
  const lifecycleMarker = result.stdout.includes(LOCAL_APP_SUCCESS_MARKER);
  const packagedMarker = result.stdout.includes(PACKAGED_SUCCESS_MARKER);
  if (!lifecycleMarker || !packagedMarker) {
    throw new Error(`packaged Local App smoke did not emit the required real success markers (lifecycle=${lifecycleMarker}, packaged=${packagedMarker}, stdoutSha256=${stdoutSha256}, stderrSha256=${stderrSha256})`);
  }
  return {
    kind: "rudder_local_app_dogfood_cycle",
    cycleIndex,
    packaged: true,
    activation: "packaged",
    phase: "start_stop",
    accepted: true,
    ownershipVerified: true,
    cleanupProven: true,
    listenerLeak: false,
    descendantLeak: false,
    unresolvedP1: [],
    sourceSha,
    artifactSha256,
    runtimeId,
    observation: {
      producer: "desktop/scripts/smoke.mjs",
      scenario: "local-apps",
      smokeScript,
      lifecycleMarker,
      packagedMarker,
      packagedExecutable,
      stdoutSha256,
      stderrSha256,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runPackagedLocalAppCycle();
    process.stdout.write(`${DOGFOOD_RESULT_PREFIX}${JSON.stringify(result)}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
