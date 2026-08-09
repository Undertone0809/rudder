import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { managedMcpAgentBindingRoutes } from "../routes/managed-mcp-agent-bindings.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const otherOrgId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";

const bindingService = {
  listForAgent: vi.fn(),
  listProviderAvailability: vi.fn(),
  upsert: vi.fn(),
  revoke: vi.fn(),
};
const findAgent = vi.fn();
const getMembership = vi.fn();

const activeServers = new Set<Server>();

async function app(actor: Record<string, unknown>) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  instance.use("/api", managedMcpAgentBindingRoutes({} as never, {
    bindingService: bindingService as never,
    findAgent,
    getMembership,
  }));
  instance.use(errorHandler);
  const server = instance.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("managed MCP agent binding routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    findAgent.mockResolvedValue({ id: agentId, orgId });
    bindingService.listForAgent.mockResolvedValue([]);
    bindingService.listProviderAvailability.mockResolvedValue([]);
    bindingService.upsert.mockResolvedValue({ binding: { id: "binding-1" } });
    bindingService.revoke.mockResolvedValue({ binding: { status: "revoked" } });
    getMembership.mockResolvedValue({
      status: "active",
      membershipRole: "owner",
    });
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("lets organization board users list, upsert, patch, and revoke bindings", async () => {
    const actor = {
      type: "board",
      source: "session",
      userId: "owner-1",
      orgIds: [orgId],
      isInstanceAdmin: false,
    };
    const api = await app(actor);

    expect((await request(api).get(`/api/agents/${agentId}/mcp-connections`)).status)
      .toBe(200);
    expect((await request(api).get(`/api/agents/${agentId}/mcp-provider-status`)).status)
      .toBe(200);
    expect((await request(api)
      .put(`/api/agents/${agentId}/mcp-connections/${connectionId}`)
      .send({ accessMode: "read_only", expectedRevision: 2 })).status).toBe(200);
    expect((await request(api)
      .patch(`/api/agents/${agentId}/mcp-connections/${connectionId}`)
      .send({ status: "disabled", enabledToolIds: [] })).status).toBe(200);
    expect((await request(api)
      .delete(`/api/agents/${agentId}/mcp-connections/${connectionId}`)).status)
      .toBe(200);

    expect(bindingService.upsert).toHaveBeenNthCalledWith(
      1,
      orgId,
      agentId,
      connectionId,
      { accessMode: "read_only", expectedRevision: 2 },
      { userId: "owner-1", agentId: null },
    );
    expect(bindingService.revoke).toHaveBeenCalledWith(
      orgId,
      agentId,
      connectionId,
      { userId: "owner-1", agentId: null },
    );
  });

  it("rejects agent keys and cross-organization board users", async () => {
    const agentResponse = await request(await app({
      type: "agent",
      source: "agent_key",
      orgId,
      agentId,
    })).get(`/api/agents/${agentId}/mcp-connections`);
    expect(agentResponse.status).toBe(403);

    const crossOrgResponse = await request(await app({
      type: "board",
      source: "session",
      userId: "owner-1",
      orgIds: [otherOrgId],
      isInstanceAdmin: false,
    })).get(`/api/agents/${agentId}/mcp-connections`);
    expect(crossOrgResponse.status).toBe(403);
    expect(bindingService.listForAgent).not.toHaveBeenCalled();
  });

  it("allows reads but rejects binding mutations from ordinary organization members", async () => {
    getMembership.mockResolvedValue({
      status: "active",
      membershipRole: "member",
    });
    const api = await app({
      type: "board",
      source: "session",
      userId: "member-1",
      orgIds: [orgId],
      isInstanceAdmin: false,
    });

    expect((await request(api).get(`/api/agents/${agentId}/mcp-connections`)).status)
      .toBe(200);
    expect((await request(api)
      .put(`/api/agents/${agentId}/mcp-connections/${connectionId}`)
      .send({})).status).toBe(403);
    expect((await request(api)
      .delete(`/api/agents/${agentId}/mcp-connections/${connectionId}`)).status)
      .toBe(403);
    expect(bindingService.upsert).not.toHaveBeenCalled();
    expect(bindingService.revoke).not.toHaveBeenCalled();
  });

  it("validates binding payloads and reports missing agents or bindings safely", async () => {
    const actor = {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    };
    const invalid = await request(await app(actor))
      .put(`/api/agents/${agentId}/mcp-connections/${connectionId}`)
      .send({ enabledToolIds: ["not-a-uuid"] });
    expect(invalid.status).toBe(400);
    expect(bindingService.upsert).not.toHaveBeenCalled();

    findAgent.mockResolvedValueOnce(null);
    expect((await request(await app(actor))
      .get(`/api/agents/${agentId}/mcp-connections`)).status).toBe(404);

    bindingService.revoke.mockResolvedValueOnce(null);
    expect((await request(await app(actor))
      .delete(`/api/agents/${agentId}/mcp-connections/${connectionId}`)).status)
      .toBe(404);
  });
});
