import { createServer, request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServerShutdown } from "./http-server-shutdown.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";

describe("HTTP server shutdown", () => {
  const servers = new Set<ReturnType<typeof createServer>>();

  afterEach(() => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    servers.clear();
  });

  it("forces a hanging active request closed and continues downstream disposal", async () => {
    const requestArrived = new Promise<void>((resolve) => {
      const server = createServer((_request, _response) => {
        resolve();
        // Deliberately leave the response active, matching a renderer request
        // that would otherwise keep server.close() pending forever.
      });
      servers.add(server);
    });
    const server = Array.from(servers)[0]!;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port");

    const clientRequest = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/queue",
      agent: false,
    });
    clientRequest.on("error", () => undefined);
    clientRequest.end();
    await requestArrived;

    const forceClose = vi.fn();
    const downstreamDispose = vi.fn();
    const supervisor = new RuntimeSupervisor();
    supervisor.own("downstream-runtime", downstreamDispose);
    supervisor.own("http-server-drain", createHttpServerShutdown(server, {
      gracePeriodMs: 20,
      onForceClose: forceClose,
    }));

    await expect(supervisor.dispose()).resolves.toBeUndefined();
    expect(forceClose).toHaveBeenCalledOnce();
    expect(downstreamDispose).toHaveBeenCalledOnce();
  });

  it("is idempotent and does not force close a normally drained server", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const forceClose = vi.fn();
    const shutdown = createHttpServerShutdown(server, {
      gracePeriodMs: 1_000,
      onForceClose: forceClose,
    });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(forceClose).not.toHaveBeenCalled();
  });

  it("continues force-close when a shutdown reporter throws", async () => {
    const server = createServer((_request, _response) => undefined);
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port");

    const requestArrived = new Promise<void>((resolve) => server.once("request", () => resolve()));
    const clientRequest = request({ host: "127.0.0.1", port: address.port, path: "/queue", agent: false });
    clientRequest.on("error", () => undefined);
    clientRequest.end();
    await requestArrived;

    const closeAllConnections = vi.spyOn(server, "closeAllConnections");
    const shutdown = createHttpServerShutdown(server, {
      gracePeriodMs: 5,
      onForceClose: () => { throw new Error("reporting failed"); },
    });

    await expect(shutdown()).resolves.toBeUndefined();
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });
});
