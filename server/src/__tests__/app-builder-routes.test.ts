import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { appBuilderRoutes } from "../routes/app-builder.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const otherOrgId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const appId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));
const mockAppBuilderService = vi.hoisted(() => ({
  listForOrganization: vi.fn(),
  getForProject: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  updateBuild: vi.fn(),
  attachConversation: vi.fn(),
  bindLocalRuntime: vi.fn(),
  clearLocalBinding: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  appBuilderService: () => mockAppBuilderService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

function appRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: appId,
    orgId,
    projectId,
    conversationId: null,
    name: "Cold Email CRM",
    sourceRoot: "apps/cold-email-crm",
    scaffoldVersion: "1",
    buildStatus: "preparing",
    latestBuildRunId: null,
    latestVerificationRunId: null,
    desktopInstallationId: null,
    appPublicId: null,
    localBindingId: null,
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    updatedAt: new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", appBuilderRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("App Builder routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue({ id: projectId, orgId });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      experimentalSitesEnabled: true,
    });
    mockAppBuilderService.listForOrganization.mockResolvedValue([appRecord()]);
    mockAppBuilderService.getForProject.mockResolvedValue(appRecord());
    mockAppBuilderService.getById.mockResolvedValue(appRecord());
    mockAppBuilderService.create.mockResolvedValue(appRecord());
    mockAppBuilderService.updateBuild.mockResolvedValue(
      appRecord({ buildStatus: "building", latestBuildRunId: runId }),
    );
    mockAppBuilderService.attachConversation.mockResolvedValue(
      appRecord({ conversationId: "66666666-6666-4666-8666-666666666666" }),
    );
    mockAppBuilderService.bindLocalRuntime.mockResolvedValue(
      appRecord({
        desktopInstallationId: "desktop_1",
        appPublicId: "app_1",
        localBindingId: "binding_1",
      }),
    );
    mockAppBuilderService.clearLocalBinding.mockResolvedValue(appRecord());
  });

  it("rejects App Builder API access while Sites is disabled", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValueOnce({
      experimentalSitesEnabled: false,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app).get(`/api/orgs/${orgId}/app-builder`);

    expect(response.status).toBe(403);
    expect(mockAppBuilderService.listForOrganization).not.toHaveBeenCalled();
  });

  it("lists only Apps in an organization the actor can access", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app).get(`/api/orgs/${orgId}/app-builder`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(mockAppBuilderService.listForOrganization).toHaveBeenCalledWith(orgId);
  });

  it("creates an organization App without a backing Project", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .post(`/api/orgs/${orgId}/app-builder`)
      .send({
        name: "Cold Email CRM",
        sourceRoot: "apps/cold-email-crm-aabbccdd",
        scaffoldVersion: "1",
      });

    expect(response.status).toBe(201);
    expect(mockAppBuilderService.create).toHaveBeenCalledWith(orgId, {
      name: "Cold Email CRM",
      sourceRoot: "apps/cold-email-crm-aabbccdd",
      scaffoldVersion: "1",
    });
  });

  it("creates one Project app and records a safe activity", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .post(`/api/projects/${projectId}/app-builder`)
      .send({
        name: "Cold Email CRM",
        sourceRoot: "apps/cold-email-crm",
        scaffoldVersion: "1",
      });

    expect(response.status).toBe(201);
    expect(mockAppBuilderService.create).toHaveBeenCalledWith(orgId, {
      name: "Cold Email CRM",
      projectId,
      sourceRoot: "apps/cold-email-crm",
      scaffoldVersion: "1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId,
        actorType: "user",
        action: "app_builder.created",
        entityType: "app_builder_app",
        entityId: appId,
      }),
    );
  });

  it("allows only the board actor to create a Project app", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId,
      runId,
    });

    const response = await request(app)
      .post(`/api/projects/${projectId}/app-builder`)
      .send({
        name: "Cold Email CRM",
        sourceRoot: "apps/cold-email-crm",
        scaffoldVersion: "1",
      });

    expect(response.status).toBe(403);
    expect(mockAppBuilderService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects unsafe source roots before invoking the service", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .post(`/api/projects/${projectId}/app-builder`)
      .send({
        name: "Unsafe App",
        sourceRoot: "../outside",
        scaffoldVersion: "1",
      });

    expect(response.status).toBe(400);
    expect(mockAppBuilderService.create).not.toHaveBeenCalled();
  });

  it("prevents an agent from reading a Project in another organization", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-2",
      orgId: otherOrgId,
    });

    const response = await request(app).get(
      `/api/projects/${projectId}/app-builder`,
    );

    expect(response.status).toBe(403);
    expect(mockAppBuilderService.getForProject).not.toHaveBeenCalled();
  });

  it("records a build-start activity tied to the reviewed run", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId,
      runId,
    });

    const response = await request(app)
      .patch(`/api/projects/${projectId}/app-builder/build`)
      .send({ status: "building", runId });

    expect(response.status).toBe(200);
    expect(mockAppBuilderService.updateBuild).toHaveBeenCalledWith(
      orgId,
      appId,
      {
        status: "building",
        runId,
        runKind: "build",
      },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "app_builder.build_started",
        entityId: appId,
        details: {
          projectId,
          status: "building",
          runKind: "build",
          runId,
        },
      }),
    );
  });

  it("rejects Agent build updates without the authenticated run ID", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId,
      runId,
    });

    const missingRunResponse = await request(app)
      .patch(`/api/projects/${projectId}/app-builder/build`)
      .send({ status: "ready" });
    expect(missingRunResponse.status).toBe(403);

    const mismatchedRunResponse = await request(app)
      .patch(`/api/projects/${projectId}/app-builder/build`)
      .send({
        status: "ready",
        runId: "66666666-6666-4666-8666-666666666666",
      });
    expect(mismatchedRunResponse.status).toBe(403);
    expect(mockAppBuilderService.updateBuild).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("attaches a reserved App to its Chat as a board mutation", async () => {
    const conversationId = "66666666-6666-4666-8666-666666666666";
    const app = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .patch(`/api/app-builder/${appId}/conversation?orgId=${orgId}`)
      .send({ conversationId });

    expect(response.status).toBe(200);
    expect(mockAppBuilderService.attachConversation).toHaveBeenCalledWith(
      orgId,
      appId,
      { conversationId },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "app_builder.conversation_attached",
        entityId: appId,
      }),
    );
  });

  it("allows only the board actor to attach opaque local bindings", async () => {
    const agentApp = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId,
    });
    const agentResponse = await request(agentApp)
      .put(`/api/projects/${projectId}/app-builder/local-binding`)
      .send({
        desktopInstallationId: "desktop_1",
        appPublicId: "app_1",
        localBindingId: "binding_1",
      });
    expect(agentResponse.status).toBe(403);
    expect(mockAppBuilderService.bindLocalRuntime).not.toHaveBeenCalled();

    const boardApp = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const boardResponse = await request(boardApp)
      .put(`/api/projects/${projectId}/app-builder/local-binding`)
      .send({
        desktopInstallationId: "desktop_1",
        appPublicId: "app_1",
        localBindingId: "binding_1",
      });

    expect(boardResponse.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "app_builder.local_binding_attached",
        details: { projectId },
      }),
    );
    expect(mockLogActivity.mock.calls.at(-1)?.[1].details).not.toHaveProperty(
      "localBindingId",
    );
  });
});
