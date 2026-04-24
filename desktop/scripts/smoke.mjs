import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";
import electronBinary from "electron";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "..");
const requireFromScript = createRequire(import.meta.url);
const smokeModeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const smokeScenarioArg = process.argv.find((arg) => arg.startsWith("--scenario="));
const smokeMode = smokeModeArg?.slice("--mode=".length) ?? process.env.RUDDER_DESKTOP_SMOKE_MODE ?? "dev";
const smokeScenario = smokeScenarioArg?.slice("--scenario=".length) ?? process.env.RUDDER_DESKTOP_SMOKE_SCENARIO ?? null;
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-desktop-smoke-"));
const REQUIRED_BUNDLED_SKILLS = [
  "para-memory-files",
  "rudder",
  "rudder-create-agent",
  "rudder-create-plugin",
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

  const meResult = await runDesktopCliCommand(executablePath, ["agent", "me", "--json"], cliEnv);
  const me = JSON.parse(meResult.stdout);
  assert.equal(me.id, ceo.id, "packaged desktop CLI should return the authenticated agent");

  const inboxResult = await runDesktopCliCommand(executablePath, ["agent", "inbox", "--json"], cliEnv);
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
  const electronApp = await electron.launch({
    executablePath,
    args,
    env: {
      ...process.env,
      RUDDER_HOME: paths.rudderHome,
      RUDDER_DESKTOP_USER_DATA_DIR: paths.electronUserDataDir,
      RUDDER_LOCAL_ENV: "prod_local",
      RUDDER_INSTANCE_ID: "default",
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

async function verifySettingsOverlayFlow(page, companyId, issuePrefix) {
  console.log("[desktop-smoke] verifying settings overlay open/close flow");
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
  await modal.getByRole("heading", { name: "Notifications" }).waitFor({ state: "visible", timeout: 15_000 });
  await modal.getByRole("button", { name: "Open notification settings" }).waitFor({ state: "visible", timeout: 15_000 });
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
  await page.getByRole("button", { name: "System settings" }).waitFor({ state: "visible", timeout: 30_000 });
  await assertDesktopServiceWorkersDisabled(page);
  const openWindowCount = electronApp.windows().filter((candidate) => !candidate.isClosed()).length;

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });

  await page.waitForLoadState("networkidle");
  await page.waitForURL(new RegExp(`/${issuePrefix}/dashboard$`), { timeout: 30_000 });
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
  const firstRun = await launchDesktop(scenarioRoot, mode, ports);
  try {
    const company = await createCompany(firstRun.baseUrl);
    await verifyBundledSkills(firstRun.baseUrl, company.id);
    const ceo = await createCeo(firstRun.baseUrl, company.id);
    const issue = await createIssue(firstRun.baseUrl, company.id, ceo.id);
    if (mode === "packaged") {
      await verifyPackagedDesktopCli(firstRun.baseUrl, ceo, issue);
    }
    firstRun.page = await verifyReloadRecovery(firstRun.electronApp, firstRun.page, company.id, company.issuePrefix);
    await verifySettingsOverlayFlow(firstRun.page, company.id, company.issuePrefix);
    console.log("[desktop-smoke] closing first app run");
    await closeDesktop(firstRun.electronApp);

    const secondRun = await launchDesktop(scenarioRoot, mode, ports);
    await verifyCompaniesPersist(secondRun.baseUrl, company.id);
    await closeDesktop(secondRun.electronApp);
  } catch (error) {
    console.error("[desktop-smoke] clean scenario failed", error);
    await closeDesktop(firstRun.electronApp).catch(() => {});
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
  if (scenario === "clean" || scenario === "upgrade") return [scenario];
  throw new Error(`Unknown smoke scenario: ${scenario}`);
}

try {
  const scenarios = resolveScenarioList(smokeMode, smokeScenario);
  for (const scenario of scenarios) {
    console.log(`[desktop-smoke] running ${scenario} scenario`);
    if (scenario === "clean") {
      await runCleanScenario(smokeMode);
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
