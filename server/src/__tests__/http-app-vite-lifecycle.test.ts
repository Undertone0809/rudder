import express from "express";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actorMiddlewareRequests = vi.hoisted(() => [] as string[]);

vi.mock("../middleware/auth.js", () => ({
  actorMiddleware: vi.fn(() => (
    req: { originalUrl: string; actor?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    actorMiddlewareRequests.push(req.originalUrl);
    req.actor = { type: "none" };
    next();
  }),
}));
vi.mock("../middleware/index.js", () => ({
  errorHandler: (_err: unknown, _req: unknown, _res: unknown, next: () => void) => next(),
  httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
  markBrowserHttpRequestBodySensitive: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
}));
vi.mock("../middleware/private-hostname-guard.js", () => ({
  privateHostnameGuard: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  resolvePrivateHostnameAllowSet: vi.fn(() => new Set<string>()),
}));
vi.mock("../routes/llms.js", () => ({ llmRoutes: vi.fn(() => express.Router()) }));
vi.mock("../services/rudder-plugins.js", () => ({
  rudderPluginService: vi.fn(() => ({ syncAllLocalApps: vi.fn(async () => undefined) })),
}));
vi.mock("../services/rust-foundation-bridge.js", () => ({
  createRustFoundationBridge: vi.fn(() => ({
    mode: "off",
    organizationBrandingMode: "off",
    projectGoalSetMode: "off",
    requiresStartup: true,
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  })),
}));
vi.mock("../ui-branding.js", () => ({ applyUiBranding: (html: string) => html }));
vi.mock("../bootstrap/register-api-routes.js", () => ({
  registerApiRoutes: vi.fn(() => express.Router()),
}));

import { createHttpApp, resolveViteHmrPort } from "../bootstrap/create-http-app.js";
import { registerApiRoutes } from "../bootstrap/register-api-routes.js";
import type { ChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import { createRustFoundationBridge } from "../services/rust-foundation-bridge.js";

function createLifecycleDb() {
  return {
    // All-off optional authorities still enter the startup transaction. Its
    // callback has no handoff queries, so these lifecycle tests need no DB.
    transaction: vi.fn(async (callback: (tx: Record<string, never>) => Promise<void>) => callback({})),
  };
}

async function reserveEphemeralPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an assigned TCP port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function canBind(port: number): Promise<boolean> {
  const server = createTcpServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function requestRawPath(baseUrl: string, path: string, method = "POST") {
  const { hostname, port } = new URL(baseUrl);
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname,
      port: Number(port),
      path,
      method,
      headers: { "content-type": "application/json" },
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

const baseOpts = {
  uiMode: "vite-dev",
  storageService: {},
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  rustFoundationMode: "off",
  rustOrganizationBrandingMode: "off",
  // The bridge lifecycle is stubbed; native reads/writes are not exercised.
  rustProjectGoalSetMode: "off",
  allowedHostnames: [],
  bindHost: "127.0.0.1",
  authReady: false,
  companyDeletionEnabled: false,
} as const;

describe("createHttpApp Vite lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actorMiddlewareRequests.length = 0;
  });

  it("fences native email-auth POSTs on the private Node listener and preserves other modes", async () => {
    const db = createLifecycleDb();
    const betterAuthRequests: string[] = [];
    const betterAuthHandler = vi.fn((req: { method: string; originalUrl: string }, res: {
      status(code: number): { json(value: unknown): void };
    }) => {
      betterAuthRequests.push(`${req.method} ${req.originalUrl}`);
      res.status(200).json({ handled: true });
    });
    const ingressKey = "native-private-ingress-key-1234567890";
    const actorEnvelopeKey = "native-actor-envelope-key-1234567890";
    const rustMode = await createHttpApp(db as never, {
      ...baseOpts,
      uiMode: "none",
      serverPort: 3100,
      rustPublicIngressAuthKey: ingressKey,
      rustFoundationActorEnvelopeKey: actorEnvelopeKey,
      rustPublicIngress: {
        listenAddr: "127.0.0.1:3100",
        nodeUpstream: "http://127.0.0.1:3101",
        authorizationKey: ingressKey,
      },
      betterAuthHandler,
    } as never);
    const rustServer = createHttpServer(rustMode.app);
    await new Promise<void>((resolve, reject) => {
      rustServer.once("error", reject);
      rustServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = rustServer.address();
      if (!address || typeof address === "string") throw new Error("Expected an assigned HTTP port");
      const privateBase = `http://127.0.0.1:${address.port}`;
      const requestsBeforeFence = actorMiddlewareRequests.length;
      const dbTransactionsBeforeFence = db.transaction.mock.calls.length;
      const protectedPaths = [
        "/api/auth/sign-up/email",
        "/api/auth/sign-in/email",
        "/api/auth/sign-out",
        "/API/AUTH/SIGN-UP/EMAIL?source=private",
        "/api/auth/sign-in%2Femail",
        "/api/auth/sign-out/",
        "/api/auth/sign-up%252femail",
        "/api/auth/unused/../sign-in/email",
      ];
      for (const path of protectedPaths) {
        const response = await requestRawPath(privateBase, path);
        expect(response.statusCode, path).toBe(404);
        expect(JSON.parse(response.body), path).toEqual({ error: "API route not found" });
      }
      expect(betterAuthRequests).toEqual([]);
      expect(actorMiddlewareRequests).toHaveLength(requestsBeforeFence);
      expect(db.transaction).toHaveBeenCalledTimes(dbTransactionsBeforeFence);

      const otherAuthRoute = await requestRawPath(privateBase, "/api/auth/verify-email", "POST");
      expect(otherAuthRoute.statusCode).toBe(200);
      expect(JSON.parse(otherAuthRoute.body)).toEqual({ handled: true });
      expect(betterAuthRequests).toEqual(["POST /api/auth/verify-email"]);
    } finally {
      await new Promise<void>((resolve, reject) => rustServer.close((error) => error ? reject(error) : resolve()));
      await rustMode.close();
    }

    const legacyDb = createLifecycleDb();
    const legacyHandler = vi.fn((_req: unknown, res: { status(code: number): { json(value: unknown): void } }) => {
      res.status(200).json({ handled: true });
    });
    const legacyMode = await createHttpApp(legacyDb as never, {
      ...baseOpts,
      uiMode: "none",
      serverPort: 3100,
      betterAuthHandler: legacyHandler,
    } as never);
    const legacyServer = createHttpServer(legacyMode.app);
    await new Promise<void>((resolve, reject) => {
      legacyServer.once("error", reject);
      legacyServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = legacyServer.address();
      if (!address || typeof address === "string") throw new Error("Expected an assigned HTTP port");
      const legacySignup = await requestRawPath(`http://127.0.0.1:${address.port}`, "/api/auth/sign-up/email");
      expect(legacySignup.statusCode).toBe(200);
      expect(legacyHandler).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => legacyServer.close((error) => error ? reject(error) : resolve()));
      await legacyMode.close();
    }
  });

  it("rejects required native ingress without issuer facts before acquiring app resources", async () => {
    for (const deploymentMode of ["local_trusted", "authenticated"] as const) {
      await expect(createHttpApp({} as never, {
        ...baseOpts, uiMode: "none", serverPort: 3100, deploymentMode, authRequirement: "required",
        rustPublicIngress: { listenAddr: "127.0.0.1:3100", nodeUpstream: "http://127.0.0.1:3101", authorizationKey: "test" },
      } as never)).rejects.toThrow("matching private authorization and explicit actor signing keys");
    }
    expect(createRustFoundationBridge).not.toHaveBeenCalled();
    expect(registerApiRoutes).not.toHaveBeenCalled();
  });

  it("closes the Chat runtime when API route registration fails", async () => {
    const db = createLifecycleDb();
    vi.mocked(registerApiRoutes).mockImplementationOnce((_db, _opts, _preview, runtime) => {
      expect(runtime?.acceptingWork).toBe(true);
      throw new Error("route registration failed");
    });

    await expect(createHttpApp(
      db as never,
      { ...baseOpts, uiMode: "none", serverPort: 3100 } as never,
    )).rejects.toThrow("route registration failed");

    const runtime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[3] as ChatBackgroundRuntime;
    expect(runtime.acceptingWork).toBe(false);
    const bridge = vi.mocked(createRustFoundationBridge).mock.results.at(-1)?.value;
    expect(bridge?.start).toHaveBeenCalledTimes(1);
    expect(bridge?.close).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("closes the owned HMR listener idempotently so the same port can be rebound", async () => {
    const hmrPort = await reserveEphemeralPort();
    expect(hmrPort).toBeGreaterThan(11_023);
    const serverPort = hmrPort - 10_000;
    expect(resolveViteHmrPort(serverPort)).toBe(hmrPort);

    const firstDb = createLifecycleDb();
    const first = await createHttpApp(
      firstDb as never,
      { ...baseOpts, serverPort } as never,
    );
    const firstBridge = vi.mocked(createRustFoundationBridge).mock.results.at(-1)?.value;
    expect(firstBridge?.start).toHaveBeenCalledTimes(1);
    expect(firstDb.transaction).toHaveBeenCalledTimes(1);
    const firstChatRuntime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[3] as ChatBackgroundRuntime;
    expect(firstChatRuntime.acceptingWork).toBe(true);
    expect(await canBind(hmrPort)).toBe(false);

    const firstClose = first.close();
    const duplicateClose = first.close();
    expect(duplicateClose).toBe(firstClose);
    await firstClose;
    expect(firstBridge?.close).toHaveBeenCalledTimes(1);
    expect(firstChatRuntime.acceptingWork).toBe(false);
    expect(firstChatRuntime.setTimeout(vi.fn(), 0)).toBeNull();
    expect(await canBind(hmrPort)).toBe(true);

    const secondDb = createLifecycleDb();
    const second = await createHttpApp(
      secondDb as never,
      { ...baseOpts, serverPort } as never,
    );
    const secondBridge = vi.mocked(createRustFoundationBridge).mock.results.at(-1)?.value;
    expect(secondBridge).not.toBe(firstBridge);
    expect(secondBridge?.start).toHaveBeenCalledTimes(1);
    expect(secondDb.transaction).toHaveBeenCalledTimes(1);
    const secondChatRuntime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[3] as ChatBackgroundRuntime;
    expect(secondChatRuntime).not.toBe(firstChatRuntime);
    expect(secondChatRuntime.acceptingWork).toBe(true);
    expect(await canBind(hmrPort)).toBe(false);
    await second.close();
    expect(secondBridge?.close).toHaveBeenCalledTimes(1);
    expect(secondChatRuntime.acceptingWork).toBe(false);
    expect(await canBind(hmrPort)).toBe(true);
  });

  it("closes Vite even when the Chat runtime disposer fails", async () => {
    const hmrPort = await reserveEphemeralPort();
    const serverPort = hmrPort - 10_000;
    const cleanupError = new Error("Chat runtime close failed");
    const db = createLifecycleDb();
    const handle = await createHttpApp(
      db as never,
      { ...baseOpts, serverPort } as never,
    );
    const bridge = vi.mocked(createRustFoundationBridge).mock.results.at(-1)?.value;
    expect(bridge?.start).toHaveBeenCalledTimes(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const runtime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[3] as ChatBackgroundRuntime;
    runtime.close = vi.fn().mockImplementation(() => {
      throw cleanupError;
    });

    expect(await canBind(hmrPort)).toBe(false);
    await expect(handle.close()).rejects.toBe(cleanupError);
    expect(bridge?.close).toHaveBeenCalledTimes(1);
    expect(await canBind(hmrPort)).toBe(true);
  });
});
