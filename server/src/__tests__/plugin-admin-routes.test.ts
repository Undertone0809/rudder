import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", pluginRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const memberActor = {
  type: "board",
  userId: "member-1",
  orgIds: ["organization-1"],
  isInstanceAdmin: false,
  source: "session",
};

describe("instance-global plugin administration", () => {
  it.each([
    ["install", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/install").send({})],
    ["uninstall", (app: ReturnType<typeof createApp>) => request(app).delete("/api/plugins/plugin-1")],
    ["enable", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/enable")],
    ["disable", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/disable")],
    ["upgrade", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/upgrade")],
    ["read config", (app: ReturnType<typeof createApp>) => request(app).get("/api/plugins/plugin-1/config")],
    ["write config", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/config").send({})],
    ["test config", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/config/test").send({})],
    ["read logs", (app: ReturnType<typeof createApp>) => request(app).get("/api/plugins/plugin-1/logs")],
    ["list jobs", (app: ReturnType<typeof createApp>) => request(app).get("/api/plugins/plugin-1/jobs")],
    ["read job runs", (app: ReturnType<typeof createApp>) => request(app).get("/api/plugins/plugin-1/jobs/job-1/runs")],
    ["trigger a job", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/jobs/job-1/trigger")],
    ["read the operational dashboard", (app: ReturnType<typeof createApp>) => request(app).get("/api/plugins/plugin-1/dashboard")],
    ["call a global data bridge", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/data/status").send({})],
    ["call a global action bridge", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/actions/run").send({})],
    ["call the legacy data bridge", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/bridge/data").send({ key: "status" })],
    ["call the legacy action bridge", (app: ReturnType<typeof createApp>) => request(app).post("/api/plugins/plugin-1/bridge/action").send({ key: "run" })],
  ])("rejects a non-admin board member attempting to %s", async (_label, sendRequest) => {
    const response = await sendRequest(createApp(memberActor));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Instance admin access required" });
  });

  it("lets an instance admin reach plugin install validation", async () => {
    const response = await request(createApp({
      ...memberActor,
      isInstanceAdmin: true,
    })).post("/api/plugins/install").send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "packageName is required and must be a string",
    });
  });

  it.each([
    ["data", "/api/plugins/plugin-1/data/state-value"],
    ["action", "/api/plugins/plugin-1/actions/write-scoped-state"],
  ])("rejects a non-admin organization member's %s bridge request targeting another organization", async (_label, route) => {
    const response = await request(createApp(memberActor)).post(route).send({
      orgId: "organization-1",
      params: {
        orgId: "organization-1",
        scopeKind: "organization",
        scopeId: "organization-2",
        stateKey: "private-state",
      },
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Instance admin access required" });
  });

  it.each([
    ["read instance state", "/api/plugins/plugin-1/data/state-value", { scopeKind: "instance", stateKey: "private-state" }],
    ["write instance state", "/api/plugins/plugin-1/actions/write-scoped-state", { scopeKind: "instance", stateKey: "private-state", value: "owned" }],
    ["delete instance state", "/api/plugins/plugin-1/actions/delete-scoped-state", { scopeKind: "instance", stateKey: "private-state" }],
    ["upsert an instance entity", "/api/plugins/plugin-1/actions/upsert-entity", { scopeKind: "instance", entityType: "private-entity", data: {} }],
    ["list organizations", "/api/plugins/plugin-1/data/organizations", { limit: 100 }],
    ["read the global overview", "/api/plugins/plugin-1/data/overview", { orgId: "organization-1" }],
  ])("rejects a non-admin organization member attempting to %s", async (_label, route, params) => {
    const response = await request(createApp(memberActor))
      .post(route)
      .send({ orgId: "organization-1", params });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Instance admin access required" });
  });

  it("lets an instance admin reach a global bridge", async () => {
    const response = await request(createApp({
      ...memberActor,
      isInstanceAdmin: true,
    })).post("/api/plugins/plugin-1/actions/run").send({});

    expect(response.status).toBe(501);
    expect(response.body).toEqual({ error: "Plugin bridge is not enabled" });
  });

  it("rejects plugin tool parameters that name a different organization", async () => {
    const response = await request(createApp(memberActor)).post("/api/plugins/tools/execute").send({
      tool: "example:run",
      parameters: { orgId: "organization-2" },
      runContext: {
        agentId: "agent-1",
        runId: "run-1",
        orgId: "organization-1",
        projectId: "project-1",
      },
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Plugin tool parameters must use the authorized organization scope",
    });
  });
});
