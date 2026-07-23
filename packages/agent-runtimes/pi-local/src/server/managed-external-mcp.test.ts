import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  callManagedExternalMcpProxy,
  discoverPiManagedExternalMcpBindings,
  renderPiManagedExternalMcpExtension,
} from "./managed-external-mcp.js";

const FIRST_BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BINDING_ID = "22222222-2222-4222-8222-222222222222";

function binding(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: FIRST_BINDING_ID,
    serverName: "supabase-memos",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.supabase-memos.list_tables"],
    },
    required: true,
    startupTimeoutMs: 1_000,
    toolTimeoutMs: 1_000,
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

function loadGeneratedCallManagedMcp(source: string): (
  proxyUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>> {
  const outputText = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function(
    "require",
    "module",
    "exports",
    "process",
    outputText,
  ) as (
    require: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
    process: { env: Record<string, string> },
  ) => void;
  evaluate(
    (specifier) => {
      if (specifier === "@earendil-works/pi-ai") return { Type: {} };
      throw new Error(`Unexpected generated extension dependency: ${specifier}`);
    },
    module,
    module.exports,
    { env: { RUDDER_API_KEY: "run-secret" } },
  );
  const callManagedMcp = module.exports.callManagedMcp;
  if (typeof callManagedMcp !== "function") {
    throw new Error("Generated extension does not export callManagedMcp");
  }
  return callManagedMcp as ReturnType<typeof loadGeneratedCallManagedMcp>;
}

describe("Pi managed external MCP bridge", () => {
  it("enforces required/optional setup when run authentication is missing", async () => {
    await expect(discoverPiManagedExternalMcpBindings(
      { managedExternalMcpBindings: [binding()] },
      {},
    )).rejects.toThrow(/required managed MCP binding/i);

    await expect(discoverPiManagedExternalMcpBindings(
      { managedExternalMcpBindings: [binding({ required: false })] },
      {},
    )).resolves.toEqual([]);
  });

  it("discovers two independent schemas and renders a provider-neutral native bridge", async () => {
    const requests: Array<{ path: string; auth: string | undefined }> = [];
    const { server, origin } = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        method: string;
      };
      requests.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
      });
      const isSupabase = req.url?.includes(FIRST_BINDING_ID);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: "pi-managed-mcp",
        result: {
          tools: [{
            name: isSupabase
              ? "external.supabase-memos.list_tables"
              : "external.linear-product.list_issues",
            description: isSupabase ? "List tables" : "List issues",
            inputSchema: {
              type: "object",
              properties: isSupabase
                ? { schema: { type: "string" } }
                : { team: { type: "string" } },
            },
          }],
        },
      }));
      expect(body.method).toBe("tools/list");
    });
    try {
      const discovered = await discoverPiManagedExternalMcpBindings(
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
            }),
          ],
        },
        {
          RUDDER_API_URL: origin,
          RUDDER_API_KEY: "run-secret",
        },
      );

      expect(discovered.map((entry) => entry.serverName)).toEqual([
        "supabase-memos",
        "linear-product",
      ]);
      expect(discovered.flatMap((entry) => entry.tools.map((tool) => tool.name))).toEqual([
        "external.supabase-memos.list_tables",
        "external.linear-product.list_issues",
      ]);
      expect(requests).toEqual([
        expect.objectContaining({
          path: `/api/mcp/runtime/bindings/${FIRST_BINDING_ID}`,
          auth: "Bearer run-secret",
        }),
        expect.objectContaining({
          path: `/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`,
          auth: "Bearer run-secret",
        }),
      ]);

      const source = renderPiManagedExternalMcpExtension(discovered);
      expect(source).toContain("external.supabase-memos.list_tables");
      expect(source).toContain("external.linear-product.list_issues");
      expect(source).toContain(`/api/mcp/runtime/bindings/${FIRST_BINDING_ID}`);
      expect(source).toContain(`/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`);
      expect(source).toContain("process.env.RUDDER_API_KEY");
      expect(source).toContain("AbortSignal.timeout");
      expect(source).not.toContain("run-secret");
      expect(source).not.toContain("rudder_issue_get");
      expect(source).not.toContain("supabase:");
      expect(source).not.toContain("linear:");
    } finally {
      await close(server);
    }
  });

  it("dispatches calls to the selected binding URL and returns safe failures", async () => {
    const paths: string[] = [];
    const { server, origin } = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        method: string;
        params?: { name?: string };
      };
      paths.push(req.url ?? "");
      if (body.params?.name === "external.linear-product.slow") {
        setTimeout(() => {
          if (!res.destroyed) {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              id: "pi-managed-mcp",
              result: {},
            }));
          }
        }, 200);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body.params?.name?.endsWith(".fail")
        ? {
            jsonrpc: "2.0",
            id: "pi-managed-mcp",
            error: { code: -32002, message: "Managed MCP tool call failed" },
          }
        : {
            jsonrpc: "2.0",
            id: "pi-managed-mcp",
            result: { content: [{ type: "text", text: "ok" }] },
          }));
    });
    const env = { RUDDER_API_KEY: "run-secret" };
    try {
      await expect(callManagedExternalMcpProxy({
        proxyUrl: `${origin}/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`,
        toolName: "external.linear-product.list_issues",
        args: { team: "ENG" },
        timeoutMs: 1_000,
        env,
      })).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
      });
      expect(paths.at(-1)).toBe(`/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`);

      await expect(callManagedExternalMcpProxy({
        proxyUrl: `${origin}/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`,
        toolName: "external.linear-product.fail",
        args: {},
        timeoutMs: 1_000,
        env,
      })).rejects.toThrow("Managed MCP tool call failed");

      await expect(callManagedExternalMcpProxy({
        proxyUrl: `${origin}/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`,
        toolName: "external.linear-product.slow",
        args: {},
        timeoutMs: 20,
        env,
      })).rejects.toThrow(/timed out/i);
    } finally {
      await close(server);
    }
  });

  it("bounds the response read in the generated extension call path", async () => {
    const { server, origin } = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: "pi-managed-mcp",
        result: {
          content: [{
            type: "text",
            text: "x".repeat((2 * 1024 * 1024) + 1),
          }],
        },
      }));
    });
    try {
      const source = renderPiManagedExternalMcpExtension([{
        ...binding(),
        toolPolicy: {
          mode: "allowlist" as const,
          allowedToolNames: ["external.supabase-memos.list_tables"],
        },
        proxyUrl: `${origin}/api/mcp/runtime/bindings/${FIRST_BINDING_ID}`,
        bearerTokenEnvVar: "RUDDER_API_KEY",
        tools: [{
          name: "external.supabase-memos.list_tables",
          inputSchema: { type: "object" },
        }],
      }]);
      expect(source).toContain("export async function callManagedMcp");
      const callManagedMcp = loadGeneratedCallManagedMcp(source);

      await expect(callManagedMcp(
        `${origin}/api/mcp/runtime/bindings/${FIRST_BINDING_ID}`,
        "external.supabase-memos.list_tables",
        {},
        1_000,
      )).rejects.toThrow(/size limit/i);
    } finally {
      await close(server);
    }
  });

  it("fails required schema discovery and omits optional discovery failures", async () => {
    const { server, origin } = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: "pi-managed-mcp",
        result: {
          tools: [{
            name: "external.supabase-memos.list_tables",
            inputSchema: "not-an-object",
          }],
        },
      }));
    });
    const env = {
      RUDDER_API_URL: origin,
      RUDDER_API_KEY: "run-secret",
    };
    try {
      await expect(discoverPiManagedExternalMcpBindings(
        { managedExternalMcpBindings: [binding()] },
        env,
      )).rejects.toThrow(/schema/i);

      await expect(discoverPiManagedExternalMcpBindings(
        { managedExternalMcpBindings: [binding({ required: false })] },
        env,
      )).resolves.toEqual([]);
    } finally {
      await close(server);
    }
  });
});
