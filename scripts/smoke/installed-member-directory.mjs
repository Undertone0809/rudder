#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const NATIVE_TARGET_COUNT = 6;
const BRIDGE_OVERRIDE_KEYS = [
  "RUDDER_RUST_MEMBER_DIRECTORY_MODE",
  "RUDDER_NATIVE_ACTOR_ENVELOPE_KEY",
  "RUDDER_SERVER_FOUNDATION_PATH",
  "RUDDER_NATIVE_MODE",
  "RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH",
  "RUDDER_RUST_ORGANIZATION_BRANDING_MODE",
  "RUDDER_RUST_PROJECT_GOAL_SET_MODE",
];

export const SMOKE_NATIVE_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "aarch64-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
];

export function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function nativeBinaryName(target) {
  return target.endsWith("-pc-windows-msvc")
    ? "rudder-server-foundation.exe"
    : "rudder-server-foundation";
}

export function targetMatchesHost(target, platform, arch) {
  const targetArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!targetArch || !target.startsWith(`${targetArch}-`)) return false;
  if (platform === "darwin") return target.endsWith("-apple-darwin");
  if (platform === "linux") return /-unknown-linux-(gnu|musl)$/u.test(target);
  if (platform === "win32") return target.endsWith("-pc-windows-msvc");
  return false;
}

export function buildServerEnvironment(baseEnv, input) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !key.startsWith("RUDDER_")),
  );

  Object.assign(env, {
    HOME: input.home,
    USERPROFILE: input.home,
    APPDATA: path.join(input.home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(input.home, "AppData", "Local"),
    DATABASE_URL: "",
    HOST: "127.0.0.1",
    PORT: String(input.apiPort),
    RUDDER_HOME: input.home,
    RUDDER_INSTANCE_ID: input.instanceId,
    RUDDER_AGENT_JWT_SECRET: input.jwtSecret,
    RUDDER_EMBEDDED_POSTGRES_PORT: String(input.databasePort),
    RUDDER_MIGRATION_AUTO_APPLY: "true",
    RUDDER_MIGRATION_PROMPT: "never",
    RUDDER_OPEN_ON_LISTEN: "false",
    RUDDER_RUST_BRIDGE_DEBUG: "true",
  });

  for (const key of BRIDGE_OVERRIDE_KEYS) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must be omitted from the default installed run`);
  }
  return env;
}

export async function inspectInstalledPrefix(installRoot, options = {}) {
  const coverageMode = options.coverageMode ?? "full-package";
  assert.ok(
    coverageMode === "full-package" || coverageMode === "host-only-development-fixture",
    `unsupported installed native coverage mode: ${coverageMode}`,
  );
  const resolvedPrefix = await realpath(installRoot);
  const resolvedTempRoot = await realpath(os.tmpdir());
  const resolvedRepositoryRoot = await realpath(options.repositoryRoot ?? REPOSITORY_ROOT);
  assert.ok(
    isPathInside(resolvedTempRoot, resolvedPrefix),
    `installed prefix must be disposable and inside ${resolvedTempRoot}: ${resolvedPrefix}`,
  );
  assert.equal(
    isPathInside(resolvedRepositoryRoot, resolvedPrefix),
    false,
    `installed prefix must not resolve into the checkout: ${resolvedPrefix}`,
  );

  const serverPackageRoot = await realpath(path.join(
    resolvedPrefix,
    "node_modules",
    "@rudderhq",
    "server",
  ));
  const cliPackageRoot = await realpath(path.join(
    resolvedPrefix,
    "node_modules",
    "@rudderhq",
    "cli",
  ));
  assert.ok(isPathInside(resolvedPrefix, serverPackageRoot), "server package escaped the disposable prefix");
  assert.ok(isPathInside(resolvedPrefix, cliPackageRoot), "CLI package escaped the disposable prefix");

  const serverMetadata = JSON.parse(await readFile(path.join(serverPackageRoot, "package.json"), "utf8"));
  const cliMetadata = JSON.parse(await readFile(path.join(cliPackageRoot, "package.json"), "utf8"));
  assert.equal(serverMetadata.name, "@rudderhq/server");
  assert.equal(cliMetadata.name, "@rudderhq/cli");

  const serverEntry = path.join(serverPackageRoot, "dist", "index.js");
  const cliEntry = path.join(cliPackageRoot, "dist", "index.js");
  await Promise.all([access(serverEntry, fsConstants.R_OK), access(cliEntry, fsConstants.R_OK)]);

  const nativeRoot = path.join(serverPackageRoot, "resources", "native");
  const nativeDirectories = (await readdir(nativeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  if (coverageMode === "full-package") {
    assert.deepEqual(
      nativeDirectories,
      [...SMOKE_NATIVE_TARGETS].sort(),
      `full-package acceptance requires all ${NATIVE_TARGET_COUNT} known native target directories`,
    );
  }

  const hostTargets = SMOKE_NATIVE_TARGETS.filter((target) => (
    targetMatchesHost(target, process.platform, process.arch)
  ));
  assert.equal(
    hostTargets.length,
    1,
    `expected one known native target for ${process.platform}/${process.arch}; found ${hostTargets.join(", ") || "none"}`,
  );
  const requiredTargets = coverageMode === "full-package" ? SMOKE_NATIVE_TARGETS : hostTargets;
  const nativeEntries = await Promise.all(requiredTargets.map(async (name) => {
    const binaryPath = path.join(nativeRoot, name, nativeBinaryName(name));
    await access(binaryPath, fsConstants.R_OK);
    return { target: name, binaryPath };
  }));
  const hostEntries = nativeEntries.filter(({ target }) => targetMatchesHost(target, process.platform, process.arch));
  assert.equal(
    hostEntries.length,
    1,
    `expected one packaged native target for ${process.platform}/${process.arch}; found ${hostEntries.map(({ target }) => target).join(", ") || "none"}`,
  );
  await access(hostEntries[0].binaryPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);

  const legacyNativeRoot = path.resolve(path.dirname(serverEntry), "../../..");
  assert.equal(
    isPathInside(resolvedRepositoryRoot, legacyNativeRoot),
    false,
    `legacy native lookup root resolves into the checkout: ${legacyNativeRoot}`,
  );
  const binaryName = nativeBinaryName(hostEntries[0].target);
  for (const mode of ["debug", "release"]) {
    const legacyCandidate = path.join(legacyNativeRoot, "native", "target", mode, binaryName);
    try {
      await access(legacyCandidate, fsConstants.F_OK);
      throw new Error(`unexpected source-layout native binary in installed prefix: ${legacyCandidate}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return {
    coverageMode,
    installRoot: resolvedPrefix,
    serverPackageRoot,
    cliPackageRoot,
    serverEntry,
    cliEntry,
    nativeEntries: nativeEntries.sort((left, right) => left.target.localeCompare(right.target)),
    hostNativeEntry: hostEntries[0],
    legacyNativeRoot,
  };
}

export function parseArgs(args) {
  const options = {
    installRoot: null,
    timeoutMs: 180_000,
    keepTemp: false,
    coverageMode: "full-package",
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--install-root") options.installRoot = args[++index] ?? "";
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(args[++index] ?? "", 10);
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--host-only-development-fixture") {
      options.coverageMode = "host-only-development-fixture";
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.installRoot) throw new Error("--install-root is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return options;
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServerProcess(serverEntry, cwd, env) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => { logs.stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { logs.stderr += chunk; });
  return { child, logs };
}

async function waitForExit(child, timeoutMs) {
  if ((child.exitCode !== null || child.signalCode !== null)
    && child.stdout?.readableEnded && child.stderr?.readableEnded) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForHealth(server, apiUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`installed server exited before health (${server.child.exitCode ?? server.child.signalCode})\n${server.logs.stderr}`);
    }
    try {
      const response = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(750) });
      if (response.status === 200) return;
    } catch {
      // The server may still be starting its database and migrations.
    }
    await delay(100);
  }
  throw new Error(`installed server health timed out\n${server.logs.stderr}`);
}

async function portIsListening(port) {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPortClosed(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await portIsListening(port)) return;
    await delay(50);
  }
  throw new Error(`port ${port} remained open after server startup rollback`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill("SIGTERM");
  try {
    await waitForExit(server.child, 15_000);
  } catch {
    server.child.kill("SIGKILL");
    await waitForExit(server.child, 5_000);
  }
}

async function runCaptured(command, args, { cwd, env, input, timeoutMs }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.stdin.end(input ?? "");
  try {
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function createOrganization(apiUrl, name, issuePrefix) {
  const result = await readJsonResponse(await fetch(`${apiUrl}/api/orgs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, issuePrefix, requireBoardApprovalForNewAgents: false }),
  }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.match(result.body.id, /^[0-9a-f-]{36}$/iu);
  return result.body.id;
}

async function createAgent(apiUrl, orgId, name) {
  const result = await readJsonResponse(await fetch(`${apiUrl}/api/orgs/${orgId}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
    }),
  }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.match(result.body.id, /^[0-9a-f-]{36}$/iu);
  return result.body.id;
}

async function createAgentKey(apiUrl, agentId) {
  const result = await readJsonResponse(await fetch(`${apiUrl}/api/agents/${agentId}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "installed-member-directory-smoke" }),
  }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.match(result.body.token, /^pcp_[a-f0-9]{48}$/u);
  return result.body.token;
}

async function getMemberPage(apiUrl, orgId, token, params = {}) {
  const query = new URLSearchParams(params);
  return await readJsonResponse(await fetch(
    `${apiUrl}/api/orgs/${orgId}/members/directory?${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  ));
}

function cliEnvironment(baseEnv, apiUrl, apiKey, orgId, agentId) {
  return {
    ...baseEnv,
    RUDDER_API_URL: apiUrl,
    RUDDER_API_KEY: apiKey,
    RUDDER_ORG_ID: orgId,
    RUDDER_AGENT_ID: agentId,
  };
}

async function runCli(cliEntry, args, cwd, env, timeoutMs) {
  return await runCaptured(process.execPath, [cliEntry, ...args], {
    cwd,
    env,
    input: "",
    timeoutMs,
  });
}

async function runMcpCall(cliEntry, input, cwd, env, timeoutMs) {
  const message = {
    jsonrpc: "2.0",
    id: `member-directory-${randomUUID()}`,
    method: "tools/call",
    params: {
      name: "rudder_organization_members_list",
      arguments: input,
    },
  };
  const result = await runCaptured(process.execPath, [cliEntry, "mcp-server"], {
    cwd,
    env: { ...env, RUDDER_TOOL_TRANSPORT_SURFACE: "mcp" },
    input: `${JSON.stringify(message)}\n`,
    timeoutMs,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const response = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).at(-1);
  assert.ok(response?.result, `MCP server did not return a JSON-RPC result: ${result.stdout}`);
  return response.result;
}

function assertShortRefs(page) {
  assert.equal(Array.isArray(page.items), true);
  assert.ok(page.items.length > 0);
  for (const member of page.items) {
    assert.match(member.ref, /^(?:agt|usr)_[a-z0-9]{8,}$/u);
    assert.doesNotMatch(member.ref, /^[0-9a-f-]{36}$/iu);
  }
}

function assertFullIds(page) {
  assert.equal(Array.isArray(page.items), true);
  assert.ok(page.items.length > 0);
  for (const member of page.items) {
    assert.match(member.ref, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  }
}

async function verifyRequiredStartupFailure(installed, runRoot, timeoutMs) {
  const home = path.join(runRoot, "home-startup-failure");
  await mkdir(home, { recursive: true });
  const apiPort = await freePort();
  const databasePort = await freePort();
  const env = buildServerEnvironment(process.env, {
    home,
    apiPort,
    databasePort,
    instanceId: `member-directory-boot-${randomUUID()}`,
    jwtSecret: randomUUID(),
  });
  const disabledPath = `${installed.hostNativeEntry.binaryPath}.missing-${randomUUID()}`;
  await rename(installed.hostNativeEntry.binaryPath, disabledPath);
  try {
    const server = startServerProcess(installed.serverEntry, runRoot, env);
    const result = await waitForExit(server.child, timeoutMs);
    assert.notEqual(result.code, 0, `required startup unexpectedly succeeded\n${server.logs.stdout}`);
    assert.match(`${server.logs.stdout}\n${server.logs.stderr}`, /foundation.*binary|binary.*unavailable/iu);
    assert.equal(await portIsListening(apiPort), false, "startup failure exposed an API listener");
    await waitForPortClosed(databasePort);
  } finally {
    await rename(disabledPath, installed.hostNativeEntry.binaryPath);
  }
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Rust foundation process ${pid} did not exit within ${timeoutMs}ms`);
}

async function killRustChild(pid) {
  try {
    process.kill(pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitForPidExit(pid);
}

async function runSmoke(options) {
  const installed = await inspectInstalledPrefix(options.installRoot, {
    coverageMode: options.coverageMode,
  });
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-installed-member-directory."));
  let server = null;
  let nativeRestore = null;
  try {
    console.log(`[installed-member-directory] disposable install prefix: ${installed.installRoot}`);
    if (installed.coverageMode === "host-only-development-fixture") {
      console.log("[installed-member-directory] evidence scope: HOST-RUNTIME-ONLY development fixture; not full-package or release proof");
    } else {
      console.log("[installed-member-directory] evidence scope: FULL-PACKAGE installed artifact; six-target package check enabled");
    }
    console.log(`[installed-member-directory] verified installed native targets (${installed.nativeEntries.length} entries): ${installed.nativeEntries.map(({ target }) => target).join(", ")}`);
    console.log(`[installed-member-directory] executing host target only: ${installed.hostNativeEntry.target} (${process.platform}/${process.arch})`);
    console.log(`[installed-member-directory] legacy native lookup root: ${installed.legacyNativeRoot} (outside checkout)`);

    await verifyRequiredStartupFailure(installed, runRoot, options.timeoutMs);
    console.log("[installed-member-directory] default required startup failure: exited without API listener; embedded database port closed");

    const home = path.join(runRoot, "home-runtime");
    await mkdir(home, { recursive: true });
    const apiPort = await freePort();
    const databasePort = await freePort();
    const env = buildServerEnvironment(process.env, {
      home,
      apiPort,
      databasePort,
      instanceId: `member-directory-runtime-${randomUUID()}`,
      jwtSecret: randomUUID(),
    });
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    server = startServerProcess(installed.serverEntry, runRoot, env);
    await waitForHealth(server, apiUrl, options.timeoutMs);
    assert.equal((server.logs.stderr.match(/\[rudder-rust-bridge\] started pid=/gu) ?? []).length, 1);
    console.log("[installed-member-directory] default packaged startup: API healthy with mode, signer, and binary overrides absent");

    const orgId = await createOrganization(apiUrl, `Installed members ${Date.now()}`, "IMD");
    const foreignOrgId = await createOrganization(apiUrl, `Installed members foreign ${Date.now()}`, "IMF");
    let agentId = "";
    for (let index = 1; index <= 11; index += 1) {
      const createdAgentId = await createAgent(apiUrl, orgId, `Member Directory Agent ${String(index).padStart(2, "0")}`);
      if (index === 1) agentId = createdAgentId;
    }
    const agentKey = await createAgentKey(apiUrl, agentId);
    // Local-trusted deployments intentionally grant implicit board access.
    // Seed through that supported entry, then exercise rejection semantics in
    // authenticated mode without changing any Rust bridge selection or signer.
    const trustedRead = await fetch(`${apiUrl}/api/orgs/${orgId}/members/directory?limit=1`);
    assert.equal(trustedRead.status, 200, "local-trusted default member read failed");
    await stopServer(server);
    await waitForPortClosed(databasePort);
    env.RUDDER_DEPLOYMENT_MODE = "authenticated";
    server = startServerProcess(installed.serverEntry, runRoot, env);
    await waitForHealth(server, apiUrl, options.timeoutMs);
    assert.equal((server.logs.stderr.match(/\[rudder-rust-bridge\] started pid=/gu) ?? []).length, 1);
    console.log("[installed-member-directory] authenticated deployment restarted on the same data; Rust overrides remain absent");
    const query = "Member Directory Agent";
    const firstPageResult = await getMemberPage(apiUrl, orgId, agentKey, {
      query,
      type: "agent",
      limit: "2",
    });
    assert.equal(firstPageResult.status, 200, JSON.stringify(firstPageResult.body));
    const firstPage = firstPageResult.body;
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);
    assert.ok(firstPage.total >= 11);
    assertShortRefs(firstPage);

    const secondPageResult = await getMemberPage(apiUrl, orgId, agentKey, {
      query,
      type: "agent",
      limit: "2",
      cursor: firstPage.nextCursor,
    });
    assert.equal(secondPageResult.status, 200, JSON.stringify(secondPageResult.body));
    const secondPage = secondPageResult.body;
    assert.equal(secondPage.items.length, 2);
    assert.equal(secondPage.hasMore, true);
    assert.equal(firstPage.items.some(({ ref }) => secondPage.items.some((item) => item.ref === ref)), false);
    assertShortRefs(secondPage);

    const fullIdResult = await getMemberPage(apiUrl, orgId, agentKey, {
      type: "agent",
      limit: "1",
      fullIds: "true",
    });
    assert.equal(fullIdResult.status, 200, JSON.stringify(fullIdResult.body));
    assertFullIds(fullIdResult.body);

    const unauthenticated = await readJsonResponse(await fetch(
      `${apiUrl}/api/orgs/${orgId}/members/directory?limit=1`,
      { headers: { authorization: "Bearer invalid-member-directory-key" } },
    ));
    assert.equal(unauthenticated.status, 401);
    const crossOrganization = await getMemberPage(apiUrl, foreignOrgId, agentKey, { limit: "1" });
    assert.equal(crossOrganization.status, 403, JSON.stringify(crossOrganization.body));
    console.log("[installed-member-directory] API: authentication, two-page cursor, short refs, full UUID refs, and cross-organization denial passed");

    const cliArgs = (targetOrgId, {
      apiKey = agentKey,
      limit = "2",
      cursor = null,
      fullIds = false,
    } = {}) => [
      "org", "members",
      "--org-id", targetOrgId,
      "--api-base", apiUrl,
      "--api-key", apiKey,
      "--query", query,
      "--type", "agent",
      "--limit", limit,
      "--json",
      ...(cursor ? ["--cursor", cursor] : []),
      ...(fullIds ? ["--full-ids"] : []),
    ];
    const cliFirst = await runCli(installed.cliEntry, cliArgs(orgId), runRoot, env, options.timeoutMs);
    assert.equal(cliFirst.code, 0, cliFirst.stderr || cliFirst.stdout);
    const cliFirstPage = JSON.parse(cliFirst.stdout);
    assert.equal(cliFirstPage.hasMore, true);
    assert.ok(cliFirstPage.nextCursor);
    assertShortRefs(cliFirstPage);
    const cliSecond = await runCli(
      installed.cliEntry,
      cliArgs(orgId, { cursor: cliFirstPage.nextCursor }),
      runRoot,
      env,
      options.timeoutMs,
    );
    assert.equal(cliSecond.code, 0, cliSecond.stderr || cliSecond.stdout);
    const cliSecondPage = JSON.parse(cliSecond.stdout);
    assert.equal(cliFirstPage.items.some(({ ref }) => cliSecondPage.items.some((item) => item.ref === ref)), false);
    assertShortRefs(cliSecondPage);
    const cliFull = await runCli(
      installed.cliEntry,
      cliArgs(orgId, { limit: "1", fullIds: true }),
      runRoot,
      env,
      options.timeoutMs,
    );
    assert.equal(cliFull.code, 0, cliFull.stderr || cliFull.stdout);
    assertFullIds(JSON.parse(cliFull.stdout));
    const cliDenied = await runCli(installed.cliEntry, cliArgs(foreignOrgId), runRoot, env, options.timeoutMs);
    assert.notEqual(cliDenied.code, 0, "CLI unexpectedly crossed organization boundaries");
    assert.match(`${cliDenied.stderr}\n${cliDenied.stdout}`, /403|forbidden|organization/iu);
    const cliUnauthenticated = await runCli(
      installed.cliEntry,
      cliArgs(orgId, { apiKey: "invalid-member-directory-key" }),
      runRoot,
      env,
      options.timeoutMs,
    );
    assert.notEqual(cliUnauthenticated.code, 0, "CLI unexpectedly accepted an invalid API key");
    assert.match(`${cliUnauthenticated.stderr}\n${cliUnauthenticated.stdout}`, /401|unauthorized/iu);
    console.log("[installed-member-directory] CLI: authenticated cursor pages, short refs, full UUID refs, invalid-key failure, and cross-organization denial passed");

    const mcpEnv = (targetOrgId, key = agentKey) => cliEnvironment(env, apiUrl, key, targetOrgId, agentId);
    const mcpFirst = await runMcpCall(installed.cliEntry, {
      query,
      type: "agent",
      limit: 2,
    }, runRoot, mcpEnv(orgId), options.timeoutMs);
    assert.equal(mcpFirst.isError, false, JSON.stringify(mcpFirst));
    assert.equal(mcpFirst.structuredContent.hasMore, true);
    assert.ok(mcpFirst.structuredContent.nextCursor);
    assertShortRefs(mcpFirst.structuredContent);
    const mcpSecond = await runMcpCall(installed.cliEntry, {
      query,
      type: "agent",
      limit: 2,
      cursor: mcpFirst.structuredContent.nextCursor,
    }, runRoot, mcpEnv(orgId), options.timeoutMs);
    assert.equal(mcpSecond.isError, false, JSON.stringify(mcpSecond));
    assert.equal(mcpFirst.structuredContent.items.some(({ ref }) => mcpSecond.structuredContent.items.some((item) => item.ref === ref)), false);
    assertShortRefs(mcpSecond.structuredContent);
    const mcpDenied = await runMcpCall(installed.cliEntry, { type: "agent", limit: 2 }, runRoot, mcpEnv(foreignOrgId), options.timeoutMs);
    assert.equal(mcpDenied.isError, true, JSON.stringify(mcpDenied));
    const mcpUnauthenticated = await runMcpCall(installed.cliEntry, { type: "agent", limit: 2 }, runRoot, mcpEnv(orgId, "invalid-member-directory-key"), options.timeoutMs);
    assert.equal(mcpUnauthenticated.isError, true, JSON.stringify(mcpUnauthenticated));
    console.log("[installed-member-directory] MCP: authenticated cursor pages, short refs, invalid-key failure, and cross-organization denial passed");

    const rustPidMatch = server.logs.stderr.match(/\[rudder-rust-bridge\] started pid=(\d+)/u);
    assert.ok(rustPidMatch, `could not identify the owned Rust child\n${server.logs.stderr}`);
    const rustPid = Number(rustPidMatch[1]);
    await killRustChild(rustPid);
    const disabledPath = `${installed.hostNativeEntry.binaryPath}.disabled-${randomUUID()}`;
    await rename(installed.hostNativeEntry.binaryPath, disabledPath);
    nativeRestore = { disabledPath, binaryPath: installed.hostNativeEntry.binaryPath };
    try {
      assert.equal((await fetch(`${apiUrl}/api/health`)).status, 200, "Node API stopped during the Rust child outage");
      const unavailable = await getMemberPage(apiUrl, orgId, agentKey, { limit: "1" });
      assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
      assert.equal(unavailable.body.code, "rust_foundation_member_directory_unavailable");

      const cliUnavailable = await runCli(installed.cliEntry, cliArgs(orgId), runRoot, env, options.timeoutMs);
      assert.notEqual(cliUnavailable.code, 0, "CLI unexpectedly returned a Node member directory during Rust outage");
      assert.match(`${cliUnavailable.stderr}\n${cliUnavailable.stdout}`, /503|unavailable/iu);

      const mcpUnavailable = await runMcpCall(installed.cliEntry, { type: "agent", limit: 2 }, runRoot, mcpEnv(orgId), options.timeoutMs);
      assert.equal(mcpUnavailable.isError, true, JSON.stringify(mcpUnavailable));
      assert.equal(mcpUnavailable.structuredContent.code, "rust_foundation_member_directory_unavailable");
      assert.equal(mcpUnavailable.structuredContent.details.status, 503);
      assert.equal((server.logs.stderr.match(/\[rudder-rust-bridge\] started pid=/gu) ?? []).length, 1, "Rust bridge restarted after the packaged executable was made unavailable");
    } finally {
      await rename(disabledPath, installed.hostNativeEntry.binaryPath);
      nativeRestore = null;
    }
    console.log("[installed-member-directory] post-boot Rust child outage: API 503, CLI/MCP errors, and no bridge restart passed");
    console.log("[installed-member-directory] the required-mode route unit test separately asserts organizationMemberService.list is never invoked on this failure path");
    console.log(installed.coverageMode === "host-only-development-fixture"
      ? "[installed-member-directory] HOST-RUNTIME-ONLY development fixture passed; not full-package or release evidence"
      : "[installed-member-directory] full-package installed member-directory acceptance passed");
  } finally {
    if (nativeRestore) {
      await rename(nativeRestore.disabledPath, nativeRestore.binaryPath).catch(() => undefined);
    }
    await stopServer(server).catch(() => undefined);
    if (options.keepTemp) console.log(`[installed-member-directory] keeping run directory: ${runRoot}`);
    else await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

function usage(code = 0) {
  console.error("Usage: node scripts/smoke/installed-member-directory.mjs --install-root <disposable-install-prefix> [--host-only-development-fixture] [--keep-temp] [--timeout-ms <ms>]");
  process.exit(code);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage(1);
  }
  if (options.help) usage(0);
  await runSmoke(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
