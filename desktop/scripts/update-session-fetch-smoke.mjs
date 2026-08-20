import { app, session } from "electron";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createDesktopBrowserApiClient } from "../dist/browser-broker-registration.js";
import { createDesktopQuitFlow } from "../dist/desktop-quit-flow.js";

const sessionCookieName = "better-auth.session_token";
const sessionCookieValue = randomBytes(24).toString("base64url");
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "rudder-update-session-smoke-"));
app.setPath("userData", userDataDir);
let server;
let baseUrl;
const watchdog = setTimeout(() => {
  console.error("Desktop update session fetch smoke timed out.");
  process.exit(1);
}, 30_000);

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function hasSessionCookie(request) {
  return (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .includes(`${sessionCookieName}=${sessionCookieValue}`);
}

async function closeServer() {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function run() {
  console.log("[update-session-smoke] waiting for Electron ready");
  await app.whenReady();
  console.log("[update-session-smoke] Electron ready");
  const authenticatedPaths = [];
  let runActive = true;
  server = http.createServer((request, response) => {
    if (!hasSessionCookie(request)) {
      json(response, 401, { error: "Rudder Account session required", code: "account_session_required" });
      return;
    }
    authenticatedPaths.push(request.url);
    if (request.url === "/api/orgs") {
      json(response, 200, [{ id: "org-smoke", name: "Update Session Smoke" }]);
      return;
    }
    if (request.url === "/api/orgs/org-smoke/live-runs") {
      json(response, 200, runActive
        ? [{ id: "run-smoke", status: "running", agentId: "agent-smoke", agentName: "Smoke Agent" }]
        : []);
      return;
    }
    if (request.url === "/api/instance/settings/browser") {
      json(response, 200, { enabled: true, openLinksIn: "built_in" });
      return;
    }
    if (request.url === "/api/instance/browser/broker") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/api/heartbeat-runs/run-smoke") {
      json(response, 200, {
        id: "run-smoke",
        orgId: "org-smoke",
        agentId: "agent-smoke",
        status: "running",
      });
      return;
    }
    if (request.url === "/api/heartbeat-runs/run-smoke/cancel" && request.method === "POST") {
      if (request.headers.origin !== baseUrl) {
        json(response, 403, { error: "Board mutation requires trusted browser origin" });
        return;
      }
      runActive = false;
      json(response, 200, { id: "run-smoke", status: "cancelled" });
      return;
    }
    json(response, 404, { error: "Not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  console.log("[update-session-smoke] fixture listening");

  const anonymousResponse = await fetch(`${baseUrl}/api/orgs`, { credentials: "include" });
  assert.equal(anonymousResponse.status, 401, "anonymous main-process fetch must reproduce the updater auth failure");
  const anonymousBrowserResponse = await fetch(`${baseUrl}/api/instance/settings/browser`, { credentials: "include" });
  assert.equal(anonymousBrowserResponse.status, 401, "anonymous main-process Browser fetch must be rejected");
  console.log("[update-session-smoke] anonymous request rejected");

  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: sessionCookieName,
    value: sessionCookieValue,
    httpOnly: true,
  });
  console.log("[update-session-smoke] session cookie installed");
  const browserApi = createDesktopBrowserApiClient(
    (input, init) => session.defaultSession.fetch(input, init),
  );
  assert.deepEqual(await browserApi.readSettings(baseUrl), { enabled: true, openLinksIn: "built_in" });
  const broker = { endpoint: "http://127.0.0.1:43123/browser", token: "b".repeat(64) };
  await browserApi.registerBroker(baseUrl, broker);
  await browserApi.unregisterBroker(baseUrl, broker.token);
  assert.equal(await browserApi.isRunActive(baseUrl, {
    orgId: "org-smoke",
    agentId: "agent-smoke",
    runId: "run-smoke",
  }), true);
  const quitFlow = createDesktopQuitFlow({
    appName: "Rudder",
    getMainWindow: () => null,
    setMainWindow: () => undefined,
    getServerHandle: () => ({ apiUrl: baseUrl, runtime: { mode: "owned" } }),
    fetchApi: (input, init) => session.defaultSession.fetch(input, init),
    stopLocalRudder: async () => undefined,
    destroyResidentTray: () => undefined,
  });

  const blockers = await quitFlow.listRunningRunsForUpdate();
  assert.equal(blockers.totalRuns, 1);
  await quitFlow.cancelActiveRunsBeforeQuit(blockers);
  assert.deepEqual(await quitFlow.listRunningRunsForUpdate(), {
    totalRuns: 0,
    organizations: [],
    blockers: [],
  });
  assert.deepEqual([...authenticatedPaths].sort(), [
    "/api/orgs",
    "/api/instance/settings/browser",
    "/api/instance/browser/broker",
    "/api/instance/browser/broker",
    "/api/heartbeat-runs/run-smoke",
    "/api/heartbeat-runs/run-smoke/cancel",
    "/api/orgs/org-smoke/live-runs",
    "/api/orgs/org-smoke/live-runs",
    "/api/orgs",
  ].sort());
  console.log("Desktop update session fetch smoke passed.");
}

async function finish() {
  if (baseUrl) {
    await session.defaultSession.cookies.remove(baseUrl, sessionCookieName).catch(() => undefined);
  }
  await closeServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  clearTimeout(watchdog);
  rmSync(userDataDir, { recursive: true, force: true });
  app.quit();
}

void run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(finish);
