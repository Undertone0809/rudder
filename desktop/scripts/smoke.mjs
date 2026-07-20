import { _electron as electron } from "@playwright/test";
import electronBinary from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "..");
const requireFromScript = createRequire(import.meta.url);
const smokeModeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const smokeScenarioArg = process.argv.find((arg) => arg.startsWith("--scenario="));
const smokeMode = smokeModeArg?.slice("--mode=".length) ?? process.env.RUDDER_DESKTOP_SMOKE_MODE ?? "dev";
const smokeScenario = smokeScenarioArg?.slice("--scenario=".length) ?? process.env.RUDDER_DESKTOP_SMOKE_SCENARIO ?? null;
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-desktop-smoke-"));
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
const browserSmokeScreenshotPath = process.env.RUDDER_DESKTOP_SMOKE_SCREENSHOT?.trim() || null;
const expectedBrowserToolNames = [
  "rudder_browser_tabs",
  "rudder_browser_open",
  "rudder_browser_navigate",
  "rudder_browser_read",
  "rudder_browser_click",
  "rudder_browser_type",
  "rudder_browser_screenshot",
  "rudder_browser_close",
];
const windowsToUnixEpochMicroseconds = 11_644_473_600_000_000n;
const REQUIRED_BUNDLED_SKILLS = [
  "browser",
  "para-memory-files",
  "rudder-docs",
  "skill-creator",
  "visualize",
];
console.log(`[desktop-smoke] temp root: ${tmpRoot}`);

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
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
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(`<!doctype html>
      <html>
        <head><title>Rudder Browser smoke</title></head>
        <body>
          <main>
            <h1>Rudder Browser fixture</h1>
            <button id="continue" type="button">Continue</button>
            <input aria-label="Smoke input" />
            <p>${request.url ?? "/"}</p>
          </main>
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

async function preparePackagedExternalRuntimeFixture(userDataDir) {
  const executablePath = await resolvePackagedExecutablePath();
  const resourcesDir = process.platform === "darwin"
    ? path.resolve(path.dirname(executablePath), "..", "Resources")
    : path.resolve(path.dirname(executablePath), "resources");
  const serverPackageDir = path.join(resourcesDir, "server-package");
  const cliEntry = path.join(serverPackageDir, "desktop-cli.js");
  const serverManifest = JSON.parse(await readFile(path.join(serverPackageDir, "package.json"), "utf8"));
  const serverEntrypoint = path.resolve(serverPackageDir, serverManifest.main ?? "dist/index.js");
  const runtimeCacheDir = path.join(resolveInstancePaths(userDataDir).rudderHome, "runtimes", serverManifest.version);
  const runtimeServerDir = path.join(runtimeCacheDir, "node_modules", "@rudderhq", "server");
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
    dependencies: { "@rudderhq/server": serverManifest.version },
  })}\n`, "utf8");
  await writeFile(path.join(runtimeCacheDir, "runtime.json"), `${JSON.stringify({
    version: 1,
    packageName: "@rudderhq/server",
    packageVersion: serverManifest.version,
    installedAt: new Date(0).toISOString(),
  })}\n`, "utf8");
  await writeFile(path.join(runtimeServerDir, "package.json"), `${JSON.stringify({
    name: "@rudderhq/server",
    version: serverManifest.version,
    type: "module",
    main: "./index.js",
    exports: { ".": "./index.js" },
  })}\n`, "utf8");
  await writeFile(
    path.join(runtimeServerDir, "index.js"),
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(loadedMarker)}, "loaded");\nexport * from ${JSON.stringify(pathToFileURL(serverEntrypoint).href)};\n`,
    "utf8",
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
    codexAdapterEntry: path.join(runtimeCodexAdapterDir, "dist", "server", "index.js"),
    executablePath,
    loadedMarker,
    runtimeCacheDir,
    serverVersion: serverManifest.version,
    staleMarker,
    userDataDir,
    env: { PATH: `${staleBinDir}${path.delimiter}${process.env.PATH ?? ""}` },
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

async function verifyBundledSkills(baseUrl, companyId) {
  console.log("[desktop-smoke] verifying bundled organization skills");
  const response = await fetch(`${baseUrl}/api/orgs/${companyId}/skills`);
  if (response.status !== 200) {
    throw new Error(`list organization skills failed (${response.status}): ${await response.text()}`);
  }
  const skills = await response.json();
  assert.ok(Array.isArray(skills), "organization skills response should be an array");

  const bundledSlugs = skills
    .filter((skill) => skill?.sourceBadge === "rudder")
    .map((skill) => skill.slug)
    .sort();

  assert.deepEqual(
    bundledSlugs,
    [...REQUIRED_BUNDLED_SKILLS].sort(),
    `expected bundled Rudder skills for new organization: ${REQUIRED_BUNDLED_SKILLS.join(", ")}`,
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
    }),
  });
  if (response.status !== 201) {
    throw new Error(`create chat failed (${response.status}): ${await response.text()}`);
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

async function createSmokeMcpClient(env) {
  const executablePath = smokeMode === "packaged" ? await resolvePackagedExecutablePath() : process.execPath;
  const args = smokeMode === "packaged"
    ? ["--desktop-cli", "mcp-server"]
    : [path.resolve(repoRoot, "cli/dist/index.js"), "mcp-server"];
  const child = spawn(executablePath, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  let exited = false;

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
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser MCP request timed out: ${method}`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      });
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
const { spawn } = require("node:child_process");

function parseManagedMcpConfig(configPath) {
  const lines = fs.readFileSync(configPath, "utf8").split(/\\r?\\n/u);
  let section = null;
  const result = { command: null, args: null, env: {} };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "[mcp_servers.rudder-operating-layer]") {
      section = "server";
      continue;
    }
    if (line === "[mcp_servers.rudder-operating-layer.env]") {
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
  const config = parseManagedMcpConfig(path.join(process.env.CODEX_HOME, "config.toml"));
  const expectedCommand = process.env.RUDDER_TEST_EXPECTED_MCP_COMMAND;
  if (config.command !== expectedCommand) {
    throw new Error("managed Codex MCP command mismatch: " + config.command);
  }
  if (JSON.stringify(config.args) !== JSON.stringify(["--desktop-cli", "mcp-server"])) {
    throw new Error("managed Codex MCP args mismatch: " + JSON.stringify(config.args));
  }
  if (desktopCliEntryVisible) throw new Error("provider inherited RUDDER_DESKTOP_CLI_ENTRY");

  const client = createMcpClient(config);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "packaged-codex-probe", version: "1" },
    });
    client.notify("notifications/initialized", {});
    const listed = await client.request("tools/list", {});
    const browserToolNames = listed.result.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("rudder_browser_"));
    const opened = readToolResult(await client.request("tools/call", {
      name: "rudder_browser_open",
      arguments: { url: process.env.RUDDER_TEST_BROWSER_URL },
    }), "rudder_browser_open");
    const snapshot = readToolResult(await client.request("tools/call", {
      name: "rudder_browser_read",
      arguments: { tabId: opened.tabId },
    }), "rudder_browser_read");
    readToolResult(await client.request("tools/call", {
      name: "rudder_browser_close",
      arguments: { tabId: opened.tabId },
    }), "rudder_browser_close");
    fs.writeFileSync(capturePath, JSON.stringify({
      browserToolNames,
      command: config.command,
      contract: initialized.result.capabilities.experimental.rudder,
      desktopCliEntryVisible,
      snapshotText: snapshot.text,
    }), "utf8");
  } finally {
    await client.close();
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
        },
        promptTemplate: "Verify the packaged Rudder MCP provider wiring.",
      },
      context: {},
      authToken: input.token,
      onLog: async () => {},
      onMeta: async (metadata) => {
        rudderMcpMetadata = metadata.rudderMcp;
      },
    });
    assert.equal(result.exitCode, 0, `packaged external-runtime Codex adapter failed: ${result.errorMessage ?? "unknown"}`);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(capture.desktopCliEntryVisible, false, "provider must not inherit the private Desktop CLI entry");
    assert.equal(capture.command, input.packagedRuntime.executablePath, "provider MCP config must use packaged Desktop CLI");
    assert.deepEqual(capture.browserToolNames, expectedBrowserToolNames, "provider MCP config should expose exact Browser tools");
    assert.match(capture.snapshotText, /Rudder Browser fixture/, "provider MCP config should read the Browser fixture");
    assert.equal(capture.contract.browserContractHash, rudderMcpMetadata.contractHash, "provider handshake and adapter metadata must agree");
    assert.equal(rudderMcpMetadata.browserAvailable, true, "packaged adapter metadata should keep Browser available");
    assert.equal(rudderMcpMetadata.provenance, "desktop_bundle", "packaged adapter metadata should report Desktop provenance");
    assert.equal(rudderMcpMetadata.version, input.packagedRuntime.serverVersion, "packaged adapter metadata version should match runtime cache");
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function verifyAgentBrowserBroker(baseUrl, databaseUrl, company, agent, packagedRuntime = null) {
  console.log("[desktop-smoke] verifying Agent Browser Broker open/read/close");
  const fixture = await startBrowserSmokeFixture();
  const postgres = await loadPostgres();
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
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
      return;
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
      assert.equal(browserToolNames.length, 8, "Agent Browser MCP should expose eight bounded tools");

      const rejectedFileOpen = await mcp.request("tools/call", {
        name: "rudder_browser_open",
        arguments: { url: pathToFileURL(path.join(tmpRoot, "agent-browser-denied.html")).href },
      });
      assert.equal(rejectedFileOpen.result?.isError, true, "Agent Browser must reject local file URLs");
      assert.ok(
        ["browser_invalid_argument", "browser_unsafe_url"].includes(rejectedFileOpen.result?.structuredContent?.code),
        "Agent Browser must classify local file URLs as invalid or unsafe",
      );

      const opened = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_open",
        arguments: { url: `${fixture.url}/agent` },
      }), "rudder_browser_open");
      assert.equal(typeof opened.tabId, "string", "Agent Browser open should return a tab id");

      const snapshot = readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_read",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_read");
      assert.match(snapshot.text, /Rudder Browser fixture/, "Agent Browser should read the fixture page");
      assert.ok(snapshot.refs.some((ref) => ref.name === "Continue"), "Agent Browser should return bounded element refs");

      readSmokeMcpToolResult(await mcp.request("tools/call", {
        name: "rudder_browser_close",
        arguments: { tabId: opened.tabId },
      }), "rudder_browser_close");
    } finally {
      await mcp.close();
    }
    console.log("[desktop-smoke] Agent Browser MCP completed tool discovery and open/read/close");
  } finally {
    await sql`update heartbeat_runs set status = 'succeeded', finished_at = now(), updated_at = now() where id = ${runId}::uuid`.catch(() => {});
    await sql.end({ timeout: 2 }).catch(() => {});
    await fixture.stop().catch(() => {});
  }
}

async function runDesktopCliCommand(executablePath, args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--desktop-cli", ...args], {
      env,
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

async function launchDesktopWindow(userDataDir, mode, ports, extraEnv = {}) {
  console.log(`[desktop-smoke] launching ${mode} desktop app`);
  const paths = resolveInstancePaths(userDataDir);
  const executablePath = mode === "packaged" ? await resolvePackagedExecutablePath() : electronBinary;
  const args = mode === "packaged" ? [] : [path.resolve(desktopDir, "dist/main.js")];
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
      PORT: String(ports.appPort),
      RUDDER_EMBEDDED_POSTGRES_PORT: String(ports.dbPort),
      ...extraEnv,
    },
  });
  const page = await electronApp.firstWindow();
  return { electronApp, page };
}

async function launchDesktop(userDataDir, mode, ports, extraEnv = {}) {
  const { electronApp, page: firstPage } = await launchDesktopWindow(userDataDir, mode, ports, extraEnv);
  const page = await waitForBoardWindow(electronApp, firstPage);
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
    document.querySelectorAll("[data-testid='chat-side-panel-browser-webview']").length > 0
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
    const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
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
      const bridgeReady = await candidate.evaluate(async () => {
        if (typeof window.desktopShell?.getBrowserPartition !== "function") return false;
        try {
          await window.desktopShell.getBrowserPartition();
          return true;
        } catch {
          return false;
        }
      }).catch(() => false);
      if (bridgeReady) {
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
      if (!bootState) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (bootState.stage === "error" || bootState.view === "failed") {
        throw new Error(`desktop boot failed: ${bootState.failure?.summary || bootState.stage}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Execution context was destroyed") && !message.includes("Target page, context or browser has been closed")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(
    boardReady,
    true,
    `expected exactly one ready Desktop board window with an active IPC bridge, got ${page?.url() ?? "no window"}`,
  );
  assert.ok(page.url().startsWith("http"), `expected desktop window to reach board UI, got ${page.url()}`);
  if (expectedUrlPattern) {
    assert.match(page.url(), expectedUrlPattern, `expected desktop window URL to match ${expectedUrlPattern}`);
  }
  return page;
}

async function closeDesktop(electronApp) {
  await electronApp.evaluate(({ app }) => {
    app.exit(0);
  });
  await electronApp.close();
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
    nextPath: `/${issuePrefix}/org`,
  });
  await page.waitForURL(new RegExp(`/${issuePrefix}/org$`), { timeout: 30_000 });

  await page.getByRole("link", { name: "Library" }).click();
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

  const beginResizeDrag = async (box) => {
    const pointerY = box.y + box.height / 2;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.mouse.move(box.x + box.width / 2, pointerY);
      await page.mouse.down();
      try {
        await page.getByTestId("side-panel-resize-shield").waitFor({ state: "visible", timeout: 2_000 });
        return pointerY;
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
    const pointerY = await beginResizeDrag(box);
    await page.mouse.move(targetX, pointerY, { steps: 12 });
    await page.mouse.up();
    await page.getByTestId("side-panel-resize-shield").waitFor({ state: "detached", timeout: 5_000 });
  };

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
  const cancelY = await beginResizeDrag(cancelResizerBox);
  await page.mouse.move(cancelResizerBox.x + 36, cancelY, { steps: 4 });
  const releasedPointerId = await page.getByTestId("side-panel-resizer").evaluate((element) => {
    window.__rudderDesktopSmokeLostCaptureCount = 0;
    element.addEventListener("lostpointercapture", () => {
      window.__rudderDesktopSmokeLostCaptureCount += 1;
    }, { once: true });
    for (let pointerId = 0; pointerId <= 32; pointerId += 1) {
      if (!element.hasPointerCapture(pointerId)) continue;
      element.releasePointerCapture(pointerId);
      return pointerId;
    }
    return null;
  });
  assert.notEqual(releasedPointerId, null, "native Electron resizer should hold pointer capture");
  await page.waitForFunction(() => window.__rudderDesktopSmokeLostCaptureCount === 1, null, { timeout: 5_000 });
  await page.getByTestId("side-panel-resize-shield").waitFor({ state: "detached", timeout: 5_000 });
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
  await dragResizer(restartResizerBox.x + 40);
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
  await dragResizer(collapsePanelBox.x + collapsePanelBox.width - 12);
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
    await page.evaluate(({ nextCompanyId, nextPath }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", nextCompanyId);
      window.history.replaceState({}, "", nextPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, {
      nextCompanyId: companyId,
      nextPath: targetPath,
    });
    await page.waitForURL(new RegExp(`/${issuePrefix}/messenger/chat/${chat.id}$`), { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await dismissOnboardingIfVisible(page);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await sidePanel.waitFor({ state: "visible", timeout: 15_000 });
    const browserView = sidePanel.getByTestId("chat-side-panel-browser-view");
    if (!(await browserView.isVisible().catch(() => false))) {
      const browserButton = sidePanel.getByTestId("chat-side-panel-empty-browser-target");
      if (await browserButton.isVisible().catch(() => false)) {
        await browserButton.click();
      } else {
        const panelText = await sidePanel.textContent().catch(() => "");
        throw new Error(`Side Panel Browser action was not visible. Current Side Panel text: ${panelText}`);
      }
    }
    await browserView.waitFor({ state: "visible", timeout: 15_000 });
    const browserUrlInput = browserView.getByLabel("Browser URL");
    await browserUrlInput.waitFor({ state: "visible", timeout: 15_000 });

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
      await sidePanel.getByTestId("chat-side-panel-browser-zoom").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await sidePanel.getByTestId("chat-side-panel-browser-zoom").textContent(), "110%");
      await pressElectronSurfaceShortcut(electronApp, "window", "0", [shortcutModifier]);
      await sidePanel.getByTestId("chat-side-panel-browser-zoom").waitFor({ state: "detached", timeout: 15_000 });

      const browserTabCountBeforeShortcut = await sidePanel.getByTestId("chat-side-panel-tab").count();
      const nativeWindowCountBeforeShortcut = electronApp
        ? await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        : null;
      await pressElectronSurfaceShortcut(electronApp, "window", "T", [shortcutModifier]);
      await page.waitForFunction((expectedCount) => (
        document.querySelectorAll("[data-testid='chat-side-panel-tab']").length === expectedCount
      ), browserTabCountBeforeShortcut + 1, { timeout: 15_000 });
      if (nativeWindowCountBeforeShortcut !== null) {
        assert.equal(
          await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
          nativeWindowCountBeforeShortcut,
          "Browser new-tab shortcut must not create a native Electron window",
        );
      }
      await sidePanel.getByTestId("chat-side-panel-tab").first().evaluate((button) => button.click());
      await page.waitForFunction(({ expectedUrl, marker }) => {
        if (window.__rudderBrowserShortcutHostMarker !== marker) return false;
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        return Boolean(webview && typeof webview.getURL === "function" && webview.getURL() === expectedUrl);
      }, { expectedUrl: fixtureUrl, marker: hostShortcutMarker }, { timeout: 15_000 });
      console.log("[desktop-smoke] Browser physical shortcuts preserved the host and targeted the active guest");

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
      const fileLoadError = sidePanel.getByTestId("chat-side-panel-browser-error");
      await fileLoadError.waitFor({ state: "visible", timeout: 30_000 });
      assert.match(await fileLoadError.innerText(), /ERR_FILE_NOT_FOUND/);
      assert.equal(page.url(), rudderUrl, "missing local files should not replace the Rudder route");

      await browserUrlInput.fill("google");
      await browserUrlInput.press("Enter");
      await page.waitForFunction(async () => {
        const webview = document.querySelector("[data-testid='chat-side-panel-browser-webview'][data-active='true']");
        if (!webview || typeof webview.getURL !== "function") return false;
        try {
          return webview.getURL().startsWith("https://www.google.com/search?q=google");
        } catch {
          return false;
        }
      }, null, { timeout: 30_000 });
      await sidePanel.getByTestId("chat-side-panel-browser-view").waitFor({ state: "visible", timeout: 15_000 });
    }

    console.log("[desktop-smoke] Side Panel Browser loaded the isolated fixture and preserved the Rudder route");
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
  await page.getByRole("button", { name: "System settings" }).waitFor({ state: "visible", timeout: 30_000 });
  await assertDesktopServiceWorkersDisabled(page);
  const openWindowCount = electronApp.windows().filter((candidate) => !candidate.isClosed()).length;

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });

  await page.waitForLoadState("networkidle");
  await page.waitForURL(new RegExp(`/${organizationRouteKey}/dashboard$`), { timeout: 30_000 });
  await dismissReleaseNotesDialogIfVisible(page);
  await page.getByRole("button", { name: "System settings" }).waitFor({ state: "visible", timeout: 30_000 });
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
  } finally {
    await closeDesktop(electronApp).catch(() => {});
  }
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
    await verifyAgentBrowserBroker(firstRun.baseUrl, runtimeUrls.databaseUrl, company, ceo, packagedRuntime);
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

async function runUpgradeScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "upgrade");
  const paths = resolveInstancePaths(scenarioRoot);
  const ports = await allocateSmokePorts();
  const runtimeUrls = createRuntimeUrls(ports);

  const firstRun = await launchDesktop(scenarioRoot, mode, ports);
  await degradeIssueSchema(runtimeUrls.databaseUrl);
  await closeDesktop(firstRun.electronApp);

  const secondRun = await launchDesktop(scenarioRoot, mode, ports);
  const company = await createCompany(secondRun.baseUrl);
  await verifyBundledSkills(secondRun.baseUrl, company.id);
  const ceo = await createCeo(secondRun.baseUrl, company.id);
  await createIssue(secondRun.baseUrl, company.id, ceo.id);
  await closeDesktop(secondRun.electronApp);

  await assertUpgradeRepairLogged(paths.logsDir);
}

function resolveScenarioList(mode, scenario) {
  if (!scenario || scenario === "default") {
    return mode === "packaged"
      ? ["startup-recovery", "clean", "upgrade"]
      : ["startup-recovery", "clean"];
  }
  if (scenario === "all") return ["startup-recovery", "clean", "upgrade"];
  if (scenario === "startup-recovery" || scenario === "clean" || scenario === "upgrade" || scenario === "browser") {
    return [scenario];
  }
  throw new Error(`Unknown smoke scenario: ${scenario}`);
}

try {
  const scenarios = resolveScenarioList(smokeMode, smokeScenario);
  for (const scenario of scenarios) {
    console.log(`[desktop-smoke] running ${scenario} scenario`);
    if (scenario === "startup-recovery") {
      await runStartupRecoveryScenario(smokeMode);
    } else if (scenario === "clean") {
      await runCleanScenario(smokeMode);
    } else if (scenario === "browser") {
      await runBrowserScenario(smokeMode);
    } else {
      await runUpgradeScenario(smokeMode);
    }
  }
  console.log(`Desktop smoke test passed (${smokeMode}; ${scenarios.join(", ")}).`);
} finally {
  try {
    await rm(tmpRoot, { recursive: true, force: true });
  } catch (error) {
    console.warn("[desktop-smoke] temp cleanup failed", error);
  }
}
