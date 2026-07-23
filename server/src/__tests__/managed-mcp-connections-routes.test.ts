import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
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
  create: vi.fn(),
  update: vi.fn(),
  reconnect: vi.fn(),
  refreshTools: vi.fn(),
  disconnect: vi.fn(),
  listTools: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ getMembership: mockMembership }),
  logActivity: mockLogActivity,
  managedMcpConnectionService: () => mockService,
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
    allowlists: {
      httpOrigins: [],
      stdioCommands: [],
      stdioWorkingDirectories: [],
      stdioEnvironmentNames: [],
    },
    hostEnv: {},
  }));
  app.use(errorHandler);
  return app;
}

describe("managed MCP connection organization routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembership.mockResolvedValue({
      status: "active",
      membershipRole: "owner",
    });
    mockService.catalog.mockReturnValue([{ id: "supabase" }]);
    mockService.list.mockResolvedValue([connectionSummary()]);
    mockService.get.mockResolvedValue(connectionSummary());
    mockService.create.mockResolvedValue(connectionSummary());
    mockService.update.mockResolvedValue(connectionSummary());
    mockService.reconnect.mockResolvedValue(connectionSummary());
    mockService.disconnect.mockResolvedValue({ ...connectionSummary(), status: "disabled" });
    mockService.listTools.mockResolvedValue([]);
    mockService.refreshTools.mockResolvedValue([]);
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
    expect((await request(app).get(
      `/api/orgs/${orgId}/mcp/connections/${connectionId}/tools`,
    )).status).toBe(200);
    expect(mockMembership).not.toHaveBeenCalled();
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
        transport: "streamable_http",
        safeConfig: { url: "https://mcp.example.test/mcp" },
      });

    expect(response.status).toBe(403);
    expect(mockService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
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

  it("exposes clear create, patch, and access-mode endpoints and writes redacted activities", async () => {
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
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("safeConfig");
    expect(mockLogActivity).toHaveBeenCalledTimes(3);
  });
});
