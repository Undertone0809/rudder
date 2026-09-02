import type { AgentRuntimeExecutionContext } from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const servers: Server[] = [];
const cleanupDirs = new Set<string>();

async function createSkill(slug: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `rudder-hermes-${slug}-`));
  cleanupDirs.add(root);
  await fs.writeFile(path.join(root, "SKILL.md"), content, "utf8");
  return root;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function context(config: Record<string, unknown>, overrides: Partial<AgentRuntimeExecutionContext> = {}): AgentRuntimeExecutionContext {
  return {
    runId: "run-rudder-1",
    agent: {
      id: "agent-hermes-1",
      orgId: "org-hermes-1",
      name: "Hermes",
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { apiKey: "hermes-test-key", ...config },
    context: { issueId: "issue-hermes-1", wakeReason: "manual" },
    onLog: async () => {},
    ...overrides,
  };
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sessionRoute(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url === "/api/sessions" && req.method === "POST") {
    json(res, 201, { object: "hermes.session", session: { id: "hermes-session-1" } });
    return true;
  }
  if (req.url === "/api/sessions/hermes-session-1" && req.method === "GET") {
    json(res, 200, { object: "hermes.session", session: { id: "hermes-session-1" } });
    return true;
  }
  if (req.url === "/api/sessions/hermes-session-1/messages" && req.method === "GET") {
    json(res, 200, { object: "list", session_id: "hermes-session-1", data: [] });
    return true;
  }
  return false;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{ url: string; requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }>; close: () => Promise<void> }> {
  const requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
    await handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map((server) => new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })),
    ...Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  ]);
  cleanupDirs.clear();
});

describe("Hermes gateway execution", () => {
  it("injects only the selected Rudder skills and records name-only projection evidence", async () => {
    const selectedMarker = "R6Z182_SELECTED_MARKER";
    const unselectedMarker = "R6Z182_UNSELECTED_MARKER";
    const selected = await createSkill("selected", `# Selected\n\n${selectedMarker}\n`);
    const unselected = await createSkill("unselected", `# Unselected\n\n${unselectedMarker}\n`);
    const submittedInputs: string[] = [];
    const metas: unknown[] = [];
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        const body = await readJsonBody(req);
        submittedInputs.push(String(body.input ?? ""));
        return json(res, 202, { run_id: "hermes-run-skills", status: "started" });
      }
      if (req.url === "/v1/runs/hermes-run-skills/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({
      url: server.url,
      timeoutMs: 1_000,
      rudderRuntimeSkills: [
        { key: "org:org-hermes-1/selected", runtimeName: "selected", source: selected, description: selectedMarker },
        { key: "org:org-hermes-1/unselected", runtimeName: "unselected", source: unselected },
      ],
      rudderSkillSync: { desiredSkills: ["org:org-hermes-1/selected"] },
    }, { onMeta: async (meta) => { metas.push(meta); } }));

    expect(result.exitCode).toBe(0);
    expect(submittedInputs).toHaveLength(1);
    expect(submittedInputs[0]).toContain(selectedMarker);
    expect(submittedInputs[0]).not.toContain(unselectedMarker);
    expect(submittedInputs[0]).toContain("Only skills listed in this section are enabled by Rudder");
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      loadedSkills: [{ key: "org:org-hermes-1/selected", runtimeName: "selected" }],
      desiredSkills: [{ key: "org:org-hermes-1/selected", runtimeName: "selected" }],
      promptInjectedSkills: [{ key: "org:org-hermes-1/selected", runtimeName: "selected" }],
      promptMetrics: { skillCount: 1 },
    });
    expect(JSON.stringify(metas)).not.toContain(selectedMarker);
    expect(JSON.stringify(metas)).not.toContain("# Selected");
  });

  it("uses the latest full skill selection on every run without stale material", async () => {
    const marker = "R6Z182_DISABLE_MARKER";
    const selected = await createSkill("toggle", `# Toggle\n\n${marker}\n`);
    const submittedInputs: string[] = [];
    let runCounter = 0;
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        submittedInputs.push(String((await readJsonBody(req)).input ?? ""));
        runCounter += 1;
        return json(res, 202, { run_id: `hermes-run-toggle-${runCounter}`, status: "started" });
      }
      if (req.url?.startsWith("/v1/runs/hermes-run-toggle-") && req.url.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const baseConfig = {
      url: server.url,
      timeoutMs: 1_000,
      rudderRuntimeSkills: [{ key: "org:org-hermes-1/toggle", runtimeName: "toggle", source: selected }],
    };

    const enabled = await execute(context({ ...baseConfig, rudderSkillSync: { desiredSkills: ["org:org-hermes-1/toggle"] } }));
    const disabled = await execute(context({ ...baseConfig, rudderSkillSync: { desiredSkills: [] } }));

    expect(enabled.exitCode).toBe(0);
    expect(disabled.exitCode).toBe(0);
    expect(submittedInputs[0]).toContain(marker);
    expect(submittedInputs[1]).not.toContain(marker);
  });

  it.each([
    ["missing", null],
    ["empty", "   \n"],
    ["oversized", "x".repeat((128 * 1024) + 1)],
  ])("fails closed for a %s selected skill before creating a Hermes session", async (scenario, content) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `rudder-hermes-${scenario}-`));
    cleanupDirs.add(root);
    if (content !== null) await fs.writeFile(path.join(root, "SKILL.md"), content, "utf8");
    const server = await listen((_req, res) => json(res, 500, { error: "must not be called" }));

    const result = await execute(context({
      url: server.url,
      rudderRuntimeSkills: [{ key: `org:org-hermes-1/${scenario}`, runtimeName: scenario, source: root }],
      rudderSkillSync: { desiredSkills: [`org:org-hermes-1/${scenario}`] },
    }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_skill_projection_failed" });
    expect(server.requests).toEqual([]);
  });

  it("fails closed when the selected skill projection exceeds the aggregate limit", async () => {
    const runtimeSkills = [];
    const desiredSkills: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const runtimeName = `aggregate-${index}`;
      const key = `org:org-hermes-1/${runtimeName}`;
      runtimeSkills.push({
        key,
        runtimeName,
        source: await createSkill(runtimeName, "x".repeat(110 * 1024)),
      });
      desiredSkills.push(key);
    }
    const server = await listen((_req, res) => json(res, 500, { error: "must not be called" }));

    const result = await execute(context({
      url: server.url,
      rudderRuntimeSkills: runtimeSkills,
      rudderSkillSync: { desiredSkills },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "hermes_gateway_skill_projection_failed",
      errorMessage: "Selected Hermes skills exceed the 512 KiB aggregate limit.",
    });
    expect(server.requests).toEqual([]);
  });

  it("keeps skill projections isolated to the current Agent configuration", async () => {
    const alphaMarker = "R6Z182_ORG_ALPHA";
    const betaMarker = "R6Z182_ORG_BETA";
    const alpha = await createSkill("org-alpha", `# Alpha\n\n${alphaMarker}\n`);
    const beta = await createSkill("org-beta", `# Beta\n\n${betaMarker}\n`);
    const submittedInputs: string[] = [];
    let runCounter = 0;
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        submittedInputs.push(String((await readJsonBody(req)).input ?? ""));
        runCounter += 1;
        return json(res, 202, { run_id: `hermes-run-org-${runCounter}`, status: "started" });
      }
      if (req.url?.startsWith("/v1/runs/hermes-run-org-") && req.url.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    for (const [orgId, source, marker] of [["org-alpha", alpha, "alpha"], ["org-beta", beta, "beta"]] as const) {
      await execute(context({
        url: server.url,
        timeoutMs: 1_000,
        rudderRuntimeSkills: [{ key: `org:${orgId}/${marker}`, runtimeName: marker, source }],
        rudderSkillSync: { desiredSkills: [`org:${orgId}/${marker}`] },
      }, { agent: { id: `agent-${marker}`, orgId, name: marker, agentRuntimeType: "hermes_gateway", agentRuntimeConfig: {} } }));
    }

    expect(submittedInputs[0]).toContain(alphaMarker);
    expect(submittedInputs[0]).not.toContain(betaMarker);
    expect(submittedInputs[1]).toContain(betaMarker);
    expect(submittedInputs[1]).not.toContain(alphaMarker);
  });

  it("maps an SSE terminal completion without polling into a timeout", async () => {
    const server = await listen((req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-1", status: "started" });
      if (req.url === "/v1/runs/hermes-run-1/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          `data: ${JSON.stringify({ event: "message.delta", delta: "hello" })}\n\n`,
          `data: ${JSON.stringify({ event: "message.delta", delta: " from Hermes" })}\n\n`,
          `data: ${JSON.stringify({ event: "run.completed", output: "hello from Hermes", usage: { input_tokens: 3, output_tokens: 4 } })}\n\n`,
        ].join(""));
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({ url: server.url, apiKey: "hermes-test-key", timeoutMs: 2_000 }));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("hello from Hermes");
    expect(result.resultJson).toMatchObject({ upstreamRunId: "hermes-run-1", status: "completed", output: "hello from Hermes" });
    expect((result.resultJson as { synthetic_tool_continuity: Record<string, unknown> }).synthetic_tool_continuity).toMatchObject({ native: false, lossless: false, eventCount: 3 });
    expect(server.requests.map((request) => request.path)).toEqual([
      "/api/sessions",
      "/api/sessions/hermes-session-1/messages",
      "/v1/runs",
      "/v1/runs/hermes-run-1/events",
    ]);
    expect(server.requests[0]?.headers.authorization).toBe("Bearer hermes-test-key");
  });

  it("returns an upstream failed terminal event as a run failure, not a timeout", async () => {
    const server = await listen((req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-failed", status: "started" });
      if (req.url === "/v1/runs/hermes-run-failed/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "run.failed", error: "provider unavailable" })}\n\n`);
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({ url: server.url, timeoutMs: 2_000 }));

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("provider unavailable");
    expect(result.resultJson).toMatchObject({ upstreamRunId: "hermes-run-failed", status: "failed" });
  });

  it("marks a terminal status reconciled after an incomplete SSE stream as partial", async () => {
    const server = await listen((req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-partial", status: "started" });
      if (req.url === "/v1/runs/hermes-run-partial/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "message.delta", delta: "prefix" })}\n\n`);
        return;
      }
      if (req.url === "/v1/runs/hermes-run-partial" && req.method === "GET") return json(res, 200, { run_id: "hermes-run-partial", status: "completed", output: "complete" });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({ url: server.url, timeoutMs: 1_000 }));

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      eventCompleteness: {
        status: "partial",
        terminalEventObserved: false,
      },
    });
  });

  it("reuses only a provider session returned by the Sessions API", async () => {
    const server = await listen((req, res) => {
      if (req.url === "/api/sessions/hermes-session-existing" && req.method === "GET") {
        return json(res, 200, { object: "hermes.session", session: { id: "hermes-session-existing" } });
      }
      if (req.url === "/api/sessions/hermes-session-existing/messages" && req.method === "GET") {
        return json(res, 200, { object: "list", session_id: "hermes-session-existing", data: [{ role: "user" }] });
      }
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-existing", status: "started" });
      if (req.url === "/v1/runs/hermes-run-existing/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context(
      { url: server.url, timeoutMs: 1_000 },
      { runtime: { sessionId: "hermes-session-existing", sessionParams: { sessionId: "hermes-session-existing" }, sessionDisplayId: "hermes-session-existing", taskKey: null } },
    ));

    expect(result.exitCode).toBe(0);
    expect(server.requests.map((request) => request.path)).toEqual([
      "/api/sessions/hermes-session-existing",
      "/api/sessions/hermes-session-existing/messages",
      "/v1/runs",
      "/v1/runs/hermes-run-existing/events",
    ]);
  });

  it("reconciles an SSE timeout and requests upstream stop", async () => {
    const server = await listen((req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-timeout", status: "started" });
      if (req.url === "/v1/runs/hermes-run-timeout/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      if (req.url === "/v1/runs/hermes-run-timeout/stop" && req.method === "POST") return json(res, 200, { run_id: "hermes-run-timeout", status: "stopping" });
      if (req.url === "/v1/runs/hermes-run-timeout" && req.method === "GET") return json(res, 200, { run_id: "hermes-run-timeout", status: "running" });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({ url: server.url, timeoutMs: 80 }));

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("hermes_gateway_cancel_unverified");
    expect(server.requests.some((request) => request.path.endsWith("/stop"))).toBe(true);
  }, 5_000);

  it("stops upstream when the Rudder abort signal is triggered", async () => {
    const server = await listen((req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-abort", status: "started" });
      if (req.url === "/v1/runs/hermes-run-abort/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      if (req.url === "/v1/runs/hermes-run-abort/stop" && req.method === "POST") return json(res, 200, { run_id: "hermes-run-abort", status: "stopping" });
      if (req.url === "/v1/runs/hermes-run-abort" && req.method === "GET") return json(res, 200, { run_id: "hermes-run-abort", status: "cancelled" });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await execute(context({ url: server.url, timeoutMs: 120 }, { abortSignal: controller.signal }));

    expect(result.exitCode).toBe(1);
    expect(result.signal).toBe("SIGTERM");
    expect(result.errorCode).toBe("hermes_gateway_stopped");
    expect(server.requests.some((request) => request.path.endsWith("/stop"))).toBe(true);
  }, 5_000);
});

describe("Hermes gateway environment probe", () => {
  it("checks health, capabilities, and model discovery on the public API", async () => {
    const server = await listen((req, res) => {
      if (req.url === "/health") return json(res, 200, { version: "0.18.2" });
      if (req.url === "/health/detailed") return json(res, 200, { status: "ready", runtime: { mode: "server_agent" } });
      if (req.url === "/v1/capabilities") return json(res, 200, {
        runtime: { tool_execution: "server" },
        features: {
          run_submission: true,
          run_status: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          session_resources: true,
        },
        endpoints: {
          runs: { method: "POST", path: "/v1/runs" },
          run_status: { method: "GET", path: "/v1/runs/{run_id}" },
          run_events: { method: "GET", path: "/v1/runs/{run_id}/events" },
          run_approval: { method: "POST", path: "/v1/runs/{run_id}/approval" },
          run_stop: { method: "POST", path: "/v1/runs/{run_id}/stop" },
          sessions: { method: "GET", path: "/api/sessions" },
          session_create: { method: "POST", path: "/api/sessions" },
          session: { method: "GET", path: "/api/sessions/{session_id}" },
          session_messages: { method: "GET", path: "/api/sessions/{session_id}/messages" },
        },
      });
      if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "hermes-agent" }] });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await testEnvironment({ orgId: "org-hermes-1", agentRuntimeType: "hermes_gateway", config: { url: server.url, apiKey: "hermes-test-key" } });

    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toEqual([
      "hermes_gateway_url_valid",
      "hermes_gateway_health_ok",
      "hermes_gateway_health_detailed_ok",
      "hermes_gateway_capabilities_ok",
      "hermes_gateway_models_ok",
    ]);
  });
});
