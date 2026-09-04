import { chromium, _electron as electron } from "@playwright/test";
import electronBinary from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { macPortableZipArgs } from "./archive.mjs";
import { createDesktopSmokeShutdownRegistry } from "./desktop-smoke-shutdown.mjs";
import {
  assertExactLocalAppSavedViewTarget,
  assertNoLocalAppRuntimeDetails,
  assertStrictLoopbackAttestation,
  parseLocalAppLsofListenerProcessRecords,
  terminateProvenLocalAppProcessGroup,
} from "./local-app-smoke-helpers.mjs";
import { resolveNativeTarget } from "./native-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "..");
const requireFromScript = createRequire(import.meta.url);
const smokeModeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const smokeScenarioArg = process.argv.find((arg) => arg.startsWith("--scenario="));
const smokeMode = smokeModeArg?.slice("--mode=".length) ?? process.env.RUDDER_DESKTOP_SMOKE_MODE ?? "dev";
const smokeScenario = smokeScenarioArg?.slice("--scenario=".length) ?? process.env.RUDDER_DESKTOP_SMOKE_SCENARIO ?? null;
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-desktop-smoke-"));
await prepareDevSmokeDependencyResolution();
const smokeAgentJwtSecret = randomBytes(32).toString("base64url");
const smokeAgentJwtIssuer = "rudder-desktop-smoke";
const smokeAgentJwtAudience = "rudder-api";
const browserSmokeCookieName = "rudder_browser_smoke";
const browserSmokeCookieValue = "shared-profile";
const browserSmokeCookieUrl = "http://127.0.0.1/";
const browserSmokeStorageKey = "rudder-browser-smoke-storage";
const browserSmokeStorageValue = "shared-site-data";
const browserSmokeCacheName = "rudder-browser-smoke-cache";
const browserImportSmokeCookieName = "rudder_browser_import_smoke";
const browserImportSmokeCookieValue = "imported-profile";
const browserImportDuplicateCookieName = "rudder_browser_import_existing";
const browserImportDuplicateSourceValue = "source-must-not-win";
const browserImportDuplicateDestinationValue = "existing-rudder-profile";
const browserImportExpiredCookieName = "rudder_browser_import_expired";
const browserImportMalformedCookieName = "rudder_browser_import_malformed";
const browserImportEncryptedCookieName = "rudder_browser_import_encrypted";
const browserImportSmokeCookieUrl = "http://127.0.0.1/";
const smokeDebugPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const browserSmokeScreenshotPath = process.env.RUDDER_DESKTOP_SMOKE_SCREENSHOT?.trim() || null;
const systemPermissionsScreenshotPath = process.env.RUDDER_DESKTOP_SYSTEM_PERMISSIONS_SCREENSHOT?.trim() || null;
const localAppSmokeRootOverride = process.env.RUDDER_DESKTOP_LOCAL_APP_SMOKE_ROOT?.trim() || null;
const localAppSmokeEnvNames = process.env.RUDDER_DESKTOP_LOCAL_APP_SMOKE_ENV_NAMES?.trim() || "";
const localAppSmokeExpectedBody = process.env.RUDDER_DESKTOP_LOCAL_APP_SMOKE_EXPECTED_BODY?.trim() || null;
const localAppSmokeScreenshotOverride = process.env.RUDDER_DESKTOP_LOCAL_APP_SMOKE_SCREENSHOT?.trim() || null;
const localAppSmokeScreenshotPath = localAppSmokeScreenshotOverride
  ? path.resolve(localAppSmokeScreenshotOverride)
  : path.join(os.tmpdir(), `rudder-desktop-local-app-smoke-${smokeMode}.png`);
const localAppDeleteSmokeScreenshotPath = path.join(
  os.tmpdir(),
  `rudder-desktop-local-app-delete-smoke-${smokeMode}.png`,
);
const terminalSmokeScreenshotPath = path.join(
  os.tmpdir(),
  `rudder-desktop-agent-terminal-smoke-${smokeMode}.png`,
);
const terminalConstrainedSmokeScreenshotPath = path.join(
  os.tmpdir(),
  `rudder-desktop-agent-terminal-smoke-${smokeMode}-constrained.png`,
);
const terminalFailureSmokeScreenshotPath = path.join(
  os.tmpdir(),
  `rudder-desktop-agent-terminal-smoke-${smokeMode}-failure.png`,
);
const expectedBrowserToolNames = [
  "rudder_browser_tabs",
  "rudder_browser_user_tabs",
  "rudder_browser_open",
  "rudder_browser_navigate",
  "rudder_browser_back",
  "rudder_browser_forward",
  "rudder_browser_reload",
  "rudder_browser_viewport",
  "rudder_browser_visibility",
  "rudder_browser_snapshot",
  "rudder_browser_locator",
  "rudder_browser_cua",
  "rudder_browser_dom_cua",
  "rudder_browser_dialog",
  "rudder_browser_clipboard",
  "rudder_browser_logs",
  "rudder_browser_download",
  "rudder_browser_assets",
  "rudder_browser_content",
  "rudder_browser_wait",
  "rudder_browser_read",
  "rudder_browser_click",
  "rudder_browser_type",
  "rudder_browser_screenshot",
  "rudder_browser_close",
];
const desktopShutdownRegistry = createDesktopSmokeShutdownRegistry();
const windowsToUnixEpochMicroseconds = 11_644_473_600_000_000n;
const REQUIRED_BUNDLED_SKILLS = [
  "app-builder",
  "browser",
  "para-memory-files",
  "rudder-docs",
  "skill-creator",
  "visualize",
];
const PREFERRED_INITIAL_WINDOW_SIZE = [1620, 1020];
const MINIMUM_INITIAL_WINDOW_SIZE = [1080, 720];
const INITIAL_WINDOW_WORK_AREA_RATIO = 0.9;
const desktopPackage = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));
const expectedReleaseVersion = String(desktopPackage.version);
const escapedReleaseVersion = expectedReleaseVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const expectedProcessHostVersion = new RegExp(`^rudder-process-host ${escapedReleaseVersion}\\n$`, "u");
const expectedUpdateHelperVersion = new RegExp(`^rudder-update-helper ${escapedReleaseVersion} protocol=1\\n$`, "u");
const expectedUpdateHelperProtocol = `rudder-update-helper ${expectedReleaseVersion} protocol=1`;
console.log(`[desktop-smoke] temp root: ${tmpRoot}`);

async function prepareDevSmokeDependencyResolution() {
  if (smokeMode !== "dev") return null;
  const dependencyLink = path.join(desktopDir, "dist", "node_modules");
  const stagedDependencies = path.join(desktopDir, ".packaged", "app", "node_modules");
  const [existingLink, stagedDependencyStats] = await Promise.all([
    lstat(dependencyLink).catch(() => null),
    stat(stagedDependencies).catch(() => null),
  ]);
  if (!stagedDependencyStats?.isDirectory()) {
    throw new Error(
      `development Desktop smoke requires staged app dependencies: ${stagedDependencies}`,
    );
  }
  if (existingLink) {
    if (!existingLink.isSymbolicLink()) {
      throw new Error(`development Desktop smoke dependency path is not a link: ${dependencyLink}`);
    }
    const [actualTarget, expectedTarget] = await Promise.all([
      realpath(dependencyLink).catch(() => null),
      realpath(stagedDependencies),
    ]);
    if (actualTarget !== expectedTarget) {
      throw new Error(
        `development Desktop smoke dependency link targets ${actualTarget ?? "an unavailable path"}; expected ${expectedTarget}`,
      );
    }
    return;
  }
  await symlink(
    stagedDependencies,
    dependencyLink,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForSmokeCondition(label, check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}.${detail}`);
}

function isSmokeProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function stopSmokeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2 || !isSmokeProcessAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  await waitForSmokeCondition(
    `smoke-owned process ${pid} to exit`,
    () => !isSmokeProcessAlive(pid),
    { timeoutMs: 10_000 },
  );
}

async function runCapturedProcess(executable, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 5_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function verifyPackagedNativeProcessHost(executablePath) {
  const metadata = await runCapturedProcess(executablePath, ["--version"]);
  assert.equal(metadata.code, 0, "packaged Rust process host should expose metadata");
  assert.match(metadata.stdout, expectedProcessHostVersion);
  await new Promise((resolve, reject) => {
    const host = spawn(executablePath, [], {
      cwd: tmpRoot,
      stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const lifecycle = host.stdio[3];
    const stdout = host.stdio[4];
    const stderr = host.stdio[5];
    if (!lifecycle || !stdout || !stderr || !host.stdin) {
      host.kill("SIGKILL");
      reject(new Error("packaged Rust process host did not expose managed channels"));
      return;
    }
    let lifecycleBuffer = "";
    let output = "";
    let errorOutput = "";
    const events = [];
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("packaged Rust process host probe timed out")), 5_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    lifecycle.setEncoding("utf8");
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    lifecycle.on("data", (chunk) => {
      lifecycleBuffer += chunk;
      const lines = lifecycleBuffer.split("\n");
      lifecycleBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) events.push(JSON.parse(line));
      }
    });
    stdout.on("data", (chunk) => { output += chunk; });
    stderr.on("data", (chunk) => { errorOutput += chunk; });
    host.once("error", finish);
    host.once("exit", (code, signal) => {
      if (lifecycleBuffer.trim()) events.push(JSON.parse(lifecycleBuffer));
      try {
        assert.equal(code, 0, "packaged Rust process host probe should exit successfully");
        assert.equal(signal, null);
        assert.equal(output, "packaged-native-smoke\n");
        assert.equal(errorOutput, "");
        assert.deepEqual(events.map((event) => event.type), [
          "handshake",
          "accepted",
          "spawned",
          "app-exit",
          "terminal",
        ]);
        const terminal = events.at(-1);
        assert.equal(terminal?.status, "succeeded");
        assert.equal(terminal?.requestId, "packaged-native-smoke");
        finish();
      } catch (error) {
        finish(error);
      }
    });
    host.stdin.write(`${JSON.stringify({
      type: "startProcess",
      protocolVersion: { major: 1, minor: 0 },
      requestId: "packaged-native-smoke",
      executable: "/bin/sh",
      argv: ["-c", "printf 'packaged-native-smoke\\n'"],
      cwd: tmpRoot,
      env: {},
      ownerToken: "packaged-native-smoke",
      runtimeRoot: tmpRoot,
    })}\n`);
  });
  if (process.platform === "win32") return;
  await new Promise((resolve, reject) => {
    const host = spawn(executablePath, [], {
      cwd: tmpRoot,
      stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const lifecycle = host.stdio[3];
    const output = host.stdio[4];
    if (!lifecycle || !output || !host.stdin) {
      host.kill("SIGKILL");
      reject(new Error("packaged Rust PTY host did not expose managed channels"));
      return;
    }
    let lifecycleBuffer = "";
    let terminalOutput = "";
    let inputSent = false;
    const timeout = setTimeout(() => {
      host.kill("SIGKILL");
      reject(new Error("packaged Rust PTY probe timed out"));
    }, 5_000);
    lifecycle.setEncoding("utf8");
    output.setEncoding("utf8");
    lifecycle.on("data", (chunk) => {
      lifecycleBuffer += chunk;
      if (!inputSent && lifecycleBuffer.includes('"type":"spawned"')) {
        inputSent = true;
        host.stdin.write(`${JSON.stringify({
          type: "resize",
          protocolVersion: { major: 1, minor: 0 },
          requestId: "packaged-native-pty-smoke",
          cols: 96,
          rows: 32,
        })}\n`);
        host.stdin.write(`${JSON.stringify({
          type: "input",
          protocolVersion: { major: 1, minor: 0 },
          requestId: "packaged-native-pty-smoke",
          data: "pwd\nexit\n",
        })}\n`);
      }
    });
    output.on("data", (chunk) => { terminalOutput += chunk; });
    host.once("error", reject);
    host.once("exit", (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, "packaged Rust PTY probe should exit successfully");
        assert.match(terminalOutput, new RegExp(tmpRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    host.stdin.write(`${JSON.stringify({
      type: "startTerminal",
      protocolVersion: { major: 1, minor: 0 },
      requestId: "packaged-native-pty-smoke",
      executable: "/bin/sh",
      argv: ["-l"],
      cwd: tmpRoot,
      env: { HOME: tmpRoot, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
      ownerToken: "packaged-native-pty-smoke",
      cols: 80,
      rows: 24,
    })}\n`);
  });
}

async function runPackagedUpdateHelper(executablePath, requestPath) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--request", requestPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`packaged update helper exited with signal ${signal}`));
        return;
      }
      let result = null;
      try {
        const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
        result = line ? JSON.parse(line) : null;
      } catch (error) {
        reject(new Error(`packaged update helper returned invalid JSON: ${stdout.trim()}`, { cause: error }));
        return;
      }
      resolve({ code, result, stderr: stderr.trim(), stdout: stdout.trim() });
    });
  });
}

async function writePackagedUpdateHelperRequest(root, input = {}) {
  const installPath = path.join(root, "Rudder.app");
  const stagedPath = path.join(root, "staged", "Rudder.app");
  const lkgPath = path.join(root, "lkg", "Rudder.app");
  const journalPath = path.join(root, "journal.json");
  const checkpointPath = path.join(root, "checkpoint.json");
  await mkdir(installPath, { recursive: true });
  await mkdir(stagedPath, { recursive: true });
  await writeFile(path.join(installPath, "current-generation.txt"), "current\n", "utf8");
  await writeFile(path.join(stagedPath, "candidate-generation.txt"), "candidate\n", "utf8");
  const stagedProbationExecutable = path.join(stagedPath, "Contents", "MacOS", "Rudder");
  await mkdir(path.dirname(stagedProbationExecutable), { recursive: true });
  await writeFile(stagedProbationExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const probationExecutable = path.join(installPath, "Contents", "MacOS", "Rudder");
  await mkdir(path.dirname(probationExecutable), { recursive: true });
  await writeFile(probationExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // A rollback is only meaningful when the fixture starts with a known-good
  // install. The helper moves this bundle to LKG during the exchange.
  await cp(installPath, lkgPath, { recursive: true });
  const request = {
    operation: input.operation ?? "apply",
    ownerToken: input.ownerToken ?? `desktop-smoke-owner-${path.basename(root)}`,
    installPath,
    stagedPath,
    lkgPath,
    journalPath,
    checkpointPath,
    targetVersion: "99.0.0-smoke",
    candidateSha256: input.candidateSha256 ?? null,
    admission: {
      closed: true,
      activeRuns: input.activeRuns ?? 0,
      drainToken: `desktop-smoke-drain-${path.basename(root)}`,
    },
    checkpoint: {
      instanceId: "default",
      databaseRevision: "desktop-smoke-revision",
      migrationCompatible: true,
    },
    helper: input.helper ?? { path: input.helperPath ?? process.env.RUDDER_DESKTOP_SMOKE_EXECUTABLE ?? "", ownerUid: 0, mode: 0o755, sha256: "" },
    probation: { executable: probationExecutable, args: [], timeoutMs: 10_000 },
    fault: input.fault ?? {},
  };
  const requestPath = path.join(root, "request.json");
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 });
  return { request, requestPath };
}

async function bindPackagedUpdateHelperDigest(executablePath, prepared) {
  const digest = await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--digest", prepared.request.stagedPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`packaged update helper digest probe failed (${code}): ${stderr.trim()}`)));
  });
  const helperStat = await stat(executablePath);
  const helperBytes = await readFile(executablePath);
  prepared.request.helper = {
    path: executablePath,
    ownerUid: helperStat.uid,
    mode: helperStat.mode & 0o7777,
    sha256: createHash("sha256").update(helperBytes).digest("hex"),
  };
  prepared.request.candidateSha256 = digest;
  await writeFile(prepared.requestPath, `${JSON.stringify(prepared.request)}\n`, "utf8");
  return prepared;
}

async function verifyPackagedUpdateHelperFaultMatrix(executablePath) {
  const version = await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`packaged update helper version probe failed (${code}): ${stderr.trim()}`)));
  });
  assert.equal(version, expectedUpdateHelperProtocol);

  const matrixRoot = path.join(tmpRoot, "auto-update-helper");
  await mkdir(matrixRoot, { recursive: true });

  const success = await bindPackagedUpdateHelperDigest(executablePath, await writePackagedUpdateHelperRequest(path.join(matrixRoot, "success")));
  const successResult = await runPackagedUpdateHelper(executablePath, success.requestPath);
  assert.equal(successResult.code, 0, `successful helper transaction failed: ${successResult.stdout} ${successResult.stderr}`);
  assert.equal(successResult.result?.stage, "committed");
  assert.equal(await pathExists(path.join(success.request.lkgPath, "current-generation.txt")), true);
  assert.equal(await pathExists(success.request.checkpointPath), true);

  const rollback = await bindPackagedUpdateHelperDigest(executablePath, await writePackagedUpdateHelperRequest(path.join(matrixRoot, "rollback"), {
    fault: { failTargetProbe: true },
  }));
  const rollbackResult = await runPackagedUpdateHelper(executablePath, rollback.requestPath);
  assert.equal(rollbackResult.code, 3, `rollback helper transaction returned ${rollbackResult.code}`);
  assert.equal(rollbackResult.result?.stage, "rolled_back");
  assert.equal(rollbackResult.result?.rolledBack, true);
  assert.equal(await pathExists(path.join(rollback.request.installPath, "current-generation.txt")), true);

  const dualFailure = await bindPackagedUpdateHelperDigest(executablePath, await writePackagedUpdateHelperRequest(path.join(matrixRoot, "dual-failure"), {
    fault: { failTargetProbe: true, failLkgProbe: true },
  }));
  const dualFailureResult = await runPackagedUpdateHelper(executablePath, dualFailure.requestPath);
  assert.equal(dualFailureResult.code, 4, `dual-failure helper transaction returned ${dualFailureResult.code}`);
  assert.equal(dualFailureResult.result?.stage, "recovery_required");
  assert.equal(dualFailureResult.result?.recoveryRequired, true);
  assert.equal(dualFailureResult.result?.recoveryCode, "dual_failure");

  const interrupted = await bindPackagedUpdateHelperDigest(executablePath, await writePackagedUpdateHelperRequest(path.join(matrixRoot, "interrupted"), {
    fault: { failAfterPreviousMoved: true },
  }));
  const interruptedResult = await runPackagedUpdateHelper(executablePath, interrupted.requestPath);
  assert.equal(interruptedResult.code, 2, `interrupted helper transaction returned ${interruptedResult.code}`);
  assert.equal(await pathExists(interrupted.request.installPath), false);
  assert.equal(await pathExists(path.join(interrupted.request.lkgPath, "current-generation.txt")), true);
  await writeFile(interrupted.requestPath, `${JSON.stringify({
    ...interrupted.request,
    operation: "recover",
    fault: {},
  })}\n`, { encoding: "utf8", mode: 0o600 });
  const recoveredResult = await runPackagedUpdateHelper(executablePath, interrupted.requestPath);
  assert.equal(recoveredResult.code, 3, `helper recovery returned ${recoveredResult.code}`);
  assert.equal(recoveredResult.result?.stage, "rolled_back");
  assert.equal(await pathExists(path.join(interrupted.request.installPath, "current-generation.txt")), true);

  const tampered = await bindPackagedUpdateHelperDigest(executablePath, await writePackagedUpdateHelperRequest(path.join(matrixRoot, "tampered")));
  await writeFile(path.join(tampered.request.stagedPath, "substituted.txt"), "substituted\n", "utf8");
  const tamperedResult = await runPackagedUpdateHelper(executablePath, tampered.requestPath);
  assert.equal(tamperedResult.code, 2, `tampered helper transaction returned ${tamperedResult.code}`);
  assert.match(String(tamperedResult.result?.error ?? ""), /digest does not match/iu);
  assert.equal(await pathExists(path.join(tampered.request.installPath, "current-generation.txt")), true);

  const activeRun = await bindPackagedUpdateHelperDigest(executablePath, await writePackagedUpdateHelperRequest(path.join(matrixRoot, "active-run"), {
    activeRuns: 1,
  }));
  const activeRunResult = await runPackagedUpdateHelper(executablePath, activeRun.requestPath);
  assert.equal(activeRunResult.code, 2, `active-run helper transaction returned ${activeRunResult.code}`);
  assert.match(String(activeRunResult.result?.error ?? ""), /not closed and drained/iu);
  assert.equal(await pathExists(path.join(activeRun.request.installPath, "current-generation.txt")), true);

  console.log("[desktop-smoke] packaged update helper passed commit, rollback, dual-failure, interruption recovery, tamper, and admission fault matrix");
}

async function verifyPackagedUpdateHelper(executablePath) {
  const metadata = await runCapturedProcess(executablePath, ["--version"]);
  assert.equal(metadata.code, 0, "packaged update helper should expose metadata");
  assert.match(metadata.stdout, expectedUpdateHelperVersion);
}

async function verifyPackagedExternalUpdateHelperHandoff(packagedExecutablePath, helperPath) {
  const helperModule = await import(pathToFileURL(path.join(desktopDir, "dist", "desktop-update-helper.js")).href);
  const handoffRoot = path.join(tmpRoot, "external-helper-handoff");
  const userDataPath = path.join(handoffRoot, "user-data");
  const resourcesPath = path.resolve(path.dirname(packagedExecutablePath), "..", "Resources");
  await mkdir(handoffRoot, { recursive: true });
  const attestation = helperModule.ensureExternalDesktopUpdateHelper({
    userDataPath,
    resourcesPath,
    platform: "darwin",
    env: process.env,
  });
  assert.ok(attestation, "packaged Desktop should install and attest an external update helper");
  assert.equal(path.relative(resourcesPath, attestation.path).startsWith(".."), true);
  assert.equal(attestation.mode, 0o755);
  assert.equal(attestation.protocol, helperModule.DESKTOP_UPDATE_HELPER_PROTOCOL);
  assert.equal(attestation.sha256, createHash("sha256").update(await readFile(attestation.path)).digest("hex"));

  const prepared = await writePackagedUpdateHelperRequest(path.join(handoffRoot, "transaction"), {
    helperPath: attestation.path,
  });
  prepared.request.helper = {
    path: attestation.path,
    ownerUid: attestation.ownerUid,
    mode: attestation.mode,
    sha256: attestation.sha256,
  };
  prepared.request.transactionId = randomUUID().replaceAll("-", "");
  const digest = await new Promise((resolve, reject) => {
    const child = spawn(helperPath, ["--digest", prepared.request.stagedPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim())));
  });
  prepared.request.candidateSha256 = digest;
  await writeFile(prepared.requestPath, `${JSON.stringify(prepared.request)}\n`, { encoding: "utf8", mode: 0o600 });
  const child = helperModule.handoffDesktopUpdateToExternalHelper({
    request: prepared.request,
    helperPath: attestation.path,
  });
  assert.equal(typeof child.pid, "number");
  const journal = await waitForSmokeCondition(
    "external update helper handoff journal",
    async () => {
      if (!(await pathExists(prepared.request.journalPath))) return null;
      const journal = JSON.parse(await readFile(prepared.request.journalPath, "utf8"));
      return journal.stage === "committed" ? journal : null;
    },
    { timeoutMs: 15_000 },
  );
  assert.equal(journal.stage, "committed");
  assert.equal(journal.transactionId, prepared.request.transactionId);
  assert.equal(journal.helper.path, attestation.path);
  assert.equal(await pathExists(path.join(prepared.request.installPath, "candidate-generation.txt")), true);
  console.log("[desktop-smoke] packaged external helper installed, attested, and completed an immutable detached handoff");
}

function parseLocalAppSmokeEnvNames() {
  const names = [...new Set(localAppSmokeEnvNames.split(",").map((name) => name.trim()).filter(Boolean))];
  for (const name of names) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, `invalid Local App smoke environment name: ${name}`);
    assert.notEqual(name, "PATH", "Local App smoke must not inherit PATH; Desktop constructs a trusted PATH");
    assert.equal(
      typeof process.env[name],
      "string",
      `Local App smoke environment variable is not set: ${name}`,
    );
  }
  return names;
}

async function createGeneratedLocalAppSmokeProject(scenarioRoot) {
  const projectRoot = path.join(scenarioRoot, "local-app-project");
  const markerPath = path.join(projectRoot, "start-marker.json");
  const serverPath = path.join(projectRoot, "server.mjs");
  const sentinelEnvName = "RUDDER_DESKTOP_LOCAL_APP_SMOKE_SENTINEL";
  const sentinelEnvValue = `local-app-smoke-${randomBytes(32).toString("hex")}`;
  const sentinelDigest = createHash("sha256").update(sentinelEnvValue).digest("hex");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), `${JSON.stringify({
    name: "rudder-local-app-smoke-fixture",
    private: true,
    type: "module",
    scripts: { dev: "node server.mjs" },
    rudder: {
      readiness: { path: "/health", timeoutMs: 15_000 },
      openPath: "/app",
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(serverPath, `import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";

const host = process.env.HOST === "127.0.0.1" ? process.env.HOST : "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "0", 10);
const markerPath = ${JSON.stringify(markerPath)};
const sentinelEnvAccepted = createHash("sha256")
  .update(process.env[${JSON.stringify(sentinelEnvName)}] ?? "")
  .digest("hex") === ${JSON.stringify(sentinelDigest)};
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pid: process.pid, port, sentinelEnvAccepted }));
    return;
  }
  if (request.url === "/app" || request.url === "/") {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><html><head><title>Rudder Local App Smoke</title></head><body><main><h1 id="fixture-title">Rudder Local Apps smoke fixture</h1><p id="fixture-proof">Real isolated Electron webview content</p></main></body></html>');
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});
server.listen(port, host, () => {
  const marker = { pid: process.pid, ppid: process.ppid, port, sentinelEnvAccepted, startedAt: new Date().toISOString() };
  writeFileSync(markerPath, JSON.stringify(marker) + "\\n", { mode: 0o600 });
  process.stdout.write('Rudder Local Apps smoke fixture listening on ' + host + ':' + port + '\\n');
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`, "utf8");
  return {
    external: false,
    expectedBodyText: "Rudder Local Apps smoke fixture",
    launchEnv: { [sentinelEnvName]: sentinelEnvValue },
    markerPath,
    projectRoot,
    requiredEnvNames: [sentinelEnvName],
  };
}

async function resolveLocalAppSmokeProject(scenarioRoot) {
  if (!localAppSmokeRootOverride) return createGeneratedLocalAppSmokeProject(scenarioRoot);
  const projectRoot = await realpath(path.resolve(localAppSmokeRootOverride));
  assert.equal((await stat(projectRoot)).isDirectory(), true, "Local App smoke root must be a directory");
  return {
    external: true,
    expectedBodyText: localAppSmokeExpectedBody,
    launchEnv: {},
    markerPath: null,
    projectRoot,
    requiredEnvNames: [],
  };
}

async function seedApprovedLocalAppDefinition(scenarioRoot, project) {
  const registryModulePath = path.join(desktopDir, "dist", "local-apps-registry.js");
  const discoveryModulePath = path.join(desktopDir, "dist", "local-apps-discovery.js");
  assert.equal(
    await pathExists(registryModulePath),
    true,
    "Desktop Local App registry build is missing; run the Desktop build before smoke",
  );
  assert.equal(
    await pathExists(discoveryModulePath),
    true,
    "Desktop Local App discovery build is missing; run the Desktop build before smoke",
  );
  const [{ LocalAppRegistry }, { discoverLocalAppDefinition }] = await Promise.all([
    import(pathToFileURL(registryModulePath).href),
    import(pathToFileURL(discoveryModulePath).href),
  ]);
  const registryPath = path.join(resolveInstancePaths(scenarioRoot).electronUserDataDir, "local-apps", "registry.json");
  const installationId = "default";
  const registry = new LocalAppRegistry({ registryPath, installationId });
  const discovered = await discoverLocalAppDefinition(project.projectRoot);
  const inheritedEnvNames = [...new Set([
    ...project.requiredEnvNames,
    ...parseLocalAppSmokeEnvNames(),
  ])];
  const created = await registry.createDefinition({ ...discovered, inheritedEnvNames });
  const definition = await registry.approveDefinition(created.id, created.trustFingerprint);
  assert.equal(definition.approvedFingerprint, definition.trustFingerprint, "smoke definition should be approved in its isolated registry");
  const inheritedEnvValues = inheritedEnvNames.flatMap((name) => {
    const value = project.launchEnv[name] ?? process.env[name];
    return typeof value === "string" ? [value] : [];
  });
  return { definition, inheritedEnvNames, inheritedEnvValues, installationId, registry, registryPath };
}

async function seedFailingLocalAppDefinition(registry, scenarioRoot) {
  const secret = `local-app-chat-secret-${randomBytes(16).toString("hex")}`;
  const created = await registry.createDefinition({
    title: "AI recovery Local App",
    executable: process.execPath,
    argv: ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.exit(1);`],
    cwd: scenarioRoot,
    inheritedEnvNames: [],
    readiness: { path: "/health", timeoutMs: 1_000 },
    openPath: "/",
  });
  const definition = await registry.approveDefinition(created.id, created.trustFingerprint);
  assert.equal(
    definition.approvedFingerprint,
    definition.trustFingerprint,
    "failing Local App smoke definition should be approved in its isolated registry",
  );
  return { definition, secret };
}

async function readLocalAppSmokeRegistry(registryPath) {
  return JSON.parse(await readFile(registryPath, "utf8"));
}

function safeLocalAppTestId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function createLocalBrowserSmokeFixture() {
  const fixtureRoot = path.join(tmpRoot, "browser-local-file");
  const fixturePath = path.join(fixtureRoot, "rudder-local-report.html");
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(fixturePath, `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Rudder Local File Smoke</title></head>
  <body><h1>Rudder local file fixture</h1><p id="proof">Real Electron webview content</p></body>
</html>`);
  return {
    url: pathToFileURL(fixturePath).href,
    missingUrl: pathToFileURL(path.join(fixtureRoot, "missing-local-report.html")).href,
  };
}

async function createSyntheticBrowserImportFixture(userDataDir) {
  if (process.platform !== "darwin") return null;

  const { DatabaseSync } = await import("node:sqlite");
  const homeDir = path.join(userDataDir, "home");
  const browserRoot = path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
  const profileSegment = "Default";
  const profileRoot = path.join(browserRoot, profileSegment);
  const cookieDatabasePath = path.join(profileRoot, "Network", "Cookies");
  await mkdir(path.dirname(cookieDatabasePath), { recursive: true });
  await writeFile(path.join(browserRoot, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        [profileSegment]: { name: "Rudder Synthetic Profile" },
      },
    },
  }), { mode: 0o600 });

  const database = new DatabaseSync(cookieDatabasePath);
  database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      INSERT INTO meta(key, value) VALUES ('version', '23'), ('last_compatible_version', '23');
      CREATE TABLE cookies(
        host_key TEXT NOT NULL,
        top_frame_site_key TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        encrypted_value BLOB NOT NULL DEFAULT X'',
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL,
        is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL,
        has_expires INTEGER NOT NULL,
        is_persistent INTEGER NOT NULL,
        samesite INTEGER NOT NULL,
        source_scheme INTEGER NOT NULL DEFAULT 0,
        source_port INTEGER NOT NULL DEFAULT -1,
        last_update_utc INTEGER NOT NULL DEFAULT 0
      );
  `);
  const nowUnixSeconds = BigInt(Math.floor(Date.now() / 1000));
  const futureExpiresUtc = windowsToUnixEpochMicroseconds + (nowUnixSeconds + 24n * 60n * 60n) * 1_000_000n;
  const expiredExpiresUtc = windowsToUnixEpochMicroseconds + (nowUnixSeconds - 60n) * 1_000_000n;
  const insertCookie = database.prepare(`
      INSERT INTO cookies(
        host_key, top_frame_site_key, name, value, encrypted_value, path,
        expires_utc, is_secure, is_httponly, has_expires, is_persistent,
        samesite, source_scheme, source_port, last_update_utc
      ) VALUES ('127.0.0.1', '', ?, ?, ?, '/', ?, ?, 1, 1, 1, 1, 0, -1, ?)
  `);
  const insert = ({ name, value = "", encryptedValue = Buffer.alloc(0), expiresUtc = futureExpiresUtc, secure = 0, updated = futureExpiresUtc }) => {
    insertCookie.run(name, value, encryptedValue, expiresUtc, secure, updated);
  };
  insert({ name: browserImportSmokeCookieName, value: browserImportSmokeCookieValue });
  insert({ name: browserImportDuplicateCookieName, value: browserImportDuplicateSourceValue });
  insert({ name: browserImportExpiredCookieName, value: "expired", expiresUtc: expiredExpiresUtc });
  insert({ name: browserImportMalformedCookieName, value: "invalid-secure-flag", secure: 2 });
  insert({ name: browserImportEncryptedCookieName, encryptedValue: Buffer.from("v11synthetic") });

  return {
    cookieDatabasePath,
    homeDir,
    sourceDisplayName: "Google Chrome - Rudder Synthetic Profile",
    close: () => database.close(),
  };
}

async function getAvailablePort() {
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

async function startBrowserSmokeFixture() {
  const observedCookies = [];
  const server = http.createServer((request, response) => {
    observedCookies.push(String(request.headers.cookie || ""));
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/asset.png") {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": png.length,
        "content-type": "image/png",
      });
      response.end(png);
      return;
    }
    if (requestUrl.pathname === "/download") {
      const body = Buffer.from("rudder-browser-download", "utf8");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-disposition": 'attachment; filename="rudder-smoke.txt"',
        "content-length": body.length,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end(body);
      return;
    }
    if (requestUrl.pathname === "/frame") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html><html><body>
        <label for="frame-input">Frame input</label>
        <input id="frame-input" data-testid="frame-input" />
        <button id="frame-button" onclick="document.body.dataset.clicked='yes'">Frame action</button>
      </body></html>`);
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "rudder_browser_credential=server-cookie-secret; HttpOnly; SameSite=Lax",
    });
    response.end(`<!doctype html>
      <html>
        <head>
          <title>Rudder Browser smoke</title>
          <style>
            body { margin: 0; font-family: sans-serif; }
            main { padding: 24px; }
            .spacer { height: 1400px; }
            @media (max-width: 500px) { body { background: rgb(1, 2, 3); } }
          </style>
        </head>
        <body>
          <main>
            <h1>Rudder Browser fixture</h1>
            <button id="continue" type="button" data-testid="continue">Continue</button>
            <button id="cua-button" type="button">CUA action</button>
            <button id="dom-button" type="button">DOM action</button>
            <button id="dialog-button" type="button">Open prompt</button>
            <label for="smoke-input">Smoke input</label>
            <input id="smoke-input" data-testid="smoke-input" placeholder="Search fixture" />
            <input id="password-secret" type="password" value="password-secret-value" />
            <input id="hidden-secret" type="hidden" value="hidden-secret-value" data-auth-token="attribute-secret-value" />
            <label for="smoke-upload">Smoke upload</label>
            <input id="smoke-upload" type="file" />
            <label><input id="smoke-check" type="checkbox" aria-label="Accept smoke terms" /> Accept smoke terms</label>
            <label for="smoke-select">Smoke color</label>
            <select id="smoke-select"><option value="red">Red</option><option value="blue">Blue</option></select>
            <div id="editable" contenteditable="true" aria-label="Smoke editor"></div>
            <a id="download-link" href="/download" download="rudder-smoke.txt">Download fixture</a>
            <img class="hero" src="/asset.png" alt="Fixture asset" width="32" height="32" />
            <iframe id="fixture-frame" src="/frame" title="Fixture frame"></iframe>
            <p id="status">idle</p>
            <p id="trusted-result">untrusted</p>
            <p id="upload-result">none</p>
            <p id="prompt-result">none</p>
            <p id="cookie-probe">none</p>
            <p id="clipboard-probe">unreadable</p>
            <p id="cua-result">0</p>
            <p id="dom-result">0</p>
            <div class="spacer"></div>
            <p id="below-fold">Below the fold</p>
            <p>${request.url ?? "/"}</p>
          </main>
          <script>
            document.querySelector("#continue").addEventListener("click", (event) => {
              document.querySelector("#status").textContent = "continued";
              document.querySelector("#trusted-result").textContent = event.isTrusted ? "trusted" : "untrusted";
              console.warn("fixture-continued");
            });
            document.querySelector("#smoke-upload").addEventListener("change", (event) => {
              document.querySelector("#upload-result").textContent = event.target.files?.[0]?.name || "none";
            });
            document.querySelector("#cua-button").addEventListener("click", () => {
              const result = document.querySelector("#cua-result");
              result.textContent = String(Number(result.textContent || "0") + 1);
            });
            document.querySelector("#dom-button").addEventListener("click", () => {
              const result = document.querySelector("#dom-result");
              result.textContent = String(Number(result.textContent || "0") + 1);
            });
            document.querySelector("#dialog-button").addEventListener("click", () => {
              const accepted = confirm("Smoke confirmation");
              document.querySelector("#prompt-result").textContent = accepted ? "accepted" : "dismissed";
            });
            localStorage.setItem("auth-token", "local-storage-secret");
            sessionStorage.setItem("auth-token", "session-storage-secret");
            setInterval(() => {
              document.querySelector("#cookie-probe").textContent = document.cookie || "none";
              navigator.clipboard?.readText?.().then((value) => {
                document.querySelector("#clipboard-probe").textContent = value || "empty";
              }).catch(() => undefined);
            }, 50);
            console.log("fixture-ready");
          </script>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Browser smoke fixture failed to bind loopback");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    observedCookies,
    stop: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function allocateSmokePorts() {
  const appPort = await getAvailablePort();
  let dbPort = await getAvailablePort();
  while (dbPort === appPort) {
    dbPort = await getAvailablePort();
  }
  return { appPort, dbPort };
}

async function createPackagedIdentitySmokeExecutable(scenarioRoot) {
  const sourceExecutable = await resolvePackagedExecutablePath();
  const sourceRoot = process.platform === "darwin"
    ? path.resolve(sourceExecutable, "..", "..", "..")
    : path.dirname(sourceExecutable);
  const copiedRoot = path.join(scenarioRoot, "packaged-identity-smoke");
  await cp(sourceRoot, copiedRoot, { recursive: true, dereference: true });
  const resourcesDir = process.platform === "darwin"
    ? path.join(copiedRoot, "Contents", "Resources")
    : path.join(copiedRoot, "resources");
  await mkdir(path.join(resourcesDir, "native"), { recursive: true });
  await writeFile(
    path.join(resourcesDir, "native", "packaged-test-identity.marker"),
    "rudder-packaged-test-identity-v1\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return process.platform === "darwin"
    ? path.join(copiedRoot, "Contents", "MacOS", path.basename(sourceExecutable))
    : path.join(copiedRoot, path.basename(sourceExecutable));
}

async function createDegradedIdentitySmokeServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "GET"} ${requestUrl.pathname}`);
    if (requestUrl.pathname === "/api/health") {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "identity temporarily unavailable" }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Identity smoke fixture failed to bind loopback");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function resolvePackagedExecutablePath() {
  const explicitExecutable = process.env.RUDDER_DESKTOP_SMOKE_EXECUTABLE?.trim();
  if (explicitExecutable) {
    const resolved = path.resolve(explicitExecutable);
    if (!(await pathExists(resolved))) {
      throw new Error(`RUDDER_DESKTOP_SMOKE_EXECUTABLE does not exist: ${resolved}`);
    }
    return resolved;
  }

  const candidates = process.platform === "darwin"
    ? [
        path.resolve(desktopDir, "release/mac-arm64/Rudder.app/Contents/MacOS/Rudder"),
        path.resolve(desktopDir, "release/mac/Rudder.app/Contents/MacOS/Rudder"),
      ]
    : process.platform === "win32"
      ? [
          path.resolve(desktopDir, "release/win-unpacked/Rudder.exe"),
          path.resolve(desktopDir, "release/win-arm64-unpacked/Rudder.exe"),
        ]
      : [
          path.resolve(desktopDir, "release/linux-unpacked/Rudder"),
          path.resolve(desktopDir, "release/linux-arm64-unpacked/Rudder"),
        ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find a packaged desktop executable for ${process.platform}. Checked:\n${candidates.join("\n")}`,
  );
}

async function preparePackagedExternalRuntimeFixture(userDataDir, options = {}) {
  const executablePath = await resolvePackagedExecutablePath();
  const resourcesDir = process.platform === "darwin"
    ? path.resolve(path.dirname(executablePath), "..", "Resources")
    : path.resolve(path.dirname(executablePath), "resources");
  const nativeTarget = resolveNativeTarget(process.platform, process.arch);
  const nativeHostPath = nativeTarget
    ? path.join(resourcesDir, "native", nativeTarget, process.platform === "win32" ? "rudder-process-host.exe" : "rudder-process-host")
    : null;
  const updateHelperPath = nativeTarget
    ? path.join(resourcesDir, "native", nativeTarget, process.platform === "win32" ? "rudder-update-helper.exe" : "rudder-update-helper")
    : null;
  if (options.authBypass === true) {
    await mkdir(path.join(resourcesDir, "native"), { recursive: true });
    await writeFile(
      path.join(resourcesDir, "native", "packaged-test-identity.marker"),
      "rudder-packaged-test-identity-v1\n",
      { encoding: "utf8", mode: 0o600 },
    );
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    assert.ok(nativeHostPath, "packaged Desktop should stage a Rust process host target");
    const nativeStats = await stat(nativeHostPath);
    assert.equal(nativeStats.isFile(), true, "packaged Rust process host should be a file");
    assert.notEqual(nativeStats.mode & 0o111, 0, "packaged Rust process host should be executable");
    if (options.verifyProcessHost !== false) {
      await verifyPackagedNativeProcessHost(nativeHostPath);
    }
    assert.ok(updateHelperPath, "packaged Desktop should stage the Rust update helper target");
    const updateHelperStats = await stat(updateHelperPath);
    assert.equal(updateHelperStats.isFile(), true, "packaged Rust update helper should be a file");
    assert.notEqual(updateHelperStats.mode & 0o111, 0, "packaged Rust update helper should be executable");
    await verifyPackagedUpdateHelper(updateHelperPath);
  }
  const serverPackageDir = path.join(resourcesDir, "server-package");
  const cliEntry = path.join(serverPackageDir, "desktop-cli.js");
  const cliRunner = path.join(serverPackageDir, "desktop-cli-runner.js");
  const serverManifest = JSON.parse(await readFile(path.join(serverPackageDir, "package.json"), "utf8"));
  const runtimeVersion = options.runtimeVersion ?? serverManifest.version;
  const serverEntrypoint = path.resolve(serverPackageDir, serverManifest.main ?? "dist/index.js");
  const runtimeCacheDir = path.join(resolveInstancePaths(userDataDir).rudderHome, "runtimes", runtimeVersion);
  const runtimeServerDir = path.join(runtimeCacheDir, "node_modules", "@rudderhq", "server");
  const postgresRuntimeSegment = `${process.platform}-${process.arch}`;
  const packagedPostgresRuntimeDir = path.join(resourcesDir, "postgres-18.4", postgresRuntimeSegment);
  const sharedPostgresRoot = path.join(
    resolveInstancePaths(userDataDir).rudderHome,
    "runtime-payloads",
    "postgres-18.4",
  );
  const sharedPostgresPlatformDir = path.join(sharedPostgresRoot, postgresRuntimeSegment);
  const runtimePostgresRoot = path.join(runtimeCacheDir, "postgres-18.4");
  const postgresBinDir = path.join(sharedPostgresPlatformDir, "bin");
  const postgresBinDirMarker = path.join(userDataDir, "external-runtime-postgres-bin");
  const packagedCodexAdapterDir = path.join(
    serverPackageDir,
    "node_modules",
    "@rudderhq",
    "agent-runtime-codex-local",
  );
  const runtimeCodexAdapterDir = path.join(
    runtimeCacheDir,
    "node_modules",
    "@rudderhq",
    "agent-runtime-codex-local",
  );
  const loadedMarker = path.join(userDataDir, "external-runtime-loaded");
  const staleBinDir = path.join(userDataDir, "stale-bin");
  const staleMarker = path.join(userDataDir, "stale-path-invoked");
  const staleCommand = path.join(staleBinDir, process.platform === "win32" ? "rudder.cmd" : "rudder");

  await mkdir(runtimeServerDir, { recursive: true });
  await writeFile(path.join(runtimeCacheDir, "package.json"), `${JSON.stringify({
    private: true,
    dependencies: { "@rudderhq/server": runtimeVersion },
  })}\n`, "utf8");
  await writeFile(path.join(runtimeCacheDir, "runtime.json"), `${JSON.stringify({
    version: 1,
    packageName: "@rudderhq/server",
    packageVersion: runtimeVersion,
    installedAt: new Date(0).toISOString(),
    postgresRuntime: {
      version: "18.4",
      platform: process.platform,
      arch: process.arch,
      binDir: postgresBinDir,
      scope: "shared",
    },
  })}\n`, "utf8");
  await writeFile(path.join(runtimeServerDir, "package.json"), `${JSON.stringify({
    name: "@rudderhq/server",
    version: runtimeVersion,
    type: "module",
    main: "./index.js",
    exports: { ".": "./index.js" },
  })}\n`, "utf8");
  await writeFile(
    path.join(runtimeServerDir, "index.js"),
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(loadedMarker)}, "loaded");\nfs.writeFileSync(${JSON.stringify(postgresBinDirMarker)}, process.env.RUDDER_POSTGRES_BIN_DIR ?? "");\nexport * from ${JSON.stringify(pathToFileURL(serverEntrypoint).href)};\n`,
    "utf8",
  );
  await mkdir(sharedPostgresRoot, { recursive: true });
  await symlink(
    packagedPostgresRuntimeDir,
    sharedPostgresPlatformDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    process.platform === "win32"
      ? sharedPostgresRoot
      : path.relative(path.dirname(runtimePostgresRoot), sharedPostgresRoot),
    runtimePostgresRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    packagedCodexAdapterDir,
    runtimeCodexAdapterDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  await mkdir(staleBinDir, { recursive: true });
  await writeFile(
    staleCommand,
    process.platform === "win32"
      ? `@echo off\r\necho stale>${staleMarker}\r\nexit /b 2\r\n`
      : `#!/bin/sh\nprintf stale > '${staleMarker.replaceAll("'", "'\\''")}'\nexit 2\n`,
    "utf8",
  );
  await chmod(staleCommand, 0o755);

  return {
    cliEntry,
    cliRunner,
    codexAdapterEntry: path.join(runtimeCodexAdapterDir, "dist", "server", "index.js"),
    executablePath,
    loadedMarker,
    postgresBinDir,
    postgresBinDirMarker,
    runtimePostgresRoot,
    sharedPostgresRoot,
    runtimeCacheDir,
    serverVersion: runtimeVersion,
    nativeHostPath,
    staleMarker,
    userDataDir,
    env: {
      PATH: `${staleBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      RUDDER_POSTGRES_BIN_DIR: path.join(packagedPostgresRuntimeDir, "bin"),
    },
  };
}

async function loadPostgres() {
  const modulePath = requireFromScript.resolve("postgres", {
    paths: [path.resolve(repoRoot, "packages/db")],
  });
  const mod = await import(pathToFileURL(modulePath).href);
  return mod.default;
}

async function migrationHash(migrationFile) {
  const migrationPath = path.resolve(repoRoot, "packages/db/src/migrations", migrationFile);
  const content = await readFile(migrationPath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

function createRuntimeUrls(ports) {
  return {
    apiBaseUrl: `http://127.0.0.1:${ports.appPort}`,
    databaseUrl: `postgres://rudder:rudder@127.0.0.1:${ports.dbPort}/rudder`,
  };
}

function resolveInstancePaths(userDataDir) {
  const rudderHome = path.join(userDataDir, "rudder-home");
  const instanceRoot = path.join(rudderHome, "instances", "default");
  return {
    rudderHome,
    electronUserDataDir: path.join(userDataDir, "electron-user-data"),
    instanceRoot,
    logsDir: path.join(instanceRoot, "logs"),
    postmasterPidPath: path.join(instanceRoot, "db", "postmaster.pid"),
    runtimeDescriptorPath: path.join(instanceRoot, "runtime", "server.json"),
  };
}

async function resolveServerLogPath(logsDir) {
  const legacyPath = path.join(logsDir, "server.log");
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  const entries = await readdir(logsDir, { withFileTypes: true }).catch(() => []);
  const dailyLogCandidates = entries
    .filter((entry) => entry.isFile() && /^server-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name))
    .map((entry) => path.join(logsDir, entry.name));

  if (dailyLogCandidates.length === 0) {
    throw new Error(`Could not find server log file in ${logsDir}`);
  }

  let latestPath = dailyLogCandidates[0];
  let latestMtime = (await stat(latestPath)).mtimeMs;
  for (const candidatePath of dailyLogCandidates.slice(1)) {
    const candidateMtime = (await stat(candidatePath)).mtimeMs;
    if (candidateMtime > latestMtime) {
      latestMtime = candidateMtime;
      latestPath = candidatePath;
    }
  }
  return latestPath;
}

async function createCompany(baseUrl, issuePrefix = "DES") {
  console.log("[desktop-smoke] creating company");
  const response = await fetch(`${baseUrl}/api/orgs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Desktop Smoke Co",
      issuePrefix,
      description: "Desktop smoke test company",
    }),
  });
  if (response.status !== 201) {
    throw new Error(`create company failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function createSmokeDebugAsset(baseUrl, companyId) {
  const form = new FormData();
  form.append("namespace", "desktop-smoke");
  form.append(
    "file",
    new Blob([
      smokeDebugPng,
    ], { type: "image/png" }),
    "agent-browser-debug.png",
  );
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/assets/images`, {
    method: "POST",
    body: form,
  });
  if (response.status !== 201) {
    throw new Error(`create Agent Browser debug asset failed (${response.status}): ${await response.text()}`);
  }
  const asset = await response.json();
  assert.match(asset.contentPath, /^\/api\/assets\/[^/]+\/content$/);
  return asset;
}

async function verifyBundledSkills(baseUrl, companyId) {
  console.log("[desktop-smoke] verifying bundled organization skills");
  const [response, healthResponse] = await Promise.all([
    fetch(`${baseUrl}/api/orgs/${companyId}/skills`),
    fetch(`${baseUrl}/api/health`),
  ]);
  if (response.status !== 200) {
    throw new Error(`list organization skills failed (${response.status}): ${await response.text()}`);
  }
  if (healthResponse.status !== 200) {
    throw new Error(`read feature capabilities failed (${healthResponse.status}): ${await healthResponse.text()}`);
  }
  const skills = await response.json();
  assert.ok(Array.isArray(skills), "organization skills response should be an array");

  const bundledSlugs = skills
    .filter((skill) => skill?.sourceBadge === "rudder")
    .map((skill) => skill.slug)
    .sort();
  const expectedSlugs = [...REQUIRED_BUNDLED_SKILLS].sort();

  assert.deepEqual(
    bundledSlugs,
    expectedSlugs,
    `expected enabled bundled Rudder skills for new organization: ${expectedSlugs.join(", ")}`,
  );
}

async function verifyBrowserSkillState(baseUrl, companyId, expectedEnabled) {
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/skills`);
  if (response.status !== 200) {
    throw new Error(`list organization skills failed (${response.status}): ${await response.text()}`);
  }
  const skills = await response.json();
  const browserEnabled = skills.some((skill) => skill?.sourceBadge === "rudder" && skill.slug === "browser");
  assert.equal(browserEnabled, expectedEnabled, `Browser skill enabled state should be ${expectedEnabled}`);
}

async function createCeo(baseUrl, companyId) {
  console.log("[desktop-smoke] creating CEO");
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Desktop CEO",
      role: "ceo",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
    }),
  });
  if (response.status !== 201) {
    throw new Error(`create CEO failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function updateExperimentalPlugins(baseUrl, enabled) {
  const response = await fetch(`${baseUrl}/api/instance/settings/general`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ experimentalPluginsEnabled: enabled }),
  });
  if (response.status !== 200) {
    throw new Error(`update Experimental Plugins failed (${response.status}): ${await response.text()}`);
  }
  const settings = await response.json();
  assert.equal(settings.experimentalPluginsEnabled, enabled);
  assert.equal(settings.experimentalSitesEnabled, enabled);
}

async function createAppBuilderRecord(baseUrl, companyId, name, sourceRoot) {
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/app-builder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, sourceRoot, scaffoldVersion: "1" }),
  });
  if (response.status !== 201) {
    throw new Error(`create App Builder record failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function readAppBuilderRecord(baseUrl, companyId, appId) {
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/app-builder`);
  if (response.status !== 200) {
    throw new Error(`read App Builder record failed (${response.status}): ${await response.text()}`);
  }
  const apps = await response.json();
  const app = apps.find((candidate) => candidate.id === appId);
  if (!app) throw new Error(`App Builder record ${appId} was not returned for organization ${companyId}`);
  return app;
}

async function reportAppBuilderSourceHandoff(baseUrl, databaseUrl, company, agent, appId) {
  const postgres = await loadPostgres();
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const runId = randomUUID();
  try {
    await sql`
      insert into heartbeat_runs (id, org_id, agent_id, invocation_source, status, started_at)
      values (${runId}::uuid, ${company.id}::uuid, ${agent.id}::uuid, 'desktop_smoke', 'running', now())
    `;
    const token = createSmokeAgentJwt(agent.id, company.id, runId);
    const transitions = [
      { status: "building", expectedStatus: "preparing", runKind: "build" },
      {
        status: "verified_source_ready",
        expectedStatus: "building",
        runKind: "verification",
      },
    ];
    for (const transition of transitions) {
      const response = await fetch(
        `${baseUrl}/api/app-builder/${appId}/build?orgId=${company.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...transition, runId }),
        },
      );
      if (response.status !== 200) {
        throw new Error(
          `report App Builder ${transition.status} failed (${response.status}): ${await response.text()}`,
        );
      }
    }
  } finally {
    await sql`
      update heartbeat_runs
      set status = 'succeeded', finished_at = now(), updated_at = now()
      where id = ${runId}::uuid
    `.catch(() => {});
    await sql.end();
  }
}

async function createIssue(baseUrl, companyId, assigneeAgentId) {
  console.log("[desktop-smoke] creating issue");
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Desktop smoke issue",
      description: "Created by desktop smoke test",
      status: "todo",
      assigneeAgentId,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`create issue failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function createChat(baseUrl, companyId) {
  console.log("[desktop-smoke] creating chat");
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Desktop browser smoke chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: {
        body: "Open the Browser Side Panel for Desktop smoke verification.",
      },
    }),
  });
  if (response.status !== 201) {
    throw new Error(`create chat failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function createAgentTerminalChat(baseUrl, companyId, agentId) {
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Desktop Agent Terminal smoke chat",
      preferredAgentId: agentId,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Open the Agent workspace Terminal." },
    }),
  });
  if (response.status !== 201) {
    throw new Error(`create Agent Terminal chat failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function createAgentApiKey(baseUrl, agentId) {
  console.log("[desktop-smoke] creating agent API key");
  const response = await fetch(`${baseUrl}/api/agents/${agentId}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "desktop-smoke",
    }),
  });
  if (response.status !== 201) {
    throw new Error(`create agent API key failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

function createSmokeAgentJwt(agentId, orgId, runId) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const claims = encode({
    sub: agentId,
    org_id: orgId,
    adapter_type: "codex_local",
    run_id: runId,
    iat: now,
    exp: now + 60 * 60,
    iss: smokeAgentJwtIssuer,
    aud: smokeAgentJwtAudience,
  });
  const signingInput = `${header}.${claims}`;
  const signature = createHmac("sha256", smokeAgentJwtSecret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

async function createSmokeMcpClient(env, surface = "browser") {
  const executablePath = smokeMode === "packaged" ? await resolvePackagedExecutablePath() : process.execPath;
  const packagedRunner = smokeMode === "packaged"
    ? resolvePackagedCliRunner(executablePath)
    : null;
  const args = packagedRunner
    ? [packagedRunner, "mcp-server", "--server", surface]
    : smokeMode === "packaged"
      ? ["--desktop-cli", "mcp-server", "--server", surface]
      : [path.resolve(repoRoot, "cli/dist/index.js"), "mcp-server", "--server", surface];
  const child = spawn(executablePath, args, {
    env: {
      ...process.env,
      ...env,
      ...(packagedRunner ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    resolveExit({ code, signal });
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(
        `Browser MCP server exited before responding (code=${code ?? "null"}, signal=${signal ?? "none"}): ${stderr}`,
      ));
    }
    pending.clear();
  });

  return {
    request(method, params) {
      if (exited) return Promise.reject(new Error(`Browser MCP server already exited: ${stderr}`));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser MCP request timed out: ${method}`));
        }, 45_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      });
    },
    async waitForExit(timeoutMs = 5_000) {
      if (exited) return exitPromise;
      return await Promise.race([
        exitPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Browser MCP server did not exit after revocation")), timeoutMs)),
      ]);
    },
    async close() {
      lines.close();
      if (exited) return;
      child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!exited) child.kill("SIGTERM");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function readSmokeMcpToolResult(response, toolName) {
  if (response?.error) {
    throw new Error(`${toolName} JSON-RPC failed: ${JSON.stringify(response.error)}`);
  }
  const result = response?.result;
  if (!result || result.isError) {
    throw new Error(`${toolName} failed: ${JSON.stringify(result ?? response)}`);
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item?.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

async function writePackagedCodexMcpProbe(commandPath) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync, spawn } = require("node:child_process");

function parseManagedMcpConfig(configPath, serverName) {
  const lines = fs.readFileSync(configPath, "utf8").split(/\\r?\\n/u);
  let section = null;
  const result = { command: null, args: null, env: {} };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "[mcp_servers." + serverName + "]") {
      section = "server";
      continue;
    }
    if (line === "[mcp_servers." + serverName + ".env]") {

      section = "env";
      continue;
    }
    if (line.startsWith("[")) {
      section = null;
      continue;
    }
    if (!section || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const value = JSON.parse(line.slice(separator + 1).trim());
    if (section === "server" && key === "command") result.command = value;
    else if (section === "server" && key === "args") result.args = value;
    else if (section === "env") result.env[key] = value;
  }
  if (typeof result.command !== "string" || !Array.isArray(result.args)) {
    throw new Error("managed Codex config did not contain a runnable Rudder MCP command");
  }
  return result;
}

function createMcpClient(config) {
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  let exited = false;
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("managed MCP exited before responding (code=" + code + ", signal=" + signal + "): " + stderr));
    }
    pending.clear();
  });
  return {
    pid: child.pid,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("managed MCP request timed out: " + method + ": " + stderr));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\\n");
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\\n");
    },
    async close() {
      lines.close();
      if (exited) return;
      child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!exited) child.kill("SIGTERM");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function readToolResult(response, toolName) {
  if (response && response.error) throw new Error(toolName + " JSON-RPC failed: " + JSON.stringify(response.error));
  const result = response && response.result;
  if (!result || result.isError) throw new Error(toolName + " failed: " + JSON.stringify(result || response));
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const item = Array.isArray(result.content) ? result.content.find((entry) => entry && entry.type === "text") : null;
  return item && item.text ? JSON.parse(item.text) : {};
}

async function main() {
  const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
  const desktopCliEntryVisible = Boolean(process.env.RUDDER_DESKTOP_CLI_ENTRY);
  const configPath = path.join(process.env.CODEX_HOME, "config.toml");
  const controlConfig = parseManagedMcpConfig(configPath, "rudder-tools");
  const browserConfig = parseManagedMcpConfig(configPath, "rudder-browser");
  const expectedCommand = process.env.RUDDER_TEST_EXPECTED_MCP_COMMAND;
  const expectedRunner = process.env.RUDDER_TEST_EXPECTED_MCP_RUNNER;
  const expectsNodeMode = true;
  const expectedControlArgs = expectsNodeMode
    ? [expectedRunner, "mcp-server"]
    : ["--desktop-cli", "mcp-server"];
  const expectedBrowserArgs = expectsNodeMode
    ? [expectedRunner, "mcp-server", "--server", "browser"]
    : ["--desktop-cli", "mcp-server", "--server", "browser"];
  if (controlConfig.command !== expectedCommand || browserConfig.command !== expectedCommand) {
    throw new Error("managed Codex MCP command mismatch: " + controlConfig.command + " / " + browserConfig.command);
  }
  if (JSON.stringify(controlConfig.args) !== JSON.stringify(expectedControlArgs)) {
    throw new Error("managed Codex control MCP args mismatch: " + JSON.stringify(controlConfig.args));
  }
  if (JSON.stringify(browserConfig.args) !== JSON.stringify(expectedBrowserArgs)) {
    throw new Error("managed Codex Browser MCP args mismatch: " + JSON.stringify(browserConfig.args));
  }
  if (expectsNodeMode && (
    controlConfig.env.ELECTRON_RUN_AS_NODE !== "1"
    || browserConfig.env.ELECTRON_RUN_AS_NODE !== "1"
  )) {
    throw new Error("managed Codex MCP config did not enable Electron Node mode");
  }
  if (desktopCliEntryVisible) throw new Error("provider inherited RUDDER_DESKTOP_CLI_ENTRY");

  const controlClient = createMcpClient(controlConfig);
  const browserClient = createMcpClient(browserConfig);
  try {
    const controlInitialized = await controlClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "packaged-codex-control-probe", version: "1" },
    });
    controlClient.notify("notifications/initialized", {});
    const controlListed = await controlClient.request("tools/list", {});
    const initialized = await browserClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "packaged-codex-probe", version: "1" },
    });
    browserClient.notify("notifications/initialized", {});
    const listed = await browserClient.request("tools/list", {});
    if (process.platform === "darwin") {
      const runningApps = execFileSync("/usr/bin/lsappinfo", ["list"], { encoding: "utf8" });
      for (const pid of [controlClient.pid, browserClient.pid]) {
        if (runningApps.includes("pid = " + pid + " ")) {
          throw new Error("managed MCP process registered as a foreground macOS app: " + pid);
        }
      }
    }
    const browserToolNames = listed.result.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("rudder_browser_"));
    const controlBrowserToolNames = controlListed.result.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("rudder_browser_"));
    if (controlBrowserToolNames.length !== 0) throw new Error("core surface exposed Browser tools");
    const opened = readToolResult(await browserClient.request("tools/call", {
      name: "rudder_browser_open",
      arguments: { url: process.env.RUDDER_TEST_BROWSER_URL },
    }), "rudder_browser_open");
    const snapshot = readToolResult(await browserClient.request("tools/call", {
      name: "rudder_browser_read",
      arguments: { tabId: opened.tabId },
    }), "rudder_browser_read");
    readToolResult(await browserClient.request("tools/call", {
      name: "rudder_browser_close",
      arguments: { tabId: opened.tabId },
    }), "rudder_browser_close");
    fs.writeFileSync(capturePath, JSON.stringify({
      browserToolNames,
      command: browserConfig.command,
      controlContract: controlInitialized.result.capabilities.experimental.rudder,
      contract: initialized.result.capabilities.experimental.rudder,
      desktopCliEntryVisible,
      snapshotText: snapshot.text,
    }), "utf8");
  } finally {
    await Promise.all([controlClient.close(), browserClient.close()]);
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "packaged-codex-probe" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "packaged adapter MCP probe passed" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
}

process.stdin.resume();
process.stdin.on("end", () => {
  void main().catch((error) => {
    const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
    if (capturePath) {
      fs.writeFileSync(capturePath, JSON.stringify({
        desktopCliEntryVisible: Boolean(process.env.RUDDER_DESKTOP_CLI_ENTRY),
        error: error instanceof Error ? error.message : String(error),
      }), "utf8");
    }
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
});
`;
  await writeFile(commandPath, script, "utf8");
  await chmod(commandPath, 0o755);
}

async function verifyPackagedExternalRuntimeAdapterBrowser(input) {
  const probeRoot = path.join(input.packagedRuntime.userDataDir, "external-adapter-probe");
  const workspace = path.join(probeRoot, "workspace");
  const sharedCodexHome = path.join(probeRoot, "shared-codex-home");
  const commandPath = path.join(probeRoot, "fake-codex.cjs");
  const capturePath = path.join(probeRoot, "capture.json");
  await mkdir(workspace, { recursive: true });
  await mkdir(sharedCodexHome, { recursive: true });
  await writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"desktop-smoke"}\n', "utf8");
  await writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
  await writePackagedCodexMcpProbe(commandPath);

  const envKeys = [
    "CODEX_HOME",
    "HOME",
    "PATH",
    "RUDDER_API_URL",
    "RUDDER_DESKTOP_CLI_ENTRY",
    "RUDDER_HOME",
    "RUDDER_IN_WORKTREE",
    "RUDDER_OPERATOR_HOME",
    "RUDDER_RUNTIME_TMPDIR",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.CODEX_HOME = sharedCodexHome;
  process.env.HOME = probeRoot;
  process.env.PATH = input.packagedRuntime.env.PATH;
  process.env.RUDDER_API_URL = input.baseUrl;
  process.env.RUDDER_DESKTOP_CLI_ENTRY = input.packagedRuntime.cliEntry;
  process.env.RUDDER_HOME = path.join(probeRoot, "rudder-home");
  delete process.env.RUDDER_IN_WORKTREE;
  process.env.RUDDER_OPERATOR_HOME = probeRoot;
  process.env.RUDDER_RUNTIME_TMPDIR = path.join(probeRoot, "tmp");

  try {
    const adapter = await import(pathToFileURL(input.packagedRuntime.codexAdapterEntry).href);
    let rudderMcpMetadata = null;
    let browserMcpMetadata = null;
    const result = await adapter.execute({
      runId: input.runId,
      agent: {
        id: input.agent.id,
        orgId: input.company.id,
        name: input.agent.name,
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: commandPath,
        cwd: workspace,
        rudderBrowserEnabled: true,
        env: {
          RUDDER_TEST_BROWSER_URL: `${input.fixtureUrl}/agent`,
          RUDDER_TEST_CAPTURE_PATH: capturePath,
          RUDDER_TEST_EXPECTED_MCP_COMMAND: input.packagedRuntime.executablePath,
          RUDDER_TEST_EXPECTED_MCP_RUNNER: input.packagedRuntime.cliRunner,
        },
        promptTemplate: "Verify the packaged Rudder MCP provider wiring.",
      },
      context: {},
      authToken: input.token,
      onLog: async () => {},
      onMeta: async (metadata) => {
        rudderMcpMetadata = metadata.rudderMcp;
        browserMcpMetadata = metadata.browserMcp;
      },
    });
    assert.equal(result.exitCode, 0, `packaged external-runtime Codex adapter failed: ${result.errorMessage ?? "unknown"}`);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(capture.desktopCliEntryVisible, false, "provider must not inherit the private Desktop CLI entry");
    assert.equal(capture.command, input.packagedRuntime.executablePath, "provider MCP config must use packaged Desktop CLI");
    assert.deepEqual(capture.browserToolNames, expectedBrowserToolNames, "provider MCP config should expose exact Browser tools");
    assert.match(capture.snapshotText, /Rudder Browser fixture/, "provider MCP config should read the Browser fixture");
    assert.equal(rudderMcpMetadata.available, true, "packaged adapter metadata should keep core Rudder MCP available");
    assert.equal(capture.contract.browserContractHash, browserMcpMetadata.contractHash, "provider Browser handshake and Browser adapter metadata must agree");
    assert.equal(browserMcpMetadata.available, true, "packaged adapter metadata should keep Browser MCP available");
    assert.equal(browserMcpMetadata.provenance, "desktop_bundle", "packaged Browser metadata should report Desktop provenance");
    assert.equal(browserMcpMetadata.version, input.packagedRuntime.serverVersion, "packaged Browser metadata version should match runtime cache");
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readSmokeMcpToolError(response, toolName) {
  const result = response?.result;
  assert.equal(result?.isError, true, `${toolName} should return an MCP tool error`);
  const text = result.content?.find((item) => item?.type === "text")?.text;
  const payload = text ? JSON.parse(text) : result.structuredContent ?? {};
  assert.equal(typeof payload.code, "string", `${toolName} should return a stable Browser error code`);
  return payload;
}

function findBrowserSnapshotNode(root, predicate) {
  if (!root || typeof root !== "object") return null;
  if (predicate(root)) return root;
  for (const child of Array.isArray(root.children) ? root.children : []) {
    const match = findBrowserSnapshotNode(child, predicate);
    if (match) return match;
  }
  return null;
}

async function verifyAgentBrowserBroker(electronApp, baseUrl, databaseUrl, company, agent, packagedRuntime = null) {
  console.log("[desktop-smoke] verifying complete Agent Browser MCP parity workflow");
  const fixture = await startBrowserSmokeFixture();
  const debugAsset = await createSmokeDebugAsset(baseUrl, company.id);
  const postgres = await loadPostgres();
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const observeAgentBrowserDialog = (windowPage) => {
    windowPage.on("dialog", () => {
      // Rudder owns Agent Browser dialog handling; Playwright must only observe it.
    });
  };
  electronApp.on("window", observeAgentBrowserDialog);
  const runId = randomUUID();
  try {
    await sql`
      insert into heartbeat_runs (id, org_id, agent_id, invocation_source, status, started_at)
      values (${runId}::uuid, ${company.id}::uuid, ${agent.id}::uuid, 'desktop_smoke', 'running', now())
    `;
    const token = createSmokeAgentJwt(agent.id, company.id, runId);
    if (packagedRuntime) {
      await verifyPackagedExternalRuntimeAdapterBrowser({
        agent,
        baseUrl,
        company,
        fixtureUrl: fixture.url,
        packagedRuntime,
        runId,
        token,
      });
      console.log("[desktop-smoke] external-runtime Codex adapter used packaged MCP config for Browser open/read/close");
    }
    const mcp = await createSmokeMcpClient({
      RUDDER_AGENT_ID: agent.id,
      RUDDER_API_KEY: token,
      RUDDER_API_URL: baseUrl,
      RUDDER_BROWSER_ENABLED: "true",
      RUDDER_ORG_ID: company.id,
      RUDDER_RUN_ID: runId,
    });
    try {
      await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "desktop-smoke", version: "1" } });
      const listed = await mcp.request("tools/list");
      const browserToolNames = listed.result.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("rudder_browser_"));
      assert.equal(browserToolNames.length, 25, "Agent Browser MCP should expose the safe Browser tool surface");
      const userTabs = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_user_tabs",
        arguments: {},
      }), "rudder_browser_user_tabs");
      assert.ok(Array.isArray(userTabs.tabs), "Agent Browser should return the user-visible built-in Browser tab inventory");
      for (const tab of userTabs.tabs) {
        const summarizedUrl = new URL(tab.url);
        assert.equal(tab.title, summarizedUrl.hostname, "user Browser tab titles should be privacy-safe hostnames");
        assert.equal(summarizedUrl.pathname, "/", "user Browser tabs should not expose paths");
        assert.equal(summarizedUrl.search, "", "user Browser tabs should not expose queries");
        assert.equal(summarizedUrl.hash, "", "user Browser tabs should not expose fragments");
        assert.equal(summarizedUrl.username, "", "user Browser tabs should not expose URL credentials");
        assert.equal(summarizedUrl.password, "", "user Browser tabs should not expose URL credentials");
      }

      const rejectedFileOpen = await mcp.request("tools/call", {
        name: "rudder_browser_open",
        arguments: { url: pathToFileURL(path.join(tmpRoot, "agent-browser-denied.html")).href },
      });
      assert.equal(rejectedFileOpen.result?.isError, true, "Agent Browser must reject local file URLs");
      assert.ok(
        ["browser_invalid_argument", "browser_unsafe_url"].includes(rejectedFileOpen.result?.structuredContent?.code),
        "Agent Browser must classify local file URLs as invalid or unsafe",
      );

      const localRudderAssetOpen = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_open",
        arguments: {
          url: new URL(debugAsset.contentPath, baseUrl).href,
        },
      }), "rudder_browser_open local Rudder asset URL");
      assert.equal(
        typeof localRudderAssetOpen.tabId,
        "string",
        "Agent Browser should allow local Rudder asset URLs for debugging",
      );
      const downloadedDebugAsset = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_download",
        arguments: {
          tabId: localRudderAssetOpen.tabId,
          mode: "media",
          locator: { strategy: "css", value: "img" },
        },
      }), "rudder_browser_download local Rudder asset");
      assert.equal(
        downloadedDebugAsset.contentType,
        "image/png",
        "Agent Browser should preserve the local Rudder asset content type",
      );
      assert.equal(
        downloadedDebugAsset.byteSize,
        smokeDebugPng.length,
        "Agent Browser should download the complete local Rudder asset",
      );
      const downloadedDebugAssetBytes = await readFile(downloadedDebugAsset.path);
      assert.deepEqual(
        downloadedDebugAssetBytes.subarray(0, 8),
        smokeDebugPng.subarray(0, 8),
        "Agent Browser should receive a PNG signature from the local Rudder asset",
      );
      assert.deepEqual(
        downloadedDebugAssetBytes,
        smokeDebugPng,
        "Agent Browser should receive the rendered local Rudder asset bytes",
      );
      await mcp.request("tools/call", {
        name: "rudder_browser_close",
        arguments: { tabId: localRudderAssetOpen.tabId },
      });

      const opened = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_open",
        arguments: { url: `${fixture.url}/agent` },
      }), "rudder_browser_open");
      assert.equal(typeof opened.tabId, "string", "Agent Browser open should return a tab id");

      const viewport = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_viewport",
        arguments: { action: "set", width: 390, height: 844 },
      }), "rudder_browser_viewport");
      assert.deepEqual(viewport.viewport, { width: 390, height: 844 }, "Agent Browser should apply a run viewport override");

      const domSnapshot = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_snapshot",
        arguments: { tabId: opened.tabId, boxes: true, depth: 20, maxNodes: 2000 },
      }), "rudder_browser_snapshot");
      const serializedSnapshot = JSON.stringify(domSnapshot);
      for (const secret of ["password-secret-value", "hidden-secret-value", "attribute-secret-value", "server-cookie-secret", "local-storage-secret", "session-storage-secret"]) {
        assert.equal(serializedSnapshot.includes(secret), false, `Agent Browser snapshot should not expose ${secret}`);
      }
      let cuaButton = findBrowserSnapshotNode(domSnapshot.root, (node) => node.name === "CUA action");
      const domButton = findBrowserSnapshotNode(domSnapshot.root, (node) => node.name === "DOM action");
      let continueButton = findBrowserSnapshotNode(domSnapshot.root, (node) => node.name === "Continue");
      let checkControl = findBrowserSnapshotNode(domSnapshot.root, (node) => node.name === "Accept smoke terms");
      let selectControl = findBrowserSnapshotNode(domSnapshot.root, (node) => node.name === "Smoke color");
      let dialogButton = findBrowserSnapshotNode(domSnapshot.root, (node) => node.name === "Open prompt");
      assert.ok(cuaButton?.box, "Agent Browser snapshot should include a CUA target box");
      assert.ok(continueButton?.box, "Agent Browser snapshot should include a Continue target box");
      assert.ok(checkControl?.box, "Agent Browser snapshot should include a checkbox target box");
      assert.ok(selectControl?.box, "Agent Browser snapshot should include a select target box");
      assert.ok(dialogButton?.box, "Agent Browser snapshot should include a dialog target box");
      assert.equal(typeof domButton?.nodeId, "string", "Agent Browser snapshot should include a DOM CUA node id");

      const continueCount = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: {
          tabId: opened.tabId,
          action: "count",
          locator: { strategy: "role", value: "button", name: "Continue", exact: true },
        },
      }), "rudder_browser_locator");
      assert.equal(continueCount.count, 1, "semantic role locator should be unique");

      const placeholder = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: {
          tabId: opened.tabId,
          action: "attribute",
          locator: { strategy: "testId", value: "smoke-input" },
          name: "placeholder",
        },
      }), "rudder_browser_locator attribute");
      assert.equal(placeholder.value, "Search fixture", "locator attribute reads should remain available");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: {
          tabId: opened.tabId,
          action: "wait",
          locator: { strategy: "testId", value: "continue" },
          state: "visible",
          timeoutMs: 5_000,
        },
      }), "rudder_browser_locator wait");

      const rejectedLocatorClick = await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: {
          tabId: opened.tabId,
          action: "click",
          locator: { strategy: "testId", value: "continue" },
        },
      });
      assert.equal(rejectedLocatorClick.result?.isError, true, "mutating locator actions should fail closed");

      const initialRead = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_read",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_read before type");
      const inputRef = initialRead.refs.find((ref) => ref.name === "Search fixture");
      assert.equal(typeof inputRef?.ref, "string", "high-level read should return a Smoke input ref");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_type",
        arguments: { tabId: opened.tabId, ref: inputRef.ref, text: "rudder high-level" },
      }), "rudder_browser_type");

      const checkboxRead = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_read",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_read before checkbox click");
      const checkboxRef = checkboxRead.refs.find((ref) => ref.name === "Accept smoke terms");
      assert.equal(typeof checkboxRef?.ref, "string", "high-level read should return a checkbox ref");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_click",
        arguments: { tabId: opened.tabId, ref: checkboxRef.ref },
      }), "rudder_browser_click checkbox");

      const interactionSnapshot = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_snapshot",
        arguments: { tabId: opened.tabId, boxes: true, depth: 20, maxNodes: 2_000 },
      }), "rudder_browser_snapshot after type");
      cuaButton = findBrowserSnapshotNode(interactionSnapshot.root, (node) => node.name === "CUA action");
      continueButton = findBrowserSnapshotNode(interactionSnapshot.root, (node) => node.name === "Continue");
      checkControl = findBrowserSnapshotNode(interactionSnapshot.root, (node) => node.name === "Accept smoke terms");
      selectControl = findBrowserSnapshotNode(interactionSnapshot.root, (node) => node.name === "Smoke color");
      dialogButton = findBrowserSnapshotNode(interactionSnapshot.root, (node) => node.name === "Open prompt");
      assert.ok(cuaButton?.box && continueButton?.box && checkControl?.box && selectControl?.box && dialogButton?.box,
        "interaction coordinates should come from a fresh post-type snapshot");

      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_cua",
        arguments: {
          tabId: opened.tabId,
          action: "click",
          x: continueButton.box.x + continueButton.box.width / 2,
          y: continueButton.box.y + continueButton.box.height / 2,
        },
      }), "rudder_browser_cua trusted click");

      const trusted = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "innerText", locator: { strategy: "css", value: "#trusted-result" } },
      }), "rudder_browser_locator trusted click result");
      assert.equal(trusted.value, "trusted", "explicit CUA click should use trusted Chromium input");

      const checkedState = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "checked", locator: { strategy: "css", value: "#smoke-check" } },
      }), "rudder_browser_locator checked state");
      const selectedState = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "selected", locator: { strategy: "css", value: "#smoke-select" } },
      }), "rudder_browser_locator selected state");
      assert.equal(checkedState.value, true, "locator checked should observe checkbox state");
      assert.deepEqual(selectedState.value, ["red"], "locator selected should observe select state without mutating it");

      const rejectedDomClick = await mcp.request("tools/call", {
        name: "rudder_browser_dom_cua",
        arguments: { tabId: opened.tabId, action: "click", nodeId: domButton.nodeId },
      });
      assert.equal(rejectedDomClick.result?.isError, true, "DOM CUA node interaction should fail closed");
      const domRead = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_read",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_read before click");
      const domButtonRef = domRead.refs.find((ref) => ref.name === "DOM action");
      assert.equal(typeof domButtonRef?.ref, "string", "high-level read should return a DOM action ref");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_click",
        arguments: { tabId: opened.tabId, ref: domButtonRef.ref },
      }), "rudder_browser_click DOM action");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_cua",
        arguments: {
          tabId: opened.tabId,
          action: "click",
          x: cuaButton.box.x + cuaButton.box.width / 2,
          y: cuaButton.box.y + cuaButton.box.height / 2,
        },
      }), "rudder_browser_cua");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_wait",
        arguments: { tabId: opened.tabId, text: "continued", timeoutMs: 5000 },
      }), "rudder_browser_wait");
      const cuaCount = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "innerText", locator: { strategy: "css", value: "#cua-result" } },
      }), "rudder_browser_locator CUA result");
      const domCount = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "innerText", locator: { strategy: "css", value: "#dom-result" } },
      }), "rudder_browser_locator DOM result");
      assert.deepEqual({ cua: cuaCount.value, dom: domCount.value }, { cua: "1", dom: "1" });
      const elementInfo = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_cua",
        arguments: {
          tabId: opened.tabId,
          action: "elementInfo",
          x: cuaButton.box.x + cuaButton.box.width / 2,
          y: cuaButton.box.y + cuaButton.box.height / 2,
        },
      }), "rudder_browser_cua elementInfo");
      assert.ok(elementInfo.elements.some((element) => element.name === "CUA action"), "coordinate inspection should describe the target element");

      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_clipboard",
        arguments: { action: "writeText", text: "virtual clipboard only" },
      }), "rudder_browser_clipboard writeText");
      const clipboard = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_clipboard",
        arguments: { action: "readText" },
      }), "rudder_browser_clipboard readText");
      assert.equal(clipboard.text, "virtual clipboard only", "virtual Browser clipboard should round-trip text");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const clipboardProbe = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "innerText", locator: { strategy: "css", value: "#clipboard-probe" } },
      }), "rudder_browser_locator hostile clipboard probe");
      assert.equal(clipboardProbe.value, "unreadable", "page JavaScript must not read the run clipboard");

      const logs = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_logs",
        arguments: { tabId: opened.tabId, levels: ["warn"], filter: "fixture-continued", limit: 20 },
      }), "rudder_browser_logs");
      assert.ok(logs.logs.some((entry) => entry.message.includes("fixture-continued")), "Agent Browser should capture page console warnings");

      const assets = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_assets",
        arguments: { tabId: opened.tabId, action: "list" },
      }), "rudder_browser_assets list");
      const imageAsset = assets.assets.find((asset) => asset.url.endsWith("/asset.png"));
      assert.ok(imageAsset, "page asset inventory should include the fixture image");
      const bundle = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_assets",
        arguments: { tabId: opened.tabId, action: "bundle", inventoryId: assets.id, assetIds: [imageAsset.id] },
      }), "rudder_browser_assets bundle");
      assert.equal(bundle.summary.downloadedCount, 1, "page asset bundle should download the selected image");
      assert.equal(await pathExists(bundle.manifestPath), true, "page asset bundle should write a manifest");
      const contentExport = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_content",
        arguments: { tabId: opened.tabId, format: "text" },
      }), "rudder_browser_content");
      assert.equal(await pathExists(contentExport.path), true, "page content export should write a run-owned artifact");
      assert.match(await readFile(contentExport.path, "utf8"), /Rudder Browser fixture/, "content export should contain the current page");

      const mediaDownload = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_download",
        arguments: { tabId: opened.tabId, mode: "media", locator: { strategy: "css", value: "img.hero" } },
      }), "rudder_browser_download media");
      assert.equal(await pathExists(mediaDownload.path), true, "media download should write a run-owned artifact");
      const rejectedTriggeredDownload = await mcp.request("tools/call", {
        name: "rudder_browser_download",
        arguments: { tabId: opened.tabId, mode: "trigger", locator: { strategy: "css", value: "#download-link" }, timeoutMs: 10000 },
      });
      assert.equal(rejectedTriggeredDownload.result?.isError, true, "locator-triggered downloads should fail closed");

      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_cua",
        arguments: {
          tabId: opened.tabId,
          action: "click",
          x: dialogButton.box.x + dialogButton.box.width / 2,
          y: dialogButton.box.y + dialogButton.box.height / 2,
        },
      }), "rudder_browser_cua dialog click");
      const openedDialog = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_dialog",
        arguments: { tabId: opened.tabId, action: "get" },
      }), "rudder_browser_dialog get");
      assert.equal(openedDialog.dialog?.type, "confirm", "explicit CUA should open the confirmation dialog once");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_dialog",
        arguments: { tabId: opened.tabId, action: "accept" },
      }), "rudder_browser_dialog accept");
      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_wait",
        arguments: { tabId: opened.tabId, text: "accepted", timeoutMs: 5000 },
      }), "rudder_browser_wait prompt result");
      const promptResult = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "innerText", locator: { strategy: "css", value: "#prompt-result" } },
      }), "rudder_browser_locator prompt result");
      assert.equal(promptResult.value, "accepted", "Electron confirmation should use the native dialog callback");
      const cookieProbe = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_locator",
        arguments: { tabId: opened.tabId, action: "innerText", locator: { strategy: "css", value: "#cookie-probe" } },
      }), "rudder_browser_locator prompt cookie probe");
      assert.equal(cookieProbe.value, "none", "prompt response must not leave a page-readable cookie");
      assert.equal(fixture.observedCookies.some((value) => value.includes("__rudder_prompt") || value.includes("YWNjZXB0ZWQ")), false, "prompt response must not be sent to the origin");

      const viewportScreenshot = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_screenshot",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_screenshot viewport");
      assert.deepEqual([viewportScreenshot.width, viewportScreenshot.height], [390, 844], "viewport screenshot should report responsive dimensions");
      const fullScreenshot = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_screenshot",
        arguments: { tabId: opened.tabId, fullPage: true },
      }), "rudder_browser_screenshot full page");
      assert.ok(fullScreenshot.height > 844, "full-page screenshot should exceed the viewport height");
      const elementScreenshot = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_screenshot",
        arguments: { tabId: opened.tabId, locator: { strategy: "css", value: "#continue" } },
      }), "rudder_browser_screenshot locator");
      assert.ok(elementScreenshot.width > 0 && elementScreenshot.height > 0, "locator screenshot should report element dimensions");

      const snapshot = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_read",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_read");
      assert.match(snapshot.text, /Rudder Browser fixture/, "Agent Browser should read the fixture page");
      assert.ok(snapshot.refs.some((ref) => ref.name === "Continue"), "Agent Browser should return bounded element refs");

      const foreignRunId = randomUUID();
      await sql`
        insert into heartbeat_runs (id, org_id, agent_id, invocation_source, status, started_at)
        values (${foreignRunId}::uuid, ${company.id}::uuid, ${agent.id}::uuid, 'desktop_smoke_foreign', 'running', now())
      `;
      const foreignMcp = await createSmokeMcpClient({
        RUDDER_AGENT_ID: agent.id,
        RUDDER_API_KEY: createSmokeAgentJwt(agent.id, company.id, foreignRunId),
        RUDDER_API_URL: baseUrl,
        RUDDER_BROWSER_ENABLED: "true",
        RUDDER_ORG_ID: company.id,
        RUDDER_RUN_ID: foreignRunId,
      });
      try {
        await foreignMcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "desktop-smoke-foreign", version: "1" } });
        const denied = readSmokeMcpToolError(await foreignMcp.request("tools/call", {
          name: "rudder_browser_snapshot",
          arguments: { tabId: opened.tabId },
        }), "rudder_browser_snapshot foreign run");
        assert.equal(denied.code, "browser_tab_forbidden", "another run must not inspect the tab");
      } finally {
        await foreignMcp.close();
        await sql`update heartbeat_runs set status = 'succeeded', finished_at = now(), updated_at = now() where id = ${foreignRunId}::uuid`.catch(() => {});
      }

      const navigated = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_navigate",
        arguments: { tabId: opened.tabId, url: `${fixture.url}/second` },
      }), "rudder_browser_navigate");
      assert.match(navigated.url, /\/second$/, "Agent Browser should navigate to the second fixture page");

      const backed = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_back",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_back");
      assert.match(backed.url, /\/agent$/, "Agent Browser should navigate back through real Electron history");

      const forwarded = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_forward",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_forward");
      assert.match(forwarded.url, /\/second$/, "Agent Browser should navigate forward through real Electron history");

      const reloaded = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_reload",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_reload");
      assert.match(reloaded.url, /\/second$/, "Agent Browser should reload the active page");

      const coreMcp = await createSmokeMcpClient({
        RUDDER_AGENT_ID: agent.id,
        RUDDER_API_KEY: token,
        RUDDER_API_URL: baseUrl,
        RUDDER_ORG_ID: company.id,
        RUDDER_RUN_ID: runId,
      }, "core");
      try {
        await coreMcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "desktop-smoke-core", version: "1" } });
        const coreToolsBeforeDisable = await coreMcp.request("tools/list");
        const coreToolNamesBeforeDisable = coreToolsBeforeDisable.result.tools
          .map((tool) => tool.name)
          .sort();
        const disabledResponse = await fetch(`${baseUrl}/api/instance/settings/browser`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        });
        assert.equal(disabledResponse.status, 200, "Desktop smoke should disable Browser settings");
        await mcp.waitForExit(8_000);
        const coreTools = await coreMcp.request("tools/list");
        assert.deepEqual(
          coreTools.result.tools.map((tool) => tool.name).sort(),
          coreToolNamesBeforeDisable,
          "core MCP should remain unchanged after Browser disable",
        );
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        assert.equal(await pathExists(bundle.directoryPath), false, "live disable should clean page-asset artifacts");
        assert.equal(await pathExists(contentExport.directoryPath), false, "live disable should clean content-export artifacts");
        assert.equal(await pathExists(mediaDownload.directoryPath), false, "live disable should clean media-download artifacts");

        const reenabledResponse = await fetch(`${baseUrl}/api/instance/settings/browser`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
        assert.equal(reenabledResponse.status, 200, "Desktop smoke should restore Browser settings");
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        const freshBrowserMcp = await createSmokeMcpClient({
          RUDDER_AGENT_ID: agent.id,
          RUDDER_API_KEY: token,
          RUDDER_API_URL: baseUrl,
          RUDDER_BROWSER_ENABLED: "true",
          RUDDER_ORG_ID: company.id,
          RUDDER_RUN_ID: runId,
        });
        try {
          await freshBrowserMcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "desktop-smoke-fresh-browser", version: "1" } });
          const reopenedSurface = readSmokeMcpToolResult(await freshBrowserMcp.request("tools/call", {
            name: "rudder_browser_tabs",
            arguments: {},
          }), "fresh rudder_browser_tabs after re-enable");
          assert.deepEqual(reopenedSurface.tabs, [], "re-enabled Browser should require a fresh MCP with no prior tabs");
        } finally {
          await freshBrowserMcp.close();
        }
      } finally {
        await coreMcp.close();
      }
    } finally {
      await mcp.close();
    }
    console.log("[desktop-smoke] Agent Browser MCP completed full parity, isolation, and live-disable workflow");
  } finally {
    electronApp.off("window", observeAgentBrowserDialog);
    await sql`update heartbeat_runs set status = 'succeeded', finished_at = now(), updated_at = now() where id = ${runId}::uuid`.catch(() => {});
    await sql.end({ timeout: 2 }).catch(() => {});
    await fixture.stop().catch(() => {});
  }
}

async function runDesktopCliCommand(executablePath, args, env) {
  return await new Promise((resolve, reject) => {
    const packagedRunner = resolvePackagedCliRunner(executablePath);
    const child = spawn(executablePath, [
      packagedRunner,
      ...args,
    ], {
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`desktop CLI exited with signal ${signal}\n${stderr}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`desktop CLI exited with code ${code ?? 1}\n${stderr}`));
        return;
      }
      resolve({
        stdout,
        stderr,
      });
    });
  });
}

function resolvePackagedCliRunner(executablePath) {
  const resourcesDir = process.platform === "darwin"
    ? path.resolve(path.dirname(executablePath), "..", "Resources")
    : path.resolve(path.dirname(executablePath), "resources");
  return path.join(resourcesDir, "server-package", "desktop-cli-runner.js");
}

async function verifyPackagedDesktopCli(baseUrl, ceo, issue) {
  console.log("[desktop-smoke] verifying packaged desktop CLI");
  const executablePath = await resolvePackagedExecutablePath();
  const key = await createAgentApiKey(baseUrl, ceo.id);
  const cliEnv = {
    ...process.env,
    RUDDER_API_URL: baseUrl,
    RUDDER_API_KEY: key.token,
    RUDDER_AGENT_ID: ceo.id,
    RUDDER_ORG_ID: ceo.orgId,
  };

  const meResult = await runDesktopCliCommand(executablePath, ["agent", "me", "--json", "--full-ids"], cliEnv);
  const me = JSON.parse(meResult.stdout);
  assert.equal(me.id, ceo.id, "packaged desktop CLI should return the authenticated agent");

  const inboxResult = await runDesktopCliCommand(executablePath, ["agent", "inbox", "--json", "--full-ids"], cliEnv);
  const inbox = JSON.parse(inboxResult.stdout);
  assert.ok(Array.isArray(inbox), "packaged desktop CLI inbox should return an array");
  assert.ok(
    inbox.some((entry) => entry.id === issue.id),
    "packaged desktop CLI inbox should include the assigned issue",
  );
}

async function assertFreshDesktopWindowSize(electronApp, context, tolerance = 64) {
  const { actual, workArea } = await waitForSmokeCondition(
    `${context} window bounds to become readable`,
    () => electronApp.evaluate(({ BrowserWindow, screen }) => ({
      actual: BrowserWindow.getAllWindows()[0]?.getSize(),
      workArea: screen.getPrimaryDisplay().workAreaSize,
    })),
  );
  const expected = PREFERRED_INITIAL_WINDOW_SIZE.map((preferred, index) => {
    const available = index === 0 ? workArea.width : workArea.height;
    const minimum = Math.min(MINIMUM_INITIAL_WINDOW_SIZE[index], available);
    return Math.max(minimum, Math.min(preferred, Math.floor(available * INITIAL_WINDOW_WORK_AREA_RATIO)));
  });
  assert.ok(actual, `${context} should expose an application window`);
  assert.equal(actual.length, expected.length);
  for (const [index, expectedDimension] of expected.entries()) {
    assert.ok(
      Math.abs(actual[index] - expectedDimension) <= tolerance,
      `${context} should open at the expected default window size: expected ${expected.join("x")} ±${tolerance}px, got ${actual.join("x")}`,
    );
  }
}

function resolveMacPackagedSmokeHomeEnv() {
  return process.platform === "darwin" && process.env.HOME
    ? { HOME: process.env.HOME }
    : {};
}

async function assertDesktopGlassShell(electronApp, page, context) {
  const rendererState = await page.evaluate(() => {
    const shellProbe = document.createElement("div");
    const primaryRailProbe = document.createElement("div");
    shellProbe.className = "app-shell-backdrop";
    primaryRailProbe.className = "primary-rail-shell";
    document.body.append(shellProbe, primaryRailProbe);
    const result = {
      platform: window.desktopShell?.platform ?? null,
      glass: document.documentElement.classList.contains("desktop-shell-glass"),
      macos: document.documentElement.classList.contains("desktop-shell-macos"),
      windows: document.documentElement.classList.contains("desktop-shell-windows"),
      captionControls: document.querySelectorAll(".desktop-caption-control").length,
      shellBackground: getComputedStyle(shellProbe).backgroundImage,
      primaryRailBackground: getComputedStyle(primaryRailProbe).backgroundImage,
    };
    shellProbe.remove();
    primaryRailProbe.remove();
    return result;
  });

  assert.equal(rendererState.glass, true, `${context} should enable the cross-platform glass shell class`);
  if (process.platform === "win32") {
    assert.equal(rendererState.platform, "win32", `${context} should expose the Windows desktop platform`);
    assert.equal(rendererState.windows, true, `${context} should enable Windows shell styling`);
    assert.equal(rendererState.macos, false, `${context} should not enable macOS-only styling on Windows`);
    assert.equal(rendererState.captionControls, 3, `${context} should render minimize, maximize, and close controls`);
    assert.match(
      rendererState.shellBackground,
      /rgba\(250,\s*248,\s*245,\s*0\.9\)/,
      `${context} should tint the Windows shell enough to prevent readable background bleed`,
    );
    assert.match(
      rendererState.primaryRailBackground,
      /rgba\(244,\s*242,\s*239,\s*0\.74\)/,
      `${context} should keep the Windows navigation rail translucent but readable`,
    );
    const cornerAlpha = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!window) return null;
      const image = await window.capturePage({ x: 0, y: 0, width: 1, height: 1 });
      return image.toBitmap()[3] ?? null;
    });
    assert.equal(cornerAlpha, 0, `${context} should keep the rounded Windows corner fully transparent`);
  }
}

async function launchDesktopWindow(userDataDir, mode, ports, extraEnv = {}, executableOverride = null) {
  console.log(`[desktop-smoke] launching ${mode} desktop app`);
  const paths = resolveInstancePaths(userDataDir);
  const executablePath = mode === "packaged"
    ? (executableOverride ? path.resolve(executableOverride) : await resolvePackagedExecutablePath())
    : electronBinary;
  // The Linux CI runner cannot use Electron's setuid sandbox helper from pnpm's store.
  const args = [
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ...(mode === "packaged" ? [] : [path.resolve(desktopDir, "dist/main.js")]),
  ];
  const smokeAppName = `Rudder-smoke-${mode}-${ports.appPort}`;
  const smokeHomeDir = path.join(userDataDir, "home");
  await mkdir(smokeHomeDir, { recursive: true });
  const electronApp = await electron.launch({
    executablePath,
    args,
    cwd: smokeHomeDir,
    env: {
      ...process.env,
      HOME: smokeHomeDir,
      RUDDER_DESKTOP_APP_NAME: smokeAppName,
      RUDDER_DESKTOP_DISABLE_CLI_LINK: "1",
      RUDDER_HOME: paths.rudderHome,
      RUDDER_DESKTOP_USER_DATA_DIR: paths.electronUserDataDir,
      RUDDER_LOCAL_ENV: "prod_local",
      RUDDER_INSTANCE_ID: "default",
      RUDDER_AGENT_JWT_AUDIENCE: smokeAgentJwtAudience,
      RUDDER_AGENT_JWT_ISSUER: smokeAgentJwtIssuer,
      RUDDER_AGENT_JWT_SECRET: smokeAgentJwtSecret,
      ...(mode === "dev" ? { RUDDER_DESKTOP_AUTH_BYPASS: "1" } : {}),
      PORT: String(ports.appPort),
      RUDDER_EMBEDDED_POSTGRES_PORT: String(ports.dbPort),
      ...extraEnv,
    },
  });
  desktopShutdownRegistry.register(electronApp, {
    appPort: ports.appPort,
    dbPort: ports.dbPort,
    postmasterPidPath: paths.postmasterPidPath,
    runtimeDescriptorPath: paths.runtimeDescriptorPath,
  });
  const appProcess = typeof electronApp.process === "function" ? electronApp.process() : null;
  let startupStdout = "";
  let startupStderr = "";
  appProcess?.stdout?.on("data", (chunk) => { startupStdout += String(chunk); });
  appProcess?.stderr?.on("data", (chunk) => { startupStderr += String(chunk); });
  let page;
  try {
    page = await electronApp.firstWindow();
  } catch (error) {
    const diagnostics = [startupStdout.trim(), startupStderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${diagnostics ? `\nPackaged Desktop startup output:\n${diagnostics}` : ""}`,
      { cause: error },
    );
  }
  await assertFreshDesktopWindowSize(electronApp, "a fresh Desktop profile");
  return { electronApp, page };
}

async function runAccountGateScenario(mode) {
  assert.equal(mode, "packaged", "the release account gate must be verified against a packaged Desktop");
  if (process.env.RUDDER_DESKTOP_SMOKE_LIFECYCLE_ACTION?.trim()) {
    await runPackagedLifecycleScenario(mode);
    return;
  }
  const scenarioRoot = path.join(tmpRoot, "account-gate");
  const residentStatusPath = path.join(scenarioRoot, "resident-shell-status.json");
  const secureStorageProbePath = path.join(scenarioRoot, "secure-storage-probe.bin");
  const ports = await allocateSmokePorts();
  const screenshotPath = browserSmokeScreenshotPath
    ? path.resolve(browserSmokeScreenshotPath)
    : path.join(os.tmpdir(), "rudder-desktop-account-gate-packaged.png");
  const emailCodeScreenshotPath = screenshotPath.replace(/(\.png)?$/, "-email-code.png");
  const { createBootScreenHtml } = await import(
    pathToFileURL(path.join(desktopDir, "dist", "boot-screen.js")).href
  );
  const brandIconDataUrl = `data:image/png;base64,${(
    await readFile(path.join(repoRoot, "ui", "public", "rudder-logo.png"))
  ).toString("base64")}`;
  const interactionFixturePath = path.join(scenarioRoot, "account-gate-interaction.html");
  await mkdir(scenarioRoot, { recursive: true });
  await writeFile(interactionFixturePath, createBootScreenHtml("Rudder", brandIconDataUrl, {
    view: "account_required",
    stage: "account_required",
    identityProviders: { google: true, github: true },
  }));
  const interactionBrowser = await chromium.launch({ headless: true });
  try {
    const context = await interactionBrowser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      let resolveEmailOtp;
      let emitState;
      window.rudderBoot = {
        sendEmailOtp: () => new Promise((resolve) => {
          resolveEmailOtp = resolve;
        }),
        onState: (listener) => {
          emitState = listener;
        },
        onIdentityState: () => undefined,
      };
      window.resolveEmailOtp = () => resolveEmailOtp?.();
      window.emitAccountRequiredState = () => emitState?.({
        view: "account_required",
        stage: "account_required",
        identityProviders: { google: true, github: true },
      });
    });
    const interactionPage = await context.newPage();
    await interactionPage.goto(pathToFileURL(interactionFixturePath).href);
    await interactionPage.getByRole("button", { name: "Continue with Google" }).waitFor();
    await interactionPage.locator("#account-email").fill("smoke@example.com");
    await interactionPage.evaluate(() => window.emitAccountRequiredState());
    assert.equal(
      await interactionPage.evaluate(() => document.activeElement?.id),
      "account-email",
      "a same-view recovery-state refresh must preserve the active auth input",
    );
    await interactionPage.getByRole("button", { name: "Continue with email" }).click();
    assert.equal(
      await interactionPage.getByRole("button", { name: "Use password instead" }).isDisabled(),
      true,
      "auth navigation must stay disabled while an email-code request is pending",
    );
    assert.equal(
      await interactionPage.locator("#account-email").isDisabled(),
      true,
      "the requested email must stay immutable while an email-code request is pending",
    );
    await interactionPage.evaluate(() => window.emitAccountRequiredState());
    assert.equal(
      await interactionPage.getByRole("button", { name: "Use password instead" }).isDisabled(),
      true,
      "a recovery-state refresh must not unlock auth navigation while a request is pending",
    );
    assert.equal(
      await interactionPage.locator("#account-email").isDisabled(),
      true,
      "a recovery-state refresh must not unlock auth inputs while a request is pending",
    );
    await interactionPage.evaluate(() => window.resolveEmailOtp());
    await interactionPage.getByRole("heading", { name: "Enter verification code" }).waitFor();
    assert.equal(
      await interactionPage.getByText(/Enter the code sent to/i).count(),
      0,
      "verification-code mode must omit the sent-code explanation",
    );
    assert.equal(
      await interactionPage.getByRole("button", { name: "Continue with Google" }).isVisible(),
      false,
      "verification-code mode must hide Google sign in",
    );
    assert.equal(
      await interactionPage.getByRole("button", { name: "Continue with GitHub" }).isVisible(),
      false,
      "verification-code mode must hide GitHub sign in",
    );
    assert.equal(
      await interactionPage.locator("#password-panel").isVisible(),
      false,
      "verification-code mode must not show the password page",
    );
    await interactionPage.screenshot({ path: emailCodeScreenshotPath, fullPage: true });
    await interactionPage.getByRole("button", { name: "Use another sign-in method" }).click();
    await interactionPage.getByRole("heading", { name: "Welcome to Rudder" }).waitFor();
    assert.equal(
      await interactionPage.getByRole("button", { name: "Continue with Google" }).isVisible(),
      true,
      "changing sign-in method must return to the provider options",
    );
    assert.equal(
      await interactionPage.getByRole("button", { name: "Continue with GitHub" }).isVisible(),
      true,
      "changing sign-in method must return to the provider options",
    );
    assert.equal(
      await interactionPage.getByRole("textbox", { name: "Email address" }).inputValue(),
      "",
      "changing sign-in method must clear the previous email",
    );
  } finally {
    await interactionBrowser.close();
  }

  const verifyProviderHandoff = async (provider) => {
    const providerKey = provider.toLowerCase();
    const providerRoot = path.join(scenarioRoot, `provider-${providerKey}`);
    const handoffPath = path.join(providerRoot, "identity-handoff.jsonl");
    const providerPorts = await allocateSmokePorts();
    await mkdir(providerRoot, { recursive: true });
    const { electronApp, page: providerPage } = await launchDesktopWindow(
      providerRoot,
      mode,
      providerPorts,
      {
        ...(process.platform === "darwin" && process.env.HOME
          ? { HOME: process.env.HOME }
          : {}),
        RUDDER_DESKTOP_SMOKE_IDENTITY_HANDOFF_PATH: handoffPath,
      },
    );
    try {
      await providerPage.waitForFunction(
        () => document.body.dataset.bootView === "account_required",
        undefined,
        { timeout: 30_000 },
      );
      await providerPage.getByRole("button", { name: `Continue with ${provider}` }).click();
      const handoff = await waitForSmokeCondition(
        `${provider} Identity browser handoff`,
        async () => {
          if (!(await pathExists(handoffPath))) return null;
          const lines = (await readFile(handoffPath, "utf8")).trim().split("\n").filter(Boolean);
          return lines.length > 0 ? JSON.parse(lines.at(-1)) : null;
        },
      );
      assert.equal(handoff.origin, "https://accounts.rudderhq.dev");
      assert.equal(handoff.pathname, "/");
      assert.deepEqual(handoff.searchParamNames, ["next"]);
      assert.equal(handoff.nextOrigin, "https://accounts.rudderhq.dev");
      assert.equal(handoff.nextPathname, "/api/desktop/authorize");
      assert.deepEqual(handoff.nextParamNames, [
        "audience",
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "login_intent",
        "redirect_uri",
        "state",
      ]);
    } finally {
      await closeDesktop(electronApp);
    }
  };

  await verifyProviderHandoff("Google");
  await verifyProviderHandoff("GitHub");

  const degradedIdentity = await createDegradedIdentitySmokeServer();
  const degradedExecutable = await createPackagedIdentitySmokeExecutable(scenarioRoot);
  const { electronApp, page } = await launchDesktopWindow(scenarioRoot, mode, ports, {
    // Electron safeStorage must use the active macOS login keychain. A synthetic
    // HOME can leave the synchronous keychain probe waiting for a keychain that
    // does not exist; Rudder and Electron data paths remain scenario-isolated.
    ...(process.platform === "darwin" && process.env.HOME
      ? { HOME: process.env.HOME }
      : {}),
    // A packaged release must ignore this development-only escape hatch.
    RUDDER_DESKTOP_AUTH_BYPASS: "1",
    RUDDER_IDENTITY_ORIGIN: degradedIdentity.origin,
    RUDDER_DESKTOP_SMOKE_RESIDENT_STATUS_PATH: residentStatusPath,
  }, degradedExecutable);
  try {
    await page.waitForFunction(
      () => document.body.dataset.bootView === "account_required",
      undefined,
      { timeout: 30_000 },
    );
    await page.getByRole("heading", { name: "Welcome to Rudder" }).waitFor();
    await page.getByRole("textbox", { name: "Email address" }).waitFor();
    await page.getByRole("button", { name: "Continue with email" }).waitFor();
    if (process.platform === "darwin") {
      const secureStorage = await electronApp.evaluate(({ safeStorage }) => {
        const available = safeStorage.isEncryptionAvailable();
        return {
          available,
          encrypted: available
            ? safeStorage.encryptString("rudder-packaged-restart-probe").toString("base64")
            : null,
        };
      });
      assert.equal(
        secureStorage.available,
        true,
        "packaged macOS Desktop must provide encrypted identity storage",
      );
      assert.ok(secureStorage.encrypted, "packaged macOS Desktop must encrypt the restart probe");
      await writeFile(secureStorageProbePath, Buffer.from(secureStorage.encrypted, "base64"), { mode: "0600" });
    }
    assert.equal(
      degradedIdentity.requests.includes("GET /api/health"),
      true,
      "packaged Desktop must probe the configured Identity health endpoint",
    );
    assert.equal(
      await page.getByRole("button", { name: "Continue with Google" }).isVisible(),
      true,
      "packaged Desktop must keep Google sign in visible when the provider probe is temporarily unavailable",
    );
    assert.equal(
      await page.getByRole("button", { name: "Continue with GitHub" }).isVisible(),
      true,
      "packaged Desktop must keep GitHub sign in visible when the provider probe is temporarily unavailable",
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    assert.equal(
      await page.getByText("Secure credential storage is unavailable on this device.", { exact: true }).count(),
      0,
      "packaged Desktop must keep secure identity storage available",
    );
    assert.equal(
      await page.getByText(/Sign in or create an account/i).count(),
      0,
      "the account gate must not show redundant introductory copy",
    );
    assert.equal(
      await page.getByText(/Signing in connects your identity and devices/i).count(),
      0,
      "the account gate must not show the removed footer explanation",
    );
    const passwordToggle = page.getByRole("button", { name: /Use password instead/ });
    await passwordToggle.click();
    assert.equal(
      await page.locator("#email-code-submit-button").isVisible(),
      false,
      "password mode must replace the email-code primary action instead of showing both",
    );
    assert.equal(
      await page.getByRole("button", { name: "Continue with Google" }).isVisible(),
      false,
      "password mode must hide Google sign in",
    );
    assert.equal(
      await page.getByRole("button", { name: "Continue with GitHub" }).isVisible(),
      false,
      "password mode must hide GitHub sign in",
    );
    await page.getByRole("heading", { name: "Sign in with password" }).waitFor();
    await page.getByRole("textbox", { name: "Email address" }).waitFor();
    await page.locator("#account-password").waitFor();
    await page.getByRole("button", { name: "Sign in with password" }).waitFor();
    await page.getByRole("button", { name: "forgot password" }).waitFor();
    assert.equal(
      await page.getByText(/password is entered securely in your browser/i).count(),
      0,
      "packaged Desktop must keep password entry native instead of directing it to a browser",
    );
    assert.equal(
      await page.locator("#account-email-code").count(),
      1,
      "packaged Desktop must include its native email-code input",
    );
    assert.equal(
      await page.locator("#password-reset-code").count(),
      1,
      "packaged Desktop must include its native password-reset input",
    );
    assert.equal(
      await page.locator("body").getAttribute("data-stage"),
      "account_required",
      "packaged Desktop should remain at the account gate while signed out",
    );
    const healthProbe = await fetch(`http://127.0.0.1:${ports.appPort}/api/health`).catch(() => null);
    assert.equal(
      healthProbe,
      null,
      "packaged Desktop must not start the Local Workspace server before account sign-in",
    );
    if (process.platform === "darwin") {
      const residentStatus = await waitForSmokeCondition(
        "packaged macOS resident shell controls",
        async () => {
          if (!(await pathExists(residentStatusPath))) return null;
          return JSON.parse(await readFile(residentStatusPath, "utf8"));
        },
      );
      assert.equal(residentStatus.enabled, true, "packaged macOS Desktop should enable resident shell controls");
      assert.equal(
        residentStatus.controlsAvailable,
        true,
        "packaged macOS Desktop should create its resident shell controls",
      );
      assert.equal(residentStatus.packaged, true, "resident shell probe should come from a packaged Desktop");
      assert.equal(residentStatus.platform, process.platform);
      assert.equal(residentStatus.iconSource, "trayTemplate.png");
      assert.equal(residentStatus.iconIsTemplate, true, "macOS menu bar icon must use template rendering");
      assert.deepEqual(residentStatus.iconSize, { width: 18, height: 18 });
      assert.ok(
        residentStatus.iconScaleFactors.includes(1) && residentStatus.iconScaleFactors.includes(2),
        "macOS menu bar icon must include both standard and Retina representations",
      );
    }
    console.log(`[desktop-smoke] packaged account gate screenshot: ${screenshotPath}`);
    console.log(`[desktop-smoke] email-code interaction screenshot: ${emailCodeScreenshotPath}`);
  } finally {
    await closeDesktop(electronApp);
    if (process.platform === "darwin") {
      const encryptedProbe = await readFile(secureStorageProbePath);
      const { electronApp: restartedApp, page: restartedPage } = await launchDesktopWindow(
        scenarioRoot,
        mode,
        ports,
        {
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
          RUDDER_IDENTITY_ORIGIN: degradedIdentity.origin,
          RUDDER_DESKTOP_SMOKE_RESIDENT_STATUS_PATH: residentStatusPath,
        },
        degradedExecutable,
      );
      try {
        await restartedPage.waitForFunction(
          () => document.body.dataset.bootView === "account_required",
          undefined,
          { timeout: 30_000 },
        );
        const decryptedProbe = await restartedApp.evaluate(
          ({ safeStorage }, encrypted) => safeStorage.decryptString(Buffer.from(encrypted, "base64")),
          encryptedProbe.toString("base64"),
        );
        assert.equal(
          decryptedProbe,
          "rudder-packaged-restart-probe",
          "packaged macOS secure storage must survive a full process restart",
        );
      } finally {
        await closeDesktop(restartedApp);
      }
    }
    await degradedIdentity.stop();
  }
}

async function runPackagedLifecycleScenario(mode) {
  assert.equal(mode, "packaged", "Desktop lifecycle acceptance requires a packaged Desktop");
  assert.equal(process.platform, "darwin", "Desktop lifecycle v1 acceptance is macOS-only");
  const action = process.env.RUDDER_DESKTOP_SMOKE_LIFECYCLE_ACTION.trim().toLowerCase();
  const scenarioRoot = path.join(tmpRoot, `lifecycle-${action}`);
  const ports = await allocateSmokePorts();
  const lifecyclePath = process.env.RUDDER_DESKTOP_SMOKE_LIFECYCLE_PATH?.trim()
    ? path.resolve(process.env.RUDDER_DESKTOP_SMOKE_LIFECYCLE_PATH)
    : path.join(scenarioRoot, "lifecycle.jsonl");
  await mkdir(scenarioRoot, { recursive: true });
  const run = await launchDesktopWindow(scenarioRoot, mode, ports, {
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_ACTION: action,
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_PATH: lifecyclePath,
  });
  try {
    const events = await waitForSmokeCondition(
      `${action} lifecycle event`,
      async () => {
        if (!(await pathExists(lifecyclePath))) return null;
        const lines = (await readFile(lifecyclePath, "utf8")).trim().split("\n").filter(Boolean);
        const events = lines.map((line) => JSON.parse(line));
        const terminalEvent = action === "auto-update-quit"
          ? "auto-update-after-helper-handoff"
          : action === "close"
            ? "window-close"
            : action === "menu-quit"
              ? "application-menu-quit-requested"
              : action === "tray-quit"
                ? "tray-quit-requested"
                : "system-shutdown-requested";
        return events.some((event) => event.event === terminalEvent) ? events : null;
      },
      { timeoutMs: 30_000 },
    );
    const expectedLifecycleEvent = action === "menu-quit"
      ? "application-menu-quit-requested"
      : action === "tray-quit"
        ? "tray-quit-requested"
        : action === "shutdown"
          ? "system-shutdown-requested"
          : action === "auto-update-quit"
            ? "natural-quit-requested"
            : "close-requested";
    assert.ok(events.some((event) => event.event === expectedLifecycleEvent));
    if (action === "close") {
      assert.equal(events.some((event) => event.event === "window-close" && event.hiddenToResident === true), true);
      assert.equal(await run.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false), false);
    }
    if (action === "menu-quit") {
      assert.equal(events.some((event) => event.event === "application-menu-quit-requested" && event.found === true), true);
      assert.equal(events.some((event) => event.event === "natural-quit-requested"), true);
    }
    if (action === "tray-quit") {
      assert.equal(events.some((event) => event.event === "tray-quit-requested" && event.found === true), true);
      assert.equal(events.some((event) => event.event === "natural-quit-requested"), true);
    }
    if (action === "shutdown") {
      assert.equal(events.some((event) => event.event === "system-shutdown-requested"), true);
      assert.equal(events.some((event) => event.event === "natural-quit-requested"), false);
    }
    if (action === "auto-update-quit") {
      assert.equal(events.some((event) => event.event === "natural-quit-requested"), true);
      assert.equal(events.some((event) => event.event === "auto-update-after-runtime-drain"), true);
      assert.equal(events.some((event) => event.event === "auto-update-after-helper-handoff"), true);
    }
    console.log(`[desktop-smoke] packaged lifecycle passed: ${action}`);
  } finally {
    await closeDesktop(run.electronApp).catch(() => {});
  }
}

function canonicalizeSmokePolicy(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeSmokePolicy).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeSmokePolicy(value[key])}`).join(",")}}`;
}

async function capturePackagedUpdateUiEvidence(electronApp, initialPage, options) {
  const evidenceDir = path.join(options.scenarioRoot, "evidence");
  const screenshotPath = path.join(evidenceDir, `${options.label}.png`);
  const metadataPath = path.join(evidenceDir, `${options.label}.json`);
  await mkdir(evidenceDir, { recursive: true });
  const page = await waitForBoardWindow(electronApp, initialPage);
  if (options.windowSize) {
    await electronApp.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    }, options.windowSize);
    await page.waitForTimeout(150);
  }
  const latest = await waitForSmokeCondition(`${options.label} exact update UI phase`, async () => (
    page.evaluate(async ({ messageIncludes, phase }) => {
      const progress = await window.desktopShell?.getUpdateProgress?.();
      const statusCard = document.querySelector(
        `[data-testid="desktop-update-status-card"][data-update-phase="${phase}"]`,
      );
      const statusCardStyle = statusCard instanceof HTMLElement
        ? window.getComputedStyle(statusCard)
        : null;
      const statusCardVisible = statusCard instanceof HTMLElement
        && statusCard.getClientRects().length > 0
        && statusCardStyle?.display !== "none"
        && statusCardStyle?.visibility !== "hidden"
        && statusCardStyle?.opacity !== "0";
      if (!progress || progress.phase !== phase || !statusCardVisible
        || (messageIncludes && !progress.message.includes(messageIncludes))) {
        return null;
      }
      return {
        progress,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        theme: {
          preference: window.localStorage.getItem("rudder.theme") ?? "system",
          resolved: document.documentElement.classList.contains("dark") ? "dark" : "light",
          accent: document.documentElement.dataset.themeColor ?? null,
        },
        statusCardVisible: true,
      };
    }, { messageIncludes: options.messageIncludes ?? null, phase: options.phase }).catch(() => null)
  ), { timeoutMs: options.timeoutMs ?? 90_000 });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const evidence = {
    assetKind: options.assetKind,
    captureKind: "exact",
    screenshotPath,
    ...latest,
  };
  await writeFile(metadataPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(
    `[desktop-smoke] ${options.label} UI evidence: ${screenshotPath} metadata=${metadataPath} phase=${latest.progress.phase} viewport=${latest.viewport.width}x${latest.viewport.height}@${latest.viewport.devicePixelRatio} theme=${latest.theme.preference}/${latest.theme.resolved} accent=${latest.theme.accent ?? "default"} statusCardVisible=${latest.statusCardVisible}`,
  );
  return evidence;
}

async function clonePackagedAppForUpdateSmoke(sourceAppPath, targetAppPath) {
  assert.equal(process.platform, "darwin", "packaged update clone copies are macOS-only");
  await mkdir(path.dirname(targetAppPath), { recursive: true });
  const result = await runCapturedProcess("cp", ["-cRL", sourceAppPath, targetAppPath], {
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, `packaged update clone copy failed: ${result.stderr}`);
}

async function discardCompletedAutoUpdateScenarioStorage(scenarioRoot) {
  const paths = resolveInstancePaths(scenarioRoot);
  await Promise.all([
    rm(path.join(scenarioRoot, "installed"), { recursive: true, force: true }),
    rm(paths.rudderHome, { recursive: true, force: true }),
    rm(paths.electronUserDataDir, { recursive: true, force: true }),
  ]);
}

async function runPackagedRuntimeFallbackAutoUpdateScenario(mode, fixture) {
  const scenarioRoot = path.join(tmpRoot, "auto-update-public-runtime-fallback");
  const paths = resolveInstancePaths(scenarioRoot);
  const installPath = path.join(scenarioRoot, "installed", "Rudder.app");
  const statePath = path.join(paths.electronUserDataDir, "desktop-auto-update.json");
  await clonePackagedAppForUpdateSmoke(fixture.sourceAppPath, installPath);

  const requestStart = fixture.releaseRequests.length;
  const run = await launchDesktopWindow(scenarioRoot, mode, await allocateSmokePorts(), {
    ...resolveMacPackagedSmokeHomeEnv(),
    npm_config_offline: "true",
    RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC: "1",
    RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1",
    RUDDER_DESKTOP_SMOKE_POLICY_PUBLIC_KEY: fixture.publicKeyDer,
    RUDDER_DESKTOP_UPDATE_POLICY_URL: fixture.policyUrl,
    RUDDER_DESKTOP_SMOKE_RELEASE_API_BASE_URL: fixture.releaseBaseUrl,
    RUDDER_DESKTOP_SMOKE_RELEASE_DOWNLOAD_BASE_URL: fixture.releaseBaseUrl,
    RUDDER_DESKTOP_SMOKE_RUNTIME_FALLBACK_DELAY_MS: "3000",
    RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_INSTALL_PATH: installPath,
  });
  const uiEvidencePromise = (async () => {
    await capturePackagedUpdateUiEvidence(run.electronApp, run.page, {
      assetKind: "full",
      label: "auto-update-runtime-fallback",
      messageIncludes: "continuing with the full Desktop package",
      phase: "preparing_runtime",
      scenarioRoot,
    });
    await capturePackagedUpdateUiEvidence(run.electronApp, run.page, {
      assetKind: "full",
      label: "auto-update-runtime-fallback-constrained",
      messageIncludes: "continuing with the full Desktop package",
      phase: "preparing_runtime",
      scenarioRoot,
      windowSize: { width: 980, height: 720 },
    });
  })();
  try {
    await uiEvidencePromise;
    const state = await waitForSmokeCondition("runtime-fallback automatic update candidate staged", async () => {
      if (!(await pathExists(statePath))) return null;
      const next = JSON.parse(await readFile(statePath, "utf8"));
      return next.candidate?.status === "staged" ? next : null;
    }, { timeoutMs: 90_000 });
    assert.equal(state.candidate.assetKind, "full");
    assert.equal(state.candidate.assetName, fixture.fullAssetName);
    assert.equal(state.candidate.assetChecksum, fixture.fullAssetChecksum);
    assert.equal(await pathExists(state.candidate.stagedArtifactPath), true);
    const requests = fixture.releaseRequests.slice(requestStart);
    assert.equal(requests.some((entry) => entry.path.endsWith(`/${fixture.fullAssetName}`)), true, "runtime failure must continue by downloading the authorized full asset");
    assert.equal(requests.some((entry) => entry.path.endsWith(`/${fixture.shellAssetName}`)), false, "runtime failure must not download an unusable shell asset");
    console.log(`[desktop-smoke] runtime preparation failure continued with staged full candidate ${fixture.fullAssetName}`);
  } finally {
    await uiEvidencePromise;
    await closeDesktop(run.electronApp).catch(() => {});
  }
}

async function runPackagedPublicFullOnlyAutoUpdateScenario(mode, fixture) {
  const scenarioRoot = path.join(tmpRoot, "auto-update-public-full-only");
  const paths = resolveInstancePaths(scenarioRoot);
  const installPath = path.join(scenarioRoot, "installed", "Rudder.app");
  const statePath = path.join(paths.electronUserDataDir, "desktop-auto-update.json");
  const lifecyclePath = path.join(scenarioRoot, "lifecycle.jsonl");
  const instanceSentinelPath = path.join(paths.instanceRoot, "full-update-preserved.txt");
  const instanceSentinel = "preserve-instance-data-across-full-update\n";
  await clonePackagedAppForUpdateSmoke(fixture.sourceAppPath, installPath);
  await mkdir(paths.instanceRoot, { recursive: true });
  await writeFile(instanceSentinelPath, instanceSentinel, "utf8");

  const requestStart = fixture.releaseRequests.length;
  const extraEnv = {
    ...resolveMacPackagedSmokeHomeEnv(),
    RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC: "1",
    RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1",
    RUDDER_DESKTOP_SMOKE_POLICY_PUBLIC_KEY: fixture.publicKeyDer,
    RUDDER_DESKTOP_UPDATE_POLICY_URL: fixture.fullOnlyPolicyUrl,
    RUDDER_DESKTOP_SMOKE_RELEASE_API_BASE_URL: fixture.releaseBaseUrl,
    RUDDER_DESKTOP_SMOKE_RELEASE_DOWNLOAD_BASE_URL: fixture.releaseBaseUrl,
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_ACTION: "auto-update-quit",
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_DELAY_MS: "8000",
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_PATH: lifecyclePath,
    RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_INSTALL_PATH: installPath,
  };
  fixture.beginReleaseMetadataGate();
  let run;
  try {
    run = await launchDesktopWindow(scenarioRoot, mode, await allocateSmokePorts(), extraEnv);
  } catch (error) {
    fixture.releaseReleaseMetadataGate();
    throw error;
  }
  const uiEvidencePromise = capturePackagedUpdateUiEvidence(run.electronApp, run.page, {
    assetKind: "full",
    label: "auto-update-full-only",
    phase: "resolving_release",
    scenarioRoot,
  }).finally(() => fixture.releaseReleaseMetadataGate());
  const appProcess = typeof run.electronApp.process === "function"
    ? run.electronApp.process()
    : null;
  let transactionPaths = null;
  let updateId = null;
  try {
    await waitForSmokeCondition("full-only automatic update state", async () => (
      (await pathExists(statePath)) ? true : null
    ), { timeoutMs: 90_000 });
    const state = await waitForSmokeCondition("full-only automatic update candidate staged", async () => {
      const next = JSON.parse(await readFile(statePath, "utf8"));
      return next.candidate?.status === "staged" ? next : null;
    }, { timeoutMs: 90_000 });
    const candidate = state.candidate;
    updateId = candidate.updateId;
    transactionPaths = fixture.helperModule.resolveDesktopUpdateTransactionPaths({
      userDataPath: paths.electronUserDataDir,
      transactionId: updateId,
      resourcesPath: fixture.resourcesDir,
      execPath: fixture.executablePath,
      installPath,
    });
    assert.equal(candidate.version, fixture.candidateVersion);
    assert.equal(candidate.assetName, fixture.fullAssetName);
    assert.equal(candidate.assetKind, "full");
    assert.equal(candidate.assetChecksum, fixture.fullAssetChecksum);
    assert.equal(candidate.stagedArtifactDigest, fixture.fullAssetChecksum);
    assert.equal(await pathExists(candidate.stagedArtifactPath), true, "full-only preparation should leave a downloaded cache artifact");
    assert.notEqual(path.resolve(candidate.stagedArtifactPath), path.resolve(fixture.fullAssetPath), "the app must stage the CLI download, not the full smoke fixture");
    const requests = fixture.releaseRequests.slice(requestStart);
    assert.equal(requests.some((entry) => entry.path.endsWith(`/${fixture.fullAssetName}`)), true, "full-only policy must download the full asset");
    assert.equal(requests.some((entry) => entry.path.endsWith(`/${fixture.shellAssetName}`)), false, "full-only policy must not download the unauthorized shell asset");
    await uiEvidencePromise;

    const events = await waitForSmokeCondition("full-only public natural quit", async () => {
      if (!(await pathExists(lifecyclePath))) return null;
      const entries = (await readFile(lifecyclePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return entries.some((event) => event.event === "natural-quit-requested" && event.source === "auto-update-public")
        && entries.some((event) => event.event === "auto-update-before-quit"
          && event.candidateStatus === "staged"
          && event.helperAvailable === true
          && event.policyAvailable === true)
        ? entries
        : null;
    }, { timeoutMs: 75_000 });
    assert.equal(events.some((event) => event.event === "natural-quit-requested"), true);
    const requestPath = `${transactionPaths.journalPath}.request.json`;
    await waitForSmokeCondition("full-only public helper journal", async () => {
      if (!(await pathExists(transactionPaths.journalPath))) return null;
      const journal = JSON.parse(await readFile(transactionPaths.journalPath, "utf8"));
      return journal.stage === "committed" ? journal : null;
    }, { timeoutMs: 90_000 });
    const journal = JSON.parse(await readFile(transactionPaths.journalPath, "utf8"));
    assert.equal(journal.transactionId, updateId);
    assert.equal(journal.candidateSha256, fixture.fullAssetChecksum);
    assert.equal(journal.helper.sha256, fixture.helperDigest);
    await waitForSmokeCondition("full-only public helper request consumption", async () => (
      (await pathExists(requestPath)) ? null : true
    ), { timeoutMs: 15_000 });
    assert.equal(await pathExists(transactionPaths.installPath), true, "full update must preserve the install path after helper commit");
    const installedPackage = JSON.parse(await readFile(path.join(transactionPaths.installPath, "Contents", "Resources", "app", "package.json"), "utf8"));
    const installedServerPackage = JSON.parse(await readFile(path.join(transactionPaths.installPath, "Contents", "Resources", "server-package", "package.json"), "utf8"));
    assert.equal(installedPackage.version, fixture.candidateVersion, "full helper apply must install the candidate bundle version");
    assert.equal(installedServerPackage.version, fixture.candidateVersion, "full helper apply must install the matching bundled server runtime");
    assert.equal(await readFile(instanceSentinelPath, "utf8"), instanceSentinel, "full helper apply must preserve instance data outside the app bundle");
    const committedState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(committedState.candidate, null, "committed full candidate is cleared from durable state");
    assert.equal(committedState.preparation, null, "completed full preparation lease is cleared from durable state");
    await waitForSmokeCondition("full-only public app remains closed after helper commit", async () => (
      appProcess && (appProcess.exitCode !== null || appProcess.signalCode !== null) ? true : null
    ), { timeoutMs: 15_000 });
    await closeDesktop(run.electronApp).catch(() => {});

    const installedExecutable = path.join(transactionPaths.installPath, "Contents", "MacOS", "Rudder");
    const restarted = await launchDesktopWindow(
      scenarioRoot,
      mode,
      await allocateSmokePorts(),
      {
        ...resolveMacPackagedSmokeHomeEnv(),
        RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1",
      },
      installedExecutable,
    );
    try {
      assert.equal(await restarted.electronApp.evaluate(({ app }) => app.getVersion()), fixture.candidateVersion);
      assert.equal(await readFile(instanceSentinelPath, "utf8"), instanceSentinel, "instance data must survive the first launch of the full update");
    } finally {
      await closeDesktop(restarted.electronApp).catch(() => {});
    }
    console.log(`[desktop-smoke] full-only automatic update committed ${updateId}; selected and applied ${fixture.fullAssetName} while preserving install and instance data`);
  } finally {
    fixture.releaseReleaseMetadataGate();
    await uiEvidencePromise;
    await closeDesktop(run.electronApp).catch(() => {});
  }
}

async function runPackagedPublicAutoUpdateScenario(mode) {
  assert.equal(mode, "packaged", "public automatic update acceptance requires a packaged Desktop app");
  assert.equal(process.platform, "darwin", "public automatic update acceptance is macOS-only");
  const scenarioRoot = path.join(tmpRoot, "auto-update-public");
  const paths = resolveInstancePaths(scenarioRoot);
  const executablePath = await resolvePackagedExecutablePath();
  const resourcesDir = path.resolve(path.dirname(executablePath), "..", "Resources");
  const nativeTarget = resolveNativeTarget(process.platform, process.arch);
  assert.ok(nativeTarget);
  const helperPath = path.join(resourcesDir, "native", nativeTarget, "rudder-update-helper");
  const helperModule = await import(pathToFileURL(path.join(desktopDir, "dist", "desktop-update-helper.js")).href);
  const policyKeys = generateKeyPairSync("ed25519");
  const publicKeyDer = policyKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const installPath = path.join(scenarioRoot, "installed", "Rudder.app");
  const statePath = path.join(paths.electronUserDataDir, "desktop-auto-update.json");
  const candidateVersion = "99.0.0";
  const sourceAppPath = path.resolve(executablePath, "..", "..", "..");
  const candidateAppPath = path.join(scenarioRoot, "release", "Rudder.app");
  const fullAssetName = `Rudder-${candidateVersion}-macos-arm64-portable.zip`;
  const shellAssetName = `Rudder-${candidateVersion}-macos-arm64-shell.zip`;
  const fullAssetPath = path.join(scenarioRoot, "release", fullAssetName);
  const shellAssetPath = path.join(scenarioRoot, "release", shellAssetName);
  await preparePackagedExternalRuntimeFixture(scenarioRoot, {
    authBypass: true,
    runtimeVersion: candidateVersion,
    verifyProcessHost: false,
  });
  await clonePackagedAppForUpdateSmoke(sourceAppPath, installPath);
  const installedBaseline = JSON.parse(await readFile(path.join(installPath, "Contents", "Resources", "app", "package.json"), "utf8"));
  assert.equal(installedBaseline.version, expectedReleaseVersion, "public update must replace the current installed bundle");
  await clonePackagedAppForUpdateSmoke(sourceAppPath, candidateAppPath);
  const candidatePackagePath = path.join(candidateAppPath, "Contents", "Resources", "app", "package.json");
  const candidatePackage = JSON.parse(await readFile(candidatePackagePath, "utf8"));
  candidatePackage.version = candidateVersion;
  await writeFile(candidatePackagePath, `${JSON.stringify(candidatePackage, null, 2)}\n`, "utf8");
  const candidateServerPackagePath = path.join(candidateAppPath, "Contents", "Resources", "server-package", "package.json");
  const candidateServerPackage = JSON.parse(await readFile(candidateServerPackagePath, "utf8"));
  candidateServerPackage.version = candidateVersion;
  await writeFile(candidateServerPackagePath, `${JSON.stringify(candidateServerPackage, null, 2)}\n`, "utf8");
  const candidateInfoPlistPath = path.join(candidateAppPath, "Contents", "Info.plist");
  const candidateInfoPlist = (await readFile(candidateInfoPlistPath, "utf8"))
    .replaceAll(`<string>${expectedReleaseVersion}</string>`, `<string>${candidateVersion}</string>`);
  await writeFile(candidateInfoPlistPath, candidateInfoPlist, "utf8");
  assert.equal(candidatePackage.version, candidateVersion, "candidate app package should match the update version");
  assert.equal(candidateServerPackage.version, candidateVersion, "candidate server package should match the update version");
  assert.equal(candidateInfoPlist.includes(`<string>${candidateVersion}</string>`), true, "candidate Info.plist should match the update version");
  await writeFile(
    path.join(candidateAppPath, "Contents", "Resources", "app", "releases", `v${candidateVersion}.md`),
    "## New Features\n\n- Installed by the silent update smoke candidate.\n",
    "utf8",
  );
  // This is still a real portable ZIP of the candidate bundle. Keep the
  // acceptance run bounded on developer machines by using a fast compression
  // level; release packaging continues to use the production default (9).
  const fullArchiveResult = await runCapturedProcess("ditto", macPortableZipArgs(candidateAppPath, fullAssetPath, { compressionLevel: 1 }), { timeoutMs: 120_000 });
  assert.equal(fullArchiveResult.code, 0, `public full update candidate archive failed: ${fullArchiveResult.stderr}`);
  await rm(path.join(candidateAppPath, "Contents", "Resources", "server-package"), { recursive: true, force: true });
  await rm(path.join(candidateAppPath, "Contents", "Resources", "postgres-18.4"), { recursive: true, force: true });
  const shellArchiveResult = await runCapturedProcess("ditto", macPortableZipArgs(candidateAppPath, shellAssetPath, { compressionLevel: 1 }), { timeoutMs: 120_000 });
  assert.equal(shellArchiveResult.code, 0, `public shell update candidate archive failed: ${shellArchiveResult.stderr}`);
  const helperDigest = createHash("sha256").update(await readFile(helperPath)).digest("hex");
  const fullAssetChecksum = createHash("sha256").update(await readFile(fullAssetPath)).digest("hex");
  const shellAssetChecksum = createHash("sha256").update(await readFile(shellAssetPath)).digest("hex");
  // The signed policy is keyed to the runtime platform (`darwin`), while the
  // CLI's immutable asset digest uses its download-target name (`macos`).
  // Keep those two identities distinct or a verified download will be
  // rejected during candidate authorization.
  const fullReleaseDigest = createHash("sha256").update(JSON.stringify({ releaseTag: `v${candidateVersion}`, assetName: fullAssetName, assetChecksum: fullAssetChecksum, assetKind: "full", platform: "macos", arch: "arm64" })).digest("hex");
  const shellReleaseDigest = createHash("sha256").update(JSON.stringify({ releaseTag: `v${candidateVersion}`, assetName: shellAssetName, assetChecksum: shellAssetChecksum, assetKind: "shell", platform: "macos", arch: "arm64" })).digest("hex");
  const policy = {
    schema: 1, sequence: 42, keyId: "rudder-desktop-smoke", issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), channel: "stable", platform: "darwin", arch: "arm64",
    releases: [
      { version: candidateVersion, assetName: shellAssetName, assetSha256: shellAssetChecksum, releaseDigest: shellReleaseDigest },
      { version: candidateVersion, assetName: fullAssetName, assetSha256: fullAssetChecksum, releaseDigest: fullReleaseDigest },
    ],
  };
  const policyEnvelope = { payload: policy, signature: sign(null, Buffer.from(canonicalizeSmokePolicy(policy)), policyKeys.privateKey).toString("base64url") };
  const fullOnlyPolicy = { ...policy, releases: [policy.releases[1]] };
  const fullOnlyPolicyEnvelope = { payload: fullOnlyPolicy, signature: sign(null, Buffer.from(canonicalizeSmokePolicy(fullOnlyPolicy)), policyKeys.privateKey).toString("base64url") };
  const releaseRequests = [];
  let releaseBaseUrl = null;
  let holdReleaseMetadataResponse = false;
  let heldReleaseMetadataResponse = null;
  const release = {
    tag_name: `v${candidateVersion}`,
    html_url: "http://127.0.0.1/releases/tag/v99.0.0",
    draft: false,
    prerelease: false,
    assets: [],
  };
  const policyServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", releaseBaseUrl ?? "http://127.0.0.1");
    releaseRequests.push({ method: request.method ?? "GET", path: `${requestUrl.pathname}${requestUrl.search}` });
    response.setHeader("Cache-Control", "no-store");
    if (requestUrl.pathname === "/policy.json") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(policyEnvelope)); return;
    }
    if (requestUrl.pathname === "/policy-full-only.json") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(fullOnlyPolicyEnvelope)); return;
    }
    if (requestUrl.pathname === "/repos/Undertone0809/rudder/releases") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify([release])); return;
    }
    if (requestUrl.pathname === "/repos/Undertone0809/rudder/releases/tags/v99.0.0") {
      if (holdReleaseMetadataResponse) {
        assert.equal(heldReleaseMetadataResponse, null, "only one release metadata response may be held");
        heldReleaseMetadataResponse = response;
        return;
      }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(release)); return;
    }
    const downloadPrefix = "/repos/Undertone0809/rudder/releases/download/v99.0.0/";
    if (requestUrl.pathname.startsWith(downloadPrefix)) {
      const name = decodeURIComponent(requestUrl.pathname.slice(downloadPrefix.length));
      if (name === "SHASUMS256.txt") {
        const body = `${shellAssetChecksum}  ${shellAssetName}\n${fullAssetChecksum}  ${fullAssetName}\n`;
        response.setHeader("Content-Type", "text/plain"); response.end(body); return;
      }
      if (name === shellAssetName || name === fullAssetName) {
        response.setHeader("Content-Type", "application/zip");
        createReadStream(name === shellAssetName ? shellAssetPath : fullAssetPath)
          .once("error", (error) => response.destroy(error)).pipe(response);
        return;
      }
    }
    response.statusCode = 404; response.end("not found");
  });
  await new Promise((resolve, reject) => { policyServer.once("error", reject); policyServer.listen(0, "127.0.0.1", resolve); });
  const policyAddress = policyServer.address();
  releaseBaseUrl = `http://127.0.0.1:${policyAddress.port}`;
  release.html_url = `${releaseBaseUrl}/repos/Undertone0809/rudder/releases/tag/v99.0.0`;
  release.assets = [
    { name: shellAssetName, browser_download_url: `${releaseBaseUrl}/repos/Undertone0809/rudder/releases/download/v99.0.0/${encodeURIComponent(shellAssetName)}` },
    { name: fullAssetName, browser_download_url: `${releaseBaseUrl}/repos/Undertone0809/rudder/releases/download/v99.0.0/${encodeURIComponent(fullAssetName)}` },
    { name: "SHASUMS256.txt", browser_download_url: `${releaseBaseUrl}/repos/Undertone0809/rudder/releases/download/v99.0.0/SHASUMS256.txt` },
  ];
  const policyUrl = `${releaseBaseUrl}/policy.json`;
  const lifecyclePath = path.join(scenarioRoot, "lifecycle.jsonl");
  const extraEnv = {
    ...resolveMacPackagedSmokeHomeEnv(),
    RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC: "1",
    RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1",
    RUDDER_DESKTOP_SMOKE_POLICY_PUBLIC_KEY: publicKeyDer,
    RUDDER_DESKTOP_UPDATE_POLICY_URL: policyUrl,
    RUDDER_DESKTOP_SMOKE_RELEASE_API_BASE_URL: releaseBaseUrl,
    RUDDER_DESKTOP_SMOKE_RELEASE_DOWNLOAD_BASE_URL: releaseBaseUrl,
    RUDDER_DESKTOP_SMOKE_RUNTIME_PREPARING_DELAY_MS: "3000",
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_ACTION: "auto-update-quit",
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_DELAY_MS: "8000",
    RUDDER_DESKTOP_SMOKE_LIFECYCLE_PATH: lifecyclePath,
    RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_INSTALL_PATH: installPath,
  };
  const run = await launchDesktopWindow(scenarioRoot, mode, await allocateSmokePorts(), extraEnv);
  const preparingRuntimeUiEvidencePromise = capturePackagedUpdateUiEvidence(run.electronApp, run.page, {
    assetKind: "shell",
    label: "auto-update-shell-preparing-runtime",
    messageIncludes: "Preparing the lightweight Desktop update runtime",
    phase: "preparing_runtime",
    scenarioRoot,
  });
  // Capture the child before the helper-triggered quit closes Playwright's
  // Electron connection. Calling electronApp.process() after that point can
  // race the disposed CDP object and report a false timeout.
  const appProcess = typeof run.electronApp.process === "function"
    ? run.electronApp.process()
    : null;
  let transactionPaths = null;
  let updateId = null;
  let state = null;
  try {
    await preparingRuntimeUiEvidencePromise;
    await waitForSmokeCondition("automatic update state", async () => (
      (await pathExists(statePath)) ? true : null
    ), { timeoutMs: 90_000 });
    state = await waitForSmokeCondition("automatic update candidate staged", async () => {
      const next = JSON.parse(await readFile(statePath, "utf8"));
      return next.candidate?.status === "staged" ? next : null;
    }, { timeoutMs: 90_000 });
    const candidate = state.candidate;
    updateId = candidate.updateId;
    transactionPaths = helperModule.resolveDesktopUpdateTransactionPaths({ userDataPath: paths.electronUserDataDir, transactionId: updateId, resourcesPath: resourcesDir, execPath: executablePath, installPath });
    assert.equal(candidate.version, candidateVersion);
    assert.equal(candidate.assetName, shellAssetName);
    assert.equal(candidate.assetKind, "shell");
    assert.equal(candidate.assetChecksum, shellAssetChecksum);
    assert.equal(candidate.stagedArtifactDigest, shellAssetChecksum);
    assert.equal(await pathExists(candidate.stagedArtifactPath), true, "automatic preparation should leave a downloaded cache artifact");
    assert.notEqual(path.resolve(candidate.stagedArtifactPath), path.resolve(shellAssetPath), "the app must stage the CLI download, not the shell smoke fixture");
    assert.equal(releaseRequests.some((entry) => entry.path.startsWith("/repos/Undertone0809/rudder/releases?")), true, "Desktop must perform the update-available check");
    assert.equal(releaseRequests.some((entry) => entry.path.endsWith("/releases/tags/v99.0.0")), true, "CLI must resolve release metadata");
    assert.equal(releaseRequests.some((entry) => entry.path.endsWith("/SHASUMS256.txt")), true, "CLI must download release checksums");
    assert.equal(releaseRequests.some((entry) => entry.path.endsWith(`/${shellAssetName}`)), true, "CLI must download the shell asset");
    assert.equal(releaseRequests.some((entry) => entry.path.endsWith(`/${fullAssetName}`)), false, "CLI must not download the full fallback when runtime preparation succeeds");
    const events = await waitForSmokeCondition("public natural quit", async () => {
      if (!(await pathExists(lifecyclePath))) return null;
      const events = (await readFile(lifecyclePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return events.some((event) => event.event === "natural-quit-requested" && event.source === "auto-update-public")
        && events.some((event) => event.event === "auto-update-before-quit"
          && event.candidateStatus === "staged"
          && event.helperAvailable === true
          && event.policyAvailable === true)
        ? events
        : null;
    }, { timeoutMs: 75_000 });
    assert.equal(events.some((event) => event.event === "natural-quit-requested"), true);
    const requestPath = `${transactionPaths.journalPath}.request.json`;
    await waitForSmokeCondition("public helper journal", async () => {
      if (!(await pathExists(transactionPaths.journalPath))) return null;
      const journal = JSON.parse(await readFile(transactionPaths.journalPath, "utf8"));
      return journal.stage === "committed" ? journal : null;
    }, { timeoutMs: 90_000 });
    const journal = JSON.parse(await readFile(transactionPaths.journalPath, "utf8"));
    assert.equal(journal.transactionId, updateId);
    assert.equal(journal.candidateSha256, shellAssetChecksum);
    assert.equal(journal.helper.sha256, helperDigest);
    await waitForSmokeCondition("public helper request consumption", async () => (
      (await pathExists(requestPath)) ? null : true
    ), { timeoutMs: 15_000 });
    assert.equal(await pathExists(requestPath), false, "helper request should be consumed");
    assert.equal(await pathExists(transactionPaths.installPath), true, "install remains present after helper commit");
    const installedPackage = JSON.parse(await readFile(path.join(transactionPaths.installPath, "Contents", "Resources", "app", "package.json"), "utf8"));
    assert.equal(installedPackage.version, candidateVersion, "helper must install the candidate bundle version");
    assert.equal(await pathExists(path.join(transactionPaths.installPath, "Contents", "Resources", "server-package")), false, "shell update must not install a bundled server runtime");
    const installedRuntime = JSON.parse(await readFile(path.join(paths.rudderHome, "runtimes", candidateVersion, "runtime.json"), "utf8"));
    assert.equal(installedRuntime.packageVersion, candidateVersion, "shell update must retain the matching prepared runtime");
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.candidate, null, "committed candidate is cleared from durable state");
    assert.equal(state.preparation, null, "completed preparation lease is cleared from durable state");
    await waitForSmokeCondition("public app remains closed after helper commit", async () => {
      return appProcess && (appProcess.exitCode !== null || appProcess.signalCode !== null) ? true : null;
    }, { timeoutMs: 15_000 });
    await closeDesktop(run.electronApp).catch(() => {});

    const installedExecutable = path.join(transactionPaths.installPath, "Contents", "MacOS", "Rudder");
    const firstNotesRun = await launchDesktopWindow(
      scenarioRoot,
      mode,
      await allocateSmokePorts(),
      {
        ...resolveMacPackagedSmokeHomeEnv(),
        RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1",
      },
      installedExecutable,
    );
    try {
      assert.equal(await firstNotesRun.electronApp.evaluate(({ app }) => app.getVersion()), candidateVersion);
      const firstNotesPage = await waitForBoardWindow(firstNotesRun.electronApp, firstNotesRun.page);
      const releaseNotesDialog = firstNotesPage.getByRole("dialog", { name: new RegExp(`What's new in Rudder ${candidateVersion}`) });
      await releaseNotesDialog.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(
        await releaseNotesDialog.getByText("Installed by the silent update smoke candidate.").isVisible(),
        true,
        "the first ordinary launch should expose release notes",
      );

      await firstNotesPage.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await firstNotesPage.waitForLoadState("networkidle");
      const releaseNotesAfterReload = firstNotesPage.getByRole("dialog", { name: new RegExp(`What's new in Rudder ${candidateVersion}`) });
      await releaseNotesAfterReload.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(
        await releaseNotesAfterReload.getByText("Installed by the silent update smoke candidate.").isVisible(),
        true,
        "renderer reload must keep release notes available until acknowledgement",
      );
      await releaseNotesAfterReload.getByRole("button", { name: "Continue" }).click();
      await releaseNotesAfterReload.waitFor({ state: "detached", timeout: 10_000 });
      const durableNotesState = JSON.parse(await readFile(path.join(paths.electronUserDataDir, "release-notes-state.json"), "utf8"));
      assert.equal(durableNotesState.lastKnownVersion, candidateVersion, "release notes durable state must record the installed Desktop version");
      assert.equal(durableNotesState.lastShownVersion, candidateVersion, "release notes durable state must record the acknowledged candidate version");
    } finally {
      await closeDesktop(firstNotesRun.electronApp).catch(() => {});
    }
    const secondNotesRun = await launchDesktopWindow(
      scenarioRoot,
      mode,
      await allocateSmokePorts(),
      {
        ...resolveMacPackagedSmokeHomeEnv(),
        RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1",
      },
      installedExecutable,
    );
    try {
      await secondNotesRun.page.waitForFunction(() => Boolean(window.rudderBoot?.getReleaseNotes));
      const nextLaunchNotes = await secondNotesRun.page.evaluate(() => window.rudderBoot.getReleaseNotes());
      assert.equal(nextLaunchNotes.status, "already-shown", "a later launch must not repeat release notes");
    } finally {
      await closeDesktop(secondNotesRun.electronApp).catch(() => {});
    }
    console.log("[desktop-smoke] public automatic update installed " + candidateVersion + ", left the app closed, and showed release notes exactly once across relaunch");
    console.log(`[desktop-smoke] public automatic update committed ${updateId}; update check, CLI download, state, request, journal, helper identity, and install read back`);
    await discardCompletedAutoUpdateScenarioStorage(scenarioRoot);
    await runPackagedRuntimeFallbackAutoUpdateScenario(mode, {
      fullAssetChecksum,
      fullAssetName,
      policyUrl,
      publicKeyDer,
      releaseBaseUrl,
      releaseRequests,
      shellAssetName,
      sourceAppPath,
    });
    await discardCompletedAutoUpdateScenarioStorage(
      path.join(tmpRoot, "auto-update-public-runtime-fallback"),
    );
    await runPackagedPublicFullOnlyAutoUpdateScenario(mode, {
      candidateVersion,
      beginReleaseMetadataGate: () => {
        assert.equal(heldReleaseMetadataResponse, null, "release metadata response gate must start empty");
        holdReleaseMetadataResponse = true;
      },
      executablePath,
      fullAssetChecksum,
      fullAssetName,
      fullAssetPath,
      fullOnlyPolicyUrl: `${releaseBaseUrl}/policy-full-only.json`,
      helperDigest,
      helperModule,
      publicKeyDer,
      releaseBaseUrl,
      releaseRequests,
      releaseReleaseMetadataGate: () => {
        holdReleaseMetadataResponse = false;
        if (!heldReleaseMetadataResponse) return;
        heldReleaseMetadataResponse.setHeader("Content-Type", "application/json");
        heldReleaseMetadataResponse.end(JSON.stringify(release));
        heldReleaseMetadataResponse = null;
      },
      resourcesDir,
      shellAssetName,
      sourceAppPath,
    });
  } finally {
    await new Promise((resolve) => policyServer.close(() => resolve()));
    await preparingRuntimeUiEvidencePromise;
    await closeDesktop(run.electronApp).catch(() => {});
  }
}

async function launchDesktop(userDataDir, mode, ports, extraEnv = {}, executableOverride = null) {
  const { electronApp, page: firstPage } = await launchDesktopWindow(
    userDataDir,
    mode,
    ports,
    extraEnv,
    executableOverride,
  );
  const page = await waitForBoardWindow(electronApp, firstPage);
  // On macOS the Dock can change the reported work area while the boot window
  // hands off to the application window. The shared tolerance stays strict
  // enough to reject the former 1440px default.
  await assertFreshDesktopWindowSize(electronApp, "the ready application window");
  await assertDesktopGlassShell(electronApp, page, "the ready application window");
  const baseUrl = new URL(page.url()).origin;
  console.log(`[desktop-smoke] board loaded at ${baseUrl}`);
  return { electronApp, page, baseUrl };
}

async function readBrowserSmokeCookie(electronApp, page) {
  return readBrowserCookie(electronApp, page, {
    name: browserSmokeCookieName,
    url: browserSmokeCookieUrl,
  });
}

async function readBrowserImportSmokeCookie(electronApp, page) {
  return readBrowserCookie(electronApp, page, {
    name: browserImportSmokeCookieName,
    url: browserImportSmokeCookieUrl,
  });
}

async function readBrowserImportDuplicateCookie(electronApp, page) {
  return readBrowserCookie(electronApp, page, {
    name: browserImportDuplicateCookieName,
    url: browserImportSmokeCookieUrl,
  });
}

async function readBrowserCookie(electronApp, page, input) {
  const partition = await page.evaluate(() => window.desktopShell.getBrowserPartition());
  const cookies = await electronApp.evaluate(async ({ session }, cookieInput) => (
    session.fromPartition(cookieInput.partition).cookies.get({
      name: cookieInput.name,
      url: cookieInput.url,
    })
  ), {
    name: input.name,
    partition,
    url: input.url,
  });
  return cookies[0] ?? null;
}

async function verifySyntheticBrowserCookieImport(electronApp, page, fixture) {
  console.log("[desktop-smoke] verifying synthetic Chromium cookie import through Desktop IPC");
  const sources = await page.evaluate(() => window.desktopShell.listBrowserImportSources());
  if (process.platform !== "darwin") {
    assert.equal(fixture, null, "non-macOS smoke must not create a synthetic Chromium source");
    assert.deepEqual(sources, [], "Browser import discovery is unavailable outside macOS in V1");
    console.log("[desktop-smoke] synthetic Chromium import skipped: macOS-only V1 capability");
    return;
  }

  assert.ok(fixture, "macOS smoke should create an isolated synthetic Chromium profile");
  const source = sources.find((candidate) => candidate.displayName === fixture.sourceDisplayName);
  assert.ok(source, "Desktop should discover the isolated synthetic Chromium profile");
  assert.equal(
    JSON.stringify(sources).includes("Library/Application Support"),
    false,
    "Browser import discovery must not expose source profile paths to the renderer",
  );

  const partition = await page.evaluate(() => window.desktopShell.getBrowserPartition());
  await electronApp.evaluate(async ({ session }, input) => {
    await session.fromPartition(input.partition).cookies.set({
      url: input.url,
      name: input.name,
      value: input.value,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      expirationDate: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });
  }, {
    name: browserImportDuplicateCookieName,
    partition,
    url: browserImportSmokeCookieUrl,
    value: browserImportDuplicateDestinationValue,
  });
  const sourceHashBefore = createHash("sha256")
    .update(await readFile(fixture.cookieDatabasePath))
    .digest("hex");
  const sourceWalHashBefore = createHash("sha256")
    .update(await readFile(`${fixture.cookieDatabasePath}-wal`))
    .digest("hex");

  const imported = await page.evaluate((sourceId) => window.desktopShell.importBrowserData({
    sourceId,
    importCookies: true,
  }), source.id);
  console.log("[desktop-smoke] synthetic Chromium import result", JSON.stringify({
    status: imported.status,
    importedCount: imported.importedCount,
    skippedCount: imported.skippedCount,
    failedCount: imported.failedCount,
    errors: imported.errors,
  }));
  assert.equal(imported.status, "succeeded");
  assert.equal(imported.importedCount, 1);
  assert.equal(imported.skippedCount, 4);
  assert.equal(imported.failedCount, 0);
  assert.deepEqual(
    new Set(imported.errors?.map((error) => error.errorCode)),
    new Set(["COOKIE_EXPIRED", "COOKIE_ROW_INVALID", "COOKIE_ENCRYPTION_UNSUPPORTED", "COOKIE_ALREADY_EXISTS"]),
    "real Desktop import should report every aggregated synthetic skip reason",
  );
  assert.ok(
    imported.errors?.every((error) => error.kind === "skipped" && error.count === 1),
    "real Desktop import should aggregate expected skips separately from failures",
  );
  assert.equal(
    (await readBrowserImportSmokeCookie(electronApp, page))?.value,
    browserImportSmokeCookieValue,
    "real Desktop import should write the synthetic cookie into the persistent Browser session",
  );
  assert.equal(
    (await readBrowserImportDuplicateCookie(electronApp, page))?.value,
    browserImportDuplicateDestinationValue,
    "real Desktop import must preserve an existing destination cookie with the same identity",
  );
  assert.equal(
    createHash("sha256").update(await readFile(fixture.cookieDatabasePath)).digest("hex"),
    sourceHashBefore,
    "real Desktop import must not modify the source Chromium Cookie database contents",
  );
  assert.equal(
    createHash("sha256").update(await readFile(`${fixture.cookieDatabasePath}-wal`)).digest("hex"),
    sourceWalHashBefore,
    "real Desktop import must not modify the source Chromium Cookie WAL contents",
  );

  const repeated = await page.evaluate((sourceId) => window.desktopShell.importBrowserData({
    sourceId,
    importCookies: true,
  }), source.id);
  assert.equal(repeated.status, "succeeded");
  assert.equal(repeated.importedCount, 0);
  assert.equal(repeated.skippedCount, 5);
  assert.equal(repeated.failedCount, 0);
  assert.equal(
    (await readBrowserImportDuplicateCookie(electronApp, page))?.value,
    browserImportDuplicateDestinationValue,
    "repeat import must not overwrite an existing destination cookie",
  );
  console.log("[desktop-smoke] synthetic Chromium import covered valid, duplicate, expired, malformed, and encrypted cookies");
}

async function setBrowserEnabled(page, baseUrl, enabled) {
  const response = await fetch(`${baseUrl}/api/instance/settings/browser`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (response.status !== 200) {
    throw new Error(`update Browser enabled state failed (${response.status}): ${await response.text()}`);
  }
  await page.evaluate((nextEnabled) => window.desktopShell.setBrowserEnabled(nextEnabled), enabled);
  return await response.json();
}

async function verifyOperatorBrowserRoutingWhileAgentAccessIsDisabled(page, baseUrl, companyId, fixtureUrl) {
  await setBrowserEnabled(page, baseUrl, false);
  await page.waitForFunction(() => (
    document.querySelectorAll(
      "[data-testid='live-surface-runtime-host'][data-target-kind='browser'] "
      + "[data-testid='chat-side-panel-browser-webview']",
    ).length > 0
  ));
  await verifyBrowserSkillState(baseUrl, companyId, false);

  const disabledAgentLinkUrl = `${fixtureUrl}/agent-disabled-link`;
  const routeBeforeDisabledAgentLink = page.url();
  await page.evaluate((url) => {
    const link = document.createElement("a");
    link.dataset.testid = "desktop-smoke-disabled-agent-link";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Disabled Agent Browser routing smoke link";
    document.body.appendChild(link);
  }, disabledAgentLinkUrl);
  await page.getByTestId("desktop-smoke-disabled-agent-link").click();
  await page.waitForFunction(({ expectedUrl }) => {
    const webview = document.querySelector(
      "[data-testid='live-surface-runtime-host'][data-owner-id^='side:']"
      + "[data-target-kind='browser'] "
      + "[data-testid='chat-side-panel-browser-webview'][data-active='true']",
    );
    if (!webview || typeof webview.getURL !== "function") return false;
    try {
      return webview.getURL() === expectedUrl;
    } catch {
      return false;
    }
  }, { expectedUrl: disabledAgentLinkUrl }, { timeout: 30_000 });
  assert.equal(
    page.url(),
    routeBeforeDisabledAgentLink,
    "operator link routing should remain internal while Agent Browser access is disabled",
  );
}

async function readBrowserSettings(baseUrl) {
  const response = await fetch(`${baseUrl}/api/instance/settings/browser`);
  if (response.status !== 200) {
    throw new Error(`read Browser settings failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function clearBrowserProfile(page) {
  await page.evaluate(() => window.desktopShell.clearBrowserData());
}

async function waitForBoardWindow(electronApp, initialPage, options = {}) {
  const { expectedUrlPattern } = options;
  let page = initialPage;
  let boardReady = false;
  let lastBridgeError = null;
  let lastBootState = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const openWindows = electronApp.windows().filter((candidate) => !candidate.isClosed());
    const boardCandidates = openWindows.filter((candidate) => {
      const currentUrl = candidate.url();
      return currentUrl
        && currentUrl.startsWith("http")
        && (!expectedUrlPattern || expectedUrlPattern.test(currentUrl));
    });
    let boardPage = null;
    for (const candidate of boardCandidates) {
      const bridgeResult = await candidate.evaluate(async () => {
        if (typeof window.desktopShell?.getBrowserPartition !== "function") {
          return { error: "desktopShell.getBrowserPartition is unavailable", ready: false };
        }
        try {
          await window.desktopShell.getBrowserPartition();
          return { error: null, ready: true };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            ready: false,
          };
        }
      }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
        ready: false,
      }));
      lastBridgeError = bridgeResult.error;
      if (bridgeResult.ready) {
        boardPage = candidate;
        break;
      }
    }
    if (boardPage && openWindows.length === 1) {
      page = boardPage;
      boardReady = true;
      break;
    }

    if (boardPage) {
      page = boardPage;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (openWindows.length > 0) {
      page = openWindows.at(-1);
    }

    if (!page || page.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    try {
      const bootState = await page.evaluate(() => {
        if (typeof window.rudderBoot?.getState === "function") {
          return window.rudderBoot.getState();
        }
        return null;
      });
      lastBootState = bootState;
      if (!bootState) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (bootState.stage === "error" || bootState.view === "failed") {
        throw new Error(`desktop boot failed: ${bootState.failure?.summary || bootState.stage}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isMainFrameTransition = message.includes(
        "available only to the current Rudder main frame",
      );
      if (
        !message.includes("Execution context was destroyed")
        && !message.includes("Target page, context or browser has been closed")
        && !isMainFrameTransition
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(
    boardReady,
    true,
    `expected exactly one ready Desktop board window with an active IPC bridge, got ${page?.url().slice(0, 240) ?? "no window"}${page?.url().length > 240 ? "..." : ""}${lastBridgeError ? `; last IPC error: ${lastBridgeError}` : ""}${lastBootState ? `; last boot state: ${JSON.stringify(lastBootState)}` : ""}`,
  );
  assert.ok(page.url().startsWith("http"), `expected desktop window to reach board UI, got ${page.url()}`);
  if (expectedUrlPattern) {
    assert.match(page.url(), expectedUrlPattern, `expected desktop window URL to match ${expectedUrlPattern}`);
  }
  return page;
}

async function closeDesktop(electronApp, options) {
  await desktopShutdownRegistry.close(electronApp, options);
}

async function dismissReleaseNotesDialogIfVisible(page) {
  const dialog = page.getByRole("dialog", { name: /What's new in Rudder/i });
  try {
    await dialog.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return;
  }

  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.waitFor({ state: "detached", timeout: 10_000 });
  console.log("[desktop-smoke] dismissed release notes dialog");
}

async function dismissOnboardingIfVisible(page) {
  const onboardingSteps = page.getByTestId("onboarding-step-tabs");
  try {
    await onboardingSteps.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return;
  }

  await page.getByRole("button", { name: "Close" }).click();
  await onboardingSteps.waitFor({ state: "detached", timeout: 10_000 });
  console.log("[desktop-smoke] dismissed route onboarding");
}

async function verifyNativeApplicationMenu(electronApp, page, companyId, issuePrefix) {
  const platform = await electronApp.evaluate(() => process.platform);
  if (platform !== "darwin") {
    const { hasApplicationMenu, visibleMenuBarWindows } = await electronApp.evaluate(({ BrowserWindow, Menu }) => ({
      hasApplicationMenu: Boolean(Menu.getApplicationMenu()),
      visibleMenuBarWindows: BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed() && window.isMenuBarVisible())
        .length,
    }));
    assert.equal(hasApplicationMenu, false, "native application menu should be hidden on non-macOS platforms");
    assert.equal(visibleMenuBarWindows, 0, "desktop windows should hide the native menu bar on non-macOS platforms");
    console.log("[desktop-smoke] native non-macOS application menu hidden");
    return page;
  }

  console.log("[desktop-smoke] verifying native macOS application menu");
  await page.evaluate((nextCompanyId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
  }, companyId);
  await page.goto(new URL(`/${issuePrefix}/dashboard`, page.url()).href);
  await page.waitForURL(new RegExp(`/${issuePrefix}/dashboard$`), { timeout: 30_000 });

  const appMenuItems = await electronApp.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const appMenu = menu?.items.find((item) =>
      Boolean(item.submenu?.getMenuItemById("rudder-settings")),
    );
    return appMenu?.submenu?.items.map((item) => ({
      id: item.id,
      label: item.label,
      accelerator: item.accelerator ?? null,
      type: item.type,
    })) ?? [];
  });

  assert.ok(
    appMenuItems.some((item) => item.id === "rudder-settings" && item.label === "Settings..."),
    "native app menu should expose Settings...",
  );
  assert.ok(
    appMenuItems.some((item) => item.id === "rudder-check-for-updates" && item.label === "Check for Updates..."),
    "native app menu should expose Check for Updates...",
  );

  await electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const settingsItem = Menu.getApplicationMenu()?.getMenuItemById("rudder-settings");
    if (!settingsItem) throw new Error("Missing rudder-settings menu item");
    settingsItem.click(undefined, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], undefined);
  });

  page = await waitForBoardWindow(electronApp, page, {
    expectedUrlPattern: /\/instance\/settings\/general$/,
  });
  const modal = page.getByTestId("settings-modal-shell");
  await modal.waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("heading", { name: "General" }).waitFor({ state: "visible", timeout: 15_000 });
  console.log("[desktop-smoke] native Settings menu item opened settings");

  await page.keyboard.press("Escape");
  await page.waitForURL((url) => !url.pathname.startsWith("/instance/settings/"), { timeout: 15_000 });
  await modal.waitFor({ state: "detached", timeout: 15_000 });
  return page;
}

async function verifySettingsOverlayFlow(page, companyId, issuePrefix) {
  console.log("[desktop-smoke] verifying settings overlay open/close flow");
  await page.evaluate((nextCompanyId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
  }, companyId);
  await page.goto(new URL(`/${issuePrefix}/dashboard`, page.url()).href);
  await page.waitForURL(new RegExp(`/${issuePrefix}/dashboard$`), { timeout: 30_000 });
  await page.waitForLoadState("networkidle");

  const staleBackdrop = page.getByTestId("settings-modal-backdrop");
  if (await staleBackdrop.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await staleBackdrop.waitFor({ state: "detached", timeout: 15_000 });
  }

  await page.getByRole("button", { name: "System settings" }).click();
  console.log("[desktop-smoke] settings trigger clicked");
  await page.waitForURL(new RegExp(`/${issuePrefix}/organization/settings$`), { timeout: 15_000 });
  await page.getByTestId("settings-modal-shell").waitFor({ state: "visible", timeout: 15_000 });
  console.log("[desktop-smoke] settings modal opened");

  const modal = page.getByTestId("settings-modal-shell");
  const sidebar = modal.getByTestId("workspace-sidebar");

  async function measureModalHeight(label, href, heading) {
    await sidebar.locator(`a[href$="${href}"]`).click();
    await page.waitForURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), { timeout: 15_000 });
    await modal.getByRole("heading", { name: heading }).waitFor({ state: "visible", timeout: 15_000 });
    const box = await modal.boundingBox();
    assert.ok(box, `settings modal should have a bounding box on ${label}`);
    console.log(`[desktop-smoke] measured settings modal height on ${label}: ${box.height}`);
    return Math.round(box.height);
  }

  const profileHeight = await measureModalHeight("profile", "/instance/settings/profile", "Profile");
  const generalHeight = await measureModalHeight("general", "/instance/settings/general", "General");
  assert.equal(
    generalHeight,
    profileHeight,
    `settings modal height should stay stable across navigation (profile=${profileHeight}, general=${generalHeight})`,
  );
  console.log("[desktop-smoke] settings internal navigation keeps modal height stable");

  await sidebar.locator('a[href$="/instance/settings/notifications"]').click();
  await page.waitForURL(/\/instance\/settings\/notifications$/, { timeout: 15_000 });
  await modal.getByRole("heading", { name: "System permissions" }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("heading", { name: "Full Disk Access", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("heading", { name: "Accessibility", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("heading", { name: "Automation", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("heading", { name: "Notifications", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByText("System notification access").waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("heading", { name: "Issue notifications", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("heading", { name: "Chat notifications", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("button", { name: "Open settings" }).first().waitFor({ state: "visible", timeout: 15_000 });
  if (process.platform === "darwin") {
    await modal.getByRole("button", { name: "Open settings" }).first().click();
    await page.waitForTimeout(250);
    if (systemPermissionsScreenshotPath) {
      await mkdir(path.dirname(systemPermissionsScreenshotPath), { recursive: true });
      await modal.screenshot({ path: systemPermissionsScreenshotPath });
      console.log(`[desktop-smoke] System permissions screenshot: ${systemPermissionsScreenshotPath}`);
    }
    assert.equal(
      await modal.getByText("This URL protocol cannot be opened from Rudder.").count(),
      0,
      "macOS system permission settings should open without an in-app URL protocol error",
    );
  }
  assert.equal(
    await modal.getByText("Checking").count(),
    0,
    "prod-local desktop smoke should not leave permission status stuck in Checking",
  );
  assert.equal(
    await modal.getByText("System managed").count(),
    0,
    "prod-local desktop smoke should show concrete permission status instead of System managed",
  );
  assert.equal(
    await modal.getByText("App icon badge").count(),
    0,
    "prod-local desktop smoke should not expose the app icon badge settings row",
  );
  assert.equal(
    await modal.getByRole("button", { name: "Send test notification" }).count(),
    0,
    "prod-local desktop smoke should not expose the test notification debug action",
  );
  assert.equal(
    await modal.getByRole("button", { name: "Preview badge" }).count(),
    0,
    "prod-local desktop smoke should not expose the badge preview debug action",
  );
  console.log("[desktop-smoke] notifications route hides desktop debug actions in prod-local");

  await sidebar.locator('a[href$="/instance/settings/about"]').click();
  await page.waitForURL(/\/instance\/settings\/about$/, { timeout: 15_000 });
  await modal.getByRole("heading", { name: "About" }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("button", { name: "Check for updates" }).waitFor({ state: "visible", timeout: 15_000 });
  console.log("[desktop-smoke] about page route opened successfully");

  const modalBox = await modal.boundingBox();
  assert.ok(modalBox, "settings modal should still have a bounding box before closing");
  await page.keyboard.press("Escape");
  console.log("[desktop-smoke] pressed Escape to close settings");
  await page.waitForURL(new RegExp(`/${issuePrefix}/dashboard$`), { timeout: 15_000 });
  await modal.waitFor({ state: "detached", timeout: 15_000 });
  console.log("[desktop-smoke] settings modal closed");
}

async function verifyIssueDetailEscapeNavigation(page, companyId, issuePrefix, issue) {
  console.log("[desktop-smoke] verifying issue detail Escape navigation");
  const issueRouteId = issue.identifier ?? issue.id;
  const waitForPath = (expectedPath, timeout = 15_000) => page.waitForFunction(
    ({ path }) => window.location.pathname === path,
    { path: expectedPath },
    { timeout },
  );
  const waitForIssueListPath = () => page.waitForFunction(
    ({ expectedPath }) => window.location.pathname === expectedPath,
    { expectedPath: `/${issuePrefix}/issues` },
    { timeout: 15_000 },
  );
  const pressEscapeToIssueList = async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.keyboard.press("Escape");
      try {
        await waitForIssueListPath();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
  const setSmokeRoute = (nextPath, mode = "replace") => page.evaluate(({ nextCompanyId, nextPath, mode }) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
    if (mode === "push") {
      window.history.pushState({}, "", nextPath);
    } else {
      window.history.replaceState({}, "", nextPath);
    }
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, {
    nextCompanyId: companyId,
    nextPath,
    mode,
  });

  await page.evaluate((nextCompanyId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
  }, companyId);
  await page.goto(new URL(`/${issuePrefix}/issues`, page.url()).href);
  await waitForPath(`/${issuePrefix}/issues`);
  await page.waitForLoadState("networkidle");
  await setSmokeRoute(`/${issuePrefix}/issues/${issueRouteId}`, "push");
  await page.waitForURL(new RegExp(`/${issuePrefix}/issues/${issueRouteId}$`), { timeout: 30_000 });
  await page.getByRole("heading", { name: issue.title }).waitFor({ state: "visible", timeout: 30_000 });

  await pressEscapeToIssueList();

  console.log("[desktop-smoke] issue detail Escape navigation returned to issues");
}

async function verifyOrganizationWorkspacesNavigation(electronApp, page, companyId, issuePrefix) {
  console.log("[desktop-smoke] verifying organization Library navigation");
  await page.evaluate(({ nextCompanyId, nextPath }) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
    window.history.replaceState({}, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, {
    nextCompanyId: companyId,
    nextPath: `/${issuePrefix}/dashboard`,
  });
  await page.waitForURL(new RegExp(`/${issuePrefix}/dashboard$`), { timeout: 30_000 });

  const primaryRail = page.getByTestId("primary-rail");
  await primaryRail.waitFor({ state: "visible", timeout: 30_000 });
  await primaryRail
    .locator('a[href*="/library"], a[href*="/resources"], a[href*="/workspaces"]')
    .first()
    .click();
  page = await waitForBoardWindow(electronApp, page, {
    expectedUrlPattern: new RegExp(`/${issuePrefix}/library(?:[?#].*)?$`),
  });
  await page.getByTestId("org-workspaces-files-card").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("org-workspaces-editor-card").waitFor({ state: "visible", timeout: 30_000 });
  console.log("[desktop-smoke] organization Library page opened");
  return page;
}

async function pressElectronSurfaceShortcut(electronApp, surfaceType, keyCode, modifiers) {
  await electronApp.evaluate(({ webContents }, input) => {
    const focusedContents = webContents.getFocusedWebContents();
    const candidates = webContents.getAllWebContents().filter((contents) => (
      !contents.isDestroyed() && contents.getType() === input.surfaceType
    ));
    const targetContents = focusedContents?.getType() === input.surfaceType
      ? focusedContents
      : candidates.length === 1
        ? candidates[0]
        : null;
    if (!targetContents) {
      throw new Error(`Desktop shortcut smoke expected one ${input.surfaceType} surface; found ${candidates.length}`);
    }
    targetContents.sendInputEvent({ type: "keyDown", keyCode: input.keyCode, modifiers: input.modifiers });
    targetContents.sendInputEvent({ type: "keyUp", keyCode: input.keyCode, modifiers: input.modifiers });
  }, { surfaceType, keyCode, modifiers });
}

async function verifyNativeSidePanelResize(electronApp, page, sidePanel, expectedUrl) {
  console.log("[desktop-smoke] verifying Side Panel resize across the native Browser webview");
  assert.ok(electronApp, "native Side Panel resize requires the Electron application");
  const readActiveWebviewUrl = () => page.evaluate(() => {
    const webview = document.querySelector(
      "[data-testid='chat-side-panel-browser-webview'][data-active='true']",
    );
    return webview && typeof webview.getURL === "function" ? webview.getURL() : null;
  });
  const waitForActiveWebview = async () => {
    await page.waitForFunction(({ url }) => {
      const webview = document.querySelector(
        "[data-testid='chat-side-panel-browser-webview'][data-active='true']",
      );
      return webview && typeof webview.getURL === "function" && webview.getURL() === url;
    }, { url: expectedUrl }, { timeout: 30_000 });
    return readActiveWebviewUrl();
  };
  assert.equal(
    await waitForActiveWebview(),
    expectedUrl,
    "resize smoke requires a real Electron Browser webview",
  );

  const originalContentSize = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("native resize smoke requires a BrowserWindow");
    const [width, height] = window.getContentSize();
    const [minimumWidth, minimumHeight] = window.getMinimumSize();
    return { width, height, minimumWidth, minimumHeight };
  });
  const setNativeViewportWidth = async (width, height = 900) => {
    await electronApp.evaluate(({ BrowserWindow }, nextSize) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("native resize smoke requires a BrowserWindow");
      window.setMinimumSize(nextSize.minimumWidth, nextSize.minimumHeight);
      window.setContentSize(nextSize.width, nextSize.height);
    }, {
      width,
      height,
      minimumWidth: Math.min(width, originalContentSize.minimumWidth),
      minimumHeight: Math.min(height, originalContentSize.minimumHeight),
    });
    await page.waitForFunction(
      (expectedWidth) => Math.abs(window.innerWidth - expectedWidth) <= 2,
      width,
      { timeout: 5_000 },
    );
  };
  const waitForSidePanelGeometryToSettle = async () => {
    await page.evaluate(async () => {
      let previous = null;
      let stableFrames = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const panel = document.querySelector("[data-testid='chat-side-panel']");
        const resizer = document.querySelector("[data-testid='side-panel-resizer']");
        if (!(panel instanceof HTMLElement) || !(resizer instanceof HTMLElement)) {
          stableFrames = 0;
          previous = null;
          continue;
        }
        const panelBox = panel.getBoundingClientRect();
        const resizerBox = resizer.getBoundingClientRect();
        const current = [panelBox.width, resizerBox.x];
        if (previous
          && Math.abs(current[0] - previous[0]) <= 0.25
          && Math.abs(current[1] - previous[1]) <= 0.25) {
          stableFrames += 1;
          if (stableFrames >= 6) return;
        } else {
          stableFrames = 0;
        }
        previous = current;
      }
      throw new Error("Side Panel geometry did not settle after the native window resize");
    });
  };

  const beginResizeDrag = async (box) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.bringToFront();
      const hitTargetBox = await page.getByTestId("side-panel-resizer-hit-target").boundingBox();
      const pointerBox = hitTargetBox ?? box;
      const pointerX = pointerBox.x + pointerBox.width / 2;
      const pointerY = pointerBox.y + pointerBox.height / 2;
      await page.mouse.move(pointerX, pointerY);
      await page.mouse.down();
      try {
        const resizeShield = page.getByTestId("side-panel-resize-shield");
        try {
          await resizeShield.waitFor({ state: "visible", timeout: 500 });
        } catch {
          // Linux webviews can consume Playwright's native pointerdown even
          // when Chromium reports the DOM hit target at the same coordinates.
          // Re-dispatch it while the native mouse button remains held so the
          // real resize lifecycle, capture, movement, and release still run.
          console.log("[desktop-smoke] native Side Panel pointerdown was intercepted; redispatching on the DOM hit target");
          await page.getByTestId("side-panel-resizer-hit-target").evaluate((element, point) => {
            element.dispatchEvent(new PointerEvent("pointerdown", {
              bubbles: true,
              button: 0,
              buttons: 1,
              clientX: point.x,
              clientY: point.y,
              isPrimary: true,
              pointerId: 1,
              pointerType: "mouse",
            }));
          }, { x: pointerX, y: pointerY });
          await resizeShield.waitFor({ state: "visible", timeout: 2_000 });
        }
        return { pointerX, pointerY };
      } catch (error) {
        await page.mouse.up();
        if (attempt === 3) throw error;
        await page.waitForTimeout(100);
      }
    }
    throw new Error("Side Panel resize drag did not start");
  };

  const dragResizer = async (targetX) => {
    const resizer = page.getByTestId("side-panel-resizer");
    const box = await resizer.boundingBox();
    assert.ok(box, "Side Panel resizer should have geometry");
    const { pointerY } = await beginResizeDrag(box);
    await page.mouse.move(targetX, pointerY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    if (await page.getByTestId("side-panel-resize-shield").isVisible().catch(() => false)) {
      // After the explicit capture-loss case below, Playwright can leave
      // Electron's follow-up pointerup targeted outside the renderer. The
      // preceding drags already prove the native path; complete this fallback
      // through the same window lifecycle listener.
      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerId: 1 }));
      });
    }
    await page.getByTestId("side-panel-resize-shield").waitFor({ state: "hidden", timeout: 5_000 });
  };
  const dragResizerWithSyntheticPointer = async (targetX, pointerId) => {
    const resizer = page.getByTestId("side-panel-resizer");
    await resizer.evaluate((element, detail) => {
      const box = element.getBoundingClientRect();
      const pointerY = box.y + box.height / 2;
      element.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: box.x + box.width / 2,
        clientY: pointerY,
        pointerId: detail.pointerId,
      }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        clientX: detail.targetX,
        clientY: pointerY,
        pointerId: detail.pointerId,
      }));
      window.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: detail.targetX,
        clientY: pointerY,
        pointerId: detail.pointerId,
      }));
    }, { pointerId, targetX });
    await page.getByTestId("side-panel-resize-shield").waitFor({ state: "hidden", timeout: 5_000 });
  };

  for (const viewportWidth of [994, 1440]) {
    await setNativeViewportWidth(viewportWidth);
    await waitForSidePanelGeometryToSettle();
    assert.equal(
      await waitForActiveWebview(),
      expectedUrl,
      `resizing the native window to ${viewportWidth}px should preserve the Browser guest`,
    );

    const resizer = page.getByTestId("side-panel-resizer");
    await page.waitForFunction(() => {
      const divider = document.querySelector("[data-testid='side-panel-resizer']");
      const hitTarget = document.querySelector("[data-testid='side-panel-resizer-hit-target']");
      if (!(divider instanceof HTMLElement) || !(hitTarget instanceof HTMLElement)) return false;
      const rect = hitTarget.getBoundingClientRect();
      const edgeTarget = document.elementFromPoint(rect.left + 0.5, rect.top + rect.height / 2);
      return divider.offsetWidth === 4
        && hitTarget.offsetWidth >= 10
        && (edgeTarget === hitTarget || hitTarget.contains(edgeTarget));
    }, null, { timeout: 5_000 });
    const [stackBox, initialPanelBox, initialResizerBox] = await Promise.all([
      page.getByTestId("workspace-main-panel-stack").boundingBox(),
      sidePanel.boundingBox(),
      resizer.boundingBox(),
    ]);
    assert.ok(stackBox && initialPanelBox && initialResizerBox, `Side Panel should be docked at ${viewportWidth}px`);

    const { stackLayoutWidth, resizerLayoutWidth } = await page.evaluate(() => ({
      stackLayoutWidth: document.querySelector("[data-testid='workspace-main-panel-stack']")?.offsetWidth ?? 0,
      resizerLayoutWidth: document.querySelector("[data-testid='side-panel-resizer']")?.offsetWidth ?? 0,
    }));
    assert.ok(
      stackLayoutWidth > 0 && resizerLayoutWidth > 0,
      "Side Panel layout geometry should be measurable",
    );
    const visualScale = stackBox.width / stackLayoutWidth;
    const boundaryWidth = (stackLayoutWidth - resizerLayoutWidth) * (2 / 3) * visualScale;
    assert.ok(initialPanelBox.width < boundaryWidth - 8, `Side Panel should start below the 2:1 boundary at ${viewportWidth}px`);
    const { pointerX: startPointerX, pointerY } = await beginResizeDrag(initialResizerBox);
    let pointerX = startPointerX;
    let previousPanelWidth = initialPanelBox.width;
    let previousResizerX = initialResizerBox.x;

    for (const targetPanelWidth of [boundaryWidth - 16, boundaryWidth - 8]) {
      let reachedTarget = false;
      let lastObservedPanelWidth = previousPanelWidth;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const currentPanelBox = await sidePanel.boundingBox();
        assert.ok(currentPanelBox, "Side Panel should remain measurable during boundary drag");
        lastObservedPanelWidth = currentPanelBox.width;
        const widthError = targetPanelWidth - currentPanelBox.width;
        // Native Electron pointer coordinates can quantize by roughly one
        // device-scaled hit-target width. Staying within 10px still proves the
        // panel remains docked on the safe side of the 2:1 boundary.
        if (Math.abs(widthError) <= 10) {
          reachedTarget = true;
          break;
        }
        pointerX -= widthError;
        await page.mouse.move(pointerX, pointerY, { steps: 12 });
        await page.waitForTimeout(100);
        assert.equal(
          await page.getByTestId("side-panel-expanded-overlay").count(),
          0,
          "feedback drag should remain docked before the 2:1 boundary",
        );
      }
      assert.ok(
        reachedTarget,
        `Side Panel should reach the ${targetPanelWidth}px pre-boundary target (last observed ${lastObservedPanelWidth}px, pointer ${pointerX}px)`,
      );
      const [panelBox, resizerBox, mainBox] = await Promise.all([
        sidePanel.boundingBox(),
        resizer.boundingBox(),
        page.getByTestId("workspace-main-card").boundingBox(),
      ]);
      assert.ok(panelBox && resizerBox && mainBox, "pre-threshold resize geometry should remain measurable");
      assert.ok(panelBox.width >= previousPanelWidth - 2, "pre-threshold panel width should grow monotonically");
      assert.ok(resizerBox.x <= previousResizerX + 2, "pre-threshold resizer should move monotonically left");
      assert.ok(
        panelBox.width <= boundaryWidth + 4,
        "the exact 2:1 workspace boundary should remain docked",
      );
      previousPanelWidth = panelBox.width;
      previousResizerX = resizerBox.x;
    }

    const preCrossPanelBox = await sidePanel.boundingBox();
    assert.ok(preCrossPanelBox, "Side Panel should remain measurable before boundary crossing");
    pointerX -= boundaryWidth + 8 - preCrossPanelBox.width;
    await page.mouse.move(pointerX, pointerY, { steps: 8 });
    await page.getByTestId("side-panel-expanded-overlay").waitFor({ state: "visible", timeout: 5_000 });
    await resizer.waitFor({ state: "hidden", timeout: 5_000 });
    await page.mouse.up();
    await page.getByTestId("side-panel-resize-shield").waitFor({ state: "hidden", timeout: 5_000 });
    await page.waitForFunction(() => {
      const stack = document.querySelector("[data-testid='workspace-main-panel-stack']");
      const panel = document.querySelector("[data-testid='chat-side-panel']");
      const main = document.querySelector("[data-testid='workspace-main-card']");
      if (!(stack instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(main instanceof HTMLElement)) return false;
      const stackBox = stack.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const mainBox = main.getBoundingClientRect();
      const mainStyle = getComputedStyle(main);
      return Math.abs(panelBox.x - stackBox.x) <= 2
        && Math.abs(panelBox.right - stackBox.right) <= 2
        && mainBox.width <= 0.5
        && main.hasAttribute("inert")
        && mainStyle.borderLeftWidth === "0px"
        && mainStyle.borderRightWidth === "0px";
    }, null, { timeout: 5_000 });
    assert.equal(
      await waitForActiveWebview(),
      expectedUrl,
      `crossing the 2:1 boundary at ${viewportWidth}px should preserve the Browser guest`,
    );
    const expandedBrowserCorners = await page.evaluate(() => {
      const host = Array.from(document.querySelectorAll(
        "[data-testid='live-surface-runtime-host'][data-owner-id^='side:'][data-target-kind='browser']",
      )).find((candidate) => !candidate.hidden);
      if (!host) throw new Error("expanded Side Browser runtime host was unavailable");
      const style = getComputedStyle(host);
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomLeftRadius,
        style.borderBottomRightRadius,
      ];
    });
    assert.ok(
      expandedBrowserCorners.every((radius) => Number.parseFloat(radius) > 0),
      `expanded Side Browser runtime host must preserve every rounded corner (${expandedBrowserCorners.join(", ")})`,
    );

    await sidePanel.getByLabel("Restore Side Panel width").click();
    await page.getByTestId("side-panel-expanded-overlay").waitFor({ state: "detached", timeout: 5_000 });
    await resizer.waitFor({ state: "visible", timeout: 5_000 });
    await waitForSidePanelGeometryToSettle();
  }
  await setNativeViewportWidth(originalContentSize.width, originalContentSize.height);
  await waitForSidePanelGeometryToSettle();

  const initialPanelBox = await sidePanel.boundingBox();
  const initialResizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
  assert.ok(initialPanelBox && initialResizerBox, "Side Panel should be docked before native resize");
  await dragResizer(initialResizerBox.x - 80);
  await page.waitForFunction(({ initialWidth }) => {
    const panel = document.querySelector("[data-testid='chat-side-panel']");
    return panel instanceof HTMLElement && panel.getBoundingClientRect().width > initialWidth + 30;
  }, { initialWidth: initialPanelBox.width }, { timeout: 5_000 });
  const expandedPanelBox = await sidePanel.boundingBox();
  assert.ok(
    expandedPanelBox && expandedPanelBox.width > initialPanelBox.width + 30,
    "dragging left should continuously widen the Side Panel",
  );
  await page.waitForTimeout(500);

  const cancelResizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
  assert.ok(cancelResizerBox, "Side Panel resizer should remain available after widening");
  const { pointerY: cancelY } = await beginResizeDrag(cancelResizerBox);
  await page.mouse.move(cancelResizerBox.x + 36, cancelY, { steps: 4 });
  const releasedCapture = await page.getByTestId("side-panel-resizer").evaluate((element) => {
    window.__rudderDesktopSmokeLostCaptureCount = 0;
    element.addEventListener("lostpointercapture", () => {
      window.__rudderDesktopSmokeLostCaptureCount += 1;
    }, { once: true });
    for (let pointerId = 0; pointerId <= 32; pointerId += 1) {
      if (!element.hasPointerCapture(pointerId)) continue;
      element.releasePointerCapture(pointerId);
      return {
        hasCaptureAfterRelease: element.hasPointerCapture(pointerId),
        pointerId,
      };
    }
    return null;
  });
  assert.notEqual(releasedCapture, null, "native Electron resizer should hold pointer capture");
  assert.equal(
    releasedCapture.hasCaptureAfterRelease,
    false,
    "native Electron resizer should release pointer capture",
  );
  await page.waitForTimeout(50);
  if (await page.evaluate(() => window.__rudderDesktopSmokeLostCaptureCount === 0)) {
    // Electron's Playwright-driven pointer capture does not consistently emit
    // lostpointercapture after a programmatic release. Dispatch the exact event
    // after proving capture is gone so the real cancellation lifecycle remains
    // black-box exercised in the Desktop renderer.
    await page.getByTestId("side-panel-resizer").evaluate((element, pointerId) => {
      element.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId }));
    }, releasedCapture.pointerId);
  }
  await page.waitForFunction(() => window.__rudderDesktopSmokeLostCaptureCount === 1, null, { timeout: 5_000 });
  await page.getByTestId("side-panel-resize-shield").waitFor({ state: "hidden", timeout: 5_000 });
  assert.deepEqual(
    await page.evaluate(() => ({
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    })),
    { cursor: "", userSelect: "" },
    "cancelled native resize should restore body interaction styles",
  );
  await page.waitForTimeout(250);
  const widthAfterCancel = (await sidePanel.boundingBox())?.width;
  assert.ok(widthAfterCancel, "Side Panel should remain visible after resize cancellation");
  await page.mouse.move(cancelResizerBox.x - 120, cancelY, { steps: 4 });
  assert.equal(
    Math.round((await sidePanel.boundingBox())?.width ?? 0),
    Math.round(widthAfterCancel),
    "removed resize listeners must ignore pointer movement after cancellation",
  );
  await page.mouse.up();

  const restartResizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
  assert.ok(restartResizerBox, "cancelled resize should release the active lifecycle");
  await dragResizerWithSyntheticPointer(restartResizerBox.x + 40, 71);
  await page.waitForFunction(({ previousWidth }) => {
    const panel = document.querySelector("[data-testid='chat-side-panel']");
    return panel instanceof HTMLElement && panel.getBoundingClientRect().width < previousWidth - 20;
  }, { previousWidth: widthAfterCancel }, { timeout: 5_000 });
  assert.ok(
    (await sidePanel.boundingBox())?.width < widthAfterCancel - 20,
    "a new resize should start after cancellation",
  );
  await page.waitForTimeout(500);

  const collapsePanelBox = await sidePanel.boundingBox();
  assert.ok(collapsePanelBox, "Side Panel should remain visible before collapse drag");
  await dragResizerWithSyntheticPointer(collapsePanelBox.x + collapsePanelBox.width - 12, 72);
  await sidePanel.waitFor({ state: "hidden", timeout: 5_000 });
  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();
  await sidePanel.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(
    await waitForActiveWebview(),
    expectedUrl,
    "reopening after collapse should preserve the native Browser guest",
  );
  console.log("[desktop-smoke] native Browser webview resize, cancel, collapse, and reopen passed");
}

async function verifyChatSidePanelBrowser(page, baseUrl, companyId, issuePrefix, options = {}) {
  console.log("[desktop-smoke] verifying chat Side Panel Browser webview");
  const {
    electronApp = null,
    exerciseRouting = true,
    exerciseResize = exerciseRouting,
    expectCookie = null,
    expectStorage = null,
    fixture: providedFixture = null,
    seedCookie = true,
    seedStorage = false,
  } = options;
  const fixture = providedFixture ?? await startBrowserSmokeFixture();
  try {
    const chat = await createChat(baseUrl, companyId);
    const targetPath = `/${issuePrefix}/messenger/chat/${chat.id}`;
    await page.evaluate((nextCompanyId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
    }, companyId);
    // The smoke fixture creates its organization through the server after the
    // renderer's initial empty organization query. Use a document navigation so
    // the application observes that externally-created organization before the
    // route-scoped Side Panel is exercised.
    await page.goto(new URL(targetPath, page.url()).href);
    await page.waitForURL(new RegExp(`/${issuePrefix}/messenger/chat/${chat.id}$`), { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await dismissOnboardingIfVisible(page);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await sidePanel.waitFor({ state: "visible", timeout: 15_000 });
    const browserView = page.getByTestId("chat-side-panel-browser-view");
    if (!(await browserView.isVisible().catch(() => false))) {
      const browserButton = sidePanel.getByTestId("chat-side-panel-empty-browser-target");
      if (await browserButton.isVisible().catch(() => false)) {
        await browserButton.click();
      } else {
        const panelText = await sidePanel.textContent().catch(() => "");
        throw new Error(`Side Panel Browser action was not visible. Current Side Panel text: ${panelText}`);
      }
    }
    try {
      await browserView.waitFor({ state: "visible", timeout: 15_000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        anchors: Array.from(document.querySelectorAll("[data-owner-id]")).map((element) => ({
          ownerId: element.getAttribute("data-owner-id"),
          rect: element.getBoundingClientRect().toJSON(),
          testId: element.getAttribute("data-testid"),
        })),
        hosts: Array.from(document.querySelectorAll("[data-testid='live-surface-runtime-host']")).map((element) => ({
          active: !element.hidden,
          ownerId: element.getAttribute("data-owner-id"),
          rect: element.getBoundingClientRect().toJSON(),
          runtimeId: element.getAttribute("data-runtime-id"),
          targetKind: element.getAttribute("data-target-kind"),
        })),
        panelText: document.querySelector("[data-testid='chat-side-panel']")?.textContent ?? null,
        sideTabs: Array.from(document.querySelectorAll("[data-testid='chat-side-panel-tab']")).map((element) => ({
          selected: element.getAttribute("aria-selected"),
          text: element.textContent,
          viewInstanceId: element.getAttribute("data-view-instance-id"),
        })),
        url: window.location.href,
      }));
      console.error(
        "[desktop-smoke] Browser live-surface visibility diagnostics",
        JSON.stringify(diagnostics),
      );
      throw error;
    }
    const browserUrlInput = browserView.getByLabel("Browser URL");
    await browserUrlInput.waitFor({ state: "visible", timeout: 15_000 });
    const sideHostRadii = await page.evaluate(() => {
      const host = Array.from(document.querySelectorAll(
        "[data-testid='live-surface-runtime-host'][data-target-kind='browser']",
      )).find((candidate) => candidate.getAttribute("data-owner-id")?.startsWith("side:"));
      if (!host) throw new Error("Side Browser runtime host was unavailable");
      const style = getComputedStyle(host);
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ];
    });
    assert.ok(
      sideHostRadii.every((radius) => Number.parseFloat(radius) > 0),
      `Side Browser runtime host must preserve all workspace-card corners (received ${sideHostRadii.join(", ")})`,
    );

    const fixtureUrl = `${fixture.url}/operator`;
    await browserUrlInput.fill(fixtureUrl);
    await browserUrlInput.press("Enter");
    await page.waitForFunction(async ({ expectedUrl }) => {
      const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
      if (!webview || typeof webview.getURL !== "function") return false;
      if (webview.getURL() !== expectedUrl) return false;
      if (typeof webview.executeJavaScript !== "function") return false;
      const bodyText = await webview.executeJavaScript("document.body?.innerText ?? ''");
      return bodyText.includes("Rudder Browser fixture");
    }, { expectedUrl: fixtureUrl }, { timeout: 30_000 });

    if (exerciseResize) {
      await verifyNativeSidePanelResize(electronApp, page, sidePanel, fixtureUrl);
    }

    const existingCookies = await page.evaluate(async () => {
      const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
      if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
      return await webview.executeJavaScript("document.cookie");
    });
    if (expectCookie !== null) {
      assert.equal(
        existingCookies.includes(`${browserSmokeCookieName}=${browserSmokeCookieValue}`),
        expectCookie,
        `Browser webview shared cookie presence should be ${expectCookie}`,
      );
    }
    if (seedCookie) {
      const cookieText = `${browserSmokeCookieName}=${browserSmokeCookieValue}; Path=/; Max-Age=86400; SameSite=Lax`;
      const seededCookies = await page.evaluate(async (nextCookie) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
        return await webview.executeJavaScript(`document.cookie = ${JSON.stringify(nextCookie)}; document.cookie`);
      }, cookieText);
      assert.match(seededCookies, new RegExp(`${browserSmokeCookieName}=${browserSmokeCookieValue}`));
    }
    const storageState = await page.evaluate(async ({ cacheName, storageKey }) => {
      const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
      if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
      return await webview.executeJavaScript(`(async () => ({
        cache: await caches.has(${JSON.stringify(cacheName)}),
        localStorage: localStorage.getItem(${JSON.stringify(storageKey)}),
      }))()`);
    }, { cacheName: browserSmokeCacheName, storageKey: browserSmokeStorageKey });
    if (expectStorage !== null) {
      assert.deepEqual(
        storageState,
        expectStorage
          ? { cache: true, localStorage: browserSmokeStorageValue }
          : { cache: false, localStorage: null },
        `Browser webview shared site-data presence should be ${expectStorage}`,
      );
    }
    if (seedStorage) {
      const seededStorage = await page.evaluate(async ({ cacheName, storageKey, storageValue }) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
        return await webview.executeJavaScript(`(async () => {
          localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(storageValue)});
          const cache = await caches.open(${JSON.stringify(cacheName)});
          await cache.put("/cached-smoke", new Response("cached"));
          return {
            cache: await caches.has(${JSON.stringify(cacheName)}),
            localStorage: localStorage.getItem(${JSON.stringify(storageKey)}),
          };
        })()`);
      }, {
        cacheName: browserSmokeCacheName,
        storageKey: browserSmokeStorageKey,
        storageValue: browserSmokeStorageValue,
      });
      assert.deepEqual(seededStorage, { cache: true, localStorage: browserSmokeStorageValue });
    }

    if (exerciseRouting) {
      const rudderUrl = page.url();
      const shortcutModifier = process.platform === "darwin" ? "meta" : "control";
      const hostShortcutMarker = randomUUID();
      await page.evaluate((marker) => {
        window.__rudderBrowserShortcutHostMarker = marker;
      }, hostShortcutMarker);

      await page.evaluate(async () => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
        webview.focus();
        await webview.executeJavaScript("document.querySelector('[aria-label=\"Smoke input\"]')?.focus()");
      });
      await page.waitForFunction(() => (
        document.activeElement?.matches("[data-testid='chat-side-panel-browser-webview'][data-active='true']")
      ), null, { timeout: 15_000 });
      await pressElectronSurfaceShortcut(electronApp, "webview", "L", [shortcutModifier]);
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Browser URL",
        null,
        { timeout: 15_000 },
      );
      assert.deepEqual(await browserUrlInput.evaluate((input) => [
        input.selectionStart,
        input.selectionEnd,
        input.value.length,
      ]), [0, fixtureUrl.length, fixtureUrl.length]);

      for (const shortcut of [
        { label: `${shortcutModifier}+R`, modifiers: [shortcutModifier] },
        { label: `${shortcutModifier}+Shift+R`, modifiers: [shortcutModifier, "shift"] },
      ]) {
        const guestMarker = randomUUID();
        await page.evaluate(async (marker) => {
          const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
          if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
          webview.focus();
          await webview.executeJavaScript(`window.__rudderBrowserReloadMarker = ${JSON.stringify(marker)}; document.querySelector('[aria-label="Smoke input"]')?.focus()`);
        }, guestMarker);
        await pressElectronSurfaceShortcut(electronApp, "webview", "R", shortcut.modifiers);
        await page.waitForFunction(async ({ marker }) => {
          if (window.__rudderBrowserShortcutHostMarker !== marker) return false;
          const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
          if (!webview || typeof webview.executeJavaScript !== "function") return false;
          try {
            return await webview.executeJavaScript("typeof window.__rudderBrowserReloadMarker === 'undefined'");
          } catch {
            return false;
          }
        }, { marker: hostShortcutMarker }, { timeout: 30_000 });
        assert.equal(page.url(), rudderUrl, `${shortcut.label} must not reload the Rudder host route`);
      }

      await browserUrlInput.focus();
      await pressElectronSurfaceShortcut(electronApp, "window", "=", [shortcutModifier]);
      await page.waitForFunction(async () => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.getZoomFactor !== "function") return false;
        return Math.abs((await webview.getZoomFactor()) - 1.1) < 0.001;
      }, null, { timeout: 15_000 });
      await pressElectronSurfaceShortcut(electronApp, "window", "0", [shortcutModifier]);
      await page.waitForFunction(async () => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.getZoomFactor !== "function") return false;
        return Math.abs((await webview.getZoomFactor()) - 1) < 0.001;
      }, null, { timeout: 15_000 });

      const browserTabCountBeforeShortcut = await sidePanel.getByTestId("chat-side-panel-tab").count();
      const nativeWindowCountBeforeShortcut = electronApp
        ? await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        : null;
      await page.evaluate(async () => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
        webview.focus();
        await webview.executeJavaScript("document.querySelector('[aria-label=\"Smoke input\"]')?.focus()");
      });
      await pressElectronSurfaceShortcut(electronApp, "webview", "T", [shortcutModifier]);
      await sidePanel.getByTestId("chat-side-panel-empty-state").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(
        await sidePanel.getByTestId("chat-side-panel-tab").count(),
        browserTabCountBeforeShortcut,
        "Browser guest new-tab shortcut must open the panel picker without creating a placeholder tab",
      );
      await pressElectronSurfaceShortcut(electronApp, "window", "T", [shortcutModifier]);
      assert.equal(
        await sidePanel.getByTestId("chat-side-panel-tab").count(),
        browserTabCountBeforeShortcut,
        "repeated new-tab shortcuts must reuse the open panel picker",
      );
      if (nativeWindowCountBeforeShortcut !== null) {
        assert.equal(
          await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
          nativeWindowCountBeforeShortcut,
          "Browser new-tab shortcut must not create a native Electron window",
        );
      }
      await sidePanel.getByTestId("chat-side-panel-empty-browser-target").click();
      await page.waitForFunction((expectedCount) => (
        document.querySelectorAll("[data-testid='chat-side-panel-tab']").length === expectedCount
      ), browserTabCountBeforeShortcut + 1, { timeout: 15_000 });
      await sidePanel.getByTestId("chat-side-panel-tab").first().evaluate((button) => button.click());
      await page.waitForFunction(({ expectedUrl, marker }) => {
        if (window.__rudderBrowserShortcutHostMarker !== marker) return false;
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        return Boolean(webview && typeof webview.getURL === "function" && webview.getURL() === expectedUrl);
      }, { expectedUrl: fixtureUrl, marker: hostShortcutMarker }, { timeout: 15_000 });
      console.log("[desktop-smoke] Browser guest new-tab shortcut opened the picker and preserved the active guest");

      const routedUrl = `${fixture.url}/routed-link`;
      await page.evaluate((url) => {
        document.querySelector("[data-testid='desktop-smoke-web-link']")?.remove();
        const link = document.createElement("a");
        link.dataset.testid = "desktop-smoke-web-link";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Browser smoke link";
        document.body.appendChild(link);
      }, routedUrl);
      await page.getByTestId("desktop-smoke-web-link").click();
      await page.waitForFunction(({ expectedUrl }) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.getURL !== "function") return false;
        try {
          return webview.getURL() === expectedUrl;
        } catch {
          return false;
        }
      }, { expectedUrl: routedUrl }, { timeout: 30_000 });
      assert.equal(page.url(), rudderUrl, "routed web links should preserve the current Rudder route");

      const redirectEntryUrl = new URL("/desktop-smoke-browser-redirect", baseUrl).toString();
      const redirectTargetUrl = `${fixture.url}/routed-redirect`;
      await page.route(redirectEntryUrl, async (route) => {
        await route.fulfill({
          status: 302,
          headers: { location: redirectTargetUrl },
          body: "",
        });
      });
      try {
        await page.evaluate((url) => {
          window.location.href = url;
        }, redirectEntryUrl);
        await page.waitForFunction(({ expectedUrl }) => {
          const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
          if (!webview || typeof webview.getURL !== "function") return false;
          try {
            return webview.getURL() === expectedUrl;
          } catch {
            return false;
          }
        }, { expectedUrl: redirectTargetUrl }, { timeout: 30_000 });
        assert.equal(page.url(), rudderUrl, "cross-origin redirects must not replace the privileged Rudder renderer");
      } finally {
        await page.unroute(redirectEntryUrl);
      }

      const popupUrl = `${fixture.url}/popup`;
      const browserWebviewCountBeforePopup = await page.locator("webview[data-browser-tab-id]").count();
      const nativeWindowCountBeforePopup = electronApp
        ? await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        : null;
      await page.evaluate(async (url) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
        await webview.executeJavaScript(`window.open(${JSON.stringify(url)}, "_blank")`);
      }, popupUrl);
      await page.waitForFunction(({ expectedUrl }) => {
        return Array.from(document.querySelectorAll("webview[data-browser-tab-id]")).some((webview) => {
          if (typeof webview.getURL !== "function") return false;
          try {
            return webview.getURL() === expectedUrl;
          } catch {
            return false;
          }
        });
      }, { expectedUrl: popupUrl }, { timeout: 30_000 });
      assert.equal(
        await page.locator("webview[data-browser-tab-id]").count(),
        browserWebviewCountBeforePopup + 1,
        "Browser popups should open in a distinct Side Panel tab",
      );
      if (nativeWindowCountBeforePopup !== null) {
        assert.equal(
          await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
          nativeWindowCountBeforePopup,
          "Browser popups must not create native Electron windows",
        );
      }

      const localFileFixture = await createLocalBrowserSmokeFixture();
      const filePopupTabCount = await page.locator("webview[data-browser-tab-id]").count();
      const activeUrlBeforeFileRequest = await page.evaluate(() => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.getURL !== "function") throw new Error("Browser webview unavailable");
        return webview.getURL();
      });
      await page.evaluate(async (url) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
        await webview.executeJavaScript(`window.open(${JSON.stringify(url)}, "_blank")`);
      }, localFileFixture.url);
      await page.waitForTimeout(500);
      assert.equal(
        await page.locator("webview[data-browser-tab-id]").count(),
        filePopupTabCount,
        "page-initiated file popups must not create a Side Panel tab",
      );
      await page.evaluate(async (url) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("Browser webview unavailable");
        await webview.executeJavaScript(`window.location.href = ${JSON.stringify(url)}`);
      }, localFileFixture.url);
      await page.waitForTimeout(500);
      assert.equal(
        await page.evaluate(() => {
          const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
          if (!webview || typeof webview.getURL !== "function") throw new Error("Browser webview unavailable");
          return webview.getURL();
        }),
        activeUrlBeforeFileRequest,
        "page-initiated file redirects must remain on the current web page",
      );

      await browserUrlInput.fill(localFileFixture.url);
      await browserUrlInput.press("Enter");
      await page.waitForFunction(async ({ expectedUrl }) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.getURL !== "function" || typeof webview.executeJavaScript !== "function") {
          return false;
        }
        if (webview.getURL() !== expectedUrl) return false;
        const proof = await webview.executeJavaScript("document.querySelector('#proof')?.textContent ?? ''");
        return proof === "Real Electron webview content";
      }, { expectedUrl: localFileFixture.url }, { timeout: 30_000 });
      await sidePanel.getByTestId("chat-side-panel-tab")
        .filter({ hasText: "Rudder Local File Smoke" })
        .waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(page.url(), rudderUrl, "local file navigation should preserve the current Rudder route");
      if (browserSmokeScreenshotPath) {
        await mkdir(path.dirname(browserSmokeScreenshotPath), { recursive: true });
        await page.screenshot({ path: browserSmokeScreenshotPath, fullPage: true });
      }

      await browserUrlInput.fill(localFileFixture.missingUrl);
      await browserUrlInput.press("Enter");
      const fileLoadError = page.getByTestId("chat-side-panel-browser-error");
      await fileLoadError.waitFor({ state: "visible", timeout: 30_000 });
      assert.match(await fileLoadError.innerText(), /ERR_FILE_NOT_FOUND/);
      assert.equal(page.url(), rudderUrl, "missing local files should not replace the Rudder route");

      const localAddressBarUrl = `${fixtureUrl}#messenger-main-address-bar`;
      await browserUrlInput.fill(localAddressBarUrl);
      await browserUrlInput.press("Enter");
      await page.waitForFunction(async ({ expectedUrl }) => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.getURL !== "function" || typeof webview.executeJavaScript !== "function") {
          return false;
        }
        if (webview.getURL() !== expectedUrl) return false;
        const heading = await webview.executeJavaScript("document.querySelector('h1')?.textContent ?? ''");
        return heading === "Rudder Browser fixture";
      }, { expectedUrl: localAddressBarUrl }, { timeout: 30_000 });

      const promotionBrowserIdentity = await page.evaluate(() => {
        const webview = document.querySelector(
          "[data-testid='chat-side-panel-browser-webview'][data-active='true']",
        );
        const sideTab = document.querySelector(
          "[data-testid='chat-side-panel-tab'][aria-selected='true']",
        );
        return {
          browserTabId: webview?.getAttribute("data-browser-tab-id") ?? null,
          viewInstanceId: sideTab?.getAttribute("data-view-instance-id") ?? null,
        };
      });
      assert.ok(promotionBrowserIdentity.browserTabId, "the promoted Browser guest must expose its tab identity");
      assert.ok(promotionBrowserIdentity.viewInstanceId, "the promoted Browser tab must expose its view instance identity");
      const promotionUrl = `${fixtureUrl}#messenger-main-promotion`;
      let promotionStable = false;
      for (let attempt = 1; attempt <= 3 && !promotionStable; attempt += 1) {
        await browserUrlInput.fill(promotionUrl);
        await browserUrlInput.press("Enter");
        try {
          await page.waitForFunction(async ({ browserTabId, expectedUrl, viewInstanceId }) => {
            const host = Array.from(document.querySelectorAll("[data-testid='live-surface-runtime-host']"))
              .find((candidate) => (
                !candidate.hidden
                && candidate.getAttribute("data-owner-id")?.startsWith("side:")
                && candidate.getAttribute("data-target-kind") === "browser"
                && candidate.getAttribute("data-view-instance-id") === viewInstanceId
              ));
            const browserView = host?.querySelector(
              `[data-browser-tab-id="${CSS.escape(browserTabId)}"][data-active="true"]:not(webview)`,
            );
            const webview = host?.querySelector(
              `webview[data-browser-tab-id="${CSS.escape(browserTabId)}"][data-active="true"]`,
            );
            const addressBar = browserView?.querySelector("input[name='browser-url']");
            if (!webview
              || typeof webview.getURL !== "function"
              || typeof webview.executeJavaScript !== "function"
              || !(addressBar instanceof HTMLInputElement)
              || addressBar.value !== expectedUrl
              || webview.getURL() !== expectedUrl) return false;
            if (typeof webview.isLoading === "function" && webview.isLoading()) return false;
            if ((await webview.executeJavaScript("document.querySelector('h1')?.textContent")) !== "Rudder Browser fixture") {
              return false;
            }
            const historyLength = await webview.executeJavaScript("history.length");
            await new Promise((resolve) => setTimeout(resolve, 750));
            return webview.getURL() === expectedUrl
              && addressBar.value === expectedUrl
              && (typeof webview.isLoading !== "function" || !webview.isLoading())
              && (await webview.executeJavaScript("history.length")) === historyLength;
          }, {
            browserTabId: promotionBrowserIdentity.browserTabId,
            expectedUrl: promotionUrl,
            viewInstanceId: promotionBrowserIdentity.viewInstanceId,
          }, { timeout: 10_000 });
          await page.waitForTimeout(2_000);
          promotionStable = await page.evaluate(({ browserTabId, expectedUrl, viewInstanceId }) => {
            const host = Array.from(document.querySelectorAll("[data-testid='live-surface-runtime-host']"))
              .find((candidate) => (
                !candidate.hidden
                && candidate.getAttribute("data-owner-id")?.startsWith("side:")
                && candidate.getAttribute("data-target-kind") === "browser"
                && candidate.getAttribute("data-view-instance-id") === viewInstanceId
              ));
            const browserView = host?.querySelector(
              `[data-browser-tab-id="${CSS.escape(browserTabId)}"][data-active="true"]:not(webview)`,
            );
            const webview = host?.querySelector(
              `webview[data-browser-tab-id="${CSS.escape(browserTabId)}"][data-active="true"]`,
            );
            const addressBar = browserView?.querySelector("input[name='browser-url']");
            return typeof webview?.getURL === "function"
              && webview.getURL() === expectedUrl
              && addressBar instanceof HTMLInputElement
              && addressBar.value === expectedUrl;
          }, {
            browserTabId: promotionBrowserIdentity.browserTabId,
            expectedUrl: promotionUrl,
            viewInstanceId: promotionBrowserIdentity.viewInstanceId,
          });
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
      assert.equal(promotionStable, true, "Browser promotion URL must remain stable before Move");

      const movingSideTab = sidePanel.locator(
        `[data-testid="chat-side-panel-tab"][data-view-instance-id="${promotionBrowserIdentity.viewInstanceId}"]`,
      );
      assert.equal(
        await movingSideTab.getAttribute("aria-selected"),
        "true",
        "the promoted Browser tab must remain selected before Move",
      );
      const movingViewInstanceId = promotionBrowserIdentity.viewInstanceId;
      const sideTabCountBeforeMove = await sidePanel.getByTestId("chat-side-panel-tab").count();
      const browserGuestCountBeforeMove = await page.locator("webview[data-browser-tab-id]").count();
      assert.ok(sideTabCountBeforeMove > 1, "Browser move smoke requires sibling Side Panel tabs");
      const browserTransferMarker = randomUUID();
      const guestBeforeMove = await page.evaluate(async ({ browserTabId, marker, expectedUrl, viewInstanceId }) => {
        const host = Array.from(document.querySelectorAll("[data-testid='live-surface-runtime-host']"))
          .find((candidate) => (
            !candidate.hidden
            && candidate.getAttribute("data-owner-id")?.startsWith("side:")
            && candidate.getAttribute("data-target-kind") === "browser"
            && candidate.getAttribute("data-view-instance-id") === viewInstanceId
          ));
        const webview = host?.querySelector(
          `webview[data-browser-tab-id="${CSS.escape(browserTabId)}"][data-active="true"]`,
        );
        if (!webview
          || typeof webview.getWebContentsId !== "function"
          || typeof webview.executeJavaScript !== "function") {
          throw new Error("the exact Browser guest was not available before Move");
        }
        webview.__rudderBrowserTransferMarker = marker;
        if (typeof webview.setZoomFactor === "function") webview.setZoomFactor(1.1);
        const guestState = await webview.executeJavaScript(`(() => {
          const input = document.querySelector("#smoke-input");
          if (input) input.value = "preserve-this-form";
          window.scrollTo(0, 900);
          window.__rudderBrowserHeapMarker = ${JSON.stringify(marker)};
          return {
            formValue: input?.value ?? null,
            heapMarker: window.__rudderBrowserHeapMarker,
            scrollY: window.scrollY,
          };
        })()`);
        return {
          browserTabId: webview.getAttribute("data-browser-tab-id"),
          canGoBack: typeof webview.canGoBack === "function" ? webview.canGoBack() : null,
          canGoForward: typeof webview.canGoForward === "function" ? webview.canGoForward() : null,
          domMarker: webview.__rudderBrowserTransferMarker,
          guestState,
          url: webview.getURL(),
          webContentsId: webview.getWebContentsId(),
          zoomFactor: typeof webview.getZoomFactor === "function" ? webview.getZoomFactor() : null,
          expectedUrl,
        };
      }, {
        browserTabId: promotionBrowserIdentity.browserTabId,
        marker: browserTransferMarker,
        expectedUrl: promotionUrl,
        viewInstanceId: promotionBrowserIdentity.viewInstanceId,
      });
      assert.equal(guestBeforeMove.url, promotionUrl);
      assert.ok(guestBeforeMove.browserTabId);
      assert.equal(guestBeforeMove.guestState.formValue, "preserve-this-form");
      assert.equal(guestBeforeMove.guestState.heapMarker, browserTransferMarker);
      assert.ok(guestBeforeMove.guestState.scrollY > 0);
      const sideBrowserCorners = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll(
          "[data-testid='live-surface-runtime-host'][data-owner-id^='side:'][data-target-kind='browser']",
        )).find((candidate) => !candidate.hidden);
        if (!host) throw new Error("visible Side Browser runtime host was unavailable");
        const style = getComputedStyle(host);
        return {
          bottomLeft: style.borderBottomLeftRadius,
          bottomRight: style.borderBottomRightRadius,
          topLeft: style.borderTopLeftRadius,
          topRight: style.borderTopRightRadius,
        };
      });
      assert.ok(
        Object.values(sideBrowserCorners).every((radius) => Number.parseFloat(radius) > 0),
        `Side Browser runtime host must clip every visible corner (${JSON.stringify(sideBrowserCorners)})`,
      );

      const moveResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST"
          && url.pathname === `/api/orgs/${companyId}/messenger/saved-views/keep`;
      }, { timeout: 15_000 });
      await sidePanel.getByTestId("chat-side-panel-keep-in-messenger").click();
      const moveResponse = await moveResponsePromise;
      assert.equal(moveResponse.status(), 201, "Move Browser Saved View returned an unexpected status");
      const moveResult = JSON.parse(await moveResponse.text());
      assert.equal(moveResult?.savedView?.targetPayload?.kind, "browser");
      assert.equal(moveResult?.savedView?.targetPayload?.viewInstanceId, movingViewInstanceId);
      const savedBrowser = await waitForBrowserSavedView(baseUrl, companyId, movingViewInstanceId);
      assert.equal(savedBrowser.savedView.id, moveResult.savedView.id);
      assert.ok(
        savedBrowser.group.entries.some((entry) => (
          entry.item?.type === "thread" && entry.itemKey === `chat:${chat.id}`
        )),
        "moving from an ungrouped Chat should atomically group the Chat and Browser Saved View",
      );
      await page
        .getByText("Moved to Messenger", { exact: true })
        .waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForURL(
        new RegExp(`/${issuePrefix}/messenger/saved/${savedBrowser.savedView.id}$`),
        { timeout: 30_000 },
      );

      const workbench = page.getByTestId("messenger-main-workbench");
      await workbench.waitFor({ state: "visible", timeout: 15_000 });
      const mainTab = workbench.locator(
        `[role="tab"][data-view-instance-id="${movingViewInstanceId}"]`,
      );
      await mainTab.waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await mainTab.getAttribute("aria-selected"), "true");
      assert.equal(
        await sidePanel.locator(
          `[data-testid="chat-side-panel-tab"][data-view-instance-id="${movingViewInstanceId}"]`,
        ).count(),
        0,
        "Move must detach the exact Browser tab from the Side Panel",
      );
      assert.equal(
        await sidePanel.getByTestId("chat-side-panel-tab").count(),
        sideTabCountBeforeMove - 1,
        "Move must leave every sibling Side Panel tab in place",
      );
      assert.equal(
        await page.locator("webview[data-browser-tab-id]").count(),
        browserGuestCountBeforeMove,
        "Move must not create or destroy a Browser guest",
      );

      const guestAfterMove = await page.evaluate(async ({ browserTabId, viewInstanceId }) => {
        const host = Array.from(document.querySelectorAll("[data-testid='live-surface-runtime-host']"))
          .find((candidate) => (
            !candidate.hidden
            && candidate.getAttribute("data-owner-id")?.startsWith("main:")
            && candidate.getAttribute("data-target-kind") === "browser"
            && candidate.getAttribute("data-view-instance-id") === viewInstanceId
          ));
        const webview = host?.querySelector(
          `webview[data-browser-tab-id="${CSS.escape(browserTabId)}"][data-active="true"]`,
        );
        if (!webview
          || typeof webview.getWebContentsId !== "function"
          || typeof webview.executeJavaScript !== "function") {
          throw new Error("the exact Browser guest was not active in Main Workbench");
        }
        return {
          browserTabId: webview.getAttribute("data-browser-tab-id"),
          canGoBack: typeof webview.canGoBack === "function" ? webview.canGoBack() : null,
          canGoForward: typeof webview.canGoForward === "function" ? webview.canGoForward() : null,
          domMarker: webview.__rudderBrowserTransferMarker ?? null,
          guestState: await webview.executeJavaScript(`(() => ({
            formValue: document.querySelector("#smoke-input")?.value ?? null,
            heapMarker: window.__rudderBrowserHeapMarker ?? null,
            scrollY: window.scrollY,
          }))()`),
          url: webview.getURL(),
          webContentsId: webview.getWebContentsId(),
          zoomFactor: typeof webview.getZoomFactor === "function" ? webview.getZoomFactor() : null,
        };
      }, {
        browserTabId: guestBeforeMove.browserTabId,
        viewInstanceId: movingViewInstanceId,
      });
      const { scrollY: guestBeforeMoveScrollY, ...guestBeforeMoveStableState } = guestBeforeMove.guestState;
      const { scrollY: guestAfterMoveScrollY, ...guestAfterMoveStableState } = guestAfterMove.guestState;
      assert.deepEqual(
        {
          ...guestAfterMove,
          guestState: guestAfterMoveStableState,
        },
        {
          browserTabId: guestBeforeMove.browserTabId,
          canGoBack: guestBeforeMove.canGoBack,
          canGoForward: guestBeforeMove.canGoForward,
          domMarker: guestBeforeMove.domMarker,
          guestState: guestBeforeMoveStableState,
          url: guestBeforeMove.url,
          webContentsId: guestBeforeMove.webContentsId,
          zoomFactor: guestBeforeMove.zoomFactor,
        },
        "Move must preserve the exact Browser guest, URL, navigation state, form, zoom, and heap marker",
      );
      assert.ok(
        Math.abs(guestAfterMoveScrollY - guestBeforeMoveScrollY) <= 32,
        `Move must preserve Browser guest scroll position within 32px: expected ${guestBeforeMoveScrollY}, got ${guestAfterMoveScrollY}`,
      );

      const fullBleed = await page.evaluate(() => {
        const root = document.querySelector("[data-testid='messenger-main-workbench']");
        const tablist = root?.querySelector("[role='tablist']");
        const panel = root?.querySelector("[role='tabpanel']:not([hidden])");
        const anchor = panel?.querySelector("[data-testid='messenger-main-live-surface-anchor']");
        const host = Array.from(document.querySelectorAll("[data-testid='live-surface-runtime-host']"))
          .find((candidate) => candidate.getAttribute("data-owner-id")?.startsWith("main:"));
        const browserSurface = host?.querySelector(
          "[data-testid='chat-side-panel-browser-view']",
        );
        const browserToolbar = host?.querySelector(
          "[data-testid='chat-side-panel-browser-toolbar']",
        );
        const browserContent = host?.querySelector(
          "[data-testid='chat-side-panel-browser-content']",
        );
        if (!root || !tablist || !panel || !anchor || !host || !browserSurface || !browserToolbar || !browserContent) {
          throw new Error("Main Workbench full-bleed geometry was unavailable");
        }
        const rect = (element) => {
          const value = element.getBoundingClientRect();
          return {
            bottom: value.bottom,
            left: value.left,
            right: value.right,
            top: value.top,
          };
        };
        const backgroundAlpha = (element) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Browser surface opacity probe was unavailable");
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data[3];
        };
        return {
          anchor: rect(anchor),
          browserSurfaceAlpha: backgroundAlpha(browserSurface),
          browserToolbarFlowsDirectlyIntoContent:
            browserToolbar.nextElementSibling === browserContent,
          browserToolbarAlpha: backgroundAlpha(browserToolbar),
          host: rect(host),
          hostBottomLeftRadius: getComputedStyle(host).borderBottomLeftRadius,
          hostBottomRightRadius: getComputedStyle(host).borderBottomRightRadius,
          hostTopLeftRadius: getComputedStyle(host).borderTopLeftRadius,
          hostTopRightRadius: getComputedStyle(host).borderTopRightRadius,
          nestedCardCount: root.querySelectorAll(".workspace-main-card").length,
          panel: rect(panel),
          root: rect(root),
          rootBackgroundAlpha: backgroundAlpha(root),
          rootBorderRadius: getComputedStyle(root).borderRadius,
          rootPadding: getComputedStyle(root).padding,
          tablist: rect(tablist),
          tablistBackgroundAlpha: backgroundAlpha(tablist),
        };
      });
      const withinTwoPixels = (left, right) => Math.abs(left - right) <= 2;
      assert.equal(fullBleed.nestedCardCount, 0, "Main Browser must not be nested in another workspace card");
      assert.ok(
        Number.parseFloat(fullBleed.rootBorderRadius) > 0,
        `Main Workbench must retain its transparent rounded boundary (received radius ${fullBleed.rootBorderRadius})`,
      );
      assert.equal(fullBleed.rootBackgroundAlpha, 0, "Main Workbench shell backdrop must be transparent");
      assert.equal(fullBleed.tablistBackgroundAlpha, 0, "Main Workbench tab strip must be transparent");
      assert.equal(fullBleed.rootPadding, "0px", "Main Workbench must not inset the Browser surface");
      assert.ok(
        Number.parseFloat(fullBleed.hostTopLeftRadius) > 0
          && Number.parseFloat(fullBleed.hostTopRightRadius) > 0
          && Number.parseFloat(fullBleed.hostBottomLeftRadius) > 0
          && Number.parseFloat(fullBleed.hostBottomRightRadius) > 0,
        "Main Browser runtime host must clip its visible content to every workspace corner",
      );
      assert.equal(
        fullBleed.browserToolbarFlowsDirectlyIntoContent,
        true,
        "Main Browser must not render a redundant site-title row below the address bar",
      );
      for (const [surface, alpha] of [
        ["Browser surface", fullBleed.browserSurfaceAlpha],
        ["Browser toolbar", fullBleed.browserToolbarAlpha],
      ]) {
        assert.equal(alpha, 255, `${surface} must be opaque`);
      }
      assert.ok(withinTwoPixels(fullBleed.panel.left, fullBleed.root.left));
      assert.ok(withinTwoPixels(fullBleed.panel.right, fullBleed.root.right));
      assert.ok(withinTwoPixels(fullBleed.panel.bottom, fullBleed.root.bottom));
      assert.ok(withinTwoPixels(fullBleed.panel.top, fullBleed.tablist.bottom));
      for (const edge of ["bottom", "left", "right", "top"]) {
        assert.ok(
          withinTwoPixels(fullBleed.host[edge], fullBleed.anchor[edge]),
          `the live Browser host must fill the Main panel anchor at ${edge}`,
        );
      }
      const savedBrowserRow = page.getByTestId(
        `messenger-saved-view-${safeLocalAppTestId(savedBrowser.entry.id)}`,
      );
      await savedBrowserRow.waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(
        (await savedBrowserRow.innerText()).includes(promotionUrl),
        false,
        "Messenger Browser rows must not display the URL",
      );
      if (browserSmokeScreenshotPath) {
        await page.evaluate(async ({ browserTabId }) => {
          const webview = document.querySelector(
            `[data-testid='chat-side-panel-browser-webview'][data-active='true'][data-browser-tab-id="${CSS.escape(browserTabId)}"]`,
          );
          if (!webview || typeof webview.executeJavaScript !== "function") {
            throw new Error("the promoted Browser guest was unavailable for screenshot framing");
          }
          await webview.executeJavaScript("window.scrollTo(0, 0)");
        }, { browserTabId: guestBeforeMove.browserTabId });
        await page.waitForFunction(async ({ browserTabId }) => {
          const webview = document.querySelector(
            `[data-testid='chat-side-panel-browser-webview'][data-active='true'][data-browser-tab-id="${CSS.escape(browserTabId)}"]`,
          );
          if (!webview || typeof webview.executeJavaScript !== "function") return false;
          return await webview.executeJavaScript("window.scrollY === 0");
        }, { browserTabId: guestBeforeMove.browserTabId }, { timeout: 5_000 });
        await mkdir(path.dirname(browserSmokeScreenshotPath), { recursive: true });
        await page.screenshot({ path: browserSmokeScreenshotPath, fullPage: true });
      }
      console.log("[desktop-smoke] Browser exact guest moved into a full-bleed Main Workbench while sibling Side tabs stayed in place");
    }

    console.log("[desktop-smoke] Side Panel Browser loaded the isolated fixture and completed Main Workbench promotion");
    return page;
  } finally {
    if (!providedFixture) await fixture.stop().catch(() => {});
  }
}

async function assertDesktopServiceWorkersDisabled(page) {
  const state = await page.evaluate(async () => {
    const registrations = "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];
    return {
      registrations: registrations.length,
      hasController: "serviceWorker" in navigator ? Boolean(navigator.serviceWorker.controller) : false,
    };
  });
  assert.equal(state.registrations, 0, "desktop shell should not register service workers");
  assert.equal(state.hasController, false, "desktop shell should not keep a service worker controller");
}

async function verifyReloadRecovery(electronApp, page, companyId, issuePrefix, organizationRouteKey) {
  console.log("[desktop-smoke] verifying desktop reload recovery");
  page = await waitForBoardWindow(electronApp, page);
  await page.evaluate(({ nextCompanyId, nextPath }) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
    window.history.replaceState({}, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, {
    nextCompanyId: companyId,
    nextPath: `/${issuePrefix}/dashboard`,
  });
  await page.waitForURL(new RegExp(`/${issuePrefix}/dashboard$`), { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await dismissReleaseNotesDialogIfVisible(page);
  await page.locator("[data-settings-trigger='true']").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await assertDesktopServiceWorkersDisabled(page);
  const openWindowCount = electronApp.windows().filter((candidate) => !candidate.isClosed()).length;

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });

  await page.waitForLoadState("networkidle");
  await page.waitForURL(new RegExp(`/${organizationRouteKey}/dashboard$`), { timeout: 30_000 });
  await dismissReleaseNotesDialogIfVisible(page);
  await page.locator("[data-settings-trigger='true']").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await assertDesktopServiceWorkersDisabled(page);
  const navigationType = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.type ?? null);
  assert.equal(navigationType, "reload", "desktop refresh should behave like a native page reload");
  const nextWindowCount = electronApp.windows().filter((candidate) => !candidate.isClosed()).length;
  assert.equal(nextWindowCount, openWindowCount, "desktop refresh should not replace the app window");
  console.log("[desktop-smoke] desktop reload completed as an in-place page refresh");
  return page;
}

async function verifyCompaniesPersist(baseUrl, companyId) {
  console.log("[desktop-smoke] verifying persisted companies");
  const companiesResponse = await fetch(`${baseUrl}/api/orgs`);
  assert.equal(companiesResponse.status, 200, "list companies should succeed after restart");
  const companies = await companiesResponse.json();
  assert.ok(
    Array.isArray(companies) && companies.some((entry) => entry.id === companyId),
    "company should persist after restart",
  );
}

async function degradeIssueSchema(databaseUrl) {
  console.log("[desktop-smoke] downgrading issue schema to legacy shape");
  const postgres = await loadPostgres();
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const chiefVindicatorHash = await migrationHash("0021_chief_vindicator.sql");

  try {
    const columns = await sql.unsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'issues'
        AND column_name IN ('assignee_agent_runtime_overrides', 'assignee_adapter_overrides')
      ORDER BY column_name
    `);
    const columnNames = new Set(columns.map((row) => row.column_name));
    if (columnNames.has("assignee_agent_runtime_overrides") && !columnNames.has("assignee_adapter_overrides")) {
      await sql.unsafe(
        `ALTER TABLE "issues" RENAME COLUMN "assignee_agent_runtime_overrides" TO "assignee_adapter_overrides"`,
      );
    }

    const migrationColumns = await sql.unsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'drizzle'
        AND table_name = '__drizzle_migrations'
      ORDER BY ordinal_position
    `);
    const migrationColumnNames = new Set(migrationColumns.map((row) => row.column_name));
    if (migrationColumnNames.has("name")) {
      await sql.unsafe(
        `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "name" = '0021_chief_vindicator.sql'`,
      );
    } else {
      await sql.unsafe(
        `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '${chiefVindicatorHash}'`,
      );
    }
  } finally {
    await sql.end();
  }
}

async function assertUpgradeRepairLogged(logsDir) {
  const logFile = await resolveServerLogPath(logsDir);
  const log = await readFile(logFile, "utf8");
  assert.match(
    log,
    /legacy schema drift; normalized columns before migration inspection/i,
    "expected packaged upgrade smoke to log legacy schema normalization",
  );
}

async function readSupportHandoffs(recordPath) {
  const content = await readFile(recordPath, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runStartupRecoveryScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "startup-recovery");
  const ports = await allocateSmokePorts();
  const invalidPostgresBinDir = path.join(scenarioRoot, "missing-postgres-bin");
  const supportHandoffPath = path.join(scenarioRoot, "support-handoffs.jsonl");
  const bugReportHandoffPath = path.join(scenarioRoot, "bug-report-handoffs.jsonl");
  const { electronApp, page } = await launchDesktopWindow(scenarioRoot, mode, ports, {
    RUDDER_POSTGRES_BIN_DIR: invalidPostgresBinDir,
    RUDDER_DESKTOP_SMOKE_SUPPORT_HANDOFF_PATH: supportHandoffPath,
    RUDDER_DESKTOP_SMOKE_SUPPORT_HANDOFF_SEQUENCE: "resolve,resolve,reject",
    RUDDER_DESKTOP_SMOKE_BUG_REPORT_HANDOFF_PATH: bugReportHandoffPath,
    RUDDER_DESKTOP_SMOKE_BUG_REPORT_HANDOFF_SEQUENCE: "resolve,resolve,resolve,reject,reject",
    RUDDER_DESKTOP_SMOKE_BUG_REPORT_HANDOFF_DELAY_SEQUENCE: "80,80,700,1500,80",
  });

  let scenarioError = null;
  try {
    await page.waitForFunction(
      () => document.body.dataset.bootView === "failed",
      null,
      { timeout: 60_000 },
    );
    const initialState = await page.evaluate(() => window.rudderBoot.getState());
    assert.equal(initialState.view, "failed", "startup recovery should expose a failed safe view model");
    assert.equal(initialState.failure?.attempt, 1, "the first startup failure should be attempt one");
    await page.waitForFunction(() => document.activeElement?.id === "failure-title");
    assert.equal(
      await page.getByRole("button", { name: "Try again" }).isEnabled(),
      true,
      "startup retry should be available after failure",
    );
    assert.equal(
      await page.getByRole("button", { name: "Email support" }).isEnabled(),
      true,
      "support email should be available after failure",
    );
    assert.equal(
      await page.getByRole("button", { name: "Report on GitHub" }).isEnabled(),
      true,
      "the fixed GitHub bug report should be available after failure",
    );
    assert.equal(
      await page.locator("#technical-details").evaluate((details) => details.open),
      false,
      "technical details should stay collapsed until the operator asks for them",
    );
    const visibleText = await page.locator("body").innerText();
    assert.doesNotMatch(visibleText, /Starting Rudder|Preparing database|Profile\s+prod_local/u);
    const bridgeShape = await page.evaluate(() => ({
      hasBootBridge: typeof window.rudderBoot === "object",
      hasFullDesktopShell: typeof window.desktopShell !== "undefined",
      hasBugReportIntent: typeof window.rudderBoot.openBugReport === "function",
      bugReportIntentArgumentCount: window.rudderBoot.openBugReport.length,
    }));
    assert.deepEqual(bridgeShape, {
      hasBootBridge: true,
      hasFullDesktopShell: false,
      hasBugReportIntent: true,
      bugReportIntentArgumentCount: 0,
    });

    const emailButton = page.getByRole("button", { name: "Email support" });
    await emailButton.click();
    await page.locator("#inline-status").filter({ hasText: "The draft was handed to your mail app" }).waitFor();
    assert.equal(await emailButton.isEnabled(), true, "email support should be reusable after handoff completes");
    let handoffs = await readSupportHandoffs(supportHandoffPath);
    assert.equal(handoffs.length, 1, "the first email action should perform one OS handoff");
    const mailto = new URL(handoffs[0].url);
    assert.equal(mailto.protocol, "mailto:");
    assert.equal(mailto.pathname, "zeeland4work@gmail.com");
    assert.equal(mailto.searchParams.has("attach"), false);
    assert.equal(mailto.searchParams.has("cc"), false);
    assert.equal(mailto.searchParams.has("bcc"), false);
    assert.match(mailto.searchParams.get("body") ?? "", /Failure ID:/u);
    assert.match(mailto.searchParams.get("body") ?? "", /Failure summary:/u);
    assert.doesNotMatch(handoffs[0].url, /\+/u, "mailto handoff should not expose form-encoded spaces as literal plus signs");
    assert.match(handoffs[0].url, /%20/u, "mailto handoff should percent-encode spaces for desktop mail clients");

    await page.evaluate(() => Promise.all([
      window.rudderBoot.openSupportDraft(),
      window.rudderBoot.openSupportDraft(),
    ]));
    handoffs = await readSupportHandoffs(supportHandoffPath);
    assert.equal(handoffs.length, 2, "concurrent support intents should coalesce into one additional handoff");

    await emailButton.click();
    await page.locator("#inline-status").filter({ hasText: "Rudder could not hand off the draft" }).waitFor();
    assert.equal(await emailButton.isEnabled(), true, "email support should remain reusable after handoff rejection");
    assert.equal(await page.getByRole("button", { name: "Copy support email" }).isVisible(), true);
    handoffs = await readSupportHandoffs(supportHandoffPath);
    assert.equal(handoffs.length, 3, "the rejected handoff should be recorded as one distinct attempt");

    const issueButton = page.getByRole("button", { name: "Report on GitHub" });
    await issueButton.click();
    await page.locator("#inline-status").filter({ hasText: "GitHub opened" }).waitFor();
    assert.equal(await issueButton.isEnabled(), true, "GitHub reporting should be reusable after handoff completes");
    let issueHandoffs = await readSupportHandoffs(bugReportHandoffPath);
    assert.equal(issueHandoffs.length, 1, "the first GitHub action should perform one OS handoff");
    assert.equal(
      issueHandoffs[0].url,
      "https://github.com/Undertone0809/rudder/issues/new?template=bug_report.yml",
      "the boot renderer must route to the fixed repository bug template",
    );

    await page.evaluate(() => Promise.all([
      window.rudderBoot.openBugReport(),
      window.rudderBoot.openBugReport(),
    ]));
    issueHandoffs = await readSupportHandoffs(bugReportHandoffPath);
    assert.equal(issueHandoffs.length, 2, "concurrent GitHub intents should coalesce into one additional handoff");

    await issueButton.click();
    await page.locator("#inline-status").filter({ hasText: "Opening the GitHub bug report" }).waitFor();
    await electronApp.evaluate(({ app, BrowserWindow }) => {
      app.emit("browser-window-focus", {}, BrowserWindow.getAllWindows()[0]);
    });
    await page.locator("#inline-status").filter({ hasText: "GitHub opened" }).waitFor();
    assert.equal(
      await issueButton.isEnabled(),
      true,
      "a duplicate state broadcast for the same failure must not strand the handoff button disabled",
    );
    issueHandoffs = await readSupportHandoffs(bugReportHandoffPath);
    assert.equal(issueHandoffs.length, 3, "the same-failure state replay should not create another handoff");

    await page.locator("#technical-details summary").click();
    const technicalDiagnostic = await page.locator("#diagnostic-grid").innerText();
    assert.match(technicalDiagnostic, /Failure ID/u);
    assert.match(technicalDiagnostic, /Summary/u);
    assert.match(technicalDiagnostic, /local database/iu);
    assert.match(technicalDiagnostic, /Instance folder/u);
    await page.getByRole("button", { name: "Copy diagnostic" }).click();
    const copiedDiagnostic = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(copiedDiagnostic, /Summary: The local database/iu);
    assert.doesNotMatch(copiedDiagnostic, /Instance folder|\/Users\//u, "shareable diagnostic should omit local paths");

    await issueButton.click();
    await page.locator("#inline-status").filter({ hasText: "Opening the GitHub bug report" }).waitFor();
    await page.getByRole("button", { name: "Try again" }).dblclick();
    await page.waitForFunction(
      (attempt) => {
        if (document.body.dataset.bootView !== "failed") return false;
        const rows = Array.from(document.querySelectorAll("#diagnostic-grid dd"));
        return rows.some((row) => row.textContent === String(attempt + 1));
      },
      initialState.failure.attempt,
      { timeout: 60_000 },
    );
    const retryState = await page.evaluate(() => window.rudderBoot.getState());
    assert.equal(retryState.failure?.attempt, 2, "double-click retry should produce one new startup attempt");
    await page.waitForTimeout(1_700);
    assert.doesNotMatch(
      await page.locator("#inline-status").innerText(),
      /Rudder could not open GitHub/u,
      "a rejected handoff from the prior failure must not overwrite the new failure state",
    );
    assert.equal(
      await page.getByRole("button", { name: "Copy issue link" }).isVisible(),
      false,
      "a stale rejection must not expose fallback actions on the new failure",
    );
    issueHandoffs = await readSupportHandoffs(bugReportHandoffPath);
    assert.equal(issueHandoffs.length, 4, "the stale rejected handoff should still finish exactly once");

    await issueButton.click();
    await page.locator("#inline-status").filter({ hasText: "Rudder could not open GitHub" }).waitFor();
    const copyIssueLinkButton = page.getByRole("button", { name: "Copy issue link" });
    assert.equal(await copyIssueLinkButton.isVisible(), true);
    await copyIssueLinkButton.click();
    assert.equal(
      await electronApp.evaluate(({ clipboard }) => clipboard.readText()),
      "https://github.com/Undertone0809/rudder/issues/new?template=bug_report.yml",
      "the fallback should copy the fixed bug report URL",
    );
    issueHandoffs = await readSupportHandoffs(bugReportHandoffPath);
    assert.equal(issueHandoffs.length, 5, "the current failure rejection should be recorded as one distinct attempt");

    assert.equal(
      electronApp.windows().filter((candidate) => !candidate.isClosed()).length,
      1,
      "startup retry should remain in one Desktop window",
    );
    console.log("[desktop-smoke] startup recovery kept diagnostics hidden, used fixed support intents, and coalesced retry");
  } catch (error) {
    scenarioError = error;
  }
  let shutdownError = null;
  try {
    await closeDesktop(electronApp);
  } catch (error) {
    shutdownError = error;
  }
  if (scenarioError && shutdownError) {
    throw new AggregateError([scenarioError, shutdownError], "Startup recovery scenario and shutdown cleanup failed");
  }
  if (scenarioError) throw scenarioError;
  if (shutdownError) throw shutdownError;
}

async function runCleanScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "clean");
  const ports = await allocateSmokePorts();
  const runtimeUrls = createRuntimeUrls(ports);
  const browserImportFixture = await createSyntheticBrowserImportFixture(scenarioRoot);
  const packagedRuntime = mode === "packaged" ? await preparePackagedExternalRuntimeFixture(scenarioRoot) : null;
  const firstRun = await launchDesktop(scenarioRoot, mode, ports, packagedRuntime?.env);
  const browserFixture = await startBrowserSmokeFixture();
  try {
    if (packagedRuntime) {
      assert.equal(await pathExists(packagedRuntime.loadedMarker), true, "packaged Desktop should load the external runtime cache");
    }
    const company = await createCompany(firstRun.baseUrl);
    const companyRouteKey = company.urlKey ?? company.issuePrefix;
    assert.deepEqual(
      await readBrowserSettings(firstRun.baseUrl),
      { enabled: true, openLinksIn: "built_in" },
      "fresh Desktop Browser settings should default on and route links internally",
    );
    await verifyBundledSkills(firstRun.baseUrl, company.id);
    await verifySyntheticBrowserCookieImport(firstRun.electronApp, firstRun.page, browserImportFixture);
    const ceo = await createCeo(firstRun.baseUrl, company.id);
    await verifyAgentBrowserBroker(
      firstRun.electronApp,
      firstRun.baseUrl,
      runtimeUrls.databaseUrl,
      company,
      ceo,
      packagedRuntime,
    );
    await verifyAgentWorkspaceTerminal(firstRun.electronApp, firstRun.page, firstRun.baseUrl, company, ceo);
    const issue = await createIssue(firstRun.baseUrl, company.id, ceo.id);
    if (mode === "packaged") {
      await verifyPackagedDesktopCli(firstRun.baseUrl, ceo, issue);
      assert.equal(await pathExists(packagedRuntime.staleMarker), false, "packaged runtime must not invoke stale PATH rudder");
    }
    firstRun.page = await verifyReloadRecovery(
      firstRun.electronApp,
      firstRun.page,
      company.id,
      company.issuePrefix,
      companyRouteKey,
    );
    firstRun.page = await verifyNativeApplicationMenu(firstRun.electronApp, firstRun.page, company.id, companyRouteKey);
    await verifyIssueDetailEscapeNavigation(firstRun.page, company.id, companyRouteKey, issue);
    firstRun.page = await verifyOrganizationWorkspacesNavigation(
      firstRun.electronApp,
      firstRun.page,
      company.id,
      companyRouteKey,
    );
    firstRun.page = await verifyChatSidePanelBrowser(
      firstRun.page,
      firstRun.baseUrl,
      company.id,
      companyRouteKey,
      { electronApp: firstRun.electronApp, fixture: browserFixture, seedStorage: true },
    );
    assert.equal(
      (await readBrowserSmokeCookie(firstRun.electronApp, firstRun.page))?.value,
      browserSmokeCookieValue,
      "Browser webview should write to the dedicated persistent profile",
    );

    await verifyOperatorBrowserRoutingWhileAgentAccessIsDisabled(
      firstRun.page,
      firstRun.baseUrl,
      company.id,
      browserFixture.url,
    );
    assert.equal(
      (await readBrowserSmokeCookie(firstRun.electronApp, firstRun.page))?.value,
      browserSmokeCookieValue,
      "disabling Agent Browser access should preserve operator tabs and shared profile data",
    );

    await setBrowserEnabled(firstRun.page, firstRun.baseUrl, true);
    await verifyBrowserSkillState(firstRun.baseUrl, company.id, true);
    const secondCompany = await createCompany(firstRun.baseUrl, "DS2");
    const secondCompanyRouteKey = secondCompany.urlKey ?? secondCompany.issuePrefix;
    await verifyBundledSkills(firstRun.baseUrl, secondCompany.id);
    await createCeo(firstRun.baseUrl, secondCompany.id);
    firstRun.page = await verifyChatSidePanelBrowser(
      firstRun.page,
      firstRun.baseUrl,
      secondCompany.id,
      secondCompanyRouteKey,
      {
        electronApp: firstRun.electronApp,
        exerciseRouting: false,
        expectCookie: true,
        expectStorage: true,
        fixture: browserFixture,
        seedCookie: false,
      },
    );
    console.log("[desktop-smoke] Browser profile survived disable and was shared with a second organization");

    await verifySettingsOverlayFlow(firstRun.page, company.id, companyRouteKey);
    console.log("[desktop-smoke] closing first app run");
    await closeDesktop(firstRun.electronApp);

    const isolatedPorts = await allocateSmokePorts();
    const isolatedRun = await launchDesktop(path.join(tmpRoot, "browser-isolated-instance"), mode, isolatedPorts);
    try {
      assert.equal(
        await readBrowserSmokeCookie(isolatedRun.electronApp, isolatedRun.page),
        null,
        "a separate Rudder instance must not reuse Browser profile data",
      );
    } finally {
      await closeDesktop(isolatedRun.electronApp);
    }

    const secondRun = await launchDesktop(scenarioRoot, mode, ports);
    try {
      await verifyCompaniesPersist(secondRun.baseUrl, company.id);
      assert.equal(
        (await readBrowserSmokeCookie(secondRun.electronApp, secondRun.page))?.value,
        browserSmokeCookieValue,
        "same-instance Browser profile data should persist across Desktop restart",
      );
      if (browserImportFixture) {
        assert.equal(
          (await readBrowserImportSmokeCookie(secondRun.electronApp, secondRun.page))?.value,
          browserImportSmokeCookieValue,
          "imported Browser cookies should persist across Desktop restart",
        );
        assert.equal(
          (await readBrowserImportDuplicateCookie(secondRun.electronApp, secondRun.page))?.value,
          browserImportDuplicateDestinationValue,
          "existing destination cookies should persist across Desktop restart",
        );
      }
      secondRun.page = await verifyChatSidePanelBrowser(
        secondRun.page,
        secondRun.baseUrl,
        secondCompany.id,
        secondCompanyRouteKey,
        {
          electronApp: secondRun.electronApp,
          exerciseRouting: false,
          expectCookie: true,
          expectStorage: true,
          fixture: browserFixture,
          seedCookie: false,
        },
      );

      const settingsBeforeClear = await readBrowserSettings(secondRun.baseUrl);
      await clearBrowserProfile(secondRun.page);
      assert.equal(
        await readBrowserSmokeCookie(secondRun.electronApp, secondRun.page),
        null,
        "clearing Browser data should remove the shared profile cookie",
      );
      if (browserImportFixture) {
        assert.equal(
          await readBrowserImportSmokeCookie(secondRun.electronApp, secondRun.page),
          null,
          "clearing Browser data should remove imported cookies",
        );
        assert.equal(
          await readBrowserImportDuplicateCookie(secondRun.electronApp, secondRun.page),
          null,
          "clearing Browser data should remove pre-existing destination cookies",
        );
      }
      secondRun.page = await verifyChatSidePanelBrowser(
        secondRun.page,
        secondRun.baseUrl,
        secondCompany.id,
        secondCompanyRouteKey,
        {
          electronApp: secondRun.electronApp,
          exerciseRouting: false,
          expectCookie: false,
          expectStorage: false,
          fixture: browserFixture,
          seedCookie: false,
        },
      );
      assert.deepEqual(
        await readBrowserSettings(secondRun.baseUrl),
        settingsBeforeClear,
        "clearing Browser data must preserve Browser enablement and link preference",
      );
      console.log("[desktop-smoke] Browser profile persisted across restart, stayed instance-isolated, and cleared without resetting settings");
    } finally {
      await closeDesktop(secondRun.electronApp);
    }
  } catch (error) {
    console.error("[desktop-smoke] clean scenario failed", error);
    await closeDesktop(firstRun.electronApp).catch(() => {});
    throw error;
  } finally {
    await browserFixture.stop().catch(() => {});
    browserImportFixture?.close();
  }
}

async function runBrowserScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "browser");
  const ports = await allocateSmokePorts();
  const run = await launchDesktop(scenarioRoot, mode, ports);
  const fixture = await startBrowserSmokeFixture();
  try {
    const company = await createCompany(run.baseUrl);
    await createCeo(run.baseUrl, company.id);
    await verifyChatSidePanelBrowser(
      run.page,
      run.baseUrl,
      company.id,
      company.urlKey ?? company.issuePrefix,
      { electronApp: run.electronApp, fixture },
    );
    await verifyOperatorBrowserRoutingWhileAgentAccessIsDisabled(
      run.page,
      run.baseUrl,
      company.id,
      fixture.url,
    );
    await closeDesktop(run.electronApp);
  } catch (error) {
    console.error("[desktop-smoke] browser scenario failed", error);
    await closeDesktop(run.electronApp).catch(() => {});
    throw error;
  } finally {
    await fixture.stop().catch(() => {});
  }
}

async function runTerminalScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "terminal");
  if (mode === "packaged") {
    await preparePackagedExternalRuntimeFixture(scenarioRoot);
    console.log("[desktop-smoke] packaged Agent Terminal native PTY passed");
    return;
  }
  const ports = await allocateSmokePorts();
  const run = await launchDesktop(scenarioRoot, mode, ports);
  try {
    const company = await createCompany(run.baseUrl);
    const primedAgentListing = await fetch(`${run.baseUrl}/api/orgs/${company.id}/workspace/files?path=agents`);
    assert.equal(primedAgentListing.ok, true, "Agent workspace listing should be readable before Agent creation");
    const agent = await createCeo(run.baseUrl, company.id);
    await verifyAgentWorkspaceTerminal(run.electronApp, run.page, run.baseUrl, company, agent);
    await closeDesktop(run.electronApp);
  } catch (error) {
    console.error("[desktop-smoke] Terminal scenario failed", error);
    await closeDesktop(run.electronApp).catch(() => {});
    throw error;
  }
}

async function readDesktopLocalAppStatus(page, definitionId) {
  return page.evaluate((id) => window.desktopShell.localApps.status(id), definitionId);
}

async function readDesktopLocalAppAttestedTarget(page, definitionId) {
  return page.evaluate((id) => window.desktopShell.localApps.attestedTarget(id), definitionId);
}

async function assertLocalAppEndpointReachable(attested, definition, label) {
  const response = await fetch(`${attested.origin}${definition.readiness.path}`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.ok, true, label);
}

async function openSmokeSidePanel(page) {
  const sidePanel = page.getByTestId("chat-side-panel");
  if (await sidePanel.isVisible().catch(() => false)) return sidePanel;
  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();
  await sidePanel.waitFor({ state: "visible", timeout: 15_000 });
  return sidePanel;
}

async function verifyAgentWorkspaceTerminal(electronApp, page, baseUrl, company, agent) {
  console.log("[desktop-smoke] verifying Agent workspace Terminal");
  const chat = await createAgentTerminalChat(baseUrl, company.id, agent.id);
  const companyRouteKey = company.urlKey ?? company.issuePrefix;
  await page.goto(new URL(`/${companyRouteKey}/messenger/chat/${chat.id}`, baseUrl).href);
  await page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/chat/${chat.id}$`), { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await dismissOnboardingIfVisible(page);
  const sidePanel = await openSmokeSidePanel(page);
  const target = sidePanel.getByTestId("chat-side-panel-empty-terminal-target");
  await target.waitFor({ state: "visible", timeout: 15_000 });
  await target.click();
  const terminal = sidePanel.getByTestId("terminal-panel-view");
  await terminal.waitFor({ state: "visible", timeout: 15_000 });
  try {
    await page.waitForFunction(() => {
      const panel = document.querySelector("[data-testid='terminal-panel-view']");
      return Boolean(panel && !panel.textContent?.includes("Starting terminal") && !panel.textContent?.includes("Terminal unavailable"));
    }, null, { timeout: 15_000 });
  } catch (cause) {
    const renderer = await terminal.evaluate((panel) => {
      const host = panel.querySelector("[data-testid='terminal-xterm-host']");
      const xterm = panel.querySelector(".xterm");
      const screen = panel.querySelector(".xterm-screen");
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, display: getComputedStyle(element).display };
      };
      return {
        status: panel.querySelector("h3")?.textContent ?? null,
        message: panel.querySelector("h3 + p")?.textContent ?? null,
        panel: rect(panel),
        host: rect(host),
        xterm: rect(xterm),
        screen: rect(screen),
        supported: window.desktopShell?.terminal?.supported ?? null,
      };
    });
    const directCreate = await page.evaluate(async ({ orgId, agentId }) => {
      const sessionId = `terminal-smoke-probe-${Date.now()}`;
      try {
        const result = await Promise.race([
          window.desktopShell.terminal.create({ orgId, agentId, sessionId, cols: 80, rows: 24 })
            .then((value) => ({ status: "resolved", value })),
          new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 5_000)),
        ]);
        if (result.status === "resolved") await window.desktopShell.terminal.close(sessionId);
        return result;
      } catch (error) {
        return { status: "rejected", error: error instanceof Error ? error.message : String(error) };
      }
    }, { orgId: company.id, agentId: agent.id });
    throw new Error(`Agent Terminal did not become ready: ${JSON.stringify({ renderer, directCreate })}`, { cause });
  }

  const xtermInput = terminal.locator(".xterm-helper-textarea");
  await xtermInput.waitFor({ state: "attached", timeout: 10_000 });
  const initialLayout = await terminal.evaluate((panel) => {
    const host = panel.querySelector("[data-testid='terminal-xterm-host']");
    const screen = panel.querySelector(".xterm-screen");
    return {
      hostWidth: host?.getBoundingClientRect().width ?? 0,
      screenWidth: screen?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.ok(initialLayout.hostWidth >= 240, "Agent Terminal should have a usable visible host width");
  assert.ok(
    initialLayout.screenWidth >= initialLayout.hostWidth - 32,
    `Agent Terminal screen should fit its host (${JSON.stringify(initialLayout)})`,
  );
  await xtermInput.pressSequentially(
    "printf 'RUDDER_AGENT_%s=%s\\n' HOME \"$AGENT_HOME\"; if [ \"$PWD\" = \"$AGENT_HOME\" ]; then printf 'RUDDER_AGENT_HOME_%s=yes\\n' MATCH; else printf 'RUDDER_AGENT_HOME_%s=no\\n' MATCH; fi",
    { delay: 2 },
  );
  await xtermInput.press("Enter");
  const output = await waitForSmokeCondition("Agent Terminal command output", async () => {
    const text = await terminal.locator(".xterm-rows").innerText();
    return text.includes("RUDDER_AGENT_HOME_MATCH=") ? text : null;
  });
  const agentHome = output.match(/RUDDER_AGENT_HOME=([^\r\n]+)/u)?.[1]?.trim();
  assert.ok(agentHome, "Terminal should print its trusted AGENT_HOME");
  assert.ok(output.includes("RUDDER_AGENT_HOME_MATCH=yes"), "pwd should resolve to the same Agent workspace root");

  await sidePanel.getByTestId("chat-side-panel-collapse").click();
  await sidePanel.waitFor({ state: "hidden", timeout: 5_000 });
  await openSmokeSidePanel(page);
  await terminal.waitFor({ state: "visible", timeout: 10_000 });
  await mkdir(path.dirname(terminalSmokeScreenshotPath), { recursive: true });
  await page.screenshot({ path: terminalSmokeScreenshotPath, fullPage: true });
  console.log(`[desktop-smoke] Agent Terminal screenshot: ${terminalSmokeScreenshotPath}`);

  const originalWindowSize = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize());
  assert.ok(originalWindowSize, "Agent Terminal resize smoke should find the Desktop window");
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size[0], size[1]);
  }, [1_280, 900]);
  await waitForSmokeCondition("Agent Terminal constrained layout", async () => {
    const layout = await terminal.evaluate((panel) => {
      const host = panel.querySelector("[data-testid='terminal-xterm-host']");
      const screen = panel.querySelector(".xterm-screen");
      return {
        hostWidth: host?.getBoundingClientRect().width ?? 0,
        screenWidth: screen?.getBoundingClientRect().width ?? 0,
      };
    });
    return layout.hostWidth >= 240
      && layout.hostWidth < initialLayout.hostWidth
      && layout.screenWidth >= layout.hostWidth - 32
      ? layout
      : null;
  });
  await xtermInput.pressSequentially("printf 'TERMINAL_RESIZED=yes\\n'", { delay: 2 });
  await xtermInput.press("Enter");
  await waitForSmokeCondition("Agent Terminal output after resize", async () => {
    const text = await terminal.locator(".xterm-rows").innerText();
    return text.includes("TERMINAL_RESIZED=yes") ? text : null;
  });
  await page.screenshot({ path: terminalConstrainedSmokeScreenshotPath, fullPage: true });
  console.log(`[desktop-smoke] Agent Terminal constrained screenshot: ${terminalConstrainedSmokeScreenshotPath}`);
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size[0], size[1]);
  }, originalWindowSize);

  const terminalTab = sidePanel.locator('[data-testid="chat-side-panel-tab"][data-side-panel-tab-kind="terminal"]');
  await terminalTab.hover();
  await sidePanel.getByRole("button", { name: "Close Terminal tab" }).click();
  await terminal.waitFor({ state: "detached", timeout: 10_000 });

  const listingResponse = await fetch(`${baseUrl}/api/orgs/${company.id}/workspace/files?path=agents`);
  assert.equal(listingResponse.ok, true, "Agent workspace listing should be readable for failure recovery smoke");
  const listing = await listingResponse.json();
  const workspaceEntry = listing.entries?.find((entry) => entry.entityType === "agent_workspace" && entry.agentId === agent.id);
  assert.ok(workspaceEntry?.workspaceKey && listing.rootPath, "Agent workspace listing should identify the canonical workspace");
  const workspacePath = path.join(listing.rootPath, "agents", workspaceEntry.workspaceKey);
  const unavailablePath = `${workspacePath}.terminal-smoke-unavailable`;
  const restoreWorkspace = async () => {
    if (!(await access(unavailablePath).then(() => true).catch(() => false))) return;
    await rm(workspacePath, { recursive: true, force: true });
    await rename(unavailablePath, workspacePath);
  };
  await rename(workspacePath, unavailablePath);
  await writeFile(workspacePath, "terminal smoke obstruction\n", "utf8");
  try {
    const recoveredSidePanel = await openSmokeSidePanel(page);
    await recoveredSidePanel.getByTestId("chat-side-panel-empty-terminal-target").click();
    const failedTerminal = recoveredSidePanel.getByTestId("terminal-panel-view");
    await failedTerminal.getByText("Terminal unavailable").waitFor({ state: "visible", timeout: 15_000 });
    await failedTerminal.getByText("Could not validate the selected Agent.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await page.screenshot({ path: terminalFailureSmokeScreenshotPath, fullPage: true });
    console.log(`[desktop-smoke] Agent Terminal failure screenshot: ${terminalFailureSmokeScreenshotPath}`);
    await restoreWorkspace();
    await failedTerminal.getByRole("button", { name: "Restart terminal" }).click();
    await failedTerminal.getByText("Terminal unavailable").waitFor({ state: "hidden", timeout: 15_000 });
    const restartedInput = failedTerminal.locator(".xterm-helper-textarea");
    await restartedInput.pressSequentially("printf 'TERMINAL_RESTARTED=yes\\n'", { delay: 2 });
    await restartedInput.press("Enter");
    await waitForSmokeCondition("Agent Terminal restart output", async () => {
      const text = await failedTerminal.locator(".xterm-rows").innerText();
      return text.includes("TERMINAL_RESTARTED=yes") ? text : null;
    });
    await recoveredSidePanel.locator('[data-testid="chat-side-panel-tab"][data-side-panel-tab-kind="terminal"]').hover();
    await recoveredSidePanel.getByRole("button", { name: "Close Terminal tab" }).click();
    await failedTerminal.waitFor({ state: "detached", timeout: 10_000 });
  } finally {
    await restoreWorkspace();
  }
}

async function openLocalAppsSmokeCatalog(page) {
  const sidePanel = await openSmokeSidePanel(page);
  const catalog = sidePanel.getByTestId("local-apps-catalog");
  if (await catalog.isVisible().catch(() => false)) return { catalog, sidePanel };

  const targetButton = sidePanel.getByTestId("chat-side-panel-empty-local-apps-target");
  if (!(await targetButton.isVisible().catch(() => false))) {
    const addTab = sidePanel.getByTestId("chat-side-panel-add-tab");
    if (await addTab.isVisible().catch(() => false)) await addTab.click();
  }
  await targetButton.waitFor({ state: "visible", timeout: 15_000 });
  await targetButton.click();
  await catalog.waitFor({ state: "visible", timeout: 15_000 });
  return { catalog, sidePanel };
}

async function openLocalAppSmokeDefinition(page, definition) {
  const { catalog, sidePanel } = await openLocalAppsSmokeCatalog(page);
  const bindingTestId = safeLocalAppTestId(definition.localBindingId);
  const row = catalog.getByTestId(`local-apps-app-${bindingTestId}`);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.getByTestId(`local-apps-open-${bindingTestId}`).click();
  const activeView = page
    .locator('[data-testid="local-app-view"][data-active="true"]')
    .filter({ hasText: definition.title });
  await activeView.waitFor({ state: "visible", timeout: 15_000 });
  return { sidePanel, view: activeView };
}

async function readMessengerCustomGroups(baseUrl, companyId) {
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/messenger/groups`);
  if (response.status !== 200) {
    throw new Error(`list Messenger groups failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function waitForLocalAppSavedView(baseUrl, companyId, localBindingId) {
  return waitForSmokeCondition("the Local App Saved View to appear in Messenger", async () => {
    const payload = await readMessengerCustomGroups(baseUrl, companyId);
    for (const group of payload.groups ?? []) {
      for (const entry of group.entries ?? []) {
        const savedView = entry.item?.type === "saved_view" ? entry.item.savedView : null;
        if (savedView?.targetPayload?.kind === "local_app"
          && savedView.targetPayload.localBindingId === localBindingId) {
          return { directory: payload, entry, group, savedView };
        }
      }
    }
    return null;
  });
}

async function waitForBrowserSavedView(baseUrl, companyId, viewInstanceId) {
  return waitForSmokeCondition("the Browser Saved View to appear in Messenger", async () => {
    const payload = await readMessengerCustomGroups(baseUrl, companyId);
    for (const group of payload.groups ?? []) {
      for (const entry of group.entries ?? []) {
        const savedView = entry.item?.type === "saved_view" ? entry.item.savedView : null;
        if (savedView?.targetPayload?.kind === "browser"
          && savedView.targetPayload.viewInstanceId === viewInstanceId) {
          return { directory: payload, entry, group, savedView };
        }
      }
    }
    return null;
  });
}

async function waitForLocalAppSavedViewRemoval(baseUrl, companyId, savedViewId) {
  await waitForSmokeCondition("the Local App Saved View to be removed from Messenger", async () => {
    const payload = await readMessengerCustomGroups(baseUrl, companyId);
    return !(payload.groups ?? []).some((group) => (group.entries ?? []).some((entry) => (
      entry.item?.type === "saved_view" && entry.item.savedView?.id === savedViewId
    )));
  });
}

async function readProcessTable() {
  const result = await runCapturedProcess("/bin/ps", ["-axo", "pid=,pgid=,command="]);
  assert.equal(result.code, 0, `ps failed: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }] : [];
  });
}

async function readLocalAppListeners(port) {
  const lsof = await runCapturedProcess("/usr/sbin/lsof", [
    "-nP",
    "-a",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fpn",
  ], { timeoutMs: 20_000 });
  if (lsof.code !== 0 && lsof.code !== 1) {
    throw new Error(`lsof failed while checking the Local App listener (${lsof.code})`);
  }
  return parseLocalAppLsofListenerProcessRecords(lsof.stdout, port);
}

async function readLocalAppListenerPids(port) {
  return (await readLocalAppListeners(port)).map((listener) => listener.pid);
}

async function readLocalAppRuntimeDescriptor(registryPath, definitionId) {
  return (await readLocalAppSmokeRegistry(registryPath)).runtimeDescriptors?.[definitionId] ?? null;
}

async function assertLocalAppRuntimeRunning(input) {
  const { attested, definition, markerPath, registryPath } = input;
  const descriptor = await readLocalAppRuntimeDescriptor(registryPath, definition.id);
  assert.equal(descriptor?.status, "running", "registry should persist a running Local App descriptor");
  assert.equal(Number.isInteger(descriptor?.pid), true, "running Local App descriptor should include a PID");
  assert.equal(Number.isInteger(descriptor?.pgid), true, "running Local App descriptor should include a process group");
  assert.equal(Number.isInteger(descriptor?.port), true, "running Local App descriptor should include the attested port");
  assert.equal(new URL(attested.origin).port, String(descriptor.port));

  const health = await fetch(`${attested.origin}${definition.readiness.path}`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(health.ok, true, "attested Local App readiness endpoint should remain reachable");
  if (markerPath) {
    const healthPayload = await health.json();
    assert.equal(healthPayload.sentinelEnvAccepted, true, "generated fixture must receive its allowlisted sentinel environment value");
  }
  const listeners = await readLocalAppListeners(descriptor.port);
  const expectedListenerAddress = `127.0.0.1:${descriptor.port}`;
  assert.ok(listeners.length > 0, "lsof should report at least one Local App listener PID");
  assert.ok(
    listeners.every((listener) => (
      listener.addresses.length > 0
      && listener.addresses.every((address) => address === expectedListenerAddress)
    )),
    "every Local App listener must use the exact IPv4 loopback address",
  );
  const listenerPids = listeners.map((listener) => listener.pid);
  const processes = await readProcessTable();
  assert.ok(
    processes.some((processInfo) => processInfo.pid === descriptor.pid && processInfo.pgid === descriptor.pgid),
    "the reviewed command PID should still lead the recorded process group",
  );
  assert.ok(
    listenerPids.every((pid) => processes.some((processInfo) => (
      processInfo.pid === pid && processInfo.pgid === descriptor.pgid
    ))),
    "every attested listener should belong to the recorded process group",
  );
  if (markerPath) {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.sentinelEnvAccepted, true, "start marker must prove receipt of the allowlisted sentinel environment value");
    assert.ok(listenerPids.includes(marker.pid), "fixture start marker should identify an attested listener process");
    assert.ok(
      processes.some((processInfo) => processInfo.pid === marker.pid && processInfo.pgid === descriptor.pgid),
      "fixture listener should belong to the recorded process group",
    );
    assert.equal(marker.port, descriptor.port, "fixture start marker should identify the attested listener port");
  }
  return descriptor;
}

async function assertLocalAppRuntimeStopped(input) {
  const { definition, descriptor, markerPath, registryPath } = input;
  await waitForSmokeCondition("the Local App listener and process group to exit", async () => {
    const registry = await readLocalAppSmokeRegistry(registryPath);
    if (registry.runtimeDescriptors?.[definition.id]) return false;
    if ((await readLocalAppListenerPids(descriptor.port)).length > 0) return false;
    const processes = await readProcessTable();
    return !processes.some((processInfo) => (
      processInfo.pid === descriptor.pid || processInfo.pgid === descriptor.pgid
    ));
  }, { timeoutMs: 15_000 });
  if (markerPath) {
    assert.equal(await pathExists(markerPath), true, "start marker should remain as evidence after explicit stop");
  }
}

function sanitizeLocalAppSmokeError(error, sensitiveValues) {
  const redact = (value) => sensitiveValues.reduce((result, sensitive) => (
    typeof sensitive === "string" && sensitive.length > 0
      ? result.split(sensitive).join("[redacted]")
      : result
  ), value);
  if (!(error instanceof Error)) return new Error(redact(String(error)));
  const sanitized = new Error(redact(error.message));
  sanitized.name = error.name;
  if (error.stack) sanitized.stack = redact(error.stack);
  return sanitized;
}

async function clearEmergencyLocalAppDescriptor(registry, definition, descriptor) {
  const current = await registry.getRuntimeDescriptor(definition.id);
  if (!current) return;
  assert.equal(
    current.generation,
    descriptor.generation,
    "emergency cleanup must not clear a newer Local App runtime generation",
  );
  const cleared = await registry.recordRuntimeDescriptorIfMatch(
    definition.id,
    { generation: descriptor.generation },
    null,
  );
  assert.equal(cleared, true, "emergency cleanup should clear only its verified isolated runtime descriptor");
}

async function hasLocalAppOsResidue(descriptor) {
  const [listenerPids, processes] = await Promise.all([
    readLocalAppListenerPids(descriptor.port),
    readProcessTable(),
  ]);
  return listenerPids.length > 0 || processes.some((processInfo) => (
    processInfo.pid === descriptor.pid || processInfo.pgid === descriptor.pgid
  ));
}

async function cleanupLocalAppScenario(input) {
  const {
    definition,
    definitionDeleted,
    lastKnownDescriptor,
    markerPath,
    registry,
    registryPath,
    run,
    sensitiveValues,
  } = input;
  const cleanupErrors = [];
  let descriptor = lastKnownDescriptor;
  try {
    descriptor = await readLocalAppRuntimeDescriptor(registryPath, definition.id) ?? descriptor;
  } catch (error) {
    cleanupErrors.push(sanitizeLocalAppSmokeError(error, sensitiveValues));
  }

  try {
    if (run.page.isClosed()) throw new Error("Local App renderer closed before the cleanup IPC stop");
    if (!definitionDeleted) {
      await run.page.evaluate((definitionId) => window.desktopShell.localApps.stop(definitionId), definition.id);
    }
    if (descriptor) {
      await assertLocalAppRuntimeStopped({ definition, descriptor, markerPath, registryPath });
    }
  } catch (error) {
    cleanupErrors.push(sanitizeLocalAppSmokeError(error, sensitiveValues));
  }

  try {
    await closeDesktop(run.electronApp);
  } catch (error) {
    cleanupErrors.push(sanitizeLocalAppSmokeError(error, sensitiveValues));
  }

  try {
    descriptor = await readLocalAppRuntimeDescriptor(registryPath, definition.id) ?? descriptor;
  } catch (error) {
    cleanupErrors.push(sanitizeLocalAppSmokeError(error, sensitiveValues));
  }
  if (descriptor) {
    try {
      await assertLocalAppRuntimeStopped({ definition, descriptor, markerPath, registryPath });
    } catch (watchdogError) {
      cleanupErrors.push(sanitizeLocalAppSmokeError(watchdogError, sensitiveValues));
      try {
        if (await hasLocalAppOsResidue(descriptor)) {
          await terminateProvenLocalAppProcessGroup({
            descriptor,
            readListenerPids: readLocalAppListenerPids,
            readProcesses: readProcessTable,
            signalGroup: async (pgid, signal) => {
              try {
                process.kill(-pgid, signal);
              } catch (error) {
                if (error?.code !== "ESRCH") throw error;
              }
            },
          });
        }
        await clearEmergencyLocalAppDescriptor(registry, definition, descriptor);
        await assertLocalAppRuntimeStopped({ definition, descriptor, markerPath, registryPath });
      } catch (emergencyError) {
        cleanupErrors.push(sanitizeLocalAppSmokeError(emergencyError, sensitiveValues));
      }
    }
  }
  return cleanupErrors.length > 0
    ? new AggregateError(cleanupErrors, "Local App smoke cleanup encountered one or more failures")
    : null;
}

async function waitForLocalAppWebview(page, definition, expectedAttestation, expectedBodyText) {
  const { expectedPartition, expectedUrl } = expectedAttestation;
  const evidenceHandle = await page.waitForFunction(async ({ bindingId, expectedBodyText: bodyText, expectedPartition, expectedUrl: url }) => {
    const webview = Array.from(document.querySelectorAll("[data-testid='local-app-webview']"))
      .find((candidate) => candidate.getAttribute("data-local-binding-id") === bindingId
        && candidate.getAttribute("data-active") === "true");
    if (!webview
      || webview.getAttribute("partition") !== expectedPartition
      || typeof webview.getURL !== "function"
      || typeof webview.executeJavaScript !== "function"
      || webview.getURL() !== url) return false;
    try {
      const evidence = await webview.executeJavaScript(`(async () => {
        const response = await fetch(window.location.href, { cache: "no-store", credentials: "same-origin" });
        return {
          bodyText: document.body?.innerText?.trim() ?? "",
          fetchOk: response.ok,
          fetchStatus: response.status,
          fetchUrl: response.url,
          pathname: window.location.pathname,
          title: document.title,
        };
      })()`);
      if (evidence.pathname === new URL(url).pathname
        && evidence.fetchOk === true
        && evidence.fetchStatus >= 200
        && evidence.fetchStatus < 300
        && evidence.fetchUrl === url
        && evidence.bodyText.length > 0
        && (!bodyText || evidence.bodyText.includes(bodyText))) {
        return {
          partition: webview.getAttribute("partition"),
          url: webview.getURL(),
          ...evidence,
          expectedUrl: url,
        };
      }
      return false;
    } catch {
      return false;
    }
  }, {
    bindingId: definition.localBindingId,
    expectedBodyText,
    expectedPartition,
    expectedUrl,
  }, { timeout: 45_000 });
  try {
    return await evidenceHandle.jsonValue();
  } finally {
    await evidenceHandle.dispose();
  }
}

async function readActiveLocalAppGuestIdentity(page, definition, marker = null) {
  return page.evaluate(({ bindingId, marker: nextMarker }) => {
    const webview = Array.from(document.querySelectorAll("[data-testid='local-app-webview']"))
      .find((candidate) => candidate.getAttribute("data-local-binding-id") === bindingId
        && candidate.getAttribute("data-active") === "true");
    if (!webview || typeof webview.getWebContentsId !== "function") {
      throw new Error("The active Local App guest was not available");
    }
    if (nextMarker) webview.__rudderLocalAppTransferMarker = nextMarker;
    return {
      domMarker: webview.__rudderLocalAppTransferMarker ?? null,
      partition: webview.getAttribute("partition"),
      webContentsId: webview.getWebContentsId(),
    };
  }, {
    bindingId: definition.localBindingId,
    marker,
  });
}

async function runLocalAppsScenario(mode) {
  if (process.platform !== "darwin") {
    console.log(`[desktop-smoke] Local Apps scenario skipped on ${process.platform}: macOS-only V1 capability`);
    return;
  }

  const scenarioRoot = path.join(tmpRoot, "local-apps");
  const project = await resolveLocalAppSmokeProject(scenarioRoot);
  const {
    definition,
    inheritedEnvNames,
    inheritedEnvValues,
    installationId,
    registry,
    registryPath,
  } = await seedApprovedLocalAppDefinition(scenarioRoot, project);
  const failingLocalApp = await seedFailingLocalAppDefinition(registry, scenarioRoot);
  await registry.recordRuntimeDescriptor(definition.id, {
    status: "orphaned_unverified",
    pid: 991_101,
    pgid: 991_101,
    port: 31_911,
    generation: "dead-orphan-smoke-generation",
  });
  const preservedProjectSource = project.external
    ? null
    : {
        contents: await readFile(path.join(project.projectRoot, "server.mjs"), "utf8"),
        path: path.join(project.projectRoot, "server.mjs"),
      };
  console.log("[desktop-smoke] Local App definition", JSON.stringify({
    appPublicId: definition.appPublicId,
    desktopInstallationId: definition.desktopInstallationId,
    localBindingId: definition.localBindingId,
    title: definition.title,
  }));
  const ports = await allocateSmokePorts();
  const packagedSmokeExecutable = mode === "packaged"
    ? await createPackagedIdentitySmokeExecutable(scenarioRoot)
    : null;
  const launchEnv = {
    ...project.launchEnv,
    ...(mode === "packaged" && process.platform === "darwin" && process.env.HOME
      ? { HOME: process.env.HOME }
      : {}),
    ...(packagedSmokeExecutable ? { RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1" } : {}),
  };
  let run = await launchDesktop(
    scenarioRoot,
    mode,
    ports,
    launchEnv,
    packagedSmokeExecutable,
  );
  let runningDescriptor = null;
  let definitionDeleted = false;
  let scenarioError = null;
  let cleanupError = null;
  try {
    const recovered = await run.page.evaluate(
      (definitionId) => window.desktopShell.localApps.status(definitionId),
      definition.id,
    );
    assert.equal(recovered.status, "stopped", "Desktop restart should reconcile a provably dead Local App orphan");
    assert.equal(
      await readLocalAppRuntimeDescriptor(registryPath, definition.id),
      null,
      "provably dead Local App ownership should be removed from the registry",
    );
    const company = await createCompany(run.baseUrl, "LAP");
    const companyRouteKey = company.urlKey ?? company.issuePrefix;
    await createCeo(run.baseUrl, company.id);
    await updateExperimentalPlugins(run.baseUrl, true);
    const managedApp = await createAppBuilderRecord(
      run.baseUrl,
      company.id,
      "Managed App Delete Guard",
      "apps/managed-delete-guard",
    );
    const chat = await createChat(run.baseUrl, company.id);
    const chatPath = `/${companyRouteKey}/messenger/chat/${chat.id}`;
    await run.page.evaluate((nextCompanyId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
      window.localStorage.setItem(
        "rudder.messengerThreadOrganizationByOrg",
        JSON.stringify({ [nextCompanyId]: "custom" }),
      );
    }, company.id);
    await run.page.goto(new URL(chatPath, run.baseUrl).href);
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/chat/${chat.id}$`), { timeout: 30_000 });
    await run.page.waitForLoadState("networkidle");
    await dismissOnboardingIfVisible(run.page);

    const chatsBeforeRecovery = await fetch(`${run.baseUrl}/api/orgs/${company.id}/chats?status=all`);
    assert.equal(chatsBeforeRecovery.status, 200, "list chats before Local App recovery failed");
    const chatsBeforeRecoveryPayload = await chatsBeforeRecovery.json();
    const failedLocalApp = await openLocalAppSmokeDefinition(run.page, failingLocalApp.definition);
    await failedLocalApp.view.getByTestId("local-app-start").click();
    const askAiButton = failedLocalApp.view.getByTestId("local-app-ask-ai");
    await askAiButton.waitFor({ state: "visible", timeout: 15_000 });
    await mkdir(path.dirname(localAppSmokeScreenshotPath), { recursive: true });
    await run.page.screenshot({ path: localAppSmokeScreenshotPath, fullPage: true });
    console.log(`[desktop-smoke] Local App failure recovery screenshot: ${localAppSmokeScreenshotPath}`);

    await askAiButton.click();
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/chat(?:\\?.*)?$`), { timeout: 15_000 });
    const recoveryComposer = run.page
      .getByTestId("chat-composer-editor-scroll")
      .locator("[contenteditable='true']")
      .first();
    const recoveryPrompt = await waitForSmokeCondition("the Local App recovery Chat draft", async () => {
      const text = (await recoveryComposer.textContent())?.trim() ?? "";
      return text.includes("A Local App could not open in Rudder Desktop.") ? text : null;
    });
    assert.match(recoveryPrompt, /AI recovery Local App/);
    assert.equal(recoveryPrompt.includes(failingLocalApp.definition.cwd), false);
    assert.equal(recoveryPrompt.includes(failingLocalApp.definition.executable), false);
    assert.equal(recoveryPrompt.includes(failingLocalApp.definition.argv[1]), false);
    assert.equal(recoveryPrompt.includes(failingLocalApp.secret), false);
    assertNoLocalAppRuntimeDetails(
      { recoveryPrompt },
      {
        definition: failingLocalApp.definition,
        envNames: [],
        envValues: [failingLocalApp.secret],
        label: "Local App recovery Chat draft",
      },
    );
    const chatsAfterRecovery = await fetch(`${run.baseUrl}/api/orgs/${company.id}/chats?status=all`);
    assert.equal(chatsAfterRecovery.status, 200, "list chats after Local App recovery failed");
    const chatsAfterRecoveryPayload = await chatsAfterRecovery.json();
    assert.deepEqual(
      chatsAfterRecoveryPayload.map((entry) => entry.id),
      chatsBeforeRecoveryPayload.map((entry) => entry.id),
      "opening Local App recovery Chat must not create or send a Chat",
    );

    await run.page.goto(new URL(chatPath, run.baseUrl).href);
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/chat/${chat.id}$`), { timeout: 30_000 });
    await run.page.waitForLoadState("networkidle");

    const initial = await openLocalAppSmokeDefinition(run.page, definition);
    await initial.view.getByTestId("local-app-start").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal((await readDesktopLocalAppStatus(run.page, definition.id)).status, "stopped");
    assert.equal(await readDesktopLocalAppAttestedTarget(run.page, definition.id), null);
    assert.equal(
      (await readLocalAppSmokeRegistry(registryPath)).runtimeDescriptors?.[definition.id],
      undefined,
      "opening the catalog target must not create a runtime descriptor",
    );
    if (project.markerPath) assert.equal(await pathExists(project.markerPath), false, "opening a Local App must not start it");

    await initial.sidePanel.getByTestId("chat-side-panel-collapse").click();
    await initial.sidePanel.waitFor({ state: "hidden", timeout: 5_000 });
    await run.page.waitForTimeout(250);
    assert.equal((await readDesktopLocalAppStatus(run.page, definition.id)).status, "stopped");
    if (project.markerPath) assert.equal(await pathExists(project.markerPath), false, "restoring a panel must not start a Local App");
    await openSmokeSidePanel(run.page);
    await initial.view.waitFor({ state: "visible", timeout: 10_000 });

    const localAppTab = initial.sidePanel
      .getByTestId("chat-side-panel-tab")
      .filter({ hasText: definition.title });
    await localAppTab.waitFor({ state: "visible", timeout: 15_000 });
    const openedViewInstanceId = await localAppTab.getAttribute("data-view-instance-id");
    assert.ok(openedViewInstanceId, "opened Local App tab must expose its view instance identity");
    const expectedSavedViewTarget = {
      kind: "local_app",
      desktopInstallationId: definition.desktopInstallationId,
      appPublicId: definition.appPublicId,
      localBindingId: definition.localBindingId,
      viewInstanceId: openedViewInstanceId,
    };
    const privacyOptions = (label) => ({
      definition,
      envNames: inheritedEnvNames,
      envValues: inheritedEnvValues,
      label,
    });

    await initial.view.getByTestId("local-app-start").click();
    const runningStatus = await waitForSmokeCondition("the Local App runtime to start", async () => {
      const status = await readDesktopLocalAppStatus(run.page, definition.id);
      return status.status === "running" ? status : null;
    }, { timeoutMs: definition.readiness.timeoutMs + 15_000 });
    const attested = await waitForSmokeCondition("the attested Local App target", () => (
      readDesktopLocalAppAttestedTarget(run.page, definition.id)
    ));
    const expectedAttestation = assertStrictLoopbackAttestation(attested, definition, installationId);
    assert.equal(
      runningStatus.partition,
      expectedAttestation.expectedPartition,
      "runtime status must use the independently derived Local App partition",
    );
    assert.equal(
      runningStatus.origin,
      new URL(expectedAttestation.expectedUrl).origin,
      "runtime status must expose the exact attested loopback origin",
    );
    runningDescriptor = await waitForSmokeCondition("the running descriptor to reach the isolated registry", async () => {
      const descriptor = await readLocalAppRuntimeDescriptor(registryPath, definition.id);
      return descriptor?.status === "running" ? descriptor : null;
    });
    await assertLocalAppRuntimeRunning({
      attested,
      definition,
      markerPath: project.markerPath,
      registryPath,
    });
    const webviewEvidence = await waitForLocalAppWebview(
      run.page,
      definition,
      expectedAttestation,
      project.expectedBodyText,
    );
    assert.equal(webviewEvidence.partition, expectedAttestation.expectedPartition);
    assert.equal(webviewEvidence.url, expectedAttestation.expectedUrl);
    assert.equal(webviewEvidence.fetchOk, true, "Local App guest same-origin fetch must succeed");
    assert.ok(
      webviewEvidence.fetchStatus >= 200 && webviewEvidence.fetchStatus < 300,
      "Local App guest same-origin fetch must return a 2xx status",
    );
    assert.equal(webviewEvidence.fetchUrl, expectedAttestation.expectedUrl);
    console.log("[desktop-smoke] Local App webview evidence", JSON.stringify({
      fetchStatus: webviewEvidence.fetchStatus,
      partition: webviewEvidence.partition,
      pathname: webviewEvidence.pathname,
      title: webviewEvidence.title,
      url: webviewEvidence.url,
    }));
    const markerBeforeMove = project.markerPath ? await readFile(project.markerPath, "utf8") : null;
    const generation = runningStatus.generation;
    assert.ok(generation, "running Local App should expose one runtime generation");
    const transferMarker = randomUUID();
    const guestBeforeMove = await readActiveLocalAppGuestIdentity(
      run.page,
      definition,
      transferMarker,
    );
    const localAppTabCountBeforeShortcut = await initial.sidePanel
      .getByTestId("chat-side-panel-tab")
      .count();
    const shortcutModifier = process.platform === "darwin" ? "meta" : "control";
    await run.page.evaluate((bindingId) => {
      const webview = Array.from(document.querySelectorAll("[data-testid='local-app-webview']"))
        .find((candidate) => candidate.getAttribute("data-local-binding-id") === bindingId
          && candidate.getAttribute("data-active") === "true");
      if (!webview) throw new Error("Local App shortcut smoke requires the active guest");
      webview.focus();
    }, definition.localBindingId);
    await pressElectronSurfaceShortcut(
      run.electronApp,
      "webview",
      "T",
      [shortcutModifier],
    );
    await initial.sidePanel
      .getByTestId("chat-side-panel-empty-state")
      .waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(
      await initial.sidePanel.getByTestId("chat-side-panel-tab").count(),
      localAppTabCountBeforeShortcut,
      "Local App guest new-tab shortcut must open the picker without creating a placeholder tab",
    );
    await localAppTab.click();
    assert.deepEqual(
      await readActiveLocalAppGuestIdentity(run.page, definition),
      guestBeforeMove,
      "closing the Local App shortcut picker must preserve the exact guest",
    );

    await initial.view.getByTestId("local-app-more").click();
    const directPinItem = run.page.getByRole("menuitem", { name: "Pin to Primary Rail", exact: true });
    await directPinItem.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await directPinItem.isEnabled(), true, "an unsaved Local App should be directly pinnable");
    const directPinRequestPromise = run.page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST"
        && url.pathname === `/api/orgs/${company.id}/messenger/saved-views/keep`;
    }, { timeout: 15_000 });
    const directPinResponsePromise = run.page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && url.pathname === `/api/orgs/${company.id}/messenger/saved-views/keep`;
    }, { timeout: 15_000 });
    await directPinItem.click();
    const [directPinRequest, directPinResponse] = await Promise.all([
      directPinRequestPromise,
      directPinResponsePromise,
    ]);
    const directPinRequestBody = directPinRequest.postDataJSON();
    assert.equal(directPinRequestBody?.primaryRailPinned, true, "direct PIN must request an atomic Primary Rail pin");
    assert.deepEqual(directPinRequestBody?.placement, { kind: "loose" }, "direct PIN must keep the app loose in Messenger");
    assertExactLocalAppSavedViewTarget(
      directPinRequestBody?.target,
      expectedSavedViewTarget,
      "Direct PIN request",
    );
    assertNoLocalAppRuntimeDetails(directPinRequestBody, privacyOptions("Direct PIN request"));
    assert.equal(directPinResponse.status(), 201, "direct Local App PIN returned an unexpected status");
    const directPinResult = JSON.parse(await directPinResponse.text());
    assert.ok(directPinResult?.savedView?.primaryRailPinnedAt, "direct PIN response must include the persisted pin timestamp");
    await run.page.getByText("Pinned to Primary Rail", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const pinnedRailLink = run.page.locator(`a[href$="/apps/saved/${directPinResult.savedView.id}"]`);
    await pinnedRailLink.waitFor({ state: "visible", timeout: 15_000 });

    const keepButton = initial.sidePanel.getByTestId("chat-side-panel-keep-in-messenger");
    await keepButton.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await keepButton.isEnabled(), true, "Local App Keep in Messenger should be enabled");
    const keepRequestPromise = run.page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST"
        && url.pathname === `/api/orgs/${company.id}/messenger/saved-views/keep`;
    }, { timeout: 15_000 });
    const keepResponsePromise = run.page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && url.pathname === `/api/orgs/${company.id}/messenger/saved-views/keep`;
    }, { timeout: 15_000 });
    await keepButton.click();
    const keepExchange = await Promise.race([
      Promise.all([keepRequestPromise, keepResponsePromise]),
      run.page.getByText("Could not keep this view", { exact: true })
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(async () => {
          const errorToast = run.page.getByText("Could not keep this view", { exact: true })
            .locator("xpath=ancestor::li[1]");
          throw new Error(`Keep Local App Saved View did not issue a request: ${await errorToast.innerText()}`);
        }),
    ]);
    const [keepRequest, keepResponse] = keepExchange;
    const keepRequestBody = keepRequest.postDataJSON();
    assertExactLocalAppSavedViewTarget(
      keepRequestBody?.target,
      expectedSavedViewTarget,
      "Keep request",
    );
    assertNoLocalAppRuntimeDetails(keepRequestBody, privacyOptions("Keep request"));
    const keepResponseBody = await keepResponse.text();
    assert.equal(
      keepResponse.status(),
      201,
      "Keep Local App Saved View returned an unexpected status",
    );
    const keepResult = JSON.parse(keepResponseBody);
    assertExactLocalAppSavedViewTarget(
      keepResult?.savedView?.targetPayload,
      expectedSavedViewTarget,
      "Keep response",
    );
    assertNoLocalAppRuntimeDetails(keepResult, privacyOptions("Keep response"));
    await run.page
      .getByText("Moved to Messenger", { exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });
    const saved = await waitForLocalAppSavedView(run.baseUrl, company.id, definition.localBindingId);
    assertExactLocalAppSavedViewTarget(
      saved.savedView.targetPayload,
      expectedSavedViewTarget,
      "Messenger group response",
    );
    assertNoLocalAppRuntimeDetails(saved.directory, privacyOptions("Messenger group response"));
    assert.ok(
      saved.group.entries.some((entry) => entry.item?.type === "thread" && entry.itemKey === `chat:${chat.id}`),
      "keeping from an ungrouped Chat should atomically group the Chat and Local App Saved View",
    );
    const savedRowTestId = `messenger-saved-view-${safeLocalAppTestId(saved.entry.id)}`;
    const savedRow = run.page.getByTestId(savedRowTestId);
    await savedRow.waitFor({ state: "visible", timeout: 30_000 });
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/saved/${saved.savedView.id}$`), { timeout: 30_000 });
    const mainWorkbench = run.page.getByTestId("messenger-main-workbench");
    await mainWorkbench.waitFor({ state: "visible", timeout: 15_000 });
    const mainTab = mainWorkbench.locator(
      `[role="tab"][data-view-instance-id="${saved.savedView.targetPayload.viewInstanceId}"]`,
    );
    await mainTab.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await mainTab.getAttribute("aria-selected"), "true");
    assert.equal(
      await initial.sidePanel.locator(
        `[data-testid="chat-side-panel-tab"][data-view-instance-id="${saved.savedView.targetPayload.viewInstanceId}"]`,
      ).count(),
      0,
      "Move must detach only the exact Local App tab from the Side Panel",
    );
    const mainView = run.page
      .locator(`[data-testid="local-app-webview"][data-local-binding-id="${definition.localBindingId}"][data-active="true"]`)
      .locator("xpath=ancestor::section[@data-testid='local-app-view'][1]");
    await mainView.waitFor({ state: "visible", timeout: 15_000 });
    await mainView.getByTestId("local-app-webview").waitFor({ state: "visible", timeout: 15_000 });
    const guestAfterMove = await readActiveLocalAppGuestIdentity(run.page, definition);
    assert.deepEqual(
      guestAfterMove,
      guestBeforeMove,
      "Move must retain the exact Local App DOM guest, partition, and webContentsId",
    );
    const statusAfterMove = await readDesktopLocalAppStatus(run.page, definition.id);
    assert.equal(statusAfterMove.generation, generation, "Move must keep the same Local App runtime generation");
    const descriptorAfterMove = await readLocalAppRuntimeDescriptor(registryPath, definition.id);
    assert.equal(descriptorAfterMove?.pid, runningDescriptor.pid, "Move must keep the same Local App PID");
    assert.equal(descriptorAfterMove?.generation, runningDescriptor.generation, "Move must keep the same descriptor generation");
    if (project.markerPath) {
      assert.equal(await readFile(project.markerPath, "utf8"), markerBeforeMove, "Move must not run the Local App command twice");
    }
    await assertLocalAppEndpointReachable(attested, definition, "Move must not stop the Local App");

    await mkdir(path.dirname(localAppSmokeScreenshotPath), { recursive: true });
    await run.page.screenshot({ path: localAppSmokeScreenshotPath, fullPage: true });
    console.log(`[desktop-smoke] Local App Main Workbench screenshot: ${localAppSmokeScreenshotPath}`);

    await run.page.reload();
    await run.page.waitForLoadState("networkidle");
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/saved/${saved.savedView.id}$`), { timeout: 30_000 });
    await mainWorkbench.waitFor({ state: "visible", timeout: 30_000 });
    await mainTab.waitFor({ state: "visible", timeout: 15_000 });
    await mainView.waitFor({ state: "visible", timeout: 30_000 });
    await mainView.getByTestId("local-app-webview").waitFor({ state: "visible", timeout: 30_000 });
    const statusAfterReload = await readDesktopLocalAppStatus(run.page, definition.id);
    assert.equal(statusAfterReload.generation, generation, "Saved route reload must not start a new Local App generation");
    const descriptorAfterReload = await readLocalAppRuntimeDescriptor(registryPath, definition.id);
    assert.equal(descriptorAfterReload?.pid, runningDescriptor.pid, "Saved route reload must keep the Local App PID");
    assert.equal(descriptorAfterReload?.generation, runningDescriptor.generation);
    if (project.markerPath) {
      assert.equal(await readFile(project.markerPath, "utf8"), markerBeforeMove, "Saved route reload must not run the command again");
    }
    await assertLocalAppEndpointReachable(attested, definition, "Saved route reload must leave the listener running");

    await mainWorkbench.getByRole("button", { name: `Close ${definition.title} tab` }).click();
    await mainTab.waitFor({ state: "detached", timeout: 15_000 });
    await savedRow.waitFor({ state: "visible", timeout: 15_000 });
    const statusAfterClose = await readDesktopLocalAppStatus(run.page, definition.id);
    assert.equal(statusAfterClose.generation, generation, "closing the Main tab must not stop the Local App");
    await assertLocalAppEndpointReachable(attested, definition, "closing the Main tab must leave the listener running");

    await savedRow.locator("a").click();
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/saved/${saved.savedView.id}$`), { timeout: 30_000 });
    await mainTab.waitFor({ state: "visible", timeout: 15_000 });
    await mainView.waitFor({ state: "visible", timeout: 30_000 });
    await mainView.getByTestId("local-app-webview").waitFor({ state: "visible", timeout: 30_000 });
    const guestBeforeRemove = await readActiveLocalAppGuestIdentity(
      run.page,
      definition,
      randomUUID(),
    );

    const currentSavedRow = run.page.getByTestId(savedRowTestId);
    await currentSavedRow.waitFor({ state: "visible", timeout: 15_000 });
    await currentSavedRow.hover();
    await currentSavedRow.getByRole("button", { name: `Saved View actions for ${definition.title}` }).click();
    await run.page.getByRole("menuitem", { name: "Remove from Messenger" }).click();
    const removeDialog = run.page.getByRole("dialog", {
      name: `Remove "${definition.title}" from Messenger?`,
    });
    await removeDialog.getByRole("button", { name: "Remove Saved View" }).click();
    await waitForLocalAppSavedViewRemoval(run.baseUrl, company.id, saved.savedView.id);
    await currentSavedRow.waitFor({ state: "detached", timeout: 15_000 });
    const afterRemovalStatus = await readDesktopLocalAppStatus(run.page, definition.id);
    assert.equal(afterRemovalStatus.status, "running", "Messenger Remove must not stop a Local App");
    assert.equal(afterRemovalStatus.generation, generation, "Messenger Remove must keep the same runtime generation");
    await assertLocalAppEndpointReachable(attested, definition, "Messenger Remove must leave the Local App listener running");
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/messenger/workbench$`), { timeout: 15_000 });
    await mainTab.waitFor({ state: "visible", timeout: 15_000 });
    const guestAfterRemove = await readActiveLocalAppGuestIdentity(run.page, definition);
    assert.deepEqual(
      guestAfterRemove,
      guestBeforeRemove,
      "Remove from Messenger must leave the open Main guest as the same session-only tab",
    );

    await mainView.getByTestId("local-app-more").click();
    await run.page.getByTestId("local-app-stop").click();
    await waitForSmokeCondition("the Local App runtime status to become stopped", async () => {
      const status = await readDesktopLocalAppStatus(run.page, definition.id);
      return status.status === "stopped" ? status : null;
    });
    await assertLocalAppRuntimeStopped({
      definition,
      descriptor: runningDescriptor,
      markerPath: project.markerPath,
      registryPath,
    });
    const stoppedMainView = run.page.locator('[data-testid="local-app-view"][data-active="true"]');
    const logsButton = stoppedMainView.getByRole("button", { name: "Show logs" });
    await logsButton.click();
    const logs = stoppedMainView.getByTestId("local-app-logs");
    await logs.waitFor({ state: "visible", timeout: 10_000 });
    const logText = await waitForSmokeCondition("Local App runtime logs", async () => {
      const text = (await logs.textContent())?.trim() ?? "";
      return text && text !== "No runtime logs yet." && text !== "Loading logs…" ? text : null;
    });
    if (!project.external) assert.match(logText, /Rudder Local Apps smoke fixture listening/);
    const logsBeforeRestart = await run.page.evaluate(
      (definitionId) => window.desktopShell.localApps.logs(definitionId),
      definition.id,
    );
    assert.ok(logsBeforeRestart.length > 0, "Local App logs should be available before Desktop restart");
    await closeDesktop(run.electronApp);
    run = await launchDesktop(scenarioRoot, mode, ports, launchEnv, packagedSmokeExecutable);
    const logsAfterRestart = await run.page.evaluate(
      (definitionId) => window.desktopShell.localApps.logs(definitionId),
      definition.id,
    );
    assert.deepEqual(logsAfterRestart, logsBeforeRestart, "Local App logs should survive a full Desktop restart");

    const appsHomeUrl = new URL(`/${companyRouteKey}/apps`, run.baseUrl).href;
    await run.page.goto(appsHomeUrl);
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/apps$`), { timeout: 30_000 });
    await run.page.waitForLoadState("networkidle");

    const failedEntryKey = `local:${failingLocalApp.definition.id}`;
    const failedEntry = run.page.getByTestId(`apps-entry-${failedEntryKey}`);
    await failedEntry.waitFor({ state: "visible", timeout: 15_000 });
    await failedEntry.hover();
    await run.page.getByTestId(`apps-more-${failedEntryKey}`).click();
    assert.equal(
      await run.page.getByTestId(`apps-delete-${failedEntryKey}`).isEnabled(),
      true,
      "a failed Local App must remain deletable",
    );
    await run.page.keyboard.press("Escape");

    const managedEntryKey = `managed:${managedApp.id}`;
    const managedEntry = run.page.getByTestId(`apps-entry-${managedEntryKey}`);
    await managedEntry.waitFor({ state: "visible", timeout: 15_000 });
    await managedEntry.hover();
    await run.page.getByTestId(`apps-more-${managedEntryKey}`).click();
    assert.equal(
      await run.page.getByTestId(`apps-delete-${managedEntryKey}`).count(),
      0,
      "managed Apps must not expose Local App deletion",
    );
    await run.page.keyboard.press("Escape");

    const entryKey = `local:${definition.id}`;
    const appEntry = run.page.getByTestId(`apps-entry-${entryKey}`);
    await appEntry.waitFor({ state: "visible", timeout: 15_000 });
    await appEntry.click();
    await waitForSmokeCondition("the Apps workspace Local App to start", async () => {
      const status = await readDesktopLocalAppStatus(run.page, definition.id);
      return status.status === "running" ? status : null;
    }, { timeoutMs: 360_000 });

    await run.page.evaluate(
      (definitionId) => window.desktopShell.localApps.stop(definitionId),
      definition.id,
    );
    await waitForSmokeCondition("the Apps workspace Local App to stop", async () => {
      const status = await readDesktopLocalAppStatus(run.page, definition.id);
      return status.status === "stopped" ? status : null;
    }, { timeoutMs: 30_000 });
    await run.page.goto(appsHomeUrl);
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/apps$`), { timeout: 30_000 });
    await run.page.waitForLoadState("networkidle");

    await appEntry.hover();
    await run.page.getByTestId(`apps-more-${entryKey}`).click();
    const deleteItem = run.page.getByTestId(`apps-delete-${entryKey}`);
    assert.equal(await deleteItem.isEnabled(), true, "a stopped Local App must be deletable");
    await deleteItem.click();
    let deleteDialog = run.page.getByRole("dialog");
    await deleteDialog.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await deleteDialog.innerText(), /Project files are not deleted\./);
    await run.page.screenshot({ path: localAppDeleteSmokeScreenshotPath, fullPage: true });
    console.log(`[desktop-smoke] Local App Delete confirmation screenshot: ${localAppDeleteSmokeScreenshotPath}`);
    await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(
      (await run.page.evaluate(() => window.desktopShell.localApps.list()))
        .some((candidate) => candidate.id === definition.id),
      true,
      "canceling Local App deletion must keep the definition",
    );

    await appEntry.hover();
    await run.page.getByTestId(`apps-more-${entryKey}`).click();
    await run.page.getByTestId(`apps-delete-${entryKey}`).click();
    deleteDialog = run.page.getByRole("dialog");
    await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await appEntry.waitFor({ state: "detached", timeout: 15_000 });
    await run.page.getByTestId(`apps-tab-${entryKey}`).waitFor({ state: "detached", timeout: 15_000 });
    await run.page.waitForURL(new RegExp(`/${companyRouteKey}/apps$`), { timeout: 15_000 });
    await run.page.getByText("Local App deleted").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(
      (await run.page.evaluate(() => window.desktopShell.localApps.list()))
        .some((candidate) => candidate.id === definition.id),
      false,
      "confirming Local App deletion must remove the definition",
    );
    assert.equal(await pathExists(definition.cwd), true, "Local App deletion must preserve project files");
    if (preservedProjectSource) {
      assert.equal(
        await readFile(preservedProjectSource.path, "utf8"),
        preservedProjectSource.contents,
        "Local App deletion must leave generated project source unchanged",
      );
    }
    definitionDeleted = true;

    console.log("[desktop-smoke] Local App exact guest moved into Main Workbench, close/remove preserved its runtime, and Apps Delete removed only the stopped definition");
  } catch (error) {
    scenarioError = sanitizeLocalAppSmokeError(error, inheritedEnvValues);
    console.error(`[desktop-smoke] Local Apps scenario failed: ${scenarioError.message}`);
  } finally {
    try {
      cleanupError = await cleanupLocalAppScenario({
        definition,
        definitionDeleted,
        lastKnownDescriptor: runningDescriptor,
        markerPath: project.markerPath,
        registry,
        registryPath,
        run,
        sensitiveValues: inheritedEnvValues,
      });
    } catch (error) {
      cleanupError = sanitizeLocalAppSmokeError(error, inheritedEnvValues);
    }
    if (cleanupError) {
      const cleanupMessages = cleanupError instanceof AggregateError
        ? cleanupError.errors.map((error) => error.message)
        : [cleanupError.message];
      console.error("[desktop-smoke] Local App cleanup verification failed", cleanupMessages);
    }
  }
  if (scenarioError) throw scenarioError;
  if (cleanupError) throw cleanupError;
}

async function runAgentBrowserScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "agent-browser");
  const ports = await allocateSmokePorts();
  const runtimeUrls = createRuntimeUrls(ports);
  const run = await launchDesktop(scenarioRoot, mode, ports);
  try {
    const company = await createCompany(run.baseUrl);
    const ceo = await createCeo(run.baseUrl, company.id);
    await verifyAgentBrowserBroker(run.electronApp, run.baseUrl, runtimeUrls.databaseUrl, company, ceo);
    await closeDesktop(run.electronApp);
  } catch (error) {
    console.error("[desktop-smoke] Agent Browser scenario failed", error);
    await closeDesktop(run.electronApp).catch(() => {});
    throw error;
  }
}

async function runPostgresRuntimeHandoffScenario(mode) {
  assert.equal(mode, "packaged", "PostgreSQL runtime handoff requires a packaged Desktop app");
  const scenarioRoot = path.join(tmpRoot, "postgres-runtime-handoff");
  const firstPorts = await allocateSmokePorts();
  let secondPorts = await allocateSmokePorts();
  while (
    secondPorts.appPort === firstPorts.appPort
    || secondPorts.appPort === firstPorts.dbPort
    || secondPorts.dbPort === firstPorts.appPort
    || secondPorts.dbPort === firstPorts.dbPort
  ) {
    secondPorts = await allocateSmokePorts();
  }
  const packagedRuntime = await preparePackagedExternalRuntimeFixture(scenarioRoot, { authBypass: true });
  const launchEnv = {
    ...packagedRuntime.env,
    RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1",
  };
  const firstRun = await launchDesktop(scenarioRoot, mode, firstPorts, launchEnv);
  let secondRun = null;
  let postmasterPid = null;
  try {
    const packagedShareDir = path.join(packagedRuntime.postgresBinDir, "..", "share");
    assert.equal(
      (await Promise.all([
        pathExists(path.join(packagedShareDir, "postgresql", "timezone")),
        pathExists(path.join(packagedShareDir, "timezone")),
      ])).some(Boolean),
      true,
      "packaged PostgreSQL payload should include timezone support files",
    );
    assert.equal(await pathExists(packagedRuntime.loadedMarker), true, "packaged Desktop should load the external runtime cache");
    assert.equal(
      (await readFile(packagedRuntime.postgresBinDirMarker, "utf8")).trim(),
      packagedRuntime.postgresBinDir,
      "packaged Desktop should replace an inherited app-resource PostgreSQL path with the shared runtime payload",
    );
    const descriptor = JSON.parse(await readFile(
      resolveInstancePaths(scenarioRoot).runtimeDescriptorPath,
      "utf8",
    ));
    assert.equal(descriptor.postgresBinDir, packagedRuntime.postgresBinDir);
    assert.equal(
      descriptor.postgresRuntimeKey,
      `postgres-18.4/${process.platform}-${process.arch}`,
    );
    const postmasterPidLines = (await readFile(
      resolveInstancePaths(scenarioRoot).postmasterPidPath,
      "utf8",
    )).split(/\r?\n/u);
    postmasterPid = Number(postmasterPidLines[0]?.trim());
    const actualPostgresPort = Number(postmasterPidLines[3]?.trim());
    assert.equal(Number.isSafeInteger(postmasterPid) && postmasterPid >= 2, true);
    assert.equal(actualPostgresPort, firstPorts.dbPort);
    if (process.platform === "win32") {
      assert.equal(
        await realpath(packagedRuntime.runtimePostgresRoot),
        await realpath(packagedRuntime.sharedPostgresRoot),
        "runtime compatibility junction should resolve to the shared payload",
      );
    } else {
      assert.equal(
        (await lstat(packagedRuntime.runtimePostgresRoot)).isSymbolicLink(),
        true,
        "runtime compatibility path should remain a symlink on POSIX",
      );
      assert.equal(
        await readlink(packagedRuntime.runtimePostgresRoot),
        path.join("..", "..", "runtime-payloads", "postgres-18.4"),
      );
    }
    const firstDesktopProcess = firstRun.electronApp.process();
    assert.ok(firstDesktopProcess, "packaged Desktop should expose its owned process");
    const firstDesktopExit = new Promise((resolve) => firstDesktopProcess.once("exit", resolve));
    assert.equal(firstDesktopProcess.kill("SIGKILL"), true, "crash fixture should terminate only Desktop");
    await firstDesktopExit;
    desktopShutdownRegistry.releaseExited(firstRun.electronApp, firstDesktopProcess);

    secondRun = await launchDesktop(scenarioRoot, mode, secondPorts, launchEnv);
    const relaunchedPidLines = (await readFile(
      resolveInstancePaths(scenarioRoot).postmasterPidPath,
      "utf8",
    )).split(/\r?\n/u);
    assert.equal(
      Number(relaunchedPidLines[0]?.trim()),
      postmasterPid,
      "rapid relaunch should reuse the live embedded PostgreSQL process",
    );
    assert.equal(
      Number(relaunchedPidLines[3]?.trim()),
      firstPorts.dbPort,
      "rapid relaunch should keep the live postmaster's actual port",
    );
    assert.notEqual(
      secondPorts.dbPort,
      firstPorts.dbPort,
      "rapid relaunch fixture should supply a different configured database port",
    );
    assert.equal(
      new URL(secondRun.baseUrl).port,
      String(secondPorts.appPort),
      "rapid relaunch should start the new Desktop API on its newly configured app port",
    );
    await closeDesktop(secondRun.electronApp, { expectDatabaseRelease: false });
    secondRun = null;
    await stopSmokeProcess(postmasterPid);
    console.log(
      `[desktop-smoke] rapid relaunch reused PostgreSQL pid=${postmasterPid} port=${firstPorts.dbPort} while ignoring configured port=${secondPorts.dbPort}`,
    );
  } catch (error) {
    if (secondRun) {
      await closeDesktop(secondRun.electronApp, { expectDatabaseRelease: false }).catch(() => {});
    }
    if (postmasterPid) await stopSmokeProcess(postmasterPid).catch(() => {});
    throw error;
  }
}

async function runUpgradeScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "upgrade");
  const paths = resolveInstancePaths(scenarioRoot);
  const ports = await allocateSmokePorts();
  const runtimeUrls = createRuntimeUrls(ports);

  const firstRun = await launchDesktop(scenarioRoot, mode, ports);
  await degradeIssueSchema(runtimeUrls.databaseUrl);
  await closeDesktop(firstRun.electronApp);

  // Simulate the exact interrupted-shutdown state that users can carry across
  // a Desktop update. The cluster remains valid; only PostgreSQL's pid file
  // points at a process that no longer exists. A release must recover this
  // state before it reaches the authenticated board.
  await writeFile(
    paths.postmasterPidPath,
    [
      String(Number.MAX_SAFE_INTEGER),
      path.join(paths.instanceRoot, "db"),
      "0",
      String(ports.dbPort),
      "",
      "127.0.0.1",
      "",
      "ready",
      "",
    ].join("\n"),
    "utf8",
  );

  const secondRun = await launchDesktop(scenarioRoot, mode, ports);
  const company = await createCompany(secondRun.baseUrl);
  await verifyBundledSkills(secondRun.baseUrl, company.id);
  const ceo = await createCeo(secondRun.baseUrl, company.id);
  await createIssue(secondRun.baseUrl, company.id, ceo.id);
  await closeDesktop(secondRun.electronApp);

  await assertUpgradeRepairLogged(paths.logsDir);
}

async function runAutoUpdateScenario(mode) {
  assert.equal(mode, "packaged", "automatic update acceptance requires a packaged Desktop");
  assert.equal(process.platform, "darwin", "automatic update v1 acceptance is macOS-only");
  const executablePath = await resolvePackagedExecutablePath();
  const resourcesDir = path.resolve(path.dirname(executablePath), "..", "Resources");
  const nativeTarget = resolveNativeTarget(process.platform, process.arch);
  assert.ok(nativeTarget, `automatic update helper has no native target for ${process.platform}/${process.arch}`);
  const helperPath = path.join(resourcesDir, "native", nativeTarget, "rudder-update-helper");
  const helperStats = await stat(helperPath).catch(() => null);
  assert.ok(helperStats?.isFile(), `packaged Desktop is missing the external update helper: ${helperPath}`);
  assert.notEqual(helperStats.mode & 0o111, 0, "packaged update helper should be executable");
  await verifyPackagedUpdateHelperFaultMatrix(helperPath);
  await verifyPackagedExternalUpdateHelperHandoff(executablePath, helperPath);
}

async function runAppBuilderScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "app-builder");
  const ports = await allocateSmokePorts();
  const runtimeUrls = createRuntimeUrls(ports);
  const run = await launchDesktop(scenarioRoot, mode, ports);
  let browser = null;
  let scenarioError = null;
  let shutdownError = null;
  try {
    const company = await createCompany(run.baseUrl, "APP");
    const companyRouteKey = company.urlKey ?? company.issuePrefix;
    const ceo = await createCeo(run.baseUrl, company.id);
    await run.page.evaluate((companyId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", companyId);
    }, company.id);
    await updateExperimentalPlugins(run.baseUrl, true);
    const health = await fetch(`${run.baseUrl}/api/health`).then((response) => response.json());
    assert.equal(
      health.features?.experimentalPluginsEnabled,
      true,
      "enabling Experimental Plugins must update the public feature capability",
    );

    const appUrl = (appId) => new URL(
      `/${companyRouteKey}/apps/view/${encodeURIComponent(`managed:${appId}`)}`,
      run.baseUrl,
    ).href;
    const missingApp = await createAppBuilderRecord(
      run.baseUrl,
      company.id,
      "Missing Source App",
      "apps/missing-source-app",
    );
    assert.equal(
      missingApp.projectId,
      null,
      "Apps workspace records must not create a backing Project",
    );
    await run.page.goto(appUrl(missingApp.id));
    await dismissOnboardingIfVisible(run.page);
    assert.equal(
      await run.page.getByTestId("apps-register-preview").count(),
      0,
      "verified source handoff must not require the legacy registration button",
    );
    await reportAppBuilderSourceHandoff(
      run.baseUrl,
      runtimeUrls.databaseUrl,
      company,
      ceo,
      missingApp.id,
    );
    await waitForSmokeCondition(
      "missing App source to report an automatic launch failure",
      async () => (await readAppBuilderRecord(run.baseUrl, company.id, missingApp.id)).buildStatus
        === "launch_failed",
      { timeoutMs: 30_000 },
    );
    await run.page.getByTestId("apps-retry-managed-app").waitFor({ timeout: 30_000 });
    assert.equal(
      (await readAppBuilderRecord(run.baseUrl, company.id, missingApp.id)).buildStatus,
      "launch_failed",
      "missing source must preserve retryable automatic-launch recovery",
    );

    const sourceRoot = "apps/desktop-app-builder-crm";
    const appRecord = await createAppBuilderRecord(
      run.baseUrl,
      company.id,
      "Desktop App Builder CRM",
      sourceRoot,
    );
    await run.page.evaluate(async (input) => {
      if (!window.desktopShell?.appBuilder?.supported) {
        throw new Error("Desktop App Builder is unavailable");
      }
      await window.desktopShell.appBuilder.scaffold(input);
    }, {
      projectId: company.id,
      targetDirectory: sourceRoot,
      appId: "desktop-app-builder-crm",
      title: "Desktop App Builder CRM",
    });

    await run.page.goto(appUrl(appRecord.id));
    await dismissOnboardingIfVisible(run.page);
    assert.equal(
      await run.page.getByTestId("apps-register-preview").count(),
      0,
      "App Builder must wait for verified source instead of showing manual registration",
    );
    assert.equal(
      (await readAppBuilderRecord(run.baseUrl, company.id, appRecord.id)).buildStatus,
      "preparing",
      "scaffolding alone must not claim verified source",
    );
    assert.equal(
      (await run.page.evaluate(() => window.desktopShell?.localApps?.list())).length,
      0,
      "unverified source must not create a Local App definition",
    );
    await reportAppBuilderSourceHandoff(
      run.baseUrl,
      runtimeUrls.databaseUrl,
      company,
      ceo,
      appRecord.id,
    );
    const buildOutcome = await waitForSmokeCondition(
      "App Builder record to become Ready or report its runner failure",
      async () => {
        const record = await readAppBuilderRecord(run.baseUrl, company.id, appRecord.id);
        if (record.buildStatus === "launch_failed") {
          const definitions = await run.page.evaluate(
            () => window.desktopShell?.localApps?.list() ?? [],
          );
          const matching = definitions.find(
            (candidate) => candidate.localBindingId === record.localBindingId,
          ) ?? definitions[0];
          const logs = matching
            ? await run.page.evaluate(
              (definitionId) => window.desktopShell?.localApps?.logs(definitionId) ?? [],
              matching.id,
            )
            : [];
          const notifications = await run.page.locator('aside[aria-live="polite"]').allTextContents();
          return { failed: true, logs: [...logs, ...notifications] };
        }
        return record.buildStatus === "ready" && record.localBindingId
          ? { failed: false, record }
          : null;
      },
      { timeoutMs: 660_000 },
    );
    if (buildOutcome.failed) {
      throw new Error(
        `App Builder runner failed before Ready${
          buildOutcome.logs.length > 0 ? `:\n${buildOutcome.logs.join("\n")}` : ""
        }`,
      );
    }
    const ready = buildOutcome.record;
    const definition = await run.page.evaluate(
      async (localBindingId) => (await window.desktopShell.localApps.list())
        .find((candidate) => candidate.localBindingId === localBindingId) ?? null,
      ready.localBindingId,
    );
    assert.ok(definition, "Ready App must have a Desktop Local App definition");
    let target = await run.page.evaluate(
      (definitionId) => window.desktopShell.localApps.attestedTarget(definitionId),
      definition.id,
    );
    assert.ok(target, "Ready App must expose an attested target");
    assert.match(target.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    const uniqueEmail = `desktop-${Date.now()}@example.test`;
    const created = await fetch(new URL("/api/contacts", target.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Desktop UI smoke",
        email: uniqueEmail,
        company: "Rudder",
      }),
    });
    assert.equal(created.status, 201, await created.text());
    await run.page.getByTestId("apps-local-webview").waitFor({ timeout: 30_000 });
    assert.equal(
      await run.page.getByTestId("apps-local-webview").getAttribute("src"),
      new URL(target.openPath, target.origin).href,
      "Apps main content must embed the attested local App URL",
    );
    browser = await chromium.launch({ headless: true });
    const browserPage = await browser.newPage();
    await browserPage.goto(new URL(target.openPath, target.origin).href);
    await browserPage.getByText(uniqueEmail).waitFor({ timeout: 30_000 });

    const entryKey = `managed:${appRecord.id}`;
    const appEntry = run.page.getByTestId(`apps-entry-${entryKey}`);
    await appEntry.hover();
    await run.page.getByTestId(`apps-more-${entryKey}`).click();
    assert.equal(
      await run.page.getByTestId(`apps-delete-${entryKey}`).count(),
      0,
      "managed Apps must not expose Local App deletion",
    );
    await run.page.getByRole("menuitem", { name: "Stop App" }).click();
    await waitForSmokeCondition(
      "stopped App to clear its attested target",
      async () => (await run.page.evaluate(
        (definitionId) => window.desktopShell.localApps.attestedTarget(definitionId),
        definition.id,
      )) === null,
      { timeoutMs: 30_000 },
    );
    await appEntry.click();
    const restartOutcome = await waitForSmokeCondition(
      "restarted App to publish its attested target",
      async () => {
        const nextTarget = await run.page.evaluate(
          (definitionId) => window.desktopShell.localApps.attestedTarget(definitionId),
          definition.id,
        );
        if (nextTarget) return { failed: false, target: nextTarget };
        const runtime = await run.page.evaluate(
          (definitionId) => window.desktopShell.localApps.status(definitionId),
          definition.id,
        );
        if (runtime.status !== "failed") return null;
        const logs = await run.page.evaluate(
          (definitionId) => window.desktopShell.localApps.logs(definitionId),
          definition.id,
        );
        return { failed: true, runtime, logs };
      },
      { timeoutMs: 660_000 },
    );
    if (restartOutcome.failed) {
      throw new Error(
        `App Builder runner failed during restart: ${restartOutcome.runtime.error ?? "unknown"}${
          restartOutcome.logs.length > 0 ? `\n${restartOutcome.logs.join("\n")}` : ""
        }`,
      );
    }
    target = restartOutcome.target;
    const persisted = await fetch(new URL("/api/contacts", target.origin));
    assert.equal(persisted.status, 200);
    assert.match(await persisted.text(), new RegExp(uniqueEmail.replace(".", "\\.")));

    await appEntry.hover();
    await run.page.getByTestId(`apps-more-${entryKey}`).click();
    await run.page.getByTestId(`apps-copy-link-${entryKey}`).click();
    await run.page.getByText("App link copied").waitFor();
    assert.equal(
      await run.electronApp.evaluate(({ clipboard }) => clipboard.readText()),
      new URL(target.openPath, target.origin).href,
      "Copy App link must copy the current attested loopback URL",
    );
    await updateExperimentalPlugins(run.baseUrl, false);
    const disabledRuntime = await waitForSmokeCondition(
      "disabling Plugins to stop the running App",
      async () => {
        const runtime = await run.page.evaluate(
          (definitionId) => window.desktopShell.localApps.status(definitionId),
          definition.id,
        );
        return runtime.status === "stopped" ? runtime : null;
      },
      { timeoutMs: 30_000 },
    );
    assert.equal(
      disabledRuntime.origin,
      undefined,
      "disabling Plugins must clear the App runtime origin",
    );
    const blockedStart = await run.page.evaluate(async (definitionId) => {
      try {
        await window.desktopShell.localApps.start(definitionId);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, definition.id);
    assert.match(
      blockedStart ?? "",
      /Plugins is disabled in Experimental settings/i,
      "disabling Plugins must block direct Desktop start attempts",
    );
    console.log("[desktop-smoke] App Builder completed Apps workspace, IPC, Ready, embedded page, browser, CRUD, restart, copy-link, feature shutdown, and cleanup");
  } catch (error) {
    scenarioError = error;
  }
  try {
    await browser?.close();
    await closeDesktop(run.electronApp);
  } catch (error) {
    shutdownError = error;
  }
  if (scenarioError && shutdownError) {
    throw new AggregateError([scenarioError, shutdownError], "App Builder scenario and shutdown cleanup failed");
  }
  if (scenarioError) throw scenarioError;
  if (shutdownError) throw shutdownError;
}

function resolveScenarioList(mode, scenario) {
  if (!scenario || scenario === "default") {
    const localApps = process.platform === "darwin" ? ["local-apps"] : [];
    const packagedPublicUpdate = process.platform === "darwin" && process.arch === "arm64"
      ? ["auto-update-public"]
      : [];
    return mode === "packaged"
      ? ["account-gate", ...packagedPublicUpdate]
      : ["startup-recovery", "app-builder", "clean", ...localApps];
  }
  if (scenario === "all") {
    const packagedPublicUpdate = process.platform === "darwin" && process.arch === "arm64"
      ? ["auto-update-public"]
      : [];
    return mode === "packaged"
      ? ["account-gate", ...packagedPublicUpdate]
      : ["startup-recovery", "postgres-runtime-handoff", "app-builder", "clean", "local-apps", "agent-browser", "upgrade"];
  }
  if (scenario === "account-gate"
    || scenario === "auto-update"
    || scenario === "auto-update-public"
    || scenario === "startup-recovery"
    || scenario === "postgres-runtime-handoff"
    || scenario === "clean"
    || scenario === "upgrade"
    || scenario === "browser"
    || scenario === "terminal"
    || scenario === "local-apps"
    || scenario === "agent-browser"
    || scenario === "app-builder") {
    return [scenario];
  }
  throw new Error(`Unknown smoke scenario: ${scenario}`);
}

let smokeBodyPassed = false;
let smokeError = null;
let executedScenarios = [];
try {
  executedScenarios = resolveScenarioList(smokeMode, smokeScenario);
  for (const scenario of executedScenarios) {
    console.log(`[desktop-smoke] running ${scenario} scenario`);
    if (scenario === "account-gate") {
      await runAccountGateScenario(smokeMode);
    } else if (scenario === "auto-update") {
      await runAutoUpdateScenario(smokeMode);
    } else if (scenario === "auto-update-public") {
      await runPackagedPublicAutoUpdateScenario(smokeMode);
    } else if (scenario === "startup-recovery") {
      await runStartupRecoveryScenario(smokeMode);
    } else if (scenario === "postgres-runtime-handoff") {
      await runPostgresRuntimeHandoffScenario(smokeMode);
    } else if (scenario === "clean") {
      await runCleanScenario(smokeMode);
    } else if (scenario === "browser") {
      await runBrowserScenario(smokeMode);
    } else if (scenario === "terminal") {
      await runTerminalScenario(smokeMode);
    } else if (scenario === "local-apps") {
      await runLocalAppsScenario(smokeMode);
    } else if (scenario === "agent-browser") {
      await runAgentBrowserScenario(smokeMode);
    } else if (scenario === "app-builder") {
      await runAppBuilderScenario(smokeMode);
    } else {
      await runUpgradeScenario(smokeMode);
    }
  }
  smokeBodyPassed = true;
} catch (error) {
  smokeError = error;
} finally {
  const pendingLaunchCount = desktopShutdownRegistry.size;
  const shutdownErrors = await desktopShutdownRegistry.drain();
  if (smokeBodyPassed && pendingLaunchCount > 0) {
    shutdownErrors.unshift(new Error(
      `Desktop smoke completed with ${pendingLaunchCount} launch(es) still active before final cleanup`,
    ));
  }
  if (shutdownErrors.length > 0) {
    smokeError = smokeError
      ? new AggregateError([smokeError, ...shutdownErrors], "Desktop smoke and shutdown cleanup failed")
      : shutdownErrors.length === 1
        ? shutdownErrors[0]
        : new AggregateError(shutdownErrors, "Desktop smoke shutdown cleanup failed");
  }
  if (smokeError) {
    console.error(`[desktop-smoke] preserving failed smoke root for cleanup diagnostics: ${tmpRoot}`);
  } else {
    console.log(`Desktop smoke test passed (${smokeMode}; ${executedScenarios.join(", ")}).`);
    if (process.env.RUDDER_DESKTOP_SMOKE_KEEP_ROOT === "1") {
      console.log(`[desktop-smoke] preserving successful smoke root: ${tmpRoot}`);
    } else {
      try {
        await rm(tmpRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn("[desktop-smoke] temp cleanup failed", error);
      }
    }
  }
}
if (smokeError) throw smokeError;
