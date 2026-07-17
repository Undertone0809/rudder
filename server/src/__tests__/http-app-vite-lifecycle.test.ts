import express from "express";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  actorMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("../middleware/index.js", () => ({
  errorHandler: (_err: unknown, _req: unknown, _res: unknown, next: () => void) => next(),
  httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/private-hostname-guard.js", () => ({
  privateHostnameGuard: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  resolvePrivateHostnameAllowSet: vi.fn(() => new Set<string>()),
}));
vi.mock("../routes/llms.js", () => ({ llmRoutes: vi.fn(() => express.Router()) }));
vi.mock("../routes/plugin-ui-static.js", () => ({
  pluginUiStaticRoutes: vi.fn(() => express.Router()),
}));
vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "/tmp/rudder-plugins",
}));
vi.mock("../ui-branding.js", () => ({ applyUiBranding: (html: string) => html }));
vi.mock("../bootstrap/register-api-routes.js", () => ({
  registerApiRoutes: vi.fn(() => express.Router()),
}));

import { createHttpApp, resolveViteHmrPort } from "../bootstrap/create-http-app.js";
import { registerApiRoutes } from "../bootstrap/register-api-routes.js";
import { logger } from "../middleware/logger.js";
import type { ChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import { pluginUiStaticRoutes } from "../routes/plugin-ui-static.js";

async function reserveEphemeralPort(): Promise<number> {
  const server = createServer();
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
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

const baseOpts = {
  uiMode: "vite-dev",
  storageService: {},
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  allowedHostnames: [],
  bindHost: "127.0.0.1",
  authReady: false,
  companyDeletionEnabled: false,
} as const;

describe("createHttpApp Vite lifecycle", () => {
  it("closes the Chat runtime when API route registration fails", async () => {
    vi.mocked(registerApiRoutes).mockImplementationOnce((_db, _opts, _plugins, _preview, runtime) => {
      expect(runtime?.acceptingWork).toBe(true);
      throw new Error("route registration failed");
    });

    await expect(createHttpApp(
      {} as never,
      { ...baseOpts, uiMode: "none", serverPort: 3100 } as never,
      {} as never,
    )).rejects.toThrow("route registration failed");

    const runtime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[4] as ChatBackgroundRuntime;
    expect(runtime.acceptingWork).toBe(false);
  });

  it("closes the Chat runtime when post-registration route setup fails", async () => {
    vi.mocked(pluginUiStaticRoutes).mockImplementationOnce(() => {
      throw new Error("plugin UI setup failed");
    });

    await expect(createHttpApp(
      {} as never,
      { ...baseOpts, uiMode: "none", serverPort: 3100 } as never,
      {} as never,
    )).rejects.toThrow("plugin UI setup failed");

    const runtime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[4] as ChatBackgroundRuntime;
    expect(runtime.acceptingWork).toBe(false);
  });

  it("preserves the startup error when post-registration cleanup also fails", async () => {
    const startupError = new Error("plugin UI setup failed");
    const cleanupError = new Error("Chat runtime close failed");
    const logError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.mocked(pluginUiStaticRoutes).mockImplementationOnce(() => {
      const runtime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[4] as ChatBackgroundRuntime;
      runtime.close = vi.fn().mockRejectedValue(cleanupError);
      throw startupError;
    });

    await expect(createHttpApp(
      {} as never,
      { ...baseOpts, uiMode: "none", serverPort: 3100 } as never,
      {} as never,
    )).rejects.toBe(startupError);
    expect(logError).toHaveBeenCalledWith(
      { err: cleanupError, startupError },
      "HTTP app startup rollback failed",
    );
    logError.mockRestore();
  });

  it("closes the owned HMR listener idempotently so the same port can be rebound", async () => {
    const hmrPort = await reserveEphemeralPort();
    expect(hmrPort).toBeGreaterThan(11_023);
    const serverPort = hmrPort - 10_000;
    expect(resolveViteHmrPort(serverPort)).toBe(hmrPort);

    const first = await createHttpApp(
      {} as never,
      { ...baseOpts, serverPort } as never,
      {} as never,
    );
    const firstChatRuntime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[4] as ChatBackgroundRuntime;
    expect(firstChatRuntime.acceptingWork).toBe(true);
    expect(await canBind(hmrPort)).toBe(false);

    const firstClose = first.close();
    const duplicateClose = first.close();
    expect(duplicateClose).toBe(firstClose);
    await firstClose;
    expect(firstChatRuntime.acceptingWork).toBe(false);
    expect(firstChatRuntime.setTimeout(vi.fn(), 0)).toBeNull();
    expect(await canBind(hmrPort)).toBe(true);

    const second = await createHttpApp(
      {} as never,
      { ...baseOpts, serverPort } as never,
      {} as never,
    );
    const secondChatRuntime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[4] as ChatBackgroundRuntime;
    expect(secondChatRuntime).not.toBe(firstChatRuntime);
    expect(secondChatRuntime.acceptingWork).toBe(true);
    expect(await canBind(hmrPort)).toBe(false);
    await second.close();
    expect(secondChatRuntime.acceptingWork).toBe(false);
    expect(await canBind(hmrPort)).toBe(true);
  });

  it("closes Vite even when the Chat runtime disposer fails", async () => {
    const hmrPort = await reserveEphemeralPort();
    const serverPort = hmrPort - 10_000;
    const cleanupError = new Error("Chat runtime close failed");
    const handle = await createHttpApp(
      {} as never,
      { ...baseOpts, serverPort } as never,
      {} as never,
    );
    const runtime = vi.mocked(registerApiRoutes).mock.calls.at(-1)?.[4] as ChatBackgroundRuntime;
    runtime.close = vi.fn().mockImplementation(() => {
      throw cleanupError;
    });

    expect(await canBind(hmrPort)).toBe(false);
    await expect(handle.close()).rejects.toBe(cleanupError);
    expect(await canBind(hmrPort)).toBe(true);
  });
});
