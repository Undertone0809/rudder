import { _electron as electron } from "@playwright/test";
import electronBinary from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const windowsToUnixEpochMicroseconds = 11_644_473_600_000_000n;
const REQUIRED_BUNDLED_SKILLS = [
  "browser",
  "para-memory-files",
  "rudder",
  "rudder-create-agent",
  "rudder-create-plugin",
  "skill-creator",
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

async function createCompany(baseUrl) {
  console.log("[desktop-smoke] creating company");
  const response = await fetch(`${baseUrl}/api/orgs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Desktop Smoke Co",
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

function createSmokeMcpClient(env) {
  const child = spawn(process.execPath, [path.resolve(repoRoot, "cli/dist/index.js"), "mcp-server"], {
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

async function verifyAgentBrowserBroker(baseUrl, databaseUrl, company, agent) {
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
    const mcp = createSmokeMcpClient({
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

async function launchDesktop(userDataDir, mode, ports) {
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
    },
  });
  let page = await electronApp.firstWindow();
  page = await waitForBoardWindow(electronApp, page);
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
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const openWindows = electronApp.windows().filter((candidate) => !candidate.isClosed());
    const boardPage = openWindows.find((candidate) => {
      const currentUrl = candidate.url();
      return currentUrl
        && currentUrl.startsWith("http")
        && (!expectedUrlPattern || expectedUrlPattern.test(currentUrl));
    });
    if (boardPage) {
      page = boardPage;
      break;
    }

    if (openWindows.length > 0) {
      page = openWindows.at(-1);
    }

    if (!page || page.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    try {
      const bootState = await page.evaluate(() => window.desktopShell.getBootState());
      if (bootState.stage === "error") {
        throw new Error(`desktop boot failed: ${bootState.error || bootState.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Execution context was destroyed") && !message.includes("Target page, context or browser has been closed")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
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

  await setSmokeRoute(`/${issuePrefix}/issues`);
  await waitForPath(`/${issuePrefix}/issues`);
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

  const dragResizer = async (targetX) => {
    const resizer = page.getByTestId("side-panel-resizer");
    const box = await resizer.boundingBox();
    assert.ok(box, "Side Panel resizer should have geometry");
    const pointerY = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, pointerY);
    await page.mouse.down();
    await page.getByTestId("side-panel-resize-shield").waitFor({ state: "visible", timeout: 5_000 });
    await page.mouse.move(targetX, pointerY, { steps: 12 });
    await page.mouse.up();
    await page.getByTestId("side-panel-resize-shield").waitFor({ state: "detached", timeout: 5_000 });
  };

  const initialPanelBox = await sidePanel.boundingBox();
  const initialResizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
  assert.ok(initialPanelBox && initialResizerBox, "Side Panel should be docked before native resize");
  await dragResizer(initialResizerBox.x - 80);
  const expandedPanelBox = await sidePanel.boundingBox();
  assert.ok(
    expandedPanelBox && expandedPanelBox.width > initialPanelBox.width + 30,
    "dragging left should continuously widen the Side Panel",
  );

  const cancelResizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
  assert.ok(cancelResizerBox, "Side Panel resizer should remain available after widening");
  const cancelY = cancelResizerBox.y + cancelResizerBox.height / 2;
  await page.mouse.move(cancelResizerBox.x + cancelResizerBox.width / 2, cancelY);
  await page.mouse.down();
  await page.getByTestId("side-panel-resize-shield").waitFor({ state: "visible", timeout: 5_000 });
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
  assert.ok(
    (await sidePanel.boundingBox())?.width < widthAfterCancel - 20,
    "a new resize should start after cancellation",
  );

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

async function verifyReloadRecovery(electronApp, page, companyId, issuePrefix) {
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
  await page.waitForURL(new RegExp(`/${issuePrefix}/dashboard$`), { timeout: 30_000 });
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

async function runCleanScenario(mode) {
  const scenarioRoot = path.join(tmpRoot, "clean");
  const ports = await allocateSmokePorts();
  const runtimeUrls = createRuntimeUrls(ports);
  const browserImportFixture = await createSyntheticBrowserImportFixture(scenarioRoot);
  const firstRun = await launchDesktop(scenarioRoot, mode, ports);
  const browserFixture = await startBrowserSmokeFixture();
  try {
    const company = await createCompany(firstRun.baseUrl);
    assert.deepEqual(
      await readBrowserSettings(firstRun.baseUrl),
      { enabled: true, openLinksIn: "built_in" },
      "fresh Desktop Browser settings should default on and route links internally",
    );
    await verifyBundledSkills(firstRun.baseUrl, company.id);
    await verifySyntheticBrowserCookieImport(firstRun.electronApp, firstRun.page, browserImportFixture);
    const ceo = await createCeo(firstRun.baseUrl, company.id);
    await verifyAgentBrowserBroker(firstRun.baseUrl, runtimeUrls.databaseUrl, company, ceo);
    const issue = await createIssue(firstRun.baseUrl, company.id, ceo.id);
    if (mode === "packaged") {
      await verifyPackagedDesktopCli(firstRun.baseUrl, ceo, issue);
    }
    firstRun.page = await verifyReloadRecovery(firstRun.electronApp, firstRun.page, company.id, company.issuePrefix);
    firstRun.page = await verifyNativeApplicationMenu(firstRun.electronApp, firstRun.page, company.id, company.issuePrefix);
    await verifyIssueDetailEscapeNavigation(firstRun.page, company.id, company.issuePrefix, issue);
    firstRun.page = await verifyOrganizationWorkspacesNavigation(
      firstRun.electronApp,
      firstRun.page,
      company.id,
      company.issuePrefix,
    );
    firstRun.page = await verifyChatSidePanelBrowser(
      firstRun.page,
      firstRun.baseUrl,
      company.id,
      company.issuePrefix,
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
    const secondCompany = await createCompany(firstRun.baseUrl);
    await verifyBundledSkills(firstRun.baseUrl, secondCompany.id);
    firstRun.page = await verifyChatSidePanelBrowser(
      firstRun.page,
      firstRun.baseUrl,
      secondCompany.id,
      secondCompany.issuePrefix,
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

    await verifySettingsOverlayFlow(firstRun.page, company.id, company.issuePrefix);
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
        secondCompany.issuePrefix,
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
        secondCompany.issuePrefix,
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
      company.issuePrefix,
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
    return mode === "packaged" ? ["clean", "upgrade"] : ["clean"];
  }
  if (scenario === "all") return ["clean", "upgrade"];
  if (scenario === "clean" || scenario === "upgrade" || scenario === "browser") return [scenario];
  throw new Error(`Unknown smoke scenario: ${scenario}`);
}

try {
  const scenarios = resolveScenarioList(smokeMode, smokeScenario);
  for (const scenario of scenarios) {
    console.log(`[desktop-smoke] running ${scenario} scenario`);
    if (scenario === "clean") {
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
