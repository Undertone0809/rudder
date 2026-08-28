import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { rudderPluginRoutes } from "../routes/rudder-plugins.js";

const mockPlugins = vi.hoisted(() => ({
  directory: vi.fn(),
  getInstalled: vi.fn(),
}));

vi.mock("../services/rudder-plugins.js", () => ({
  rudderPluginService: () => mockPlugins,
}));

vi.mock("../services/rudder-plugin-catalog.js", () => ({
  rudderPluginCatalogService: () => ({}),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ getMembership: vi.fn() }),
  logActivity: vi.fn(),
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLUGIN_ID = "86f6573e-2707-438b-9334-696c91fd0856";

function createAgentActor(orgId = ORG_ID) {
  return {
    type: "agent" as const,
    agentId: "33333333-3333-4333-8333-333333333333",
    orgId,
    orgIds: [orgId],
    runId: "44444444-4444-4444-8444-444444444444",
  };
}

function createApp(actor = createAgentActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", rudderPluginRoutes({} as never, {} as never));
  app.use(errorHandler);
  return app;
}

describe("Rudder plugin Agent read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlugins.directory.mockResolvedValue({ installed: [], localApps: [], discover: [], discoverSource: "none" });
    mockPlugins.getInstalled.mockResolvedValue({
      id: PLUGIN_ID,
      displayName: "Canva",
      components: [{ type: "skill", displayName: "Canva Design" }],
    });
  });

  it("lets a same-organization Agent search the plugin directory", async () => {
    const response = await request(createApp()).get(`/api/orgs/${ORG_ID}/plugins`);

    expect(response.status).toBe(200);
    expect(mockPlugins.directory).toHaveBeenCalledWith(ORG_ID);
  });

  it("lets a same-organization Agent resolve an installed plugin reference", async () => {
    const response = await request(createApp()).get(`/api/orgs/${ORG_ID}/plugins/${PLUGIN_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: PLUGIN_ID, displayName: "Canva" });
    expect(mockPlugins.getInstalled).toHaveBeenCalledWith(ORG_ID, PLUGIN_ID);
  });

  it("keeps plugin reads isolated to the Agent organization", async () => {
    const response = await request(createApp(createAgentActor(OTHER_ORG_ID)))
      .get(`/api/orgs/${ORG_ID}/plugins/${PLUGIN_ID}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Agent key cannot access another organization");
    expect(mockPlugins.getInstalled).not.toHaveBeenCalled();
  });
});
