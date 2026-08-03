import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { browserRoutes } from "../routes/browser.js";
import { BrowserBrokerError } from "../services/browser-broker.js";

function createRegistryMock() {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    isAvailable: vi.fn(),
    forward: vi.fn(),
  };
}

let registry = createRegistryMock();
let getBrowserSettings = vi.fn();
let findRun = vi.fn();
let recordActivity = vi.fn();

async function closeTestServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sendRequest(
  app: Express,
  method: "post" | "put",
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const server = createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    let pendingRequest = request(server)[method](path);
    for (const [name, value] of Object.entries(headers)) {
      pendingRequest = pendingRequest.set(name, value);
    }
    return await pendingRequest.send(body);
  } finally {
    await closeTestServer(server);
  }
}

function runtimeActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    source: "agent_jwt",
    orgId: "org-1",
    agentId: "agent-1",
    runId: "run-1",
    adapterType: "codex_local",
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
  app.use("/api", browserRoutes({} as any, {
    deploymentMode,
    registry,
    getBrowserSettings,
    findRun,
    recordActivity,
  }));
  app.use(errorHandler);
  return app;
}

function createAuthenticatedBrowserApp() {
  const results = [[], [], [{ id: "agent-1", orgId: "org-1", status: "active" }]];
  let index = 0;
  const authDb = {
    select: vi.fn(() => {
      const chain = {
        from: () => chain,
        where: () => chain,
        then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(results[index++] ?? []).then(resolve, reject),
      };
      return chain;
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(authDb as any, { deploymentMode: "local_trusted" }));
  app.use("/api", browserRoutes({} as any, {
    deploymentMode: "local_trusted",
    registry,
    getBrowserSettings,
    findRun,
    recordActivity,
  }));
  app.use(errorHandler);
  return app;
}

describe.sequential("Browser routes", () => {
  beforeEach(() => {
    registry = createRegistryMock();
    getBrowserSettings = vi.fn();
    findRun = vi.fn();
    recordActivity = vi.fn();
    getBrowserSettings.mockResolvedValue({ enabled: true, openLinksIn: "built_in" });
    findRun.mockResolvedValue({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "running" });
    recordActivity.mockResolvedValue(undefined);
    registry.isAvailable.mockReturnValue(true);
    registry.unregister.mockReturnValue(true);
    registry.forward.mockResolvedValue({ tabId: "tab-1", url: "https://example.com/path?secret=1" });
  });

  it("lets only a local board register an opaque loopback Broker", async () => {
    const localBoard = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    const payload = {
      endpoint: "http://127.0.0.1:4141/browser",
      token: "a".repeat(48),
    };

    const registered = await sendRequest(createApp(localBoard), "put", "/api/instance/browser/broker", payload);
    expect(registered.status, JSON.stringify({ body: registered.body, text: registered.text })).toBe(204);
    expect(registry.register).toHaveBeenCalledWith(payload);

    const authenticated = await sendRequest(
      createApp(localBoard, "authenticated"),
      "put",
      "/api/instance/browser/broker",
      payload,
    );
    expect(authenticated.status, JSON.stringify({ body: authenticated.body, text: authenticated.text })).toBe(422);

    const agent = await sendRequest(
      createApp({
        type: "agent",
        orgId: "org-1",
        agentId: "agent-1",
        runId: "run-1",
      }),
      "put",
      "/api/instance/browser/broker",
      payload,
    );
    expect(agent.status).toBe(403);
  });

  it("validates Browser lifecycle generations and reports stale registration conflicts", async () => {
    const localBoard = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    const payload = {
      endpoint: "http://127.0.0.1:4141/browser",
      token: "a".repeat(48),
      ownerId: "02ad71bd-dcc1-4c93-9642-b16c8c1d2e08",
      generation: 2,
    };

    const invalid = await sendRequest(
      createApp(localBoard),
      "put",
      "/api/instance/browser/broker",
      { ...payload, generation: undefined },
    );
    expect(invalid.status).toBe(400);

    const invalidRefresh = await sendRequest(
      createApp(localBoard),
      "put",
      "/api/instance/browser/broker",
      { endpoint: payload.endpoint, token: payload.token, refresh: true },
    );
    expect(invalidRefresh.status).toBe(400);

    const refresh = await sendRequest(
      createApp(localBoard),
      "put",
      "/api/instance/browser/broker",
      { ...payload, refresh: true },
    );
    expect(refresh.status).toBe(204);
    expect(registry.register).toHaveBeenLastCalledWith({ ...payload, refresh: true });

    registry.register.mockImplementationOnce(() => {
      throw new BrowserBrokerError(
        "browser_broker_stale_registration",
        "Browser Broker registration was superseded by a newer Desktop lifecycle.",
      );
    });
    const stale = await sendRequest(createApp(localBoard), "put", "/api/instance/browser/broker", payload);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "browser_broker_stale_registration" });

    registry.register.mockImplementationOnce(() => {
      throw new BrowserBrokerError(
        "browser_broker_revoked_registration",
        "Browser Broker registration was revoked and must reconnect.",
      );
    });
    const revoked = await sendRequest(
      createApp(localBoard),
      "put",
      "/api/instance/browser/broker",
      { ...payload, refresh: true },
    );
    expect(revoked.status).toBe(409);
    expect(revoked.body).toMatchObject({ code: "browser_broker_revoked_registration" });
  });

  it("returns stable disabled and unavailable errors before dispatch", async () => {
    const actor = runtimeActor();
    getBrowserSettings.mockResolvedValueOnce({ enabled: false, openLinksIn: "built_in" });

    const disabled = await sendRequest(createApp(actor), "post", "/api/browser/tabs", {});
    expect(disabled.status).toBe(409);
    expect(disabled.body).toMatchObject({ code: "browser_disabled" });
    expect(registry.forward).not.toHaveBeenCalled();

    registry.isAvailable.mockReturnValueOnce(false);
    const unavailable = await sendRequest(createApp(actor), "post", "/api/browser/tabs", {});
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: "browser_unavailable" });
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("exposes a Broker-free liveness probe that revokes disabled or inactive Browser MCP processes", async () => {
    const actor = runtimeActor();
    const live = await sendRequest(createApp(actor), "post", "/api/browser/liveness", {});
    expect(live.status).toBe(204);
    expect(registry.forward).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();

    getBrowserSettings.mockResolvedValueOnce({ enabled: false, openLinksIn: "built_in" });
    const disabled = await sendRequest(createApp(actor), "post", "/api/browser/liveness", {});
    expect(disabled.status).toBe(409);
    expect(disabled.body).toMatchObject({ code: "browser_disabled" });

    findRun.mockResolvedValueOnce({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "succeeded" });
    const inactive = await sendRequest(createApp(actor), "post", "/api/browser/liveness", {});
    expect(inactive.status).toBe(409);
    expect(inactive.body).toMatchObject({ code: "browser_run_inactive" });
  });

  it("rejects Browser calls from a runtime without managed Browser tools", async () => {
    const unsupported = await sendRequest(
      createApp(runtimeActor({ adapterType: "gemini_local" })),
      "post",
      "/api/browser/tabs",
      {},
    );

    expect(unsupported.status).toBe(403);
    expect(unsupported.body).toMatchObject({ code: "browser_runtime_unsupported" });
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("returns a stable unsupported error for Agent Browser calls outside local_trusted", async () => {
    const unsupported = await sendRequest(
      createApp(runtimeActor(), "authenticated"),
      "post",
      "/api/browser/tabs",
      {},
    );

    expect(unsupported.status).toBe(403);
    expect(unsupported.body).toMatchObject({ code: "browser_runtime_unsupported" });
    expect(getBrowserSettings).not.toHaveBeenCalled();
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.isAvailable).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("requires a running run owned by the authenticated org and agent", async () => {
    const missingRun = await sendRequest(
      createApp(runtimeActor({ runId: undefined })),
      "post",
      "/api/browser/tabs",
      {},
    );
    expect(missingRun.status).toBe(400);
    expect(missingRun.body.code).toBe("browser_run_required");

    findRun.mockResolvedValue({ id: "run-1", orgId: "org-1", agentId: "agent-2", status: "running" });
    const foreignRun = await sendRequest(createApp(runtimeActor()), "post", "/api/browser/tabs", {});
    expect(foreignRun.status).toBe(403);
    expect(foreignRun.body.code).toBe("browser_run_forbidden");

    findRun.mockResolvedValue({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "succeeded" });
    const finishedRun = await sendRequest(createApp(runtimeActor()), "post", "/api/browser/tabs", {});
    expect(finishedRun.status).toBe(409);
    expect(finishedRun.body.code).toBe("browser_run_inactive");
  });

  it("rejects model-supplied identity and forwards only validated Browser arguments", async () => {
    const actor = runtimeActor();

    const injected = await sendRequest(
      createApp(actor),
      "post",
      "/api/browser/open",
      { url: "https://example.com", orgId: "org-other" },
    );
    expect(injected.status).toBe(400);
    expect(registry.forward).not.toHaveBeenCalled();

    const opened = await sendRequest(
      createApp(actor),
      "post",
      "/api/browser/open",
      { url: "https://example.com" },
    );
    expect(opened.status).toBe(200);
    expect(registry.forward).toHaveBeenCalledWith({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "open",
      args: { url: "https://example.com" },
    });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      agentId: "agent-1",
      runId: "run-1",
      action: "agent.browser.open",
      details: expect.objectContaining({ origin: "https://example.com", status: "completed" }),
    }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent.browser.open.requested",
      details: expect.objectContaining({ origin: "https://example.com", status: "requested" }),
    }));
    expect(JSON.stringify(recordActivity.mock.calls)).not.toContain("secret=1");
  });

  it("does not dispatch when the durable Browser action intent cannot be recorded", async () => {
    recordActivity.mockRejectedValueOnce(new Error("activity unavailable"));
    const response = await sendRequest(
      createApp(runtimeActor()),
      "post",
      "/api/browser/open",
      { url: "https://example.com" },
    );

    expect(response.status, JSON.stringify({ body: response.body, text: response.text })).toBe(500);
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("returns a successful Broker result when completion logging fails after a recorded intent", async () => {
    recordActivity
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("completion unavailable"));
    const response = await sendRequest(
      createApp(runtimeActor()),
      "post",
      "/api/browser/open",
      { url: "https://example.com" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tabId: "tab-1" });
    expect(registry.forward).toHaveBeenCalledOnce();
    expect(recordActivity).toHaveBeenCalledTimes(2);
    expect(recordActivity.mock.invocationCallOrder[0]).toBeLessThan(registry.forward.mock.invocationCallOrder[0]!);
  });

  it("does not hold a successful Browser response on a stalled completion log", async () => {
    recordActivity
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const response = await Promise.race([
      sendRequest(createApp(runtimeActor()), "post", "/api/browser/open", { url: "https://example.com" }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Browser response waited on completion logging")), 250);
      }),
    ]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tabId: "tab-1" });
    expect(recordActivity).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["tabs", {}],
    ["user_tabs", {}],
    ["open", { url: "https://example.com" }],
    ["navigate", { tabId: "tab-1", url: "https://example.com/next" }],
    ["back", { tabId: "tab-1" }],
    ["forward", { tabId: "tab-1" }],
    ["reload", { tabId: "tab-1" }],
    ["viewport", { action: "set", width: 390, height: 844 }],
    ["visibility", { visible: true }],
    ["snapshot", { tabId: "tab-1", boxes: true, depth: 12 }],
    ["locator", {
      tabId: "tab-1",
      action: "wait",
      locator: { strategy: "role", value: "button", name: "Continue", exact: true },
      state: "visible",
      timeoutMs: 10_000,
    }],
    ["cua", { tabId: "tab-1", action: "click", x: 20, y: 30, keys: ["Shift"] }],
    ["dom_cua", { tabId: "tab-1", action: "get", maxNodes: 500 }],
    ["dialog", { tabId: "tab-1", action: "get" }],
    ["clipboard", { action: "writeText", text: "session-only" }],
    ["logs", { tabId: "tab-1", levels: ["warn", "error"], limit: 20 }],
    ["download", {
      tabId: "tab-1",
      mode: "media",
      locator: { strategy: "css", value: "img.hero" },
    }],
    ["assets", { tabId: "tab-1", action: "list" }],
    ["content", { tabId: "tab-1", format: "text" }],
    ["wait", { tabId: "tab-1", text: "Ready", timeoutMs: 5_000 }],
    ["read", { tabId: "tab-1" }],
    ["click", { tabId: "tab-1", ref: "ref-1" }],
    ["type", { tabId: "tab-1", ref: "ref-1", text: "hello", submit: true }],
    ["screenshot", { tabId: "tab-1" }],
    ["close", { tabId: "tab-1" }],
  ])("validates and dispatches the %s action", async (action, payload) => {
    const actor = runtimeActor();
    const response = await sendRequest(createApp(actor), "post", `/api/browser/${action}`, payload);

    expect(response.status).toBe(200);
    expect(registry.forward).toHaveBeenCalledWith({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action,
      args: payload,
    });
  });

  it("does not expose arbitrary evaluation as a Browser route", async () => {
    const response = await sendRequest(
      createApp(runtimeActor()),
      "post",
      "/api/browser/evaluate",
      { tabId: "tab-1", function: "() => document.cookie" },
    );

    expect(response.status).toBe(404);
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it.each([
    "click", "dblclick", "hover", "fill", "type", "press", "check", "uncheck",
    "setChecked", "select", "scroll", "drag", "focus", "setFiles",
  ])("rejects mutating locator action %s before Broker dispatch", async (locatorAction) => {
    const response = await sendRequest(
      createApp(runtimeActor()),
      "post",
      "/api/browser/locator",
      {
        tabId: "tab-1",
        action: locatorAction,
        locator: { strategy: "css", value: "#target" },
      },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "browser_invalid_argument" });
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("rejects locator-triggered downloads before Broker dispatch", async () => {
    const response = await sendRequest(
      createApp(runtimeActor()),
      "post",
      "/api/browser/download",
      {
        tabId: "tab-1",
        mode: "trigger",
        locator: { strategy: "css", value: "#download" },
      },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "browser_invalid_argument" });
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it.each([
    ["locator", { tabId: "tab-1", action: "click", locator: { strategy: "role", value: "button" }, rawCdp: "Runtime.evaluate" }],
    ["locator", { tabId: "tab-1", action: "count", locator: { strategy: "role", value: "button" }, dialogResponse: { accept: true } }],
    ["locator", { tabId: "tab-1", action: "setFiles", locator: { strategy: "css", value: "input[type=file]" }, paths: ["/etc/hosts"] }],
    ["cua", { tabId: "tab-1", action: "click", x: 20 }],
    ["dom_cua", { tabId: "tab-1", action: "click", nodeId: "snapshot-1-node-9" }],
    ["clipboard", { action: "write", items: [{ entries: [{ mimeType: "text/plain", text: "a", base64: "YQ==" }] }] }],
    ["download", { tabId: "tab-1", mode: "trigger", locator: { strategy: "css", value: "a" }, timeoutMs: 30_001 }],
    ["assets", { tabId: "tab-1", action: "bundle" }],
    ["assets", { tabId: "tab-1", action: "bundle", inventoryId: "11111111-1111-4111-8111-111111111111" }],
    ["content", { tabId: "tab-1", format: "html" }],
    ["wait", { tabId: "tab-1", url: "example", urlRegex: true }],
    ["locator", {
      tabId: "tab-1",
      action: "click",
      locator: { strategy: "css", value: "button" },
      expectNavigation: { url: "(a+)+$", urlRegex: true },
    }],
    ["wait", { tabId: "tab-1" }],
    ["screenshot", { tabId: "tab-1", fullPage: true, clip: { x: 0, y: 0, width: 100, height: 100 } }],
  ])("rejects invalid or over-broad %s arguments before Broker dispatch", async (action, payload) => {
    const response = await sendRequest(createApp(runtimeActor()), "post", `/api/browser/${action}`, payload);

    expect(response.status, JSON.stringify({ action, payload, body: response.body, text: response.text })).toBe(400);
    expect(response.body).toMatchObject({ code: "browser_invalid_argument" });
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("never records clipboard contents in activity metadata", async () => {
    const response = await sendRequest(
      createApp(runtimeActor()),
      "post",
      "/api/browser/clipboard",
      { action: "writeText", text: "private clipboard value" },
    );

    expect(response.status).toBe(200);
    const serializedActivity = JSON.stringify(recordActivity.mock.calls);
    expect(serializedActivity).not.toContain("private clipboard value");
    expect(serializedActivity).not.toContain("writeText");
    expect(serializedActivity).toContain("agent.browser.clipboard");
  });

  it("preserves the stable missing-ref status returned by Desktop", async () => {
    registry.forward.mockRejectedValueOnce(new BrowserBrokerError(
      "browser_ref_not_found",
      "Browser element reference is missing or stale.",
    ));
    const response = await sendRequest(
      createApp(runtimeActor()),
      "post",
      "/api/browser/click",
      { tabId: "tab-1", ref: "stale-ref" },
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: "browser_ref_not_found",
      error: "Browser element reference is missing or stale.",
    });
  });

  it("rejects a plain Agent API key even when it supplies a run header", async () => {
    const response = await sendRequest(
      createApp(runtimeActor({ source: "agent_key" })),
      "post",
      "/api/browser/tabs",
      {},
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "browser_run_credential_required" });
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("accepts a matching run-scoped Agent JWT through the auth middleware", async () => {
    const token = createLocalAgentJwt("agent-1", "org-1", "codex_local", "run-1");
    expect(token).toBeTruthy();

    const response = await sendRequest(
      createAuthenticatedBrowserApp(),
      "post",
      "/api/browser/tabs",
      {},
      { authorization: `Bearer ${token}`, "x-rudder-run-id": "run-1" },
    );

    expect(response.status).toBe(200);
    expect(findRun).toHaveBeenCalledWith("run-1");
    expect(registry.forward).toHaveBeenCalledWith({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "tabs",
      args: {},
    });
  });

  it("rejects a mismatched run header before the authenticated Browser route resolves a run", async () => {
    const token = createLocalAgentJwt("agent-1", "org-1", "codex_local", "run-a");
    expect(token).toBeTruthy();

    const response = await sendRequest(
      createAuthenticatedBrowserApp(),
      "post",
      "/api/browser/tabs",
      {},
      { authorization: `Bearer ${token}`, "x-rudder-run-id": "run-b" },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "agent_run_context_mismatch" });
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });
});
