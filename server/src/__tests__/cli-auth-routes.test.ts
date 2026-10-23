import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  deduplicateAgentName: (name: string) => name,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
}));

async function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "none", source: "none" };
    next();
  });
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  app.use(
    "/api",
    accessRoutes({} as never, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
  app.use(errorHandler);
  return app;
}

describe("private Node CLI auth authority fence", () => {
  it.each([
    ["POST", "/api/cli-auth/challenges"],
    ["GET", "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562?token=synthetic-token"],
    ["POST", "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562/approve"],
    ["POST", "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562/cancel"],
    ["GET", "/api/cli-auth/me"],
    ["POST", "/api/cli-auth/revoke-current"],
  ])("returns 404 for retired %s %s without invoking Node CLI side effects", async (method, path) => {
    const app = await createApp();
    const route = method === "POST" ? request(app).post(path) : request(app).get(path);
    const response = await route.send(method === "POST" ? { token: "synthetic-token" } : undefined);

    expect(response.status).toBe(404);
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });

  it("leaves other CLI-auth namespace paths on the ordinary Node 404 route", async () => {
    const app = await createApp();
    const response = await request(app).get("/api/cli-auth/unmigrated");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "API route not found" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
