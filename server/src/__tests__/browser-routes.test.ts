import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { browserRoutes } from "../routes/browser.js";

const registry = {
  register: vi.fn(),
  unregister: vi.fn(),
  isAvailable: vi.fn(),
  forward: vi.fn(),
};
const getBrowserSettings = vi.fn();
const findRun = vi.fn();
const recordActivity = vi.fn();

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

describe("Browser routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrowserSettings.mockResolvedValue({ enabled: true, openLinksIn: "built_in" });
    findRun.mockResolvedValue({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "running" });
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
    const actor = { type: "agent", orgId: "org-1", agentId: "agent-1", runId: "run-1" };
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

  it("requires a running run owned by the authenticated org and agent", async () => {
    const missingRun = await request(createApp({
      type: "agent",
      orgId: "org-1",
      agentId: "agent-1",
    })).post("/api/browser/tabs").send({});
    expect(missingRun.status).toBe(400);
    expect(missingRun.body.code).toBe("browser_run_required");

    findRun.mockResolvedValueOnce({ id: "run-1", orgId: "org-1", agentId: "agent-2", status: "running" });
    const foreignRun = await request(createApp({
      type: "agent",
      orgId: "org-1",
      agentId: "agent-1",
      runId: "run-1",
    })).post("/api/browser/tabs").send({});
    expect(foreignRun.status).toBe(403);
    expect(foreignRun.body.code).toBe("browser_run_forbidden");

    findRun.mockResolvedValueOnce({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "succeeded" });
    const finishedRun = await request(createApp({
      type: "agent",
      orgId: "org-1",
      agentId: "agent-1",
      runId: "run-1",
    })).post("/api/browser/tabs").send({});
    expect(finishedRun.status).toBe(409);
    expect(finishedRun.body.code).toBe("browser_run_inactive");
  });

  it("rejects model-supplied identity and forwards only validated Browser arguments", async () => {
    const actor = { type: "agent", orgId: "org-1", agentId: "agent-1", runId: "run-1" };

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
      details: expect.objectContaining({ origin: "https://example.com" }),
    }));
    expect(JSON.stringify(recordActivity.mock.calls)).not.toContain("secret=1");
  });

  it.each([
    ["tabs", {}],
    ["open", { url: "https://example.com" }],
    ["navigate", { tabId: "tab-1", url: "https://example.com/next" }],
    ["read", { tabId: "tab-1" }],
    ["click", { tabId: "tab-1", ref: "ref-1" }],
    ["type", { tabId: "tab-1", ref: "ref-1", text: "hello", submit: true }],
    ["screenshot", { tabId: "tab-1" }],
    ["close", { tabId: "tab-1" }],
  ])("validates and dispatches the %s action", async (action, payload) => {
    const actor = { type: "agent", orgId: "org-1", agentId: "agent-1", runId: "run-1" };
    const response = await request(createApp(actor)).post(`/api/browser/${action}`).send(payload);

    expect(response.status).toBe(200);
    expect(registry.forward).toHaveBeenCalledWith({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action,
      args: payload,
    });
  });
});
