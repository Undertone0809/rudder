import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getBrowser: vi.fn(),
  getGeneral: vi.fn(),
  getNotifications: vi.fn(),
  updateBrowser: vi.fn(),
  updateGeneral: vi.fn(),
  updateNotifications: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockOperatorProfileService = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  getShortcuts: vi.fn(),
  updateShortcuts: vi.fn(),
}));
const mockBoardAuthService = vi.hoisted(() => ({
  resolveBoardActivityCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  boardAuthService: () => mockBoardAuthService,
  instanceSettingsService: () => mockInstanceSettingsService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: mockLogActivity,
  operatorProfileService: () => mockOperatorProfileService,
}));

const mockPathPicker = vi.hoisted(() => ({
  pick: vi.fn(),
}));

vi.mock("../services/native-path-picker.js", () => ({
  NativePathPickerUnsupportedError: class NativePathPickerUnsupportedError extends Error {},
  createNativePathPicker: () => mockPathPicker,
}));

const mockProductAnalytics = vi.hoisted(() => ({
  getProductAnalyticsInstallationState: vi.fn(),
  reconcileProductAnalyticsInstallationMode: vi.fn(),
  recordProductAnalyticsConsent: vi.fn(),
  registerProductAnalyticsInstallation: vi.fn(),
}));

vi.mock("../services/product-analytics.js", () => mockProductAnalytics);

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
      showDeveloperDiagnostics: false,
      experimentalSitesEnabled: false,
      locale: "en",
    });
    mockInstanceSettingsService.getNotifications.mockResolvedValue({
      desktopInboxNotifications: true,
      desktopDockBadge: true,
      desktopIssueNotifications: true,
      desktopChatNotifications: true,
    });
    mockInstanceSettingsService.getBrowser.mockResolvedValue({
      enabled: true,
      openLinksIn: "built_in",
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: true,
        showDeveloperDiagnostics: true,
        experimentalSitesEnabled: false,
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
    mockInstanceSettingsService.updateBrowser.mockResolvedValue({
      id: "instance-settings-1",
      browser: {
        enabled: false,
        openLinksIn: "default_browser",
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
    mockOperatorProfileService.getShortcuts.mockResolvedValue({ shortcuts: [] });
    mockOperatorProfileService.updateShortcuts.mockImplementation(async (_userId, patch) => patch);
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["organization-1"]);
    mockPathPicker.pick.mockResolvedValue("/Users/test/project");
    mockProductAnalytics.getProductAnalyticsInstallationState.mockResolvedValue(null);
    mockProductAnalytics.registerProductAnalyticsInstallation.mockResolvedValue({ installation: null, installationSecret: null });
    mockProductAnalytics.recordProductAnalyticsConsent.mockResolvedValue(null);
    mockProductAnalytics.reconcileProductAnalyticsInstallationMode.mockResolvedValue(null);
  });

  it("does not expose account-linked payload previews through installation settings", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      productAnalyticsMode: "account_linked",
      productAnalyticsConsentEpoch: 4,
    });
    mockProductAnalytics.getProductAnalyticsInstallationState.mockResolvedValue({
      pendingCount: 1,
      installation: {
        installationId: "installation-analytics",
        state: {
          lastPayloadMode: "account_linked",
          lastPayloadAt: "2026-08-04T09:00:00.000Z",
          lastPayload: [{ eventName: "work_loop_completed", pseudonymousOrgId: "org-hash-a" }],
        },
      },
    });

    const response = await request(await createApp({
      type: "board",
      userId: "user-b",
      source: "session",
      isInstanceAdmin: true,
    })).get("/api/instance/settings/product-analytics");

    expect(response.status).toBe(200);
    expect(response.body.lastPayload).toBeNull();
    expect(response.body.lastPayloadAt).toBeNull();
  });

  it("exposes only explicitly anonymous payload previews", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      productAnalyticsMode: "anonymous",
      productAnalyticsConsentEpoch: 2,
    });
    mockProductAnalytics.getProductAnalyticsInstallationState.mockResolvedValue({
      pendingCount: 0,
      installation: {
        installationId: "installation-analytics",
        state: {
          lastPayloadMode: "anonymous",
          lastPayloadAt: "2026-08-04T09:00:00.000Z",
          lastPayload: [{ eventName: "work_loop_completed", pseudonymousOrgId: "org-hash" }],
        },
      },
    });

    const response = await request(await createApp({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
    })).get("/api/instance/settings/product-analytics");

    expect(response.status).toBe(200);
    expect(response.body.lastPayload).toEqual([{ eventName: "work_loop_completed", pseudonymousOrgId: "org-hash" }]);
    expect(response.body.lastPayloadAt).toBe("2026-08-04T09:00:00.000Z");
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
    expect(getRes.body).toEqual({
      censorUsernameInLogs: false,
      showDeveloperDiagnostics: false,
      experimentalSitesEnabled: false,
      locale: "en",
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: true, showDeveloperDiagnostics: true, locale: "zh-CN" });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
      censorUsernameInLogs: true,
      showDeveloperDiagnostics: true,
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

  it("allows local implicit board users to read and update Browser settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const getRes = await request(app).get("/api/instance/settings/browser");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      enabled: true,
      openLinksIn: "built_in",
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/browser")
      .send({ openLinksIn: "default_browser", enabled: false });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual({
      enabled: false,
      openLinksIn: "default_browser",
    });
    expect(mockInstanceSettingsService.updateBrowser).toHaveBeenCalledWith({
      openLinksIn: "default_browser",
      enabled: false,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity.mock.calls.map(([, event]) => event)).toEqual([
      expect.objectContaining({
        orgId: "organization-1",
        action: "instance.settings.browser_updated",
        entityType: "instance_settings",
        entityId: "instance-settings-1",
        details: {
          settings: {
            enabled: false,
            openLinksIn: "default_browser",
          },
          changedKeys: ["enabled", "openLinksIn"],
        },
      }),
      expect.objectContaining({
        orgId: "organization-2",
        action: "instance.settings.browser_updated",
        entityType: "instance_settings",
        entityId: "instance-settings-1",
        details: {
          settings: {
            enabled: false,
            openLinksIn: "default_browser",
          },
          changedKeys: ["enabled", "openLinksIn"],
        },
      }),
    ]);
    for (const [, event] of mockLogActivity.mock.calls) {
      expect(Object.keys(event.details).sort()).toEqual(["changedKeys", "settings"]);
    }
  });

  it("rejects Browser settings outside local_trusted mode", async () => {
    const app = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
    }, "authenticated");

    const getRes = await request(app).get("/api/instance/settings/browser");
    const patchRes = await request(app)
      .patch("/api/instance/settings/browser")
      .send({ enabled: false });

    expect(getRes.status).toBe(422);
    expect(getRes.body).toEqual({
      error: "Browser settings are only available in local_trusted mode.",
    });
    expect(patchRes.status).toBe(422);
    expect(patchRes.body).toEqual({
      error: "Browser settings are only available in local_trusted mode.",
    });
    expect(mockInstanceSettingsService.getBrowser).not.toHaveBeenCalled();
    expect(mockInstanceSettingsService.updateBrowser).not.toHaveBeenCalled();
  });

  it("rejects non-admin and agent callers from Browser settings", async () => {
    const nonAdminApp = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      orgIds: ["organization-1"],
    });
    const agentApp = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
    });

    const nonAdminRes = await request(nonAdminApp).get("/api/instance/settings/browser");
    const agentRes = await request(agentApp)
      .patch("/api/instance/settings/browser")
      .send({ enabled: false });

    expect(nonAdminRes.status).toBe(403);
    expect(agentRes.status).toBe(403);
    expect(mockInstanceSettingsService.getBrowser).not.toHaveBeenCalled();
    expect(mockInstanceSettingsService.updateBrowser).not.toHaveBeenCalled();
  });

  it("rejects unknown Browser patch fields before persistence", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch("/api/instance/settings/browser")
      .send({ profilePath: "/tmp/profile" });

    expect(res.status).toBe(400);
    expect(mockInstanceSettingsService.updateBrowser).not.toHaveBeenCalled();
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

  it("allows board users to read and update shortcut settings without instance admin access", async () => {
    mockOperatorProfileService.getShortcuts.mockResolvedValue({
      shortcuts: [{ actionId: "issue.create", disabled: true }],
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      orgIds: ["organization-1"],
    });

    const getRes = await request(app).get("/api/instance/settings/shortcuts");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      shortcuts: [{ actionId: "issue.create", disabled: true }],
    });
    expect(mockOperatorProfileService.getShortcuts).toHaveBeenCalledWith("user-1");

    const patch = {
      shortcuts: [
        {
          actionId: "commandPalette.open",
          bindings: [{ key: "p", metaKey: true }],
        },
      ],
    };
    const patchRes = await request(app)
      .patch("/api/instance/settings/shortcuts")
      .send(patch);

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual(patch);
    expect(mockOperatorProfileService.updateShortcuts).toHaveBeenCalledWith("user-1", patch);
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "instance.settings.shortcuts_updated",
      entityType: "operator_profile",
      entityId: "user-1",
      details: {
        shortcutActionIds: ["commandPalette.open"],
        disabledActionIds: [],
      },
    }));
  });

  it("rejects unknown shortcut action ids before service update", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      orgIds: ["organization-1"],
    });

    const res = await request(app)
      .patch("/api/instance/settings/shortcuts")
      .send({ shortcuts: [{ actionId: "system.escapeBack", disabled: true }] });

    expect(res.status).toBe(400);
    expect(mockOperatorProfileService.updateShortcuts).not.toHaveBeenCalled();
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

  it("rejects agent callers from shortcut settings", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/instance/settings/shortcuts");

    expect(res.status).toBe(403);
    expect(mockOperatorProfileService.getShortcuts).not.toHaveBeenCalled();
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
