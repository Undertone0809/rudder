import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { requestBodyForLogs } from "../middleware/logger.js";
import { managedMcpConnectionRoutes } from "../routes/managed-mcp-connections.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";

const mockMembership = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockService = vi.hoisted(() => ({
  catalog: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  ensureOfficial: vi.fn(),
  prepareSupabaseAccountUpgrade: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reconnect: vi.fn(),
  refreshTools: vi.fn(),
  disconnect: vi.fn(),
  listTools: vi.fn(),
}));
const mockOAuthService = vi.hoisted(() => ({
  start: vi.fn(),
  callback: vi.fn(),
  getGrantSummary: vi.fn(),
  listScopeOptions: vi.fn(),
  selectScope: vi.fn(),
  createCredential: vi.fn(),
  revoke: vi.fn(),
}));
const mockBindingService = vi.hoisted(() => ({
  listProviderAvailability: vi.fn(),
}));
let capturedErrorBody: unknown;

vi.mock("../services/index.js", () => ({
  accessService: () => ({ getMembership: mockMembership }),
  logActivity: mockLogActivity,
  managedMcpConnectionService: () => mockService,
  managedMcpOAuthService: () => mockOAuthService,
  managedMcpBindingService: () => mockBindingService,
}));

function connectionSummary() {
  return {
    id: connectionId,
    orgId,
    name: "custom-http",
    displayName: "Custom HTTP",
    provider: "custom",
    transport: "streamable_http",
    externalScope: null,
    accessMode: "provider_default",
    status: "draft",
    safeConfig: {
      url: "https://mcp.example.test/mcp",
      secretHeaderNames: ["Authorization"],
    },
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 60_000,
    enabled: true,
    required: false,
    hasCredentials: true,
    lastDiscoveredAt: null,
    activatedAt: null,
    disabledAt: null,
    revokedAt: null,
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
    updatedAt: new Date("2026-07-23T00:00:00.000Z"),
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", managedMcpConnectionRoutes({} as never, {
    deploymentMode: "authenticated",
    serverPort: 3100,
    authPublicBaseUrl: "https://rudder.example.test",
    allowlists: {
      httpOrigins: [],
      stdioCommands: [],
      stdioWorkingDirectories: [],
      stdioEnvironmentNames: [],
    },
    hostEnv: {},
  }));
  app.use((error: unknown, req: express.Request, _res: express.Response, next: express.NextFunction) => {
    capturedErrorBody = requestBodyForLogs(req, req.body);
    next(error);
  });
  app.use(errorHandler);
  return app;
}

describe("managed MCP connection organization routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedErrorBody = undefined;
    mockMembership.mockResolvedValue({
      status: "active",
      membershipRole: "owner",
    });
    mockService.catalog.mockReturnValue([{ id: "supabase" }]);
    mockService.list.mockResolvedValue([connectionSummary()]);
    mockService.get.mockResolvedValue(connectionSummary());
    mockService.ensureOfficial.mockResolvedValue(connectionSummary());
    mockService.prepareSupabaseAccountUpgrade.mockResolvedValue(connectionSummary());
    mockService.create.mockResolvedValue(connectionSummary());
    mockService.update.mockResolvedValue(connectionSummary());
    mockService.reconnect.mockResolvedValue(connectionSummary());
    mockService.disconnect.mockResolvedValue({ ...connectionSummary(), status: "disabled" });
    mockService.listTools.mockResolvedValue([]);
    mockService.refreshTools.mockResolvedValue([]);
    mockBindingService.listProviderAvailability.mockResolvedValue([]);
    mockOAuthService.createCredential.mockReturnValue({
      token: vi.fn(),
      refresh: vi.fn(),
    });
    mockOAuthService.start.mockResolvedValue({
      connectionId,
      authorizationUrl: "https://oauth.example.test/authorize",
      expiresAt: new Date("2026-07-23T00:10:00.000Z"),
    });
    mockOAuthService.callback.mockResolvedValue({ connectionId, status: "active" });
    mockOAuthService.getGrantSummary.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      connectionId,
      status: "active",
      hasCredentials: true,
    });
    mockOAuthService.listScopeOptions.mockResolvedValue([]);
    mockOAuthService.selectScope.mockResolvedValue(connectionSummary());
    mockOAuthService.revoke.mockResolvedValue({
      ...connectionSummary(),
      provider: "linear",
      status: "revoked",
      enabled: false,
    });
  });

  it("allows organization members to read catalog, connections, and tools", async () => {
    const app = createApp({
      type: "board",
      userId: "member-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    expect((await request(app).get(`/api/orgs/${orgId}/mcp/providers`)).status).toBe(200);
    expect((await request(app).get(`/api/orgs/${orgId}/mcp/connections`)).status).toBe(200);
    expect((await request(app).get(`/api/orgs/${orgId}/mcp/provider-status`)).status)
      .toBe(200);
    expect((await request(app).get(
      `/api/orgs/${orgId}/mcp/connections/${connectionId}/tools`,
    )).status).toBe(200);
    expect(mockMembership).not.toHaveBeenCalled();
  });

  it("atomically ensures an official provider through the provider-level connect endpoint", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .post(`/api/orgs/${orgId}/mcp/providers/supabase/connect`)
      .send({ scope: "organization", accessMode: "read_only" });

    expect(response.status).toBe(200);
    expect(mockService.ensureOfficial).toHaveBeenCalledWith(
      orgId,
      "supabase",
      {
        scope: "organization",
        ownerAgentId: null,
        accessMode: "read_only",
      },
      { userId: "owner-1", agentId: null },
    );
  });

  it("connects GitHub with a transient PAT without entering the OAuth flow", async () => {
    const github = {
      ...connectionSummary(),
      provider: "github",
      status: "active",
      safeConfig: {
        endpoint: "https://api.githubcopilot.com/mcp/",
        scopeMode: "account",
      },
    };
    mockService.ensureOfficial.mockResolvedValueOnce(github);
    mockService.get.mockResolvedValueOnce(github);
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const pat = "github_pat_12345678901234567890";

    const response = await request(app)
      .post(`/api/orgs/${orgId}/mcp/providers/github/connect`)
      .send({ scope: "organization", pat });

    expect(response.status).toBe(200);
    expect(mockService.ensureOfficial).toHaveBeenCalledWith(
      orgId,
      "github",
      {
        scope: "organization",
        ownerAgentId: null,
        accessMode: undefined,
        pat,
      },
      { userId: "owner-1", agentId: null },
    );
    expect(mockService.refreshTools).toHaveBeenCalledWith(
      orgId,
      connectionId,
      { userId: "owner-1", agentId: null },
    );
    expect(mockOAuthService.start).not.toHaveBeenCalled();
    expect(response.body.safeConfig).not.toHaveProperty("pat");
  });

  it("rejects official providers from the generic connection create endpoint", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const pat = "github_pat_12345678901234567890";

    const response = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections`)
      .send({
        name: "github-generic",
        displayName: "GitHub",
        provider: "github",
        scope: "organization",
        transport: "streamable_http",
        safeConfig: {
          endpoint: "https://api.githubcopilot.com/mcp/",
          scopeMode: "account",
        },
        secrets: { bearerToken: pat },
      });

    expect(response.status).toBe(400);
    expect(capturedErrorBody).toBe("[REDACTED]");
    expect(JSON.stringify(capturedErrorBody)).not.toContain(pat);
    expect(mockService.create).not.toHaveBeenCalled();
    expect(mockService.ensureOfficial).not.toHaveBeenCalled();
  });

  it("marks a GitHub PAT connect request sensitive and rejects missing credentials", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const response = await request(app)
      .post(`/api/orgs/${orgId}/mcp/providers/github/connect`)
      .send({ scope: "organization", pat: "github_pat_short" });

    expect(response.status).toBe(400);
    expect(capturedErrorBody).toBe("[REDACTED]");
    expect(JSON.stringify(capturedErrorBody)).not.toContain("github_pat_short");
    expect(mockService.ensureOfficial).not.toHaveBeenCalled();
  });

  it("rejects an official provider connect request without an explicit scope", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .post(`/api/orgs/${orgId}/mcp/providers/supabase/connect`)
      .send({ accessMode: "read_only" });

    expect(response.status).toBe(400);
    expect(mockService.ensureOfficial).not.toHaveBeenCalled();
  });

  it("starts an explicit Supabase account upgrade through a dedicated endpoint", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/upgrade-account-access`)
      .send({});

    expect(response.status).toBe(201);
    expect(mockService.prepareSupabaseAccountUpgrade).toHaveBeenCalledWith(
      orgId,
      connectionId,
      { userId: "owner-1", agentId: null },
    );
    expect(mockOAuthService.start).toHaveBeenCalledWith(
      orgId,
      connectionId,
      expect.objectContaining({ userId: "owner-1" }),
    );
  });

  it("stages an organization access change through OAuth without patching the live connection", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const response = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/reauthorize-access`)
      .send({ accessMode: "read_write" });

    expect(response.status).toBe(201);
    expect(mockOAuthService.start).toHaveBeenCalledWith(
      orgId,
      connectionId,
      expect.objectContaining({ userId: "owner-1" }),
      { requestedAccessMode: "read_write" },
    );
    expect(mockService.update).not.toHaveBeenCalled();
  });

  it("rejects GitHub connections from OAuth start and reauthorization routes", async () => {
    mockService.get.mockResolvedValue({
      ...connectionSummary(),
      provider: "github",
      status: "active",
    });
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const start = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/oauth/start`)
      .send({});
    const reauthorize = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/reauthorize-access`)
      .send({ accessMode: "read_write" });

    expect(start.status).toBe(422);
    expect(reauthorize.status).toBe(422);
    expect(start.body.error).toContain("personal access tokens");
    expect(reauthorize.body.error).toContain("personal access tokens");
    expect(mockOAuthService.start).not.toHaveBeenCalled();
  });

  it("rejects agent API keys and cross-organization board access for all management reads", async () => {
    const agentResponse = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId,
      source: "agent_key",
    })).get(`/api/orgs/${orgId}/mcp/connections`);
    expect(agentResponse.status).toBe(403);

    const crossOrgResponse = await request(createApp({
      type: "board",
      userId: "member-1",
      orgIds: [otherOrgId],
      source: "session",
      isInstanceAdmin: false,
    })).get(`/api/orgs/${orgId}/mcp/connections`);
    expect(crossOrgResponse.status).toBe(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("requires an active owner membership for mutations", async () => {
    mockMembership.mockResolvedValue({
      status: "active",
      membershipRole: "member",
    });
    const response = await request(createApp({
      type: "board",
      userId: "member-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/orgs/${orgId}/mcp/connections`)
      .send({
        name: "custom-http",
        displayName: "Custom HTTP",
        provider: "custom",
        scope: "organization",
        transport: "streamable_http",
        safeConfig: {
          url: "https://mcp.example.test/mcp",
          secretHeaderNames: ["Authorization"],
        },
        secrets: { headers: { Authorization: "Bearer forbidden-owner-secret" } },
      });

    expect(response.status).toBe(403);
    expect(capturedErrorBody).toBe("[REDACTED]");
    expect(JSON.stringify(capturedErrorBody)).not.toContain("forbidden-owner-secret");
    expect(mockService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("marks secret-bearing create and patch bodies sensitive before validation fails", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const createResponse = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections`)
      .send({
        name: "INVALID NAME",
        secrets: { bearerToken: "validation-create-secret" },
      });
    expect(createResponse.status).toBe(400);
    expect(capturedErrorBody).toBe("[REDACTED]");

    capturedErrorBody = undefined;
    const patchResponse = await request(app)
      .patch(`/api/orgs/${orgId}/mcp/connections/${connectionId}`)
      .send({
        unexpected: "validation-patch-secret",
        secrets: { bearerToken: "validation-patch-secret" },
      });
    expect(patchResponse.status).toBe(400);
    expect(capturedErrorBody).toBe("[REDACTED]");
  });

  it("allows active owners, instance administrators, and local implicit board users to mutate", async () => {
    const owner = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const admin = createApp({
      type: "board",
      userId: "admin-1",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    });
    const local = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    expect((await request(owner)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/refresh-tools`)
      .send({})).status).toBe(200);
    expect((await request(admin)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/reconnect`)
      .send({})).status).toBe(200);
    expect((await request(local)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/disconnect`)
      .send({})).status).toBe(200);
    expect(mockMembership).toHaveBeenCalledTimes(1);
  });

  it("exposes create, patch, and access-mode endpoints without duplicating service-owned audit", async () => {
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const credential = "Bearer literal-must-never-enter-activity";
    const createResponse = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections`)
      .send({
        name: "custom-http",
        displayName: "Custom HTTP",
        provider: "custom",
        scope: "organization",
        transport: "streamable_http",
        safeConfig: {
          url: "https://mcp.example.test/mcp",
          secretHeaderNames: ["Authorization"],
        },
        secrets: { headers: { Authorization: credential } },
      });
    const patchResponse = await request(app)
      .patch(`/api/orgs/${orgId}/mcp/connections/${connectionId}`)
      .send({ displayName: "Renamed" });
    mockService.update.mockResolvedValueOnce({
      ...connectionSummary(),
      provider: "supabase",
      externalScope: "project-a",
      accessMode: "read_only",
      status: "active",
    });
    const accessResponse = await request(app)
      .patch(`/api/orgs/${orgId}/mcp/connections/${connectionId}/access-mode`)
      .send({ accessMode: "read_only" });

    expect(createResponse.status).toBe(201);
    expect(patchResponse.status).toBe(200);
    expect(accessResponse.status).toBe(200);
    expect(mockService.update).toHaveBeenLastCalledWith(
      orgId,
      connectionId,
      { accessMode: "read_only" },
      { userId: "owner-1", agentId: null },
      { allowCuratedAccessMode: true },
    );
    expect(mockService.refreshTools).toHaveBeenCalledWith(
      orgId,
      connectionId,
      { userId: "owner-1", agentId: null },
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("maps standard OAuth callback query names and prevents browser propagation", async () => {
    const response = await request(createApp({
      type: "none",
      source: "none",
    })).get(
      "/api/mcp/oauth/callback"
      + "?state=opaque-one-time-state"
      + "&error=access_denied"
      + "&error_description=provider-private-description"
      + "&error_uri=https%3A%2F%2Foauth.example.test%2Ferror"
      + "&iss=https%3A%2F%2Foauth.example.test",
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(mockOAuthService.callback).toHaveBeenCalledWith({
      state: "opaque-one-time-state",
      code: undefined,
      error: "access_denied",
      errorDescription: "provider-private-description",
      iss: "https://oauth.example.test",
    });
  });

  it("lets organization members read the OAuth grant without exposing project selection endpoints", async () => {
    const app = createApp({
      type: "board",
      userId: "member-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    expect((await request(app).get(
      `/api/orgs/${orgId}/mcp/connections/${connectionId}/oauth/grant`,
    )).status).toBe(200);
    expect((await request(app).get(
      `/api/orgs/${orgId}/mcp/connections/${connectionId}/oauth/scopes`,
    )).status).toBe(404);
    expect(mockOAuthService.getGrantSummary).toHaveBeenCalledWith(orgId, connectionId);
    expect(mockOAuthService.listScopeOptions).not.toHaveBeenCalled();
    expect(mockMembership).not.toHaveBeenCalled();
  });

  it("rejects agents and cross-organization boards from every OAuth management endpoint", async () => {
    const agent = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId,
      source: "agent_key",
    });
    const crossOrg = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [otherOrgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const endpoints = [
      { method: "get", path: "oauth/grant" },
      { method: "post", path: "oauth/start", body: {} },
      { method: "post", path: "reauthorize-access", body: { accessMode: "read_write" } },
      { method: "post", path: "reconnect", body: {} },
      { method: "post", path: "disconnect", body: {} },
    ] as const;

    for (const app of [agent, crossOrg]) {
      for (const endpoint of endpoints) {
        const base = `/api/orgs/${orgId}/mcp/connections/${connectionId}/${endpoint.path}`;
        const response = endpoint.method === "get"
          ? await request(app).get(base)
          : await request(app).post(base).send(endpoint.body);
        expect(response.status).toBe(403);
      }
    }
    expect(mockOAuthService.start).not.toHaveBeenCalled();
    expect(mockOAuthService.getGrantSummary).not.toHaveBeenCalled();
    expect(mockOAuthService.listScopeOptions).not.toHaveBeenCalled();
    expect(mockOAuthService.selectScope).not.toHaveBeenCalled();
    expect(mockOAuthService.revoke).not.toHaveBeenCalled();
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("allows owners, instance administrators, and local implicit boards to manage OAuth", async () => {
    const owner = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const admin = createApp({
      type: "board",
      userId: "admin-1",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    });
    const local = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    expect((await request(owner)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/oauth/start`)
      .send({})).status).toBe(201);
    expect((await request(admin)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/reauthorize-access`)
      .send({ accessMode: "read_write" })).status).toBe(201);
    mockService.get.mockResolvedValue({
      ...connectionSummary(),
      provider: "linear",
      status: "active",
    });
    expect((await request(local)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/disconnect`)
      .send({})).status).toBe(200);
  });

  it("revokes curated connections on disconnect but preserves the active grant during reauthorization", async () => {
    mockService.get.mockResolvedValue({
      ...connectionSummary(),
      provider: "linear",
      status: "active",
    });
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const disconnected = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/disconnect`)
      .send({});
    const reconnected = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/reconnect`)
      .send({});

    expect(disconnected.status).toBe(200);
    expect(reconnected.status).toBe(201);
    expect(reconnected.body.authorizationUrl).toBe("https://oauth.example.test/authorize");
    expect(mockOAuthService.revoke).toHaveBeenNthCalledWith(
      1,
      orgId,
      connectionId,
      expect.objectContaining({ userId: "owner-1" }),
    );
    expect(mockOAuthService.revoke).toHaveBeenCalledOnce();
    expect(mockOAuthService.start).toHaveBeenCalledOnce();
    expect(mockService.disconnect).not.toHaveBeenCalled();
    expect(mockService.reconnect).not.toHaveBeenCalled();
  });

  it("reconnects and disconnects GitHub through the managed PAT lifecycle", async () => {
    const github = {
      ...connectionSummary(),
      provider: "github",
      status: "error",
      safeConfig: {
        endpoint: "https://api.githubcopilot.com/mcp/",
        scopeMode: "account",
      },
    };
    mockService.get.mockResolvedValue(github);
    mockService.reconnect.mockResolvedValue({ ...github, status: "active" });
    mockService.disconnect.mockResolvedValue({ ...github, status: "disabled", enabled: false });
    const app = createApp({
      type: "board",
      userId: "owner-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });
    const pat = "github_pat_12345678901234567890";

    const reconnectResponse = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/reconnect`)
      .send({ pat });
    const disconnectResponse = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/disconnect`)
      .send({});

    expect(reconnectResponse.status).toBe(200);
    expect(mockService.reconnect).toHaveBeenCalledWith(
      orgId,
      connectionId,
      { userId: "owner-1", agentId: null },
      { githubPat: pat },
    );
    expect(mockService.refreshTools).toHaveBeenCalledWith(
      orgId,
      connectionId,
      { userId: "owner-1", agentId: null },
    );
    expect(mockOAuthService.start).not.toHaveBeenCalled();
    expect(disconnectResponse.status).toBe(200);
    expect(mockService.disconnect).toHaveBeenCalledWith(
      orgId,
      connectionId,
      { userId: "owner-1", agentId: null },
    );
    expect(mockOAuthService.revoke).not.toHaveBeenCalled();
  });
});
