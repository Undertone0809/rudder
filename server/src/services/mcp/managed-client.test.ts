import { mkdir, mkdtemp, realpath, stat, symlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedMcpClient,
  resolveMcpHttpCredentials,
  type ResolvedMcpHttpCredentials,
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
  alwaysUnauthorized?: boolean;
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
    if (
      options.alwaysUnauthorized
      || (acceptedBearer && authorization !== `Bearer ${acceptedBearer}`)
    ) {
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

  it("preserves the receiver for stateful OAuth credentials", async () => {
    const oauth = {
      currentToken: "stateful-token",
      async token() {
        return this.currentToken;
      },
      async refresh() {},
    };

    const credentials = resolveMcpHttpCredentials({ oauth });
    await expect(credentials.authProvider?.token()).resolves.toBe("stateful-token");
  });

  it("refreshes only once and surfaces persistent upstream 401 responses", async () => {
    const server = await startMockMcpServer({ alwaysUnauthorized: true });
    servers.push(server);
    let refreshes = 0;
    let reauthorizationTransitions = 0;

    await expect(createManagedMcpClient({
      transport: "streamable_http",
      url: `${server.origin}/mcp`,
      network: { allowedOrigins: [server.origin] },
      credentials: resolveMcpHttpCredentials({
        oauth: {
          token: async () => "always-rejected",
          refresh: async () => {
            refreshes += 1;
          },
          markNeedsReauth: async () => {
            reauthorizationTransitions += 1;
          },
        },
      }),
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "mcp_upstream_unauthorized" });

    expect(refreshes).toBe(1);
    expect(reauthorizationTransitions).toBe(1);
    expect(server.requests.filter((request) => request.method === "initialize")).toHaveLength(2);
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
  it("uses canonical authenticated paths, selects environment, and force-reaps a stubborn child", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-mcp-stdio-"));
    const canonicalCwd = path.join(fixtureRoot, "canonical-cwd");
    const cwdAlias = path.join(fixtureRoot, "cwd-alias");
    const commandAlias = path.join(fixtureRoot, "node-alias");
    await mkdir(canonicalCwd);
    await symlink(canonicalCwd, cwdAlias, "dir");
    await symlink(process.execPath, commandAlias, "file");
    const touchedPath = path.join(canonicalCwd, "must-not-exist");
    const shellText = `$(touch ${touchedPath})`;
    const fixturePath = fileURLToPath(new URL("./__fixtures__/stdio-server.mjs", import.meta.url));
    const client = await createManagedMcpClient({
      transport: "stdio",
      command: commandAlias,
      args: [fixturePath, shellText],
      cwd: cwdAlias,
      staticEnv: {
        STATIC_ENV: "static-value",
        STUBBORN_MODE: "1",
      },
      forwardedEnv: ["FORWARDED_ENV"],
      secretEnv: { SECRET_ENV: "secret-value" },
      hostEnv: {
        FORWARDED_ENV: "forwarded-value",
        UNSELECTED_SECRET: "must-not-leak",
      },
      deploymentPolicy: {
        deploymentMode: "authenticated",
        stdioCommands: [[commandAlias, fixturePath, shellText]],
        stdioWorkingDirectories: [cwdAlias],
        stdioEnvironmentNames: [
          "STATIC_ENV",
          "STUBBORN_MODE",
          "FORWARDED_ENV",
          "SECRET_ENV",
        ],
      },
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
      maxOutputBytes: 128 * 1024,
    });
    clients.push(client);

    const result = await client.callTool("inspect", {});
    const details = result.structuredContent as Record<string, unknown>;
    expect(details).toMatchObject({
      argv0: await realpath(process.execPath),
      cwd: await realpath(canonicalCwd),
      extraArg: shellText,
      staticEnv: "static-value",
      forwardedEnv: "forwarded-value",
      secretEnv: "secret-value",
      unselectedEnv: null,
      inheritedHome: null,
    });
    await expect(stat(touchedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const pid = details.pid as number;
    const closeStartedAt = Date.now();
    const firstClose = client.close();
    let secondCloseObservedLiveChild = false;
    const secondClose = client.close().then(() => {
      try {
        process.kill(pid, 0);
        secondCloseObservedLiveChild = true;
      } catch {
        secondCloseObservedLiveChild = false;
      }
    });
    await Promise.all([firstClose, secondClose]);
    clients.splice(clients.indexOf(client), 1);
    expect(secondCloseObservedLiveChild).toBe(false);
    expect(Date.now() - closeStartedAt).toBeLessThan(5_500);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("enforces tool timeout with redacted errors", async () => {
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
        stdioCommands: [],
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
  });

  it("returns a specific output-boundary error and reaps the child", async () => {
    const fixturePath = fileURLToPath(new URL("./__fixtures__/stdio-server.mjs", import.meta.url));
    const client = await createManagedMcpClient({
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath],
      staticEnv: {},
      forwardedEnv: [],
      secretEnv: { SECRET_ENV: "server-secret" },
      hostEnv: {},
      deploymentPolicy: {
        deploymentMode: "local_trusted",
        stdioCommands: [],
        stdioWorkingDirectories: [],
        stdioEnvironmentNames: [],
      },
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
      maxOutputBytes: 2_048,
    });
    clients.push(client);

    const inspected = await client.callTool("inspect", {});
    const pid = (inspected.structuredContent as Record<string, unknown>).pid as number;
    const largeError = await client.callTool("large", { bytes: 8_192 }).then(
      () => null,
      (error: unknown) => error,
    );
    await client.close();
    clients.splice(clients.indexOf(client), 1);

    expect(largeError).toMatchObject({ code: "mcp_result_too_large" });
    expect(JSON.stringify(largeError)).not.toContain("server-secret");
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects forged resolved credentials at the true client boundary", async () => {
    const server = await startMockMcpServer();
    servers.push(server);
    const forgedCredentials: ResolvedMcpHttpCredentials[] = [
      {
        headers: { Authorization: "Bearer manual-secret" },
        authProvider: { token: async () => "oauth-secret" },
      },
      { headers: { Cookie: "cookie-secret" } },
      { headers: { Host: "host-secret" } },
      { headers: { "Proxy-Authorization": "proxy-secret" } },
    ];
    for (const forged of forgedCredentials) {
      await expect(createManagedMcpClient({
        transport: "streamable_http",
        url: `${server.origin}/mcp`,
        network: { allowedOrigins: [server.origin] },
        credentials: forged,
        startupTimeoutMs: 1_000,
        toolTimeoutMs: 1_000,
      })).rejects.toSatisfy((error: unknown) => (
        !/manual-secret|oauth-secret|cookie-secret|host-secret|proxy-secret/u
          .test(JSON.stringify(error))
      ));
    }
    expect(server.requests).toHaveLength(0);
  });
});
