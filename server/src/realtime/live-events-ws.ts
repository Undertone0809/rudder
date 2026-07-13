import type { Db } from "@rudderhq/db";
import { agentApiKeys, instanceUserRoles, organizationMemberships } from "@rudderhq/db";
import type { DeploymentMode } from "@rudderhq/shared";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  close(callback: (error?: Error) => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  orgId: string;
  actorType: "board" | "agent";
  actorId: string;
}

interface IncomingMessageWithContext extends IncomingMessage {
  rudderUpgradeContext?: UpgradeContext;
}

export interface LiveEventsWebSocketRuntime {
  close(): Promise<void>;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/orgs\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  orgId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        orgId,
        actorType: "board",
        actorId: "board",
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ orgId: organizationMemberships.orgId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.principalType, "user"),
            eq(organizationMemberships.principalId, userId),
            eq(organizationMemberships.status, "active"),
          ),
        ),
    ]);

    const hasCompanyMembership = memberships.some((row) => row.orgId === orgId);
    if (!roleRow && !hasCompanyMembership) return null;

    return {
      orgId,
      actorType: "board",
      actorId: userId,
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.orgId !== orgId) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    orgId,
    actorType: "agent",
    actorId: key.agentId,
  };
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): LiveEventsWebSocketRuntime {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();
  const pendingUpgradeSockets = new Set<Duplex>();
  let closing = false;
  let closeInFlight: Promise<void> | null = null;

  const cleanupClient = (socket: WsSocket) => {
    const cleanup = cleanupByClient.get(socket);
    cleanupByClient.delete(socket);
    aliveByClient.delete(socket);
    try {
      cleanup?.();
    } catch (err) {
      logger.warn({ err }, "live websocket subscription cleanup failed");
    }
  };

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).rudderUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const unsubscribe = subscribeCompanyLiveEvents(context.orgId, (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(event));
    });

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      cleanupClient(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, orgId: context.orgId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing) {
      socket.destroy();
      return;
    }
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const orgId = parseCompanyId(url.pathname);
    if (!orgId) {
      socket.destroy();
      return;
    }

    const removePendingSocket = () => pendingUpgradeSockets.delete(socket);
    pendingUpgradeSockets.add(socket);
    socket.once("close", removePendingSocket);
    void authorizeUpgrade(db, req, orgId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((context) => {
        if (closing) {
          socket.destroy();
          return;
        }
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.rudderUpgradeContext = context;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        if (closing) {
          socket.destroy();
          return;
        }
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      })
      .finally(() => {
        pendingUpgradeSockets.delete(socket);
        socket.off("close", removePendingSocket);
      });
  };

  server.on("upgrade", handleUpgrade);

  return {
    close(): Promise<void> {
      if (closeInFlight) return closeInFlight;
      closing = true;
      server.off("upgrade", handleUpgrade);
      clearInterval(pingInterval);

      for (const socket of pendingUpgradeSockets) {
        socket.destroy();
      }
      pendingUpgradeSockets.clear();

      for (const socket of wss.clients) {
        try {
          cleanupClient(socket);
        } finally {
          socket.terminate();
        }
      }

      closeInFlight = new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      return closeInFlight;
    },
  };
}
