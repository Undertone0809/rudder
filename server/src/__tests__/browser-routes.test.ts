import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { browserRoutes } from "../routes/browser.js";
import { BrowserBrokerError } from "../services/browser-broker.js";

const registry = {
  register: vi.fn(),
  unregister: vi.fn(),
  isAvailable: vi.fn(),
  forward: vi.fn(),
};
const getBrowserSettings = vi.fn();
const findRun = vi.fn();
const recordActivity = vi.fn();

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

describe("Browser routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrowserSettings.mockReset();
    findRun.mockReset();
    recordActivity.mockReset();
    registry.isAvailable.mockReset();
    registry.unregister.mockReset();
    registry.forward.mockReset();
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

    const registered = await request(createApp(localBoard))
      .put("/api/instance/browser/broker")
      .send(payload);
    expect(registered.status).toBe(204);
    expect(registry.register).toHaveBeenCalledWith(payload);

    const authenticated = await request(createApp(localBoard, "authenticated"))
      .put("/api/instance/browser/broker")
      .send(payload);
    expect(authenticated.status).toBe(422);

    const agent = await request(createApp({
      type: "agent",
      orgId: "org-1",
      agentId: "agent-1",
      runId: "run-1",
    }))
      .put("/api/instance/browser/broker")
      .send(payload);
    expect(agent.status).toBe(403);
  });

  it("returns stable disabled and unavailable errors before dispatch", async () => {
    const actor = runtimeActor();
    getBrowserSettings.mockResolvedValueOnce({ enabled: false, openLinksIn: "built_in" });

    const disabled = await request(createApp(actor)).post("/api/browser/tabs").send({});
    expect(disabled.status).toBe(409);
    expect(disabled.body).toMatchObject({ code: "browser_disabled" });
    expect(registry.forward).not.toHaveBeenCalled();

    registry.isAvailable.mockReturnValueOnce(false);
    const unavailable = await request(createApp(actor)).post("/api/browser/tabs").send({});
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: "browser_unavailable" });
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("exposes a Broker-free liveness probe that revokes disabled or inactive Browser MCP processes", async () => {
    const actor = runtimeActor();
    const live = await request(createApp(actor)).post("/api/browser/liveness").send({});
    expect(live.status).toBe(204);
    expect(registry.forward).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();

    getBrowserSettings.mockResolvedValueOnce({ enabled: false, openLinksIn: "built_in" });
    const disabled = await request(createApp(actor)).post("/api/browser/liveness").send({});
    expect(disabled.status).toBe(409);
    expect(disabled.body).toMatchObject({ code: "browser_disabled" });

    findRun.mockResolvedValueOnce({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "succeeded" });
    const inactive = await request(createApp(actor)).post("/api/browser/liveness").send({});
    expect(inactive.status).toBe(409);
    expect(inactive.body).toMatchObject({ code: "browser_run_inactive" });
  });

  it("rejects Browser calls from a runtime without managed Browser tools", async () => {
    const unsupported = await request(createApp(runtimeActor({ adapterType: "gemini_local" })))
      .post("/api/browser/tabs")
      .send({});

    expect(unsupported.status).toBe(403);
    expect(unsupported.body).toMatchObject({ code: "browser_runtime_unsupported" });
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("returns a stable unsupported error for Agent Browser calls outside local_trusted", async () => {
    const unsupported = await request(createApp(runtimeActor(), "authenticated"))
      .post("/api/browser/tabs")
      .send({});

    expect(unsupported.status).toBe(403);
    expect(unsupported.body).toMatchObject({ code: "browser_runtime_unsupported" });
    expect(getBrowserSettings).not.toHaveBeenCalled();
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.isAvailable).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("requires a running run owned by the authenticated org and agent", async () => {
    const missingRun = await request(createApp(runtimeActor({ runId: undefined })))
      .post("/api/browser/tabs")
      .send({});
    expect(missingRun.status).toBe(400);
    expect(missingRun.body.code).toBe("browser_run_required");

    findRun.mockResolvedValue({ id: "run-1", orgId: "org-1", agentId: "agent-2", status: "running" });
    const foreignRun = await request(createApp(runtimeActor())).post("/api/browser/tabs").send({});
    expect(foreignRun.status).toBe(403);
    expect(foreignRun.body.code).toBe("browser_run_forbidden");

    findRun.mockResolvedValue({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "succeeded" });
    const finishedRun = await request(createApp(runtimeActor())).post("/api/browser/tabs").send({});
    expect(finishedRun.status).toBe(409);
    expect(finishedRun.body.code).toBe("browser_run_inactive");
  });

  it("rejects model-supplied identity and forwards only validated Browser arguments", async () => {
    const actor = runtimeActor();

    const injected = await request(createApp(actor))
      .post("/api/browser/open")
      .send({ url: "https://example.com", orgId: "org-other" });
    expect(injected.status).toBe(400);
    expect(registry.forward).not.toHaveBeenCalled();

    const opened = await request(createApp(actor))
      .post("/api/browser/open")
      .send({ url: "https://example.com" });
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
    const response = await request(createApp(runtimeActor()))
      .post("/api/browser/open")
      .send({ url: "https://example.com" });

    expect(response.status).toBe(500);
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("returns a successful Broker result when completion logging fails after a recorded intent", async () => {
    recordActivity
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("completion unavailable"));
    const response = await request(createApp(runtimeActor()))
      .post("/api/browser/open")
      .send({ url: "https://example.com" });

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
      request(createApp(runtimeActor())).post("/api/browser/open").send({ url: "https://example.com" }),
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
      action: "click",
      locator: { strategy: "role", value: "button", name: "Continue", exact: true },
      expectNavigation: { url: "/next", waitUntil: "load", timeoutMs: 10_000 },
      dialogResponse: { accept: true, promptText: "accepted" },
    }],
    ["cua", { tabId: "tab-1", action: "click", x: 20, y: 30, keys: ["Shift"] }],
    ["dom_cua", { tabId: "tab-1", action: "get", maxNodes: 500 }],
    ["evaluate", { tabId: "tab-1", function: "() => document.title", arg: null }],
    ["dialog", { tabId: "tab-1", action: "get" }],
    ["clipboard", { action: "writeText", text: "session-only" }],
    ["logs", { tabId: "tab-1", levels: ["warn", "error"], limit: 20 }],
    ["download", {
      tabId: "tab-1",
      mode: "media",
      locator: { strategy: "css", value: "img.hero" },
    }],
    ["assets", { tabId: "tab-1", action: "list" }],
    ["content", { tabId: "tab-1", format: "html" }],
    ["wait", { tabId: "tab-1", text: "Ready", timeoutMs: 5_000 }],
    ["read", { tabId: "tab-1" }],
    ["click", { tabId: "tab-1", ref: "ref-1" }],
    ["type", { tabId: "tab-1", ref: "ref-1", text: "hello", submit: true }],
    ["screenshot", { tabId: "tab-1" }],
    ["close", { tabId: "tab-1" }],
  ])("validates and dispatches the %s action", async (action, payload) => {
    const actor = runtimeActor();
    const response = await request(createApp(actor)).post(`/api/browser/${action}`).send(payload);

    expect(response.status).toBe(200);
    expect(registry.forward).toHaveBeenCalledWith({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action,
      args: payload,
    });
  });

  it.each([
    ["locator", { tabId: "tab-1", action: "click", locator: { strategy: "role", value: "button" }, rawCdp: "Runtime.evaluate" }],
    ["locator", { tabId: "tab-1", action: "count", locator: { strategy: "role", value: "button" }, dialogResponse: { accept: true } }],
    ["cua", { tabId: "tab-1", action: "click", x: 20 }],
    ["dom_cua", { tabId: "tab-1", action: "click" }],
    ["clipboard", { action: "write", items: [{ entries: [{ mimeType: "text/plain", text: "a", base64: "YQ==" }] }] }],
    ["assets", { tabId: "tab-1", action: "bundle" }],
    ["assets", { tabId: "tab-1", action: "bundle", inventoryId: "11111111-1111-4111-8111-111111111111" }],
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
    const response = await request(createApp(runtimeActor())).post(`/api/browser/${action}`).send(payload);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "browser_invalid_argument" });
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("never records clipboard contents in activity metadata", async () => {
    const response = await request(createApp(runtimeActor()))
      .post("/api/browser/clipboard")
      .send({ action: "writeText", text: "private clipboard value" });

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
    const response = await request(createApp(runtimeActor()))
      .post("/api/browser/click")
      .send({ tabId: "tab-1", ref: "stale-ref" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: "browser_ref_not_found",
      error: "Browser element reference is missing or stale.",
    });
  });

  it("rejects a plain Agent API key even when it supplies a run header", async () => {
    const response = await request(createApp(runtimeActor({ source: "agent_key" })))
      .post("/api/browser/tabs")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "browser_run_credential_required" });
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("accepts a matching run-scoped Agent JWT through the auth middleware", async () => {
    const token = createLocalAgentJwt("agent-1", "org-1", "codex_local", "run-1");
    expect(token).toBeTruthy();

    const response = await request(createAuthenticatedBrowserApp())
      .post("/api/browser/tabs")
      .set("authorization", `Bearer ${token}`)
      .set("x-rudder-run-id", "run-1")
      .send({});

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

    const response = await request(createAuthenticatedBrowserApp())
      .post("/api/browser/tabs")
      .set("authorization", `Bearer ${token}`)
      .set("x-rudder-run-id", "run-b")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "agent_run_context_mismatch" });
    expect(findRun).not.toHaveBeenCalled();
    expect(registry.forward).not.toHaveBeenCalled();
  });
});
