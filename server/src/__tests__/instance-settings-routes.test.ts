import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getNotifications: vi.fn(),
  getExperimental: vi.fn(),
  updateGeneral: vi.fn(),
  updateNotifications: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockOperatorProfileService = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));
const mockBoardAuthService = vi.hoisted(() => ({
  resolveBoardActivityCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockUpdateConfigFile = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  boardAuthService: () => mockBoardAuthService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
  operatorProfileService: () => mockOperatorProfileService,
}));

vi.mock("../config.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../config-file.js", async () => {
  const actual = await vi.importActual<typeof import("../config-file.js")>("../config-file.js");
  return {
    ...actual,
    updateConfigFile: mockUpdateConfigFile,
  };
});

const mockPathPicker = vi.hoisted(() => ({
  pick: vi.fn(),
}));

vi.mock("../services/native-path-picker.js", () => ({
  NativePathPickerUnsupportedError: class NativePathPickerUnsupportedError extends Error {},
  createNativePathPicker: () => mockPathPicker,
}));

async function createApp(actor: any, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const { errorHandler } = await import("../middleware/index.js");
  const { instanceSettingsRoutes } = await import("../routes/instance-settings.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

describe("instance settings routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      locale: "en",
    });
    mockInstanceSettingsService.getNotifications.mockResolvedValue({
      desktopInboxNotifications: true,
      desktopDockBadge: true,
      desktopIssueNotifications: true,
      desktopChatNotifications: true,
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      autoRestartDevServerWhenIdle: false,
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: true,
        locale: "zh-CN",
      },
    });
    mockInstanceSettingsService.updateNotifications.mockResolvedValue({
      id: "instance-settings-1",
      notifications: {
        desktopInboxNotifications: false,
        desktopDockBadge: true,
        desktopIssueNotifications: false,
        desktopChatNotifications: true,
      },
    });
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({
      id: "instance-settings-1",
      experimental: {
        autoRestartDevServerWhenIdle: false,
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["organization-1", "organization-2"]);
    mockOperatorProfileService.get.mockResolvedValue({
      nickname: "Zee",
      moreAboutYou: "Builds agent workflows",
    });
    mockOperatorProfileService.update.mockResolvedValue({
      nickname: "Zee",
      moreAboutYou: "Builds agent workflows",
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["organization-1"]);
    mockPathPicker.pick.mockResolvedValue("/Users/test/project");
    mockLoadConfig.mockReturnValue({
      langfuse: {
        enabled: false,
        baseUrl: "http://localhost:3000",
        publicKey: "pk-lf-current",
        secretKey: "sk-lf-current",
        environment: "local",
      },
    });
    mockUpdateConfigFile.mockImplementation((mutator) => mutator({
      $meta: {
        version: 1,
        updatedAt: "2026-04-15T00:00:00.000Z",
        source: "configure",
      },
      database: {},
      logging: {},
      server: {},
      langfuse: {
        enabled: false,
        baseUrl: "http://localhost:3000",
        publicKey: "pk-lf-current",
        secretKey: "sk-lf-current",
        environment: "local",
      },
    }));
    delete process.env.LANGFUSE_ENABLED;
    delete process.env.LANGFUSE_BASE_URL;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_ENVIRONMENT;
  });

  it("allows local board users to read experimental settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/experimental");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      autoRestartDevServerWhenIdle: false,
    });
  });

  it("allows local board users to update guarded dev-server auto-restart", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ autoRestartDevServerWhenIdle: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      autoRestartDevServerWhenIdle: true,
    });
  });

  it("rejects removed isolated workspace experimental settings patches", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableIsolatedWorkspaces: true });

    expect(patchRes.status).toBe(400);
    expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
  });

  it("allows local board users to read and update general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/general");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ censorUsernameInLogs: false, locale: "en" });

    const patchRes = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: true, locale: "zh-CN" });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
      censorUsernameInLogs: true,
      locale: "zh-CN",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("allows local board users to read and update notification settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/notifications");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      desktopInboxNotifications: true,
      desktopDockBadge: true,
      desktopIssueNotifications: true,
      desktopChatNotifications: true,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/notifications")
      .send({ desktopIssueNotifications: false });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateNotifications).toHaveBeenCalledWith({
      desktopIssueNotifications: false,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("returns sanitized local langfuse settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/instance/settings/langfuse");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      baseUrl: "http://localhost:3000",
      publicKey: "pk-lf-current",
      environment: "prod",
      secretKeyConfigured: true,
      managedByEnv: false,
    });
  });

  it("preserves the stored secret key when patching langfuse with a blank secret", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    mockLoadConfig.mockReturnValueOnce({
      langfuse: {
        enabled: true,
        baseUrl: "https://cloud.langfuse.com",
        publicKey: "pk-lf-next",
        secretKey: "sk-lf-current",
        environment: "local",
      },
    });

    const res = await request(app)
      .patch("/api/instance/settings/langfuse")
      .send({
        enabled: true,
        baseUrl: "https://cloud.langfuse.com",
        publicKey: "pk-lf-next",
        secretKey: "",
        environment: "local",
      });

    expect(res.status).toBe(200);
    expect(mockUpdateConfigFile).toHaveBeenCalledTimes(1);
    const updatedConfig = mockUpdateConfigFile.mock.results[0]?.value;
    expect(updatedConfig.langfuse).toEqual({
      enabled: true,
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-lf-next",
      secretKey: "sk-lf-current",
      environment: "prod",
    });
    expect(res.body).toEqual({
      enabled: true,
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-lf-next",
      environment: "prod",
      secretKeyConfigured: true,
      managedByEnv: false,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("clears the stored secret key only when requested", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    mockLoadConfig.mockReturnValueOnce({
      langfuse: {
        enabled: false,
        baseUrl: "http://localhost:3000",
        publicKey: "pk-lf-current",
        secretKey: undefined,
        environment: "",
      },
    });

    const res = await request(app)
      .patch("/api/instance/settings/langfuse")
      .send({
        clearSecretKey: true,
      });

    expect(res.status).toBe(200);
    const updatedConfig = mockUpdateConfigFile.mock.results[0]?.value;
    expect(updatedConfig.langfuse).toEqual({
      enabled: false,
      baseUrl: "http://localhost:3000",
      publicKey: "pk-lf-current",
      environment: "prod",
    });
    expect(res.body.secretKeyConfigured).toBe(false);
  });

  it("rejects langfuse settings outside local_trusted mode", async () => {
    const app = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
    }, "authenticated");

    const res = await request(app).get("/api/instance/settings/langfuse");

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Langfuse settings are only available in local_trusted mode.",
    });
  });

  it("rejects langfuse writes when env vars manage the runtime", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-env";
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch("/api/instance/settings/langfuse")
      .send({ enabled: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Langfuse settings are managed by environment variables.",
    });
    expect(mockUpdateConfigFile).not.toHaveBeenCalled();
  });

  it("allows board users to read and update profile settings without instance admin access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      orgIds: ["organization-1"],
    });

    const getRes = await request(app).get("/api/instance/settings/profile");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      nickname: "Zee",
      moreAboutYou: "Builds agent workflows",
    });
    expect(mockOperatorProfileService.get).toHaveBeenCalledWith("user-1");

    const patchRes = await request(app)
      .patch("/api/instance/settings/profile")
      .send({ nickname: "  Zee  " });

    expect(patchRes.status).toBe(200);
    expect(mockOperatorProfileService.update).toHaveBeenCalledWith("user-1", {
      nickname: "  Zee  ",
    });
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("skips profile activity logging when the board user has no visible organizations", async () => {
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([]);

    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch("/api/instance/settings/profile")
      .send({ moreAboutYou: "Local operator" });

    expect(res.status).toBe(200);
    expect(mockOperatorProfileService.update).toHaveBeenCalledWith("local-board", {
      moreAboutYou: "Local operator",
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects non-admin board users", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      orgIds: ["organization-1"],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
  });

  it("rejects agent callers from operator profile settings", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/instance/settings/profile");

    expect(res.status).toBe(403);
    expect(mockOperatorProfileService.get).not.toHaveBeenCalled();
  });

  it("rejects anonymous callers from operator profile settings", async () => {
    const app = await createApp({
      type: "none",
      source: "none",
    });

    const res = await request(app).patch("/api/instance/settings/profile").send({ nickname: "Zee" });

    expect(res.status).toBe(403);
    expect(mockOperatorProfileService.update).not.toHaveBeenCalled();
  });

  it("opens the native path picker for local trusted board users", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/instance/path-picker")
      .send({ selectionType: "directory" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "/Users/test/project", cancelled: false });
    expect(mockPathPicker.pick).toHaveBeenCalledWith("directory");
  });

  it("returns unsupported for authenticated deployments", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: ["company-1"],
      },
      "authenticated",
    );

    const res = await request(app)
      .post("/api/instance/path-picker")
      .send({ selectionType: "file" });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Native path picker is only available in local_trusted mode.",
    });
    expect(mockPathPicker.pick).not.toHaveBeenCalled();
  });
});
