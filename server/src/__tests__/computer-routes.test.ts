import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { computerRoutes } from "../routes/computer.js";
import { ComputerBrokerError } from "../services/computer-broker.js";

function createRegistryMock() {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    isAvailable: vi.fn(() => true),
    forward: vi.fn(async () => ({ apps: [] })),
  };
}

let registry = createRegistryMock();
let getEnabled = vi.fn(async () => true);
let findRun = vi.fn(async () => ({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "running" }));
let recordActivity = vi.fn(async () => undefined);

async function closeTestServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function post(app: Express, path: string, body: unknown) {
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await request(server).post(path).send(body);
  } finally {
    await closeTestServer(server);
  }
}

function createApp(actor: Record<string, unknown>, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", computerRoutes({} as never, {
    deploymentMode,
    registry,
    getEnabled,
    findRun,
    recordActivity,
  }));
  app.use(errorHandler);
  return app;
}

const runtimeActor = (overrides: Record<string, unknown> = {}) => ({
  type: "agent",
  source: "agent_jwt",
  orgId: "org-1",
  agentId: "agent-1",
  runId: "run-1",
  adapterType: "codex_local",
  ...overrides,
});

describe.sequential("Computer Use routes", () => {
  beforeEach(() => {
    registry = createRegistryMock();
    getEnabled = vi.fn(async () => true);
    findRun = vi.fn(async () => ({ id: "run-1", orgId: "org-1", agentId: "agent-1", status: "running" }));
    recordActivity = vi.fn(async () => undefined);
  });

  it("fails closed when disabled, Desktop-disconnected, unsupported, or owned by another Run", async () => {
    getEnabled.mockResolvedValueOnce(false);
    expect((await post(createApp(runtimeActor()), "/api/computer/list_apps", {})).body)
      .toMatchObject({ code: "computer_disabled" });

    registry.isAvailable.mockReturnValueOnce(false);
    expect((await post(createApp(runtimeActor()), "/api/computer/list_apps", {})).body)
      .toMatchObject({ code: "computer_unavailable" });

    expect((await post(createApp(runtimeActor({ adapterType: "claude_local" })), "/api/computer/list_apps", {})).body)
      .toMatchObject({ code: "computer_runtime_unsupported" });

    findRun.mockResolvedValueOnce({ id: "run-1", orgId: "org-2", agentId: "agent-1", status: "running" });
    expect((await post(createApp(runtimeActor()), "/api/computer/list_apps", {})).body)
      .toMatchObject({ code: "computer_run_forbidden" });
    expect(registry.forward).not.toHaveBeenCalled();
  });

  it("derives identity from the run credential and keeps typed text out of activity", async () => {
    registry.forward.mockResolvedValueOnce({ effect: "confirmed", pid: 42, windowId: 7 });
    const observationId = "02ad71bd-dcc1-4c93-9642-b16c8c1d2e08";
    const response = await post(createApp(runtimeActor()), "/api/computer/type_text", {
      observationId,
      elementIndex: 3,
      text: "private user value",
    });
    expect(response.status).toBe(200);
    expect(registry.forward).toHaveBeenCalledWith({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "type_text",
      args: { observationId, elementIndex: 3, text: "private user value" },
    });
    expect(JSON.stringify(recordActivity.mock.calls)).not.toContain("private user value");
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ action: "type_text", observationId }),
    }));
  });

  it("returns stable broker errors", async () => {
    registry.forward.mockRejectedValueOnce(new ComputerBrokerError(
      "computer_stale_observation",
      "Observe the window again.",
    ));
    const response = await post(createApp(runtimeActor()), "/api/computer/click", {
      observationId: "02ad71bd-dcc1-4c93-9642-b16c8c1d2e08",
      x: 10,
      y: 20,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "computer_stale_observation" });
  });
});
