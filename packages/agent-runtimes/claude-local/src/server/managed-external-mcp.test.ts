import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { describe, expect, it } from "vitest";
import {
  resolveManagedExternalClaudeMcpConfigs,
  resolveRudderMcpServerConfigs,
} from "./execute.js";

const bindings = [
  {
    bindingId: "11111111-1111-4111-8111-111111111111",
    serverName: "supabase-memos",
    accessMode: "read_only",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.supabase-memos.list_tables"],
    },
    required: true,
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 60_000,
  },
  {
    bindingId: "22222222-2222-4222-8222-222222222222",
    serverName: "notion-docs",
    accessMode: "provider_granted",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.notion-docs.search"],
    },
    required: false,
    startupTimeoutMs: 12_000,
    toolTimeoutMs: 45_000,
  },
];

async function listen(
  handler: (
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
  ) => void | Promise<void>,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function healthyProxy(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      method: string;
    };
    if (body.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id: "rudder-managed-mcp-preflight",
      result: body.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "test", version: "1" },
          }
        : { tools: [] },
    }));
  });
}

describe("Claude managed external MCP config", () => {
  it("adds two independent HTTP servers without changing the first-party server", async () => {
    const { server, origin } = await listen(healthyProxy);
    try {
      const env = {
        RUDDER_API_URL: origin,
        RUDDER_API_KEY: "run-secret",
      };
      const baseline = await resolveRudderMcpServerConfigs(env);
      const external = await resolveManagedExternalClaudeMcpConfigs(
        { managedExternalMcpBindings: bindings },
        env,
      );
      const combined = await resolveRudderMcpServerConfigs(
        env,
        undefined,
        undefined,
        { managedExternalMcpBindings: bindings },
      );

      expect(combined["rudder-tools"]).toEqual(baseline["rudder-tools"]);
      expect(external).toEqual({
        "supabase-memos": {
          type: "http",
          url: `${origin}/api/mcp/runtime/bindings/11111111-1111-4111-8111-111111111111`,
          headers: { Authorization: "Bearer ${RUDDER_API_KEY}" },
          timeout: 60_000,
        },
        "notion-docs": {
          type: "http",
          url: `${origin}/api/mcp/runtime/bindings/22222222-2222-4222-8222-222222222222`,
          headers: { Authorization: "Bearer ${RUDDER_API_KEY}" },
          timeout: 45_000,
        },
      });
      expect(Object.keys(combined)).toEqual([
        "rudder-tools",
        "supabase-memos",
        "notion-docs",
      ]);
      expect(JSON.stringify(external)).not.toContain("run-secret");
      expect(JSON.stringify(combined["rudder-tools"])).not.toContain("external.");
    } finally {
      await close(server);
    }
  });

  it("enforces required/optional missing-auth behavior", async () => {
    await expect(resolveManagedExternalClaudeMcpConfigs(
      { managedExternalMcpBindings: [bindings[0]] },
      {},
    )).rejects.toThrow(/required managed MCP binding/i);
    await expect(resolveManagedExternalClaudeMcpConfigs(
      { managedExternalMcpBindings: [{ ...bindings[1], required: false }] },
      {},
    )).resolves.toEqual({});
  });

  it("fails a required unreachable proxy and omits an optional one", async () => {
    const { server, origin } = await listen((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const env = {
      RUDDER_API_URL: origin,
      RUDDER_API_KEY: "run-secret",
    };
    try {
      await expect(resolveManagedExternalClaudeMcpConfigs(
        { managedExternalMcpBindings: [bindings[0]] },
        env,
      )).rejects.toThrow(/required managed MCP binding.*preflight failed/i);
      await expect(resolveManagedExternalClaudeMcpConfigs(
        { managedExternalMcpBindings: [{ ...bindings[1], required: false }] },
        env,
      )).resolves.toEqual({});
    } finally {
      await close(server);
    }
  });
});
