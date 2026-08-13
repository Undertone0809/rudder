import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { describe, expect, it } from "vitest";
import {
  ManagedExternalMcpConfigurationError,
  parseManagedExternalMcpBindings,
  preflightManagedExternalMcpBindings,
  resolveManagedExternalMcpBindings,
} from "./managed-external-mcp.js";

const FIRST_BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BINDING_ID = "22222222-2222-4222-8222-222222222222";

function binding(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: FIRST_BINDING_ID,
    serverName: "supabase-memos",
    accessMode: "read_only",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.supabase-memos.list_tables"],
    },
    required: true,
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 60_000,
    ...overrides,
  };
}

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

describe("managed external MCP runtime bindings", () => {
  it("validates provider-neutral descriptors and derives stable run proxy URLs", () => {
    const resolved = resolveManagedExternalMcpBindings(
      {
        managedExternalMcpBindings: [
          binding(),
          binding({
            bindingId: SECOND_BINDING_ID,
            serverName: "linear-product",
            toolPolicy: {
              mode: "allowlist",
              allowedToolNames: ["external.linear-product.list_issues"],
            },
            required: false,
          }),
        ],
      },
      {
        RUDDER_API_URL: "https://rudder.example.test/base/",
        RUDDER_API_KEY: "run-secret-must-not-leak",
      },
    );

    expect(resolved).toEqual([
      expect.objectContaining({
        bindingId: FIRST_BINDING_ID,
        serverName: "supabase-memos",
        accessMode: "read_only",
        proxyUrl: `https://rudder.example.test/api/mcp/runtime/bindings/${FIRST_BINDING_ID}`,
        bearerTokenEnvVar: "RUDDER_API_KEY",
      }),
      expect.objectContaining({
        bindingId: SECOND_BINDING_ID,
        serverName: "linear-product",
        proxyUrl: `https://rudder.example.test/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`,
        bearerTokenEnvVar: "RUDDER_API_KEY",
      }),
    ]);
    expect(JSON.stringify(resolved)).not.toContain("run-secret-must-not-leak");
  });

  it.each([
    "none",
    "read_only",
    "read_write",
    "provider_granted",
    "full",
  ])("accepts the supported access mode %s", (accessMode) => {
    const resolved = resolveManagedExternalMcpBindings(
      { managedExternalMcpBindings: [binding({ accessMode })] },
      {
        RUDDER_API_URL: "https://rudder.example.test",
        RUDDER_API_KEY: "run-token",
      },
    );
    expect(resolved[0]?.accessMode).toBe(accessMode);
  });

  it.each([undefined, "administrator"])(
    "rejects the unsupported access mode %s",
    (accessMode) => {
      expect(() => parseManagedExternalMcpBindings({
        managedExternalMcpBindings: [binding({ accessMode })],
      })).toThrow(/accessMode is invalid/i);
    },
  );

  it("fails closed per malformed descriptor without blocking healthy bindings", () => {
    const failures: ManagedExternalMcpConfigurationError[] = [];
    for (const managedExternalMcpBindings of [
      [binding({ provider: "supabase" })],
      [binding({ bindingId: "not-a-uuid" })],
      [binding({ serverName: "rudder-tools" })],
      [binding({ serverName: "rudder-computer" })],
      [binding({ toolPolicy: { mode: "allowlist", allowedToolNames: ["same", "same"] } })],
      [binding({ toolPolicy: { mode: "allowlist", allowedToolNames: ["rudder_issue_get"] } })],
    ]) {
      expect(resolveManagedExternalMcpBindings(
        { managedExternalMcpBindings },
        {
          RUDDER_API_URL: "https://rudder.example.test",
          RUDDER_API_KEY: "run-token",
        },
        { onFailure: (_serverName, error) => failures.push(error) },
      )).toEqual([]);
    }
    expect(failures).toHaveLength(6);

    expect(resolveManagedExternalMcpBindings(
      {
        managedExternalMcpBindings: [
          binding({ provider: "supabase" }),
          binding({
            bindingId: SECOND_BINDING_ID,
            serverName: "linear-product",
            toolPolicy: {
              mode: "allowlist",
              allowedToolNames: ["external.linear-product.list_issues"],
            },
          }),
        ],
      },
      {
        RUDDER_API_URL: "https://rudder.example.test",
        RUDDER_API_KEY: "run-token",
      },
    )).toEqual([
      expect.objectContaining({ bindingId: SECOND_BINDING_ID }),
    ]);
  });

  it("omits every binding without blocking the runtime when run auth is missing", () => {
    const failures: ManagedExternalMcpConfigurationError[] = [];
    expect(resolveManagedExternalMcpBindings(
      { managedExternalMcpBindings: [binding()] },
      { RUDDER_API_URL: "https://rudder.example.test" },
      { onFailure: (_serverName, error) => failures.push(error) },
    )).toEqual([]);
    expect(failures[0]?.message).toMatch(/run authentication is unavailable/i);

    expect(resolveManagedExternalMcpBindings(
      {
        managedExternalMcpBindings: [
          binding({ required: false }),
          binding({
            bindingId: SECOND_BINDING_ID,
            serverName: "linear-product",
            required: false,
            toolPolicy: {
              mode: "allowlist",
              allowedToolNames: ["external.linear-product.list_issues"],
            },
          }),
        ],
      },
      {},
    )).toEqual([]);
  });

  it("treats an absent contract as no external bindings", () => {
    expect(resolveManagedExternalMcpBindings({}, {})).toEqual([]);
  });

  it("preflights initialize and tools/list, while omitting optional failures", async () => {
    const requests: Array<{
      bindingId: string;
      method: string;
      authorization: string | undefined;
    }> = [];
    const { server, origin } = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        method: string;
      };
      const bindingId = (req.url ?? "").split("/").at(-1) ?? "";
      requests.push({
        bindingId,
        method: body.method,
        authorization: req.headers.authorization,
      });
      if (bindingId === SECOND_BINDING_ID) {
        res.statusCode = 503;
        res.end();
        return;
      }
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
          : {
              tools: [{
                name: "external.supabase-memos.list_tables",
                inputSchema: { type: "object" },
              }],
            },
      }));
    });
    try {
      await expect(preflightManagedExternalMcpBindings(
        {
          managedExternalMcpBindings: [
            binding({ startupTimeoutMs: 1_000 }),
            binding({
              bindingId: SECOND_BINDING_ID,
              serverName: "linear-product",
              required: false,
              startupTimeoutMs: 1_000,
              toolPolicy: {
                mode: "allowlist",
                allowedToolNames: ["external.linear-product.list_issues"],
              },
            }),
          ],
        },
        {
          RUDDER_API_URL: origin,
          RUDDER_API_KEY: "run-secret",
        },
      )).resolves.toEqual([
        expect.objectContaining({ bindingId: FIRST_BINDING_ID }),
      ]);
      expect(requests.filter((entry) => entry.bindingId === FIRST_BINDING_ID))
        .toEqual([
          expect.objectContaining({
            method: "initialize",
            authorization: "Bearer run-secret",
          }),
          expect.objectContaining({ method: "notifications/initialized" }),
          expect.objectContaining({ method: "tools/list" }),
        ]);
    } finally {
      await close(server);
    }
  });

  it("omits a required binding when its real proxy preflight fails", async () => {
    const { server, origin } = await listen((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    try {
      const failures: ManagedExternalMcpConfigurationError[] = [];
      await expect(preflightManagedExternalMcpBindings(
        {
          managedExternalMcpBindings: [
            binding({ startupTimeoutMs: 1_000 }),
          ],
        },
        {
          RUDDER_API_URL: origin,
          RUDDER_API_KEY: "run-secret",
        },
        {
          onFailure: (_serverName, error) => {
            failures.push(error);
          },
        },
      )).resolves.toEqual([]);
      expect(failures[0]?.message).toMatch(/managed MCP binding.*preflight failed/i);
    } finally {
      await close(server);
    }
  });
});
