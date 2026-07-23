import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedMcpClient,
  resolveMcpHttpCredentials,
} from "./managed-client.js";

interface MockMcpServer {
  origin: string;
  requests: Array<{ method: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startMockMcpServer(options: {
  requiredBearer?: string;
  refreshBearer?: string;
  redirectOnce?: boolean;
  rateLimitTools?: boolean;
} = {}): Promise<MockMcpServer> {
  const requests: MockMcpServer["requests"] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (options.redirectOnce && req.url === "/redirect") {
      res.writeHead(307, { location: "/mcp" });
      res.end();
      return;
    }

    const message = await readJson(req);
    const authorization = req.headers.authorization;
    requests.push({ method: message.method, authorization });
    const acceptedBearer = options.refreshBearer ?? options.requiredBearer;
    if (acceptedBearer && authorization !== `Bearer ${acceptedBearer}`) {
      res.writeHead(401, { "www-authenticate": "Bearer" });
      res.end();
      return;
    }
    if (options.rateLimitTools && message.method === "tools/list") {
      res.writeHead(429, { "retry-after": "1" });
      res.end();
      return;
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === "initialize") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "rudder-http-fixture", version: "1.0.0" },
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{
            name: "echo",
            description: "Echo an input",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          }],
        },
      });
      return;
    }
    if (message.method === "tools/call") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: message.params.arguments.value }],
          structuredContent: { echoed: message.params.arguments.value },
        },
      });
      return;
    }
    json(res, 404, {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

const clients: Array<{ close(): Promise<void> }> = [];
const servers: MockMcpServer[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("managed MCP Streamable HTTP client", () => {
  it("performs initialize, tools/list, and tools/call without authentication", async () => {
    const server = await startMockMcpServer();
    servers.push(server);
    const client = await createManagedMcpClient({
      transport: "streamable_http",
      url: `${server.origin}/mcp`,
      network: { allowedOrigins: [server.origin] },
      credentials: resolveMcpHttpCredentials({}),
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
    });
    clients.push(client);

    await expect(client.discoverTools()).resolves.toEqual([
      expect.objectContaining({ name: "echo" }),
    ]);
    await expect(client.callTool("echo", { value: "hello" })).resolves.toMatchObject({
      structuredContent: { echoed: "hello" },
    });
    expect(server.requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });

  it("injects one Bearer source and refreshes at most once after 401", async () => {
    const server = await startMockMcpServer({ refreshBearer: "fresh-token" });
    servers.push(server);
    let token = "expired-token";
    let refreshes = 0;
    const client = await createManagedMcpClient({
      transport: "streamable_http",
      url: `${server.origin}/mcp`,
      network: { allowedOrigins: [server.origin] },
      credentials: resolveMcpHttpCredentials({
        oauth: {
          token: async () => token,
          refresh: async () => {
            refreshes += 1;
            token = "fresh-token";
          },
        },
      }),
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
    });
    clients.push(client);

    await expect(client.discoverTools()).resolves.toHaveLength(1);
    expect(refreshes).toBe(1);
    expect(server.requests.filter((request) => request.method === "initialize")).toHaveLength(2);
    expect(server.requests.at(-1)?.authorization).toBe("Bearer fresh-token");
  });

  it("follows only policy-validated redirects and surfaces rate limits safely", async () => {
    const redirecting = await startMockMcpServer({ redirectOnce: true });
    servers.push(redirecting);
    const redirectedClient = await createManagedMcpClient({
      transport: "streamable_http",
      url: `${redirecting.origin}/redirect`,
      network: { allowedOrigins: [redirecting.origin] },
      credentials: resolveMcpHttpCredentials({ bearerToken: "redirect-secret" }),
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
    });
    clients.push(redirectedClient);
    await expect(redirectedClient.discoverTools()).resolves.toHaveLength(1);

    const limited = await startMockMcpServer({ rateLimitTools: true });
    servers.push(limited);
    const limitedClient = await createManagedMcpClient({
      transport: "streamable_http",
      url: `${limited.origin}/mcp`,
      network: { allowedOrigins: [limited.origin] },
      credentials: resolveMcpHttpCredentials({}),
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
    });
    clients.push(limitedClient);
    await expect(limitedClient.discoverTools()).rejects.toMatchObject({
      code: "mcp_upstream_rate_limited",
    });
  });

  it("rejects conflicting Authorization sources without exposing their values", () => {
    expect(() => resolveMcpHttpCredentials({
      bearerToken: "first-secret",
      authorizationHeader: "Bearer second-secret",
    })).toThrowError(expect.not.stringMatching(/first-secret|second-secret/));
  });
});

describe("managed MCP STDIO client", () => {
  it("passes argv without a shell, selects environment, and reaps the child on close", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "rudder-mcp-stdio-"));
    const touchedPath = path.join(cwd, "must-not-exist");
    const shellText = `$(touch ${touchedPath})`;
    const fixturePath = fileURLToPath(new URL("./__fixtures__/stdio-server.mjs", import.meta.url));
    const client = await createManagedMcpClient({
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath, shellText],
      cwd,
      staticEnv: { SELECTED_ENV: "selected-value" },
      forwardedEnv: [],
      secretEnv: {},
      hostEnv: { UNSELECTED_SECRET: "must-not-leak" },
      deploymentPolicy: {
        deploymentMode: "local_trusted",
        stdioExecutables: [],
        stdioWorkingDirectories: [],
        stdioEnvironmentNames: [],
      },
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
      maxOutputBytes: 128 * 1024,
    });
    clients.push(client);

    const result = await client.callTool("inspect", {});
    const details = result.structuredContent as Record<string, unknown>;
    expect(details).toMatchObject({
      cwd: await realpath(cwd),
      extraArg: shellText,
      selectedEnv: "selected-value",
      unselectedEnv: null,
    });
    await expect(stat(touchedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const pid = details.pid as number;
    await client.close();
    clients.splice(clients.indexOf(client), 1);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("enforces tool timeout and output limits with redacted errors", async () => {
    const fixturePath = fileURLToPath(new URL("./__fixtures__/stdio-server.mjs", import.meta.url));
    const client = await createManagedMcpClient({
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath],
      staticEnv: {},
      forwardedEnv: [],
      secretEnv: { SELECTED_ENV: "server-secret" },
      hostEnv: {},
      deploymentPolicy: {
        deploymentMode: "local_trusted",
        stdioExecutables: [],
        stdioWorkingDirectories: [],
        stdioEnvironmentNames: [],
      },
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 25,
      maxOutputBytes: 2_048,
    });
    clients.push(client);

    await expect(client.callTool("sleep", { delayMs: 100 })).rejects.toMatchObject({
      code: "mcp_tool_timeout",
    });
    await expect(client.callTool("large", { bytes: 8_192 })).rejects.toSatisfy(
      (error: unknown) => JSON.stringify(error).includes("server-secret") === false,
    );
  });
});
