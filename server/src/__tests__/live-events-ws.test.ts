import type { Db } from "@rudderhq/db";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";
import { createLocalAccountSessionRevocation } from "../services/local-account-session-revocation.js";

type LiveEventsRuntime = ReturnType<typeof setupLiveEventsWebSocketServer>;

const openServers = new Set<Server>();
const openSockets = new Set<WebSocket>();
const openRuntimes = new Set<LiveEventsRuntime>();

async function listen(server: Server): Promise<number> {
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 500);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

afterEach(async () => {
  for (const socket of openSockets) socket.terminate();
  openSockets.clear();

  for (const runtime of openRuntimes) {
    await Promise.resolve(runtime.close()).catch(() => undefined);
  }
  openRuntimes.clear();

  for (const server of openServers) await closeServer(server);
  openServers.clear();
  vi.useRealTimers();
});

describe("Live Events WebSocket runtime", () => {
  it("rejects an anonymous local WebSocket when account auth is required", async () => {
    const server = createServer();
    const runtime = setupLiveEventsWebSocketServer(server, {} as Db, {
      deploymentMode: "local_trusted",
      authRequirement: "required",
      resolveSessionFromHeaders: async () => null,
    });
    openRuntimes.add(runtime);
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/orgs/org-1/events/ws`);
    socket.on("error", () => undefined);
    openSockets.add(socket);

    const [, response] = await once(socket, "unexpected-response");
    expect((response as { statusCode?: number }).statusCode).toBe(403);
    socket.terminate();
    openSockets.delete(socket);
  });

  it("preserves local-trusted event delivery and payload shape", async () => {
    const server = createServer();
    const runtime = setupLiveEventsWebSocketServer(server, {} as Db, {
      deploymentMode: "local_trusted",
    });
    openRuntimes.add(runtime);
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/orgs/org-1/events/ws`);
    openSockets.add(socket);
    await once(socket, "open");

    const received = once(socket, "message");
    const published = publishLiveEvent({
      orgId: "org-1",
      type: "issue.content_updated",
      payload: { entityId: "issue-1" },
    });
    const [raw] = await received;

    expect(JSON.parse(String(raw))).toEqual(published);

    const closed = once(socket, "close");
    socket.close();
    await closed;
    openSockets.delete(socket);
  });

  it("closes active board WebSockets when all local account sessions are revoked", async () => {
    const server = createServer();
    const sessionRevocation = createLocalAccountSessionRevocation();
    const runtime = setupLiveEventsWebSocketServer(server, {} as Db, {
      deploymentMode: "local_trusted",
      sessionRevocation,
    });
    openRuntimes.add(runtime);
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/orgs/org-1/events/ws`);
    openSockets.add(socket);
    await once(socket, "open");

    const closed = once(socket, "close");
    sessionRevocation.publish("board");
    const [code, reason] = await closed;

    expect(code).toBe(1008);
    expect(String(reason)).toBe("account signed out");
    openSockets.delete(socket);
  });

  it("rejects an account WebSocket when revocation wins during session lookup", async () => {
    let releaseSession!: () => void;
    let markSessionRequested!: () => void;
    const sessionRequested = new Promise<void>((resolve) => {
      markSessionRequested = resolve;
    });
    const delayedSession = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "role-1", orgId: "org-1" }]),
        }),
      }),
    } as unknown as Db;
    const sessionRevocation = createLocalAccountSessionRevocation();
    const server = createServer();
    const runtime = setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "local_trusted",
      authRequirement: "required",
      sessionRevocation,
      resolveSessionFromHeaders: async () => {
        markSessionRequested();
        await delayedSession;
        return {
          session: { id: "session-1", userId: "user-1" },
          user: { id: "user-1", email: "user@example.com", name: "User" },
        };
      },
    });
    openRuntimes.add(runtime);
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/orgs/org-1/events/ws`);
    socket.on("error", () => undefined);
    openSockets.add(socket);

    await sessionRequested;
    sessionRevocation.publish("user-1");
    releaseSession();
    const [, response] = await once(socket, "unexpected-response");

    expect((response as { statusCode?: number }).statusCode).toBe(403);
    socket.terminate();
    openSockets.delete(socket);
  });

  it("closes active clients and removes only its own upgrade listener", async () => {
    const server = createServer();
    const unrelatedUpgradeListener = vi.fn();
    server.on("upgrade", unrelatedUpgradeListener);
    const initialUpgradeListeners = server.listenerCount("upgrade");
    const runtime = setupLiveEventsWebSocketServer(server, {} as Db, {
      deploymentMode: "local_trusted",
    });
    openRuntimes.add(runtime);
    expect(server.listenerCount("upgrade")).toBe(initialUpgradeListeners + 1);

    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/orgs/org-1/events/ws`);
    openSockets.add(socket);
    await once(socket, "open");
    const clientClosed = once(socket, "close");

    await Promise.all([runtime.close(), runtime.close()]);

    expect(server.listenerCount("upgrade")).toBe(initialUpgradeListeners);
    expect(server.listeners("upgrade")).toContain(unrelatedUpgradeListener);
    await clientClosed;
    openSockets.delete(socket);
    openRuntimes.delete(runtime);
  });

  it("clears the WebSocket heartbeat timer during close", async () => {
    vi.useFakeTimers();
    const initialTimerCount = vi.getTimerCount();
    const server = createServer();
    const runtime = setupLiveEventsWebSocketServer(server, {} as Db, {
      deploymentMode: "local_trusted",
    });
    openRuntimes.add(runtime);

    expect(vi.getTimerCount()).toBe(initialTimerCount + 1);

    await runtime.close();

    expect(vi.getTimerCount()).toBe(initialTimerCount);
    openRuntimes.delete(runtime);
  });

  it("destroys pending authenticated upgrades so the HTTP server can close", async () => {
    let releaseSession!: (session: null) => void;
    let markSessionRequested!: () => void;
    const pendingSession = new Promise<null>((resolve) => {
      releaseSession = resolve;
    });
    const sessionRequested = new Promise<void>((resolve) => {
      markSessionRequested = resolve;
    });
    const server = createServer();
    const runtime = setupLiveEventsWebSocketServer(server, {} as Db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: async () => {
        markSessionRequested();
        return pendingSession;
      },
    });
    openRuntimes.add(runtime);
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/orgs/org-1/events/ws`);
    socket.on("error", () => undefined);
    openSockets.add(socket);
    const socketClosed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });

    await withTimeout(sessionRequested, "session authorization");
    const httpClosed = closeServer(server);
    try {
      await withTimeout(
        Promise.all([runtime.close(), httpClosed, socketClosed]),
        "pending upgrade shutdown",
      );
    } finally {
      releaseSession(null);
    }

    openSockets.delete(socket);
    openRuntimes.delete(runtime);
  });
});
