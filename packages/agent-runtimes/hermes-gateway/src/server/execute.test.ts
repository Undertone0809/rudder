import type { AgentRuntimeControlHandle, AgentRuntimeExecutionContext, AgentRuntimeInvocationMeta } from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute, supportsLocalAgentJwtForContext } from "./execute.js";
import { testEnvironment } from "./test.js";

const servers: Server[] = [];
const cleanupDirs = new Set<string>();
const ACP_TIMEOUT_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (process.env.HERMES_STALL_METHOD === message.method) continue;
      send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true }, ...(process.env.HERMES_STALL_METHOD === "authenticate" ? { authMethods: [{ id: "hermes-test-auth" }] } : {}) } });
    } else if (message.method === "authenticate") {
      if (process.env.HERMES_STALL_METHOD !== message.method) send({ id: message.id, result: {} });
    } else if (message.method === "session/new") {
      send({ id: message.id, result: { sessionId: "execute-hermes-timeout-session" } });
    } else if (message.method === "session/load") {
      if (process.env.HERMES_STALL_METHOD !== message.method) send({ id: message.id, result: { sessionId: message.params.sessionId } });
    } else if (message.method === "session/prompt") {
      if (process.env.HERMES_STALL_METHOD === message.method) continue;
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native timeout fixture result" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.method === "session/cancel") {
      process.stderr.write("session cancel received\n");
    }
  }
});
`;

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

describe("Hermes local Run credential gate", () => {
  const productRpcConfig = {
    hermesPythonCommand: "/opt/hermes/python",
    hermesSourcePath: "/opt/hermes/source",
    hermesHome: "/tmp/hermes-profile",
    hermesProviderVersion: "0.21.0",
    hermesChatBackend: "native_product_rpc",
  };

  it("allows a Rudder JWT only for local Product RPC Chat, not HTTP or ACP", () => {
    expect(supportsLocalAgentJwtForContext(context(productRpcConfig, {
      context: { chatMode: true, chatConversationId: "chat-local-product-rpc" },
    }))).toBe(true);
    expect(supportsLocalAgentJwtForContext(context({
      ...productRpcConfig,
      hermesChatBackend: "native_runs_http",
      url: "http://127.0.0.1:8642",
    }, {
      context: { chatMode: true, chatConversationId: "chat-remote-http" },
    }))).toBe(false);
    expect(supportsLocalAgentJwtForContext(context({ ...productRpcConfig, hermesChatBackend: "acp" }, {
      context: { chatMode: true, chatConversationId: "chat-acp" },
    }))).toBe(false);
    expect(supportsLocalAgentJwtForContext(context(productRpcConfig))).toBe(false);
  });
});

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

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>): Promise<{ url: string; requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }>; close: () => Promise<void> }> {
  const requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
    if (req.url === "/v1/capabilities" && req.method === "GET") {
      try {
        await handler(req, res);
      } catch (error) {
        if (!res.writableEnded) {
          return json(res, 200, { features: { runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 } } });
        }
        throw error;
      }
      if (!res.writableEnded) {
        return json(res, 200, { features: { runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 } } });
      }
      return;
    }
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

type HermesRunSteerScenario = {
  advertised?: boolean;
  steerStatus?: number;
  steerBody?: Record<string, unknown>;
  disconnectSteer?: boolean;
  stopBeforeSteer?: boolean;
  includeMedia?: boolean;
};

async function executeRunSteerScenario(options: HermesRunSteerScenario = {}) {
  let resolveHandle!: (handle: AgentRuntimeControlHandle) => void;
  let resolveEvents!: (response: ServerResponse) => void;
  let stopped = false;
  const handleReady = new Promise<AgentRuntimeControlHandle>((resolve) => { resolveHandle = resolve; });
  const eventsReady = new Promise<ServerResponse>((resolve) => { resolveEvents = resolve; });
  const steerBodies: Record<string, unknown>[] = [];
  const server = await listen(async (req, res) => {
    if (sessionRoute(req, res)) return;
    if (req.url === "/v1/capabilities") {
      return json(res, 200, {
        features: {
          runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 },
          run_steer: options.advertised === true,
        },
        endpoints: options.advertised === true
          ? { run_steer: { method: "POST", path: "/v1/runs/{run_id}/steer" } }
          : {},
      });
    }
    if (req.url === "/v1/runs" && req.method === "POST") {
      await readJsonBody(req);
      return json(res, 202, { run_id: "hermes-run-steer", status: "started" });
    }
    if (req.url === "/v1/runs/hermes-run-steer/events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      resolveEvents(res);
      return;
    }
    if (req.url === "/v1/runs/hermes-run-steer/stop" && req.method === "POST") {
      stopped = true;
      await readJsonBody(req);
      return json(res, 200, { run_id: "hermes-run-steer", status: "stopped" });
    }
    if (req.url === "/v1/runs/hermes-run-steer/steer" && req.method === "POST") {
      steerBodies.push(await readJsonBody(req));
      if (options.disconnectSteer) {
        req.socket.destroy();
        return;
      }
      const status = options.steerStatus ?? (stopped ? 409 : 200);
      const body = options.steerBody ?? (status >= 400
        ? { run_id: "hermes-run-steer", accepted: false }
        : { object: "hermes.run.steer", run_id: "hermes-run-steer", accepted: true });
      return json(res, status, body);
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });

  const executionPromise = execute(context({ url: server.url, hermesChatBackend: "native_runs_http" }, {
    context: { chatMode: true, chatConversationId: "chat-hermes-steer", chatPrompt: "initial prompt" },
    controlAttempt: {
      attemptEpoch: 1,
      ownerToken: "owner-hermes-steer",
      async register(handle) {
        resolveHandle(handle);
        return { isCurrent: () => true, release: async () => {} };
      },
      async complete() {},
    },
  }));
  const handle = await handleReady;
  const eventsResponse = await eventsReady;
  const interruptResult = options.stopBeforeSteer
    ? await handle.interrupt("operator_stop")
    : null;
  const result = await handle.steer({
    text: "focus on the failing tests",
    clientMessageId: "chat-steer-message-1",
    ...(options.includeMedia ? {
      media: [{
        source: "chat_attachment" as const,
        attachmentId: "attachment-1",
        assetId: "asset-1",
        name: "screenshot.png",
        originalFilename: "screenshot.png",
        contentType: "image/png",
        byteSize: 10,
        localPath: "/tmp/screenshot.png",
      }],
    } : {}),
  });
  eventsResponse?.end(`data: ${JSON.stringify({ event: "run.completed", output: "done" })}\n\n`);
  const execution = await executionPromise;
  return { handle, interruptResult, result, execution, requests: server.requests, steerBodies };
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
  it("refuses run submission when the API does not promise durable idempotency", async () => {
    const server = await listen((req, res) => {
      if (req.url === "/v1/capabilities") {
        return json(res, 200, { features: { runs_idempotency: { supported: true, durable: false, retention_seconds: 86_400 } } });
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({ url: server.url }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_idempotency_unavailable" });
    expect(result.resultJson).toMatchObject({ runSubmission: { supported: true, durable: false, submitted: false } });
    expect(server.requests.map((request) => request.path)).toEqual(["/v1/capabilities"]);
  });

  it("registers and forwards native steer only when the authenticated gateway advertises its exact endpoint", async () => {
    const scenario = await executeRunSteerScenario({ advertised: true });

    expect(scenario.handle.capabilities.steer).toBe("native");
    expect(scenario.result).toEqual({
      disposition: "accepted_current",
      providerThreadId: "hermes-session-1",
      providerTurnId: "hermes-run-steer",
    });
    expect(scenario.steerBodies).toEqual([{ input: "focus on the failing tests" }]);
    expect(scenario.requests.filter((request) => request.path.endsWith("/steer"))).toHaveLength(1);
    expect(scenario.execution.sessionParams).toMatchObject({ hermesRunSteerAdvertised: true });
  });

  it("keeps native steer disabled when the gateway does not advertise it", async () => {
    const scenario = await executeRunSteerScenario({ advertised: false });

    expect(scenario.handle.capabilities.steer).toBe("interrupt_continue");
    expect(scenario.result).toMatchObject({ disposition: "unsupported" });
    expect(scenario.steerBodies).toEqual([]);
    expect(scenario.execution.sessionParams).toMatchObject({ hermesRunSteerAdvertised: false });
  });

  it("treats a post-Stop 409 as an explicit rejection, not an accepted steer", async () => {
    const scenario = await executeRunSteerScenario({ advertised: true, stopBeforeSteer: true });

    expect(scenario.interruptResult).toBe("acknowledged");
    expect(scenario.result).toMatchObject({
      disposition: "rejected",
      reason: expect.stringContaining("HTTP 409"),
    });
    expect(scenario.steerBodies).toEqual([{ input: "focus on the failing tests" }]);
    expect(scenario.requests.filter((request) => request.path.endsWith("/steer"))).toHaveLength(1);
  });

  it("does not report a mismatched steer acknowledgement as accepted", async () => {
    const scenario = await executeRunSteerScenario({
      advertised: true,
      steerBody: { object: "hermes.run.steer", run_id: "another-run", accepted: true },
    });

    expect(scenario.result).toMatchObject({
      disposition: "acceptance_unknown",
      providerTurnId: "hermes-run-steer",
    });
    expect(scenario.requests.filter((request) => request.path.endsWith("/steer"))).toHaveLength(1);
  });

  it("does not resend a steer whose transport response is lost", async () => {
    const scenario = await executeRunSteerScenario({ advertised: true, disconnectSteer: true });

    expect(scenario.result).toMatchObject({
      disposition: "acceptance_unknown",
      reason: expect.stringContaining("do not resend automatically"),
    });
    expect(scenario.steerBodies).toEqual([{ input: "focus on the failing tests" }]);
    expect(scenario.requests.filter((request) => request.path.endsWith("/steer"))).toHaveLength(1);
  });

  it.each([400, 409])("keeps HTTP %s steer rejection explicit", async (status) => {
    const scenario = await executeRunSteerScenario({ advertised: true, steerStatus: status });

    expect(scenario.result).toMatchObject({
      disposition: "rejected",
      reason: expect.stringContaining(`HTTP ${status}`),
    });
    expect(scenario.requests.filter((request) => request.path.endsWith("/steer"))).toHaveLength(1);
  });

  it("preserves an explicit negative acknowledgement as a provider rejection", async () => {
    const scenario = await executeRunSteerScenario({
      advertised: true,
      steerBody: { object: "hermes.run.steer", run_id: "hermes-run-steer", accepted: false },
    });

    expect(scenario.result).toMatchObject({
      disposition: "rejected",
      providerTurnId: "hermes-run-steer",
      reason: expect.stringContaining("explicitly declined"),
    });
    expect(scenario.requests.filter((request) => request.path.endsWith("/steer"))).toHaveLength(1);
  });

  it("does not silently drop media that the steer endpoint cannot accept", async () => {
    const scenario = await executeRunSteerScenario({ advertised: true, includeMedia: true });

    expect(scenario.result).toMatchObject({ disposition: "unsupported", reason: expect.stringContaining("text only") });
    expect(scenario.steerBodies).toEqual([]);
  });

  it("uses the formal Idempotency-Key header and replays the original run for the same payload", async () => {
    const accepted = new Map<string, { body: string; runId: string }>();
    const submissions: Array<{ key: string | undefined; body: Record<string, unknown>; replayed: boolean }> = [];
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        const body = await readJsonBody(req);
        if (typeof key !== "string") return json(res, 400, { code: "invalid_idempotency_key" });
        const fingerprint = JSON.stringify(body);
        const previous = accepted.get(key);
        if (previous && previous.body !== fingerprint) return json(res, 409, { code: "idempotency_key_conflict" });
        const record = previous ?? { body: fingerprint, runId: "hermes-run-idempotent" };
        accepted.set(key, record);
        submissions.push({ key, body, replayed: Boolean(previous) });
        return json(res, 202, { run_id: record.runId, status: "started", replayed: Boolean(previous) });
      }
      if (req.url === "/v1/runs/hermes-run-idempotent/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const first = await execute(context({ url: server.url, hermesChatBackend: "native_runs_http" }, {
      context: { chatMode: true, chatConversationId: "chat-hermes-idempotency", chatPrompt: "same prompt" },
    }));
    const replay = await execute(context({ url: server.url, hermesChatBackend: "native_runs_http" }, {
      context: { chatMode: true, chatConversationId: "chat-hermes-idempotency", chatPrompt: "same prompt" },
    }));

    expect(first.exitCode).toBe(0);
    expect(replay.exitCode).toBe(0);
    expect((replay.resultJson as Record<string, unknown>).runSubmission).toMatchObject({
      acceptance: "accepted",
      idempotencyKey: "run-rudder-1",
      replayed: true,
    });
    expect(submissions).toHaveLength(2);
    expect(submissions.map(({ key }) => key)).toEqual(["run-rudder-1", "run-rudder-1"]);
    expect(submissions.every(({ body }) => !Object.hasOwn(body, "idempotency_key"))).toBe(true);
  });

  it("fails a changed payload with the provider's idempotency conflict", async () => {
    let acceptedBody: string | null = null;
    let runCount = 0;
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        if (req.headers["idempotency-key"] !== "run-rudder-1") return json(res, 400, { code: "invalid_idempotency_key" });
        const body = JSON.stringify(await readJsonBody(req));
        if (acceptedBody !== null && acceptedBody !== body) return json(res, 409, { code: "idempotency_key_conflict" });
        acceptedBody = body;
        runCount += 1;
        return json(res, 202, { run_id: "hermes-run-conflict", status: "started" });
      }
      if (req.url === "/v1/runs/hermes-run-conflict/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const first = await execute(context({ url: server.url, hermesChatBackend: "native_runs_http" }, {
      context: { chatMode: true, chatConversationId: "chat-hermes-conflict", chatPrompt: "original prompt" },
    }));
    const conflict = await execute(context({ url: server.url, hermesChatBackend: "native_runs_http" }, {
      context: { chatMode: true, chatConversationId: "chat-hermes-conflict", chatPrompt: "changed prompt" },
    }));

    expect(first.exitCode).toBe(0);
    expect(conflict).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_idempotency_conflict" });
    expect(runCount).toBe(1);
  });

  it("reconciles ambiguous acceptance with the same durable key after a gateway restart", async () => {
    const durableRecords = new Map<string, { body: string; runId: string }>();
    const firstGateway = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        const body = JSON.stringify(await readJsonBody(req));
        if (typeof key !== "string") throw new Error("missing formal idempotency header");
        durableRecords.set(key, { body, runId: "hermes-run-before-restart" });
        res.destroy();
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const first = await execute(context({ url: firstGateway.url, timeoutMs: 500 }));
    await firstGateway.close();

    const replayedKeys: string[] = [];
    const restartedGateway = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        const body = JSON.stringify(await readJsonBody(req));
        if (typeof key !== "string") return json(res, 400, { code: "invalid_idempotency_key" });
        const previous = durableRecords.get(key);
        if (!previous) return json(res, 500, { code: "durable_reservation_lost" });
        if (previous.body !== body) return json(res, 409, { code: "idempotency_key_conflict" });
        replayedKeys.push(key);
        return json(res, 202, { run_id: previous.runId, status: "started", replayed: true });
      }
      if (req.url === "/v1/runs/hermes-run-before-restart/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`data: ${JSON.stringify({ event: "run.completed", output: "reconciled" })}\n\n`);
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const reconciled = await execute(context({ url: restartedGateway.url, timeoutMs: 1_000 }));

    expect(first).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_submission_indeterminate" });
    expect(first.resultJson).toMatchObject({ runSubmission: {
      acceptance: "unknown",
      idempotencyKey: "run-rudder-1",
      durableReplay: true,
      independentResubmissionAllowed: false,
    } });
    expect(reconciled.exitCode).toBe(0);
    expect(replayedKeys).toEqual(["run-rudder-1"]);
    expect((reconciled.resultJson as Record<string, unknown>).runSubmission).toMatchObject({ replayed: true });
  });

  it("uses ACP for chat without requiring the legacy HTTP gateway and returns a native session", async () => {
    const mockAcp = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "execute-hermes-session" } });
    else if (message.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native execute result" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
    const pids: number[] = [];
    const result = await execute(context({
      hermesChatBackend: "acp",
      command: process.execPath,
      args: ["-e", mockAcp],
      providerHostId: "host-hermes-execute",
      providerProfileId: "profile-hermes-execute",
      hermesProviderVersion: "0.21.0",
      timeoutMs: 2_000,
    }, {
      context: { chatMode: true, chatPrompt: "native chat prompt" },
      onSpawn: async ({ pid }) => { pids.push(pid); },
    }));

    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "execute-hermes-session",
      resultJson: { nativeSession: true, transport: "hermes-acp-stdio", profileId: "profile-hermes-execute" },
    });
    expect(result.summary).toBe("native execute result");
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0], 0)).toThrow();
  });

  it("preserves an initialize timeout on resume without cancelling before the handshake", async () => {
    const baseConfig = { hermesChatBackend: "acp", command: process.execPath, args: ["-e", ACP_TIMEOUT_MOCK] };
    const seed = await execute(context({ ...baseConfig, timeoutMs: 1_000 }, {
      context: { chatMode: true, chatPrompt: "create resumable session" },
    }));
    expect(seed.sessionId).toBe("execute-hermes-timeout-session");
    expect(seed.sessionParams).toBeTruthy();

    const pids: number[] = [];
    const logs: string[] = [];
    const result = await execute(context({
      ...baseConfig,
      env: { HERMES_STALL_METHOD: "initialize" },
      timeoutMs: 250,
    }, {
      runtime: {
        sessionId: seed.sessionId!,
        sessionParams: seed.sessionParams!,
        sessionDisplayId: seed.sessionDisplayId!,
        taskKey: null,
      },
      context: { chatMode: true, chatPrompt: "initialize stalled" },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      onSpawn: async ({ pid }) => { pids.push(pid); },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true,
      errorCode: "hermes_native_timeout",
      sessionId: seed.sessionId,
      resultJson: { timeout: { code: "HERMES_ACP_RPC_TIMEOUT", method: "initialize", timeoutMs: 250 } },
    });
    expect(result.sessionParams).toEqual(seed.sessionParams);
    expect(result.errorMessage).toContain("initialize timed out");
    expect(logs.join("\n")).not.toContain("Hermes ACP cancel requested");
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });

  it("preserves an authenticate RPC timeout and reaps the child before a session exists", async () => {
    const pids: number[] = [];
    const logs: string[] = [];
    const result = await execute(context({
      hermesChatBackend: "acp",
      command: process.execPath,
      args: ["-e", ACP_TIMEOUT_MOCK],
      env: { HERMES_STALL_METHOD: "authenticate" },
      hermesAcpAuthMethodId: "hermes-test-auth",
      timeoutMs: 250,
    }, {
      context: { chatMode: true, chatPrompt: "authenticate stalled" },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      onSpawn: async ({ pid }) => { pids.push(pid); },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true,
      errorCode: "hermes_native_timeout",
      sessionId: null,
      resultJson: { timeout: { code: "HERMES_ACP_RPC_TIMEOUT", method: "authenticate", timeoutMs: 250 } },
    });
    expect(result.errorMessage).toContain("authenticate timed out");
    expect(logs.join("\n")).not.toContain("Hermes ACP cancel requested");
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });

  it("maps a stalled ACP prompt to a timeout terminal and cancels and reaps its child", async () => {
    const pids: number[] = [];
    const logs: string[] = [];
    const result = await execute(context({
      hermesChatBackend: "acp",
      command: process.execPath,
      args: ["-e", ACP_TIMEOUT_MOCK],
      env: { HERMES_STALL_METHOD: "session/prompt" },
      providerHostId: "host-hermes-prompt-timeout",
      providerProfileId: "profile-hermes-prompt-timeout",
      hermesProviderVersion: "0.21.0",
      timeoutMs: 250,
    }, {
      context: { chatMode: true, chatPrompt: "stalled prompt" },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      onSpawn: async ({ pid }) => { pids.push(pid); },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true,
      errorCode: "hermes_native_timeout",
      sessionId: "execute-hermes-timeout-session",
      resultJson: { timeout: { code: "HERMES_ACP_RPC_TIMEOUT", method: "session/prompt", timeoutMs: 250 } },
    });
    expect(result.sessionParams).toMatchObject({ sessionId: "execute-hermes-timeout-session", transport: "hermes-acp-stdio" });
    expect(logs.join("\n")).toContain("Hermes ACP cancel requested session=execute-hermes-timeout-session");
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });

  it("maps a stalled ACP session/load to a timeout terminal and cancels and reaps its child", async () => {
    const baseConfig = {
      hermesChatBackend: "acp",
      command: process.execPath,
      args: ["-e", ACP_TIMEOUT_MOCK],
      providerHostId: "host-hermes-load-timeout",
      providerProfileId: "profile-hermes-load-timeout",
      hermesProviderVersion: "0.21.0",
    };
    const seed = await execute(context({ ...baseConfig, timeoutMs: 1_000 }, {
      context: { chatMode: true, chatPrompt: "create resumable session" },
    }));
    expect(seed.sessionId).toBe("execute-hermes-timeout-session");
    expect(seed.sessionParams).toBeTruthy();

    const pids: number[] = [];
    const logs: string[] = [];
    const result = await execute(context({
      ...baseConfig,
      env: { HERMES_STALL_METHOD: "session/load" },
      timeoutMs: 250,
    }, {
      runtime: {
        sessionId: seed.sessionId!,
        sessionParams: seed.sessionParams!,
        sessionDisplayId: seed.sessionDisplayId!,
        taskKey: null,
      },
      context: { chatMode: true, chatPrompt: "resume stalled session" },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      onSpawn: async ({ pid }) => { pids.push(pid); },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true,
      errorCode: "hermes_native_timeout",
      sessionId: seed.sessionId,
      resultJson: { timeout: { code: "HERMES_ACP_RPC_TIMEOUT", method: "session/load", timeoutMs: 250 } },
    });
    expect(result.sessionParams).toEqual(seed.sessionParams);
    expect(logs.join("\n")).toContain(`Hermes ACP cancel requested session=${seed.sessionId}`);
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });

  it("propagates a Hermes ACP subscription 403 as a failed Rudder execution", async () => {
    const mockAcp = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "execute-hermes-session-http-403" } });
    else if (message.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "error", error: { code: "non_retryable_client_error", status: 403, message: "subscription required" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
    const result = await execute(context({
      hermesChatBackend: "acp",
      command: process.execPath,
      args: ["-e", mockAcp],
      providerHostId: "host-hermes-http-403",
      providerProfileId: "profile-hermes-http-403",
      hermesProviderVersion: "0.21.0",
      timeoutMs: 2_000,
    }, {
      context: { chatMode: true, chatPrompt: "native chat prompt" },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "hermes_native_provider_error",
      sessionId: "execute-hermes-session-http-403",
      resultJson: { nativeSession: true, providerError: true, providerHttpStatus: 403 },
    });
  });

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
      prompt: submittedInputs[0],
      agentInstructionStack: submittedInputs[0],
      promptMetrics: { skillCount: 1 },
    });
    expect(JSON.stringify(metas)).toContain(selectedMarker);
    expect(JSON.stringify(metas)).not.toContain(unselectedMarker);
  });

  it("records the exact API prompt in invocation metadata without logging it", async () => {
    const prompt = "Submitted API prompt: exact text\nwith a second line.";
    const submittedInputs: string[] = [];
    const metas: AgentRuntimeInvocationMeta[] = [];
    const logs: string[] = [];
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        submittedInputs.push(String((await readJsonBody(req)).input ?? ""));
        return json(res, 202, { run_id: "hermes-run-prompt-snapshot", status: "started" });
      }
      if (req.url === "/v1/runs/hermes-run-prompt-snapshot/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({
      url: server.url,
      hermesChatBackend: "native_runs_http",
      timeoutMs: 1_000,
    }, {
      context: { chatMode: true, chatConversationId: "chat-hermes-prompt-snapshot", chatPrompt: prompt },
      onMeta: async (meta) => { metas.push(meta); },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    }));

    expect(result.exitCode).toBe(0);
    expect(submittedInputs).toEqual([prompt]);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ prompt: submittedInputs[0], agentInstructionStack: submittedInputs[0] });
    expect(logs.join("\n")).not.toContain(prompt);
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
    expect(result.resultJson).toMatchObject({
      continuity: {
        mode: "hermes_http_session",
        native: true,
        lossless: false,
        inputPolicy: "current_turn_only",
        priorToolContextInjected: false,
      },
    });
    expect(result.resultJson).not.toHaveProperty("synthetic_tool_continuity");
    expect(result).toMatchObject({ sessionId: "hermes-session-1", sessionDisplayId: "hermes-session-1" });
    expect(server.requests.map((request) => request.path)).toEqual([
      "/v1/capabilities",
      "/api/sessions",
      "/api/sessions/hermes-session-1/messages",
      "/v1/runs",
      "/v1/runs/hermes-run-1/events",
    ]);
    expect(server.requests[0]?.headers.authorization).toBe("Bearer hermes-test-key");
  });

  it("releases a Hermes session writer at provider completion so the next run can reuse the session", async () => {
    let runCount = 0;
    let providerTurnLeaseHeld = false;
    const submittedSessionIds: string[] = [];
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (providerTurnLeaseHeld) return json(res, 409, { code: "session_turn_already_active" });
        providerTurnLeaseHeld = true;
        submittedSessionIds.push(String(body.session_id ?? ""));
        runCount += 1;
        return json(res, 202, { run_id: `hermes-run-session-lease-${runCount}`, status: "started" });
      }
      if (/^\/v1\/runs\/hermes-run-session-lease-\d+\/events$/.test(req.url ?? "")) {
        // Hermes publishes run.completed only after run_conversation has released its turn lease.
        providerTurnLeaseHeld = false;
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const runtime = {
      sessionId: "hermes-session-1",
      sessionParams: { sessionId: "hermes-session-1" },
      sessionDisplayId: "hermes-session-1",
      taskKey: null,
    };

    const first = await execute(context({ url: server.url, timeoutMs: 1_000 }, { runId: "run-hermes-first", runtime }));
    expect(first.exitCode).toBe(0);
    expect(first.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });

    const second = await execute(context({ url: server.url, timeoutMs: 1_000 }, { runId: "run-hermes-second", runtime }));
    expect(second.exitCode).toBe(0);
    expect(second.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(submittedSessionIds).toEqual(["hermes-session-1", "hermes-session-1"]);
    expect(runCount).toBe(2);
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
    expect(result).toMatchObject({
      sessionId: "hermes-session-1",
      sessionDisplayId: "hermes-session-1",
      sessionParams: { sessionId: "hermes-session-1", hermesTransport: "hermes-http-sse" },
    });
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
      {
        url: server.url,
        timeoutMs: 1_000,
        providerHostId: "host-hermes-test",
        providerProfileId: "profile-hermes-test",
        capabilityRevision: "hermes-api-v1",
        hermesProviderVersion: "0.19.1",
        hermesAuthEnvVar: "HERMES_API_KEY",
      },
      { runtime: { sessionId: "hermes-session-existing", sessionParams: { sessionId: "hermes-session-existing" }, sessionDisplayId: "hermes-session-existing", taskKey: null } },
    ));

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("hermes-session-existing");
    expect(result.sessionDisplayId).toBe("hermes-session-existing");
    expect(result.sessionParams).toMatchObject({
      sessionId: "hermes-session-existing",
      hermesTransport: "hermes-http-sse",
      profileHostId: "host-hermes-test",
      profileId: "profile-hermes-test",
      capabilityRevision: "hermes-api-v1",
      hermesProviderVersion: "0.19.1",
      hermesAuthEnvVar: "HERMES_API_KEY",
    });
    expect(server.requests.map((request) => request.path)).toEqual([
      "/v1/capabilities",
      "/api/sessions/hermes-session-existing",
      "/api/sessions/hermes-session-existing/messages",
      "/v1/runs",
      "/v1/runs/hermes-run-existing/events",
    ]);
  });

  it("keeps HTTP Chat continuity on its Conversation/Profile/principal and submits only each current turn", async () => {
    const submissions: Array<{ sessionKey: string | undefined; body: Record<string, unknown> }> = [];
    let sessionCount = 0;
    let runCount = 0;
    const server = await listen(async (req, res) => {
      if (req.url === "/api/sessions" && req.method === "POST") {
        sessionCount += 1;
        return json(res, 201, { object: "hermes.session", session: { id: `hermes-chat-session-${sessionCount}` } });
      }
      const sessionMatch = req.url?.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
      if (sessionMatch && req.method === "GET") {
        const id = decodeURIComponent(sessionMatch[1]!);
        return sessionMatch[2]
          ? json(res, 200, { object: "list", session_id: id, data: [{ role: "user" }] })
          : json(res, 200, { object: "hermes.session", session: { id } });
      }
      if (req.url === "/v1/runs" && req.method === "POST") {
        submissions.push({
          sessionKey: typeof req.headers["x-hermes-session-key"] === "string" ? req.headers["x-hermes-session-key"] : undefined,
          body: await readJsonBody(req),
        });
        runCount += 1;
        return json(res, 202, { run_id: `hermes-chat-run-${runCount}`, status: "started" });
      }
      const eventMatch = req.url?.match(/^\/v1\/runs\/(hermes-chat-run-\d+)\/events$/);
      if (eventMatch) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const config = {
      url: server.url,
      hermesChatBackend: "native_runs_http",
      providerHostId: "host-hermes-chat",
      providerProfileId: "profile-hermes-chat",
      providerBindingId: "binding-hermes-chat",
      capabilityRevision: "hermes-chat-v1",
      payloadTemplate: {
        conversation_history: [{ role: "assistant", content: "template history" }],
        previous_response_id: "template-response",
      },
      timeoutMs: 1_000,
    };
    const chatContext = (conversationId: string, principalScopeRef: string, chatPrompt: string) => ({
      chatMode: true,
      chatConversationId: conversationId,
      principalScopeRef,
      chatPrompt,
      rudderToolContext: [{ kind: "tool_result", content: "PREVIOUS_TOOL_RESULT_DO_NOT_SEND" }],
      transcript: [{ role: "assistant", content: "PREVIOUS_TRANSCRIPT_DO_NOT_SEND" }],
    });
    const invocationContexts: Array<Record<string, unknown>> = [];

    const first = await execute(context(config, {
      runId: "run-hermes-chat-first",
      context: chatContext("chat-hermes-1", "user:alice", "CURRENT TURN ONE"),
      onMeta: async (meta) => { invocationContexts.push(meta.context ?? {}); },
    }));
    expect(first.exitCode).toBe(0);
    expect(first).toMatchObject({
      sessionId: "hermes-chat-session-1",
      sessionDisplayId: "hermes-chat-session-1",
      sessionParams: {
        sessionId: "hermes-chat-session-1",
        rudderContinuityIdentity: expect.any(String),
      },
    });

    const second = await execute(context(config, {
      runId: "run-hermes-chat-second",
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: null,
      },
      context: chatContext("chat-hermes-1", "user:alice", "CURRENT TURN TWO"),
      onMeta: async (meta) => { invocationContexts.push(meta.context ?? {}); },
    }));
    expect(second.exitCode).toBe(0);
    expect(second).toMatchObject({
      sessionId: first.sessionId,
      sessionDisplayId: first.sessionId,
      sessionParams: { rudderContinuityIdentity: first.sessionParams?.rudderContinuityIdentity },
    });

    const wrongPrincipalResume = await execute(context(config, {
      runId: "run-hermes-chat-wrong-principal-resume",
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: null,
      },
      context: chatContext("chat-hermes-1", "user:bob", "SHOULD NOT SUBMIT"),
    }));
    expect(wrongPrincipalResume).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_session_mapping_failed" });

    const differentPrincipal = await execute(context(config, {
      runId: "run-hermes-chat-other-principal",
      context: chatContext("chat-hermes-1", "user:bob", "CURRENT TURN THREE"),
    }));
    const differentConversation = await execute(context(config, {
      runId: "run-hermes-chat-other-conversation",
      context: chatContext("chat-hermes-2", "user:alice", "CURRENT TURN FOUR"),
    }));
    const differentProfile = await execute(context({ ...config, providerProfileId: "profile-hermes-other", providerBindingId: "binding-hermes-other" }, {
      runId: "run-hermes-chat-other-profile",
      context: chatContext("chat-hermes-1", "user:alice", "CURRENT TURN FIVE"),
    }));
    expect([differentPrincipal.exitCode, differentConversation.exitCode, differentProfile.exitCode]).toEqual([0, 0, 0]);

    expect(submissions.map(({ body }) => body.input)).toEqual([
      "CURRENT TURN ONE",
      "CURRENT TURN TWO",
      "CURRENT TURN THREE",
      "CURRENT TURN FOUR",
      "CURRENT TURN FIVE",
    ]);
    expect(submissions[0]?.sessionKey).toBe(submissions[1]?.sessionKey);
    expect(new Set(submissions.filter((_, index) => index !== 1).map(({ sessionKey }) => sessionKey)).size).toBe(4);
    for (const { body } of submissions) {
      expect(body).not.toHaveProperty("conversation_history");
      expect(body).not.toHaveProperty("previous_response_id");
      expect(JSON.stringify(body)).not.toContain("PREVIOUS_TOOL_RESULT_DO_NOT_SEND");
      expect(JSON.stringify(body)).not.toContain("PREVIOUS_TRANSCRIPT_DO_NOT_SEND");
    }
    expect(invocationContexts).toHaveLength(2);
    expect(invocationContexts[0]).not.toHaveProperty("rudderToolContextSummary");
    expect(invocationContexts[0]).not.toHaveProperty("rudderToolContext");
    expect(invocationContexts[0]).not.toHaveProperty("transcript");
  });

  it("fails closed for HTTP Chat without a stable Conversation ID", async () => {
    const server = await listen(() => { throw new Error("HTTP Chat without a Conversation ID must not contact Hermes"); });
    const result = await execute(context({ url: server.url, hermesChatBackend: "native_runs_http" }, {
      context: { chatMode: true, chatPrompt: "current turn" },
    }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_conversation_binding_missing" });
    expect(server.requests).toHaveLength(0);
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

  it("keeps Hermes credentials and raw tool interactions out of persisted metadata", async () => {
    const secret = "HERMES_API_KEY_VALUE";
    const interactionSecret = "raw-tool-interaction-secret";
    const metas: unknown[] = [];
    const logs: string[] = [];
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        const body = await readJsonBody(req);
        expect(JSON.stringify(body)).not.toContain(secret);
        return json(res, 202, { run_id: "hermes-run-secret-check", status: "started" });
      }
      if (req.url === "/v1/runs/hermes-run-secret-check/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
        return;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({
      url: server.url,
      apiKey: secret,
      hermesAuthEnvVar: secret,
      timeoutMs: 1_000,
    }, {
      context: {
        issueId: "issue-hermes-secret-check",
        wakeReason: "manual",
        apiKey: secret,
        rudderToolContext: [{ kind: "tool_call", toolCallId: "call-1", content: interactionSecret }],
      },
      onMeta: async (meta) => { metas.push(meta); },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).not.toHaveProperty("apiKey");
    expect(result.sessionParams).not.toHaveProperty("hermesAuthEnvVar");
    expect(JSON.stringify(metas)).not.toContain(secret);
    expect(JSON.stringify(metas)).not.toContain(interactionSecret);
    expect(metas[0]).toMatchObject({ context: {} });
    expect(metas[0]).not.toHaveProperty("context.rudderToolContextSummary");
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(interactionSecret);
  });

  it("redacts configured credentials from an upstream submission error", async () => {
    const secret = "HERMES_API_KEY_VALUE";
    const unconfiguredSecret = "unconfigured-upstream-secret";
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") {
        await readJsonBody(req);
        return json(res, 401, { error: `clientSecret=${unconfiguredSecret}`, apiKey: secret });
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({ url: server.url, apiKey: secret, timeoutMs: 1_000 }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_submission_failed" });
    expect(result).toMatchObject({
      sessionId: "hermes-session-1",
      sessionDisplayId: "hermes-session-1",
      sessionParams: { sessionId: "hermes-session-1", hermesTransport: "hermes-http-sse" },
    });
    expect(result.errorMessage).not.toContain(secret);
    expect(result.errorMessage).not.toContain(unconfiguredSecret);
    expect(JSON.stringify(result.resultJson)).not.toContain(secret);
    expect(JSON.stringify(result.resultJson)).not.toContain(unconfiguredSecret);
    expect(result.resultJson).toMatchObject({ error: "clientSecret=[REDACTED]", apiKey: "[REDACTED]" });
  });

  it("passes only safe approval evidence to the Rudder interaction bridge", async () => {
    const secret = "hermes-approval-secret";
    const unconfiguredSecret = "unconfigured-approval-secret";
    let approvalPayload: Record<string, unknown> | null = null;
    const logs: string[] = [];
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-approval-safe", status: "started" });
      if (req.url === "/v1/runs/hermes-run-approval-safe/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          `data: ${JSON.stringify({ event: "approval.request", approval_id: "remote-approval-1", tool: `clientSecret=${unconfiguredSecret}`, output: secret, secretField: secret, privateKey: unconfiguredSecret })}\n\n`,
          `data: ${JSON.stringify({ event: "run.completed", output: "approved flow complete" })}\n\n`,
        ].join(""));
        return;
      }
      if (req.url === "/v1/runs/hermes-run-approval-safe/approval" && req.method === "POST") {
        await readJsonBody(req);
        return json(res, 200, { status: "denied" });
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({
      url: server.url,
      headers: { authorization: `Bearer ${secret}`, "x-api-key": secret },
      timeoutMs: 1_000,
    }, {
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      requestApproval: async (request) => {
        approvalPayload = request.payload;
        return { id: "rudder-approval-1", status: "pending" };
      },
      waitForApproval: async () => ({ id: "rudder-approval-1", status: "rejected" }),
    }));

    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(approvalPayload)).not.toContain(secret);
    expect(JSON.stringify(approvalPayload)).not.toContain(unconfiguredSecret);
    expect(approvalPayload).toMatchObject({
      provider: "hermes",
      event: { event: "approval.request", approval_id: "remote-approval-1", tool: "clientSecret=[REDACTED]" },
      choices: ["once", "deny"],
    });
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("fails closed for native secret requests without persisting secret-shaped values", async () => {
    const secret = "raw-native-secret";
    const logs: string[] = [];
    const server = await listen(async (req, res) => {
      if (sessionRoute(req, res)) return;
      if (req.url === "/v1/runs" && req.method === "POST") return json(res, 202, { run_id: "hermes-run-secret-request", status: "started" });
      if (req.url === "/v1/runs/hermes-run-secret-request/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          `data: ${JSON.stringify({ event: "secret.request", request_id: "native-secret-1", clientSecret: secret, privateKey: secret, bearerToken: secret, value: secret })}\n\n`,
          `data: ${JSON.stringify({ event: "run.completed", output: `clientSecret=${secret}` })}\n\n`,
        ].join(""));
        return;
      }
      if (req.url === "/v1/runs/hermes-run-secret-request/stop" && req.method === "POST") return json(res, 200, { run_id: "hermes-run-secret-request", status: "stopping" });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const result = await execute(context({ url: server.url, apiKey: "hermes-gateway-key", timeoutMs: 1_000 }, {
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "hermes_gateway_interaction_unresolved",
      resultJson: { output: null },
    });
    expect(JSON.stringify(result.resultJson)).not.toContain(secret);
    expect(result.summary).toBeUndefined();
    expect(logs.join("\n")).not.toContain(secret);
  });
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
