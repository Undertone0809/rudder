#!/usr/bin/env node

/**
 * Black-box check for the Kitchen Sink HTTP tool.
 *
 * The Rudder server must already be running with the fixture origin in
 * RUDDER_PLUGIN_HTTP_ALLOWLIST. The script starts only the disposable target
 * fixture, configures the local plugin for that target, invokes the public
 * tool-dispatch route, and checks the POST received by the fixture.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scriptDir, "../packages/plugins/examples/plugin-kitchen-sink-example/fixtures/http-post-fixture.mjs");
const apiBase = (process.env.RUDDER_GOAL_HTTP_API ?? "http://127.0.0.1:3100/api").replace(/\/$/, "");
const pluginId = "rudder-kitchen-sink-example";
const message = process.env.RUDDER_GOAL_HTTP_MESSAGE ?? `goal-http-blackbox-${Date.now()}`;
const runId = process.env.RUDDER_GOAL_HTTP_RUN_ID ?? "88888888-8888-4888-8888-888888888888";
const fixturePort = process.env.RUDDER_GOAL_HTTP_FIXTURE_PORT ?? "4311";

async function requestJson(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function waitForListening(child) {
  return new Promise((resolveListening, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += String(chunk);
      const match = output.match(/PLUGIN_HTTP_FIXTURE_LISTENING (\d+)/);
      if (match?.[1]) {
        child.stdout.off("data", onData);
        resolveListening(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null) reject(new Error(`HTTP fixture exited before listening (code ${code}): ${output}`));
    });
  });
}

async function waitForRequest(logPath, predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const lines = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
      const match = lines.map((line) => JSON.parse(line)).find(predicate);
      if (match) return match;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for POST ${runId} in ${logPath}`);
}

function firstRecord(value) {
  return Array.isArray(value) ? value[0] : null;
}

const tempDir = await mkdtemp(join(tmpdir(), "rudder-goal-plugin-http-"));
const logPath = join(tempDir, "requests.jsonl");
const fixture = spawn(process.execPath, [fixturePath], {
  env: {
    ...process.env,
    RUDDER_PLUGIN_HTTP_FIXTURE_PORT: fixturePort,
    RUDDER_PLUGIN_HTTP_FIXTURE_LOG: logPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let originalConfig = null;
try {
  const listeningPort = await waitForListening(fixture);
  const targetUrl = `http://127.0.0.1:${listeningPort}/plugin-http`;
  const health = await requestJson("/health");
  const organizations = await requestJson("/orgs");
  const orgId = process.env.RUDDER_GOAL_HTTP_ORG_ID ?? firstRecord(organizations)?.id;
  if (!orgId) throw new Error("No organization found; set RUDDER_GOAL_HTTP_ORG_ID");

  const agents = await requestJson(`/orgs/${encodeURIComponent(orgId)}/agents`);
  const projects = await requestJson(`/orgs/${encodeURIComponent(orgId)}/projects`);
  const agentId = process.env.RUDDER_GOAL_HTTP_AGENT_ID
    ?? agents.find((agent) => !["terminated", "pending_approval"].includes(agent.status))?.id;
  const projectId = process.env.RUDDER_GOAL_HTTP_PROJECT_ID ?? firstRecord(projects)?.id;
  if (!agentId || !projectId) throw new Error("No invokable Agent or Project found; set RUDDER_GOAL_HTTP_AGENT_ID and RUDDER_GOAL_HTTP_PROJECT_ID");

  const current = await requestJson(`/plugins/${pluginId}/config`);
  originalConfig = current?.configJson ?? {};
  await requestJson(`/plugins/${pluginId}/config`, {
    method: "POST",
    body: JSON.stringify({ configJson: { ...originalConfig, httpDemoUrl: targetUrl } }),
  });

  const tools = await requestJson(`/plugins/tools?pluginId=${encodeURIComponent(pluginId)}`);
  const tool = tools.find((entry) => entry.name === `${pluginId}:http-post` || entry.toolName === "http-post");
  if (!tool) throw new Error("Kitchen Sink HTTP tool is not registered");

  const result = await requestJson("/plugins/tools/execute", {
    method: "POST",
    body: JSON.stringify({
      tool: `${pluginId}:http-post`,
      parameters: { message },
      runContext: { agentId, runId, orgId, projectId },
    }),
  });
  const received = await waitForRequest(logPath, (entry) => entry.method === "POST" && entry.url === "/plugin-http");
  const receivedBody = JSON.parse(received.body);
  if (receivedBody.message !== message || receivedBody.runId !== runId || receivedBody.orgId !== orgId) {
    throw new Error(`Fixture received an unexpected body: ${JSON.stringify(receivedBody)}`);
  }
  if (result?.result?.data?.status !== 200) throw new Error(`Plugin tool returned an unexpected result: ${JSON.stringify(result)}`);

  process.stdout.write(`${JSON.stringify({
    verdict: "PASS",
    health,
    orgId,
    agentId,
    projectId,
    tool: `${pluginId}:http-post`,
    fixture: received,
    result,
    logPath,
  }, null, 2)}\n`);
} finally {
  if (originalConfig) {
    try {
      await requestJson(`/plugins/${pluginId}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: originalConfig }),
      });
    } catch (error) {
      process.stderr.write(`Failed to restore plugin config: ${error}\n`);
    }
  }
  fixture.kill("SIGTERM");
  await new Promise((resolveExit) => fixture.once("exit", resolveExit));
  await rm(tempDir, { recursive: true, force: true });
}
