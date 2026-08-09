import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/client";
import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidden } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { managedMcpRuntimeRoutes } from "../routes/managed-mcp-runtime.js";
import {
  createManagedMcpClient,
  ManagedMcpClientError,
  resolveMcpHttpCredentials,
} from "../services/mcp/managed-client.js";

const bindingId = "11111111-1111-4111-8111-111111111111";
const actor = {
  type: "agent",
  source: "agent_jwt",
  orgId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
};
const runtime = {
  requireBindingAccess: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
};

const activeServers = new Set<Server>();

async function app(requestActor: Record<string, unknown>) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    (req as any).actor = requestActor;
    next();
  });
  instance.use("/api", managedMcpRuntimeRoutes(runtime as never));
  instance.use(errorHandler);
  const server = instance.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("managed MCP run-scoped proxy route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.requireBindingAccess.mockResolvedValue({});
    runtime.listTools.mockResolvedValue([{
      name: "external.alpha.read",
      description: "Read",
      inputSchema: { type: "object" },
    }]);
    runtime.callTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("rejects board users, generic agent keys, and JWT actors without signed run context", async () => {
    for (const invalidActor of [
      { type: "board", source: "local_implicit", isInstanceAdmin: true },
      { type: "agent", source: "agent_key", orgId: actor.orgId, agentId: actor.agentId },
      { type: "agent", source: "agent_jwt", orgId: actor.orgId, agentId: actor.agentId },
    ]) {
      const response = await request(await app(invalidActor))
        .post(`/api/mcp/runtime/bindings/${bindingId}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain(bindingId);
    }
    expect(runtime.listTools).not.toHaveBeenCalled();
  });

  it("supports initialize, initialized notification, ping, tools/list, and tools/call", async () => {
    const api = await app(actor);
    const initialize = await request(api)
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
    expect(initialize.status).toBe(200);
    expect(initialize.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rudder-managed-mcp-proxy", version: "1.0.0" },
      },
    });
    expect(initialize.headers["mcp-protocol-version"]).toBe("2025-06-18");

    const unsupported = await request(api)
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({
        jsonrpc: "2.0",
        id: "newer-client",
        method: "initialize",
        params: {
          protocolVersion: "2099-01-01",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
    expect(unsupported.body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(unsupported.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(
      unsupported.body.result.protocolVersion,
    );

    expect((await request(api)
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" })).status)
      .toBe(202);
    expect((await request(api)
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({ jsonrpc: "2.0", id: "ping-1", method: "ping" })).body.result)
      .toEqual({});

    const listed = await request(api)
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.body.result.tools).toEqual([expect.objectContaining({
      name: "external.alpha.read",
    })]);

    const called = await request(api)
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "external.alpha.read",
          arguments: { query: "hello" },
        },
      });
    expect(called.body.result).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(runtime.callTool).toHaveBeenCalledWith(
      {
        orgId: actor.orgId,
        agentId: actor.agentId,
        runId: actor.runId,
      },
      bindingId,
      "external.alpha.read",
      { query: "hello" },
    );
  });

  it("returns safe JSON-RPC errors without reflecting upstream or authorization details", async () => {
    runtime.listTools.mockRejectedValueOnce(
      forbidden("secret binding and token details"),
    );
    const denied = await request(await app(actor))
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(denied.status).toBe(200);
    expect(denied.body.error).toEqual({
      code: -32001,
      message: "Managed MCP request is not authorized",
    });
    expect(JSON.stringify(denied.body)).not.toContain("secret");
    expect(JSON.stringify(denied.body)).not.toContain("token");

    runtime.callTool.mockRejectedValueOnce(
      new ManagedMcpClientError("mcp_tool_timeout", "upstream secret timeout"),
    );
    const failed = await request(await app(actor))
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "external.alpha.read", arguments: {} },
      });
    expect(failed.body.error).toEqual({
      code: -32002,
      message: "Managed MCP tool call failed",
      data: { code: "mcp_tool_timeout" },
    });
    expect(JSON.stringify(failed.body)).not.toContain("upstream secret timeout");
  });

  it("rejects malformed and unsupported JSON-RPC requests without invoking a tool", async () => {
    const malformed = await request(await app(actor))
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({ jsonrpc: "1.0", id: 1, method: "tools/call" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe(-32600);

    const unsupported = await request(await app(actor))
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    expect(unsupported.status).toBe(200);
    expect(unsupported.body.error.code).toBe(-32601);

    runtime.requireBindingAccess.mockClear();
    const notification = await request(await app(actor))
      .post(`/api/mcp/runtime/bindings/${bindingId}`)
      .send({ jsonrpc: "2.0", method: "notifications/custom" });
    expect(notification.status).toBe(202);
    expect(runtime.requireBindingAccess).toHaveBeenCalledWith(
      {
        orgId: actor.orgId,
        agentId: actor.agentId,
        runId: actor.runId,
      },
      bindingId,
    );
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("works end-to-end through the pinned Streamable HTTP SDK client", async () => {
    const server = await app(actor);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = await createManagedMcpClient({
      transport: "streamable_http",
      url: `${origin}/api/mcp/runtime/bindings/${bindingId}`,
      credentials: resolveMcpHttpCredentials({}),
      network: { allowedOrigins: [origin] },
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
    });
    try {
      await expect(client.discoverTools()).resolves.toEqual([
        expect.objectContaining({ name: "external.alpha.read" }),
      ]);
      await expect(client.callTool("external.alpha.read", { query: "sdk" }))
        .resolves.toEqual({
          content: [{ type: "text", text: "ok" }],
        });
      expect(runtime.callTool).toHaveBeenCalledWith(
        expect.objectContaining({ runId: actor.runId }),
        bindingId,
        "external.alpha.read",
        { query: "sdk" },
      );
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      activeServers.delete(server);
    }
  });
});
