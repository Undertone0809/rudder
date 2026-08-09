import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockAgentIntegrationService = vi.hoisted(() => ({
  create: vi.fn(),
  listForAgent: vi.fn(),
  markErrorForAgent: vi.fn(),
  revokeForAgent: vi.fn(),
  updateSettingsForAgent: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));
const mockFeishuAppRegistrationSessions = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  takeResult: vi.fn(),
  markCompleted: vi.fn(),
}));
const mockFeishuUserBindings = vi.hoisted(() => ({
  bindActiveOrgUserByOpenId: vi.fn(),
}));
const mockEnsureFeishuIntegrationRuntimeStarted = vi.hoisted(() => vi.fn());
const mockStopFeishuIntegrationRuntime = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    getMembership: vi.fn(),
    listPrincipalGrants: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
  }),
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
  }),
  agentService: () => mockAgentService,
  agentIntegrationService: () => mockAgentIntegrationService,
  approvalService: () => ({ create: vi.fn() }),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({}),
  logActivity: vi.fn(),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  organizationSkillService: () => ({}),
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/integrations/feishu/app-registration.js", () => ({
  defaultFeishuAppRegistrationSessions: mockFeishuAppRegistrationSessions,
}));

vi.mock("../services/integrations/feishu/runtime-registry.js", () => ({
  ensureFeishuIntegrationRuntimeStarted: mockEnsureFeishuIntegrationRuntimeStarted,
  stopFeishuIntegrationRuntime: mockStopFeishuIntegrationRuntime,
}));

vi.mock("../services/integrations/feishu/user-bindings.js", () => ({
  feishuIntegrationUserBindingService: () => mockFeishuUserBindings,
}));

vi.mock("../services/integrations/agent-integrations.js", () => ({
  agentIntegrationService: () => mockAgentIntegrationService,
  summarizeAgentIntegration: (row: Record<string, unknown>) => {
    const { appCredentialSecretId: _appCredentialSecretId, ...rest } = row;
    return {
      ...rest,
      hasCredentialSecret: Boolean(_appCredentialSecretId),
    };
  },
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: vi.fn(() => null),
  listAgentRuntimeModels: vi.fn(),
}));

const activeServers = new Set<Server>();

async function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

afterEach(async () => {
  await Promise.all(Array.from(activeServers, (server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  activeServers.clear();
});

function makeAgent() {
  return {
    id: agentId,
    orgId,
    name: "Builder",
    urlKey: "builder",
    role: "engineer",
    status: "active",
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    permissions: { canCreateAgents: false, canManageSkills: true },
  };
}

describe("agent integration setup URL routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentIntegrationService.create.mockResolvedValue({
      id: "integration-1",
      orgId,
      agentId,
      provider: "feishu",
      status: "active",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: "44444444-4444-4444-8444-444444444444",
      externalAppId: "cli_registered",
      externalBotOpenId: null,
      externalTenantKey: null,
      installerUserId: "ou_installer",
      manageUrl: "https://open.feishu.cn/app/cli_registered",
      installedAt: new Date("2026-06-21T00:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-06-21T00:00:00.000Z"),
      updatedAt: new Date("2026-06-21T00:00:00.000Z"),
    });
    mockAgentIntegrationService.updateSettingsForAgent.mockResolvedValue({
      id: "integration-1",
      orgId,
      agentId,
      provider: "feishu",
      status: "active",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: "44444444-4444-4444-8444-444444444444",
      externalAppId: "cli_registered",
      externalBotOpenId: null,
      externalTenantKey: null,
      installerUserId: "ou_installer",
      manageUrl: "https://open.feishu.cn/app/cli_registered",
      settings: {
        feishu: {
          dailySessionRolloverEnabled: true,
          dailySessionRolloverHours: 24,
          dailySessionRolloverNotifyFeishu: false,
        },
      },
      installedAt: new Date("2026-06-21T00:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-06-21T00:00:00.000Z"),
      updatedAt: new Date("2026-06-21T00:00:00.000Z"),
    });
    mockSecretService.create.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      orgId,
      name: "Feishu app credentials - Builder - Rudder - cli_registered",
      provider: "local_encrypted",
      externalRef: null,
      latestVersion: 1,
      description: null,
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt: new Date("2026-06-21T00:00:00.000Z"),
      updatedAt: new Date("2026-06-21T00:00:00.000Z"),
    });
    mockFeishuUserBindings.bindActiveOrgUserByOpenId.mockResolvedValue({
      id: "binding-1",
      orgId,
      integrationId: "integration-1",
      userId: "user-1",
      externalOpenId: "ou_installer",
      externalUnionId: null,
      boundAt: new Date("2026-06-21T00:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-06-21T00:00:00.000Z"),
      updatedAt: new Date("2026-06-21T00:00:00.000Z"),
    });
    mockAgentIntegrationService.markErrorForAgent.mockResolvedValue(null);
    mockEnsureFeishuIntegrationRuntimeStarted.mockResolvedValue({ enabled: true, started: 1, running: true });
    mockStopFeishuIntegrationRuntime.mockResolvedValue({ enabled: true, stopped: true });
  });

  it("returns a browser-openable Feishu launcher URL with a prefilled bot name for board users", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-url?providerRegion=lark_global`)
      .set("Host", "rudder.example.test");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      provider: "feishu",
      providerRegion: "lark_global",
      suggestedBotName: "Builder - Rudder",
      expiresAt: null,
    });

    const setupUrl = new URL(res.body.setupUrl);
    expect(setupUrl.origin).toBe("https://open.larksuite.com");
    expect(setupUrl.pathname).toBe("/page/launcher");
    expect(setupUrl.searchParams.get("from")).toBe("sdk");
    expect(setupUrl.searchParams.get("name")).toBe("Builder - Rudder");
    expect(setupUrl.searchParams.get("source")).toBe("rudder/agent-integrations");
    expect(setupUrl.searchParams.get("tp")).toBe("sdk");
    expect(setupUrl.searchParams.get("agentId")).toBe(agentId);
    expect(setupUrl.searchParams.get("orgId")).toBe(orgId);
    expect(setupUrl.searchParams.get("region")).toBe("lark_global");
    expect(setupUrl.searchParams.get("transport")).toBe("long_connection");
    expect(setupUrl.searchParams.get("callbackUrl")).toBe(
      `http://rudder.example.test/api/orgs/${orgId}/integrations/feishu/mock-inbound`,
    );
  });

  it("keeps long prefilled Feishu bot names within the launcher field limit", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      name: "ZST613 Bot 1782103161531",
    });

    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-url`)
      .set("Host", "rudder.example.test");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.suggestedBotName).toBe("ZST613 Bot 178210316153 - Rudder");
    expect(res.body.suggestedBotName).toHaveLength(32);

    const setupUrl = new URL(res.body.setupUrl);
    expect(setupUrl.searchParams.get("name")).toBe("ZST613 Bot 178210316153 - Rudder");
  });

  it("denies setup URL generation for agents from another organization", async () => {
    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-from-other-org",
      orgId: "33333333-3333-4333-8333-333333333333",
      source: "agent_key",
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-url`);

    expect(res.status).toBe(403);
  });

  it("starts a Feishu app registration setup session for board users", async () => {
    mockFeishuAppRegistrationSessions.start.mockResolvedValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      suggestedBotName: "Builder - Rudder",
      status: "waiting_for_authorization",
      statusDetail: "Waiting for Feishu authorization",
      expiresAt: new Date("2026-06-21T00:10:00.000Z"),
      integration: null,
    });

    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/agents/${agentId}/integrations/feishu/setup-sessions`)
      .send({ providerRegion: "feishu_cn" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockFeishuAppRegistrationSessions.start).toHaveBeenCalledWith(expect.objectContaining({
      orgId,
      agentId,
      providerRegion: "feishu_cn",
      suggestedBotName: "Builder - Rudder",
      onAuthorizationComplete: expect.any(Function),
    }));
    expect(res.body).toMatchObject({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      status: "waiting_for_authorization",
      integration: null,
    });
  });

  it("updates Feishu daily session notification settings for board users", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch(`/api/agents/${agentId}/integrations/integration-1/settings`)
      .send({
        settings: {
          feishu: {
            dailySessionRolloverEnabled: true,
            dailySessionRolloverHours: 24,
            dailySessionRolloverNotifyFeishu: false,
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentIntegrationService.updateSettingsForAgent).toHaveBeenCalledWith(
      orgId,
      agentId,
      "integration-1",
      {
        feishu: {
          dailySessionRolloverEnabled: true,
          dailySessionRolloverHours: 24,
          dailySessionRolloverNotifyFeishu: false,
        },
      },
    );
    expect(res.body).toMatchObject({
      id: "integration-1",
      hasCredentialSecret: true,
      settings: {
        feishu: {
          dailySessionRolloverNotifyFeishu: false,
        },
      },
    });
  });

  it("polls a completed Feishu app registration and persists the integration", async () => {
    mockFeishuAppRegistrationSessions.get.mockReturnValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      suggestedBotName: "Builder - Rudder",
      status: "waiting_for_authorization",
      statusDetail: "polling",
      expiresAt: new Date("2026-06-21T00:10:00.000Z"),
      integration: null,
    });
    mockFeishuAppRegistrationSessions.takeResult.mockReturnValue({
      appId: "cli_registered",
      appSecret: "secret_registered",
      installerUserId: "ou_installer",
      installerUnionId: "on_installer",
    });
    mockFeishuAppRegistrationSessions.markCompleted.mockReturnValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      suggestedBotName: "Builder - Rudder",
      status: "completed",
      statusDetail: "Connected",
      expiresAt: new Date("2026-06-21T00:10:00.000Z"),
      integration: {
        id: "integration-1",
        orgId,
        agentId,
        provider: "feishu",
        status: "active",
        transport: "long_connection",
        providerRegion: "feishu_cn",
        hasCredentialSecret: true,
        externalAppId: "cli_registered",
        externalBotOpenId: null,
        externalTenantKey: null,
        installerUserId: "ou_installer",
        manageUrl: "https://open.feishu.cn/app/cli_registered",
        installedAt: new Date("2026-06-21T00:00:00.000Z"),
        revokedAt: null,
        createdAt: new Date("2026-06-21T00:00:00.000Z"),
        updatedAt: new Date("2026-06-21T00:00:00.000Z"),
      },
    });

    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-sessions/session-1`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockFeishuAppRegistrationSessions.get).toHaveBeenCalledWith({
      id: "session-1",
      orgId,
      agentId,
    });
    expect(mockSecretService.create).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        name: "Feishu app credentials - Builder - Rudder - cli_registered",
        provider: "local_encrypted",
        value: JSON.stringify({ appId: "cli_registered", appSecret: "secret_registered" }),
      }),
      { userId: "user-1", agentId: null },
    );
    expect(mockAgentIntegrationService.create).toHaveBeenCalledWith(orgId, expect.objectContaining({
      agentId,
      provider: "feishu",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: "44444444-4444-4444-8444-444444444444",
      externalAppId: "cli_registered",
      installerUserId: "ou_installer",
      manageUrl: "https://open.feishu.cn/app/cli_registered",
    }));
    expect(mockFeishuUserBindings.bindActiveOrgUserByOpenId).toHaveBeenCalledWith({
      orgId,
      integrationId: "integration-1",
      userId: "user-1",
      externalOpenId: "ou_installer",
      externalUnionId: "on_installer",
    });
    expect(mockEnsureFeishuIntegrationRuntimeStarted).toHaveBeenCalledWith(
      "integration-1",
      "feishu_setup_session_completed",
    );
    expect(res.body).toMatchObject({
      status: "completed",
      integration: {
        externalAppId: "cli_registered",
        hasCredentialSecret: true,
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("secret_registered");
  });

  it("marks setup failed when the new Feishu chat runtime does not start", async () => {
    mockFeishuAppRegistrationSessions.get.mockReturnValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      suggestedBotName: "Builder - Rudder",
      status: "waiting_for_authorization",
      statusDetail: "polling",
      expiresAt: new Date("2026-06-21T00:10:00.000Z"),
      integration: null,
    });
    mockFeishuAppRegistrationSessions.takeResult.mockReturnValue({
      appId: "cli_registered",
      appSecret: "secret_registered",
      installerUserId: "ou_installer",
      installerUnionId: "on_installer",
    });
    mockEnsureFeishuIntegrationRuntimeStarted.mockResolvedValue({ enabled: true, started: 0, running: false });

    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-sessions/session-1`);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("could not start its chat connection");
    expect(mockAgentIntegrationService.markErrorForAgent).toHaveBeenCalledWith(orgId, agentId, "integration-1");
    expect(mockFeishuAppRegistrationSessions.markCompleted).not.toHaveBeenCalled();
  });

  it("auto-binds the installer identity to the implicit local board user", async () => {
    mockFeishuAppRegistrationSessions.get.mockReturnValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      suggestedBotName: "Builder - Rudder",
      status: "waiting_for_authorization",
      statusDetail: "polling",
      expiresAt: new Date("2026-06-21T00:10:00.000Z"),
      integration: null,
    });
    mockFeishuAppRegistrationSessions.takeResult.mockReturnValue({
      appId: "cli_registered",
      appSecret: "secret_registered",
      installerUserId: "ou_installer",
      installerUnionId: "on_installer",
    });
    mockFeishuAppRegistrationSessions.markCompleted.mockReturnValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      suggestedBotName: "Builder - Rudder",
      status: "completed",
      statusDetail: "Connected",
      expiresAt: new Date("2026-06-21T00:10:00.000Z"),
      integration: {
        id: "integration-1",
        orgId,
        agentId,
        provider: "feishu",
        status: "active",
        transport: "long_connection",
        providerRegion: "feishu_cn",
        hasCredentialSecret: true,
        externalAppId: "cli_registered",
        externalBotOpenId: null,
        externalTenantKey: null,
        installerUserId: "ou_installer",
        manageUrl: "https://open.feishu.cn/app/cli_registered",
        installedAt: new Date("2026-06-21T00:00:00.000Z"),
        revokedAt: null,
        createdAt: new Date("2026-06-21T00:00:00.000Z"),
        updatedAt: new Date("2026-06-21T00:00:00.000Z"),
      },
    });

    const res = await request(await createApp({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-sessions/session-1`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockFeishuUserBindings.bindActiveOrgUserByOpenId).toHaveBeenCalledWith({
      orgId,
      integrationId: "integration-1",
      userId: "local-board",
      externalOpenId: "ou_installer",
      externalUnionId: "on_installer",
    });
  });

  it("does not expose setup sessions outside the current agent boundary", async () => {
    mockFeishuAppRegistrationSessions.get.mockReturnValue(null);

    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-sessions/session-other`);

    expect(res.status).toBe(404);
    expect(mockFeishuAppRegistrationSessions.get).toHaveBeenCalledWith({
      id: "session-other",
      orgId,
      agentId,
    });
    expect(mockFeishuAppRegistrationSessions.takeResult).not.toHaveBeenCalled();
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockAgentIntegrationService.create).not.toHaveBeenCalled();
  });

  it("returns an already-completed setup session without persisting credentials again", async () => {
    mockFeishuAppRegistrationSessions.get.mockReturnValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?from=sdk&name=Builder+-+Rudder",
      suggestedBotName: "Builder - Rudder",
      status: "completed",
      statusDetail: "Connected",
      expiresAt: new Date("2026-06-21T00:10:00.000Z"),
      integration: {
        id: "integration-1",
        orgId,
        agentId,
        provider: "feishu",
        status: "active",
        transport: "long_connection",
        providerRegion: "feishu_cn",
        hasCredentialSecret: true,
        externalAppId: "cli_registered",
        externalBotOpenId: null,
        externalTenantKey: null,
        installerUserId: "ou_installer",
        manageUrl: "https://open.feishu.cn/app/cli_registered",
        installedAt: new Date("2026-06-21T00:00:00.000Z"),
        revokedAt: null,
        createdAt: new Date("2026-06-21T00:00:00.000Z"),
        updatedAt: new Date("2026-06-21T00:00:00.000Z"),
      },
    });

    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-sessions/session-1`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: "completed",
      integration: {
        externalAppId: "cli_registered",
        hasCredentialSecret: true,
      },
    });
    expect(mockFeishuAppRegistrationSessions.takeResult).not.toHaveBeenCalled();
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockAgentIntegrationService.create).not.toHaveBeenCalled();
  });
});
