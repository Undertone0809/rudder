import { createServer as createHttpServer } from "node:http";
import {
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSecureMcpFetch } from "./pinned-fetch.js";

const openSockets = new Set<Socket>();
const openServers = new Set<Server>();

function trackServer<T extends Server>(server: T): T {
  openServers.add(server);
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });
  return server;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return address.port;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  await Promise.all([...openServers].map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
  openServers.clear();
  openSockets.clear();
});

describe("secure managed MCP pinned fetch deadlines", () => {
  it("cancels a stalled request body when the total deadline expires", async () => {
    let bodyCancelled = false;
    const requestBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [],
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      totalTimeoutMs: 30,
    });

    await expect(fetchFn("https://mcp.example/request-body", {
      method: "POST",
      body: requestBody,
      duplex: "half",
    } as RequestInit)).rejects.toThrow(/total timeout/i);
    await waitFor(() => bodyCancelled);
  });

  it("aborts a stalled TLS connection at the connect deadline and closes its socket", async () => {
    const server = trackServer(createTcpServer((socket) => socket.resume()));
    const port = await listen(server);
    const origin = `https://127.0.0.1:${port}`;
    const safety = AbortSignal.timeout(500);
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [origin],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      connectTimeoutMs: 30,
      headersTimeoutMs: 400,
      bodyTimeoutMs: 400,
      totalTimeoutMs: 400,
    });

    await expect(fetchFn(`${origin}/mcp`, { signal: safety }))
      .rejects.toThrow(/connect timeout/i);
    await waitFor(() => openSockets.size === 0);
  });

  it("aborts when a connected server does not send headers and closes its socket", async () => {
    const server = trackServer(createHttpServer());
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [origin],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      connectTimeoutMs: 200,
      headersTimeoutMs: 30,
      bodyTimeoutMs: 400,
      totalTimeoutMs: 400,
    });

    await expect(fetchFn(`${origin}/mcp`, { signal: AbortSignal.timeout(500) }))
      .rejects.toThrow(/headers timeout/i);
    await waitFor(() => openSockets.size === 0);
  });

  it("aborts a stalled response body at the body deadline and closes its socket", async () => {
    const server = trackServer(createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    }));
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [origin],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      connectTimeoutMs: 200,
      headersTimeoutMs: 200,
      bodyTimeoutMs: 30,
      totalTimeoutMs: 400,
    });

    const response = await fetchFn(`${origin}/mcp`, {
      signal: AbortSignal.timeout(500),
    });
    await expect(response.text()).rejects.toThrow(/body timeout/i);
    await waitFor(() => openSockets.size === 0);
  });

  it("keeps one total deadline across response body consumption", async () => {
    const server = trackServer(createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    }));
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [origin],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      connectTimeoutMs: 200,
      headersTimeoutMs: 200,
      bodyTimeoutMs: 400,
      totalTimeoutMs: 30,
    });

    const response = await fetchFn(`${origin}/mcp`, {
      signal: AbortSignal.timeout(500),
    });
    await expect(response.text()).rejects.toThrow(/total timeout/i);
    await waitFor(() => openSockets.size === 0);
  });

  it("preserves caller aborts while cleaning up the active socket", async () => {
    const server = trackServer(createHttpServer());
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const caller = new AbortController();
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [origin],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      connectTimeoutMs: 400,
      headersTimeoutMs: 400,
      bodyTimeoutMs: 400,
      totalTimeoutMs: 400,
    });

    const pending = fetchFn(`${origin}/mcp`, { signal: caller.signal });
    await waitFor(() => openSockets.size === 1);
    caller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow(/caller cancelled/i);
    await waitFor(() => openSockets.size === 0);
  });
});

describe("secure managed MCP pinned fetch response cleanup", () => {
  it("cancels a redirect response body before following the validated location", async () => {
    let redirectClosed = false;
    const server = trackServer(createHttpServer((request, response) => {
      if (request.url === "/redirect") {
        response.once("close", () => {
          redirectClosed = true;
        });
        response.writeHead(302, { location: "/final" });
        response.write("ignored");
        return;
      }
      response.end("done");
    }));
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [origin],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      connectTimeoutMs: 200,
      headersTimeoutMs: 200,
      bodyTimeoutMs: 200,
      totalTimeoutMs: 500,
    });

    const response = await fetchFn(`${origin}/redirect`);
    await expect(response.text()).resolves.toBe("done");
    await waitFor(() => redirectClosed);
  });
});
