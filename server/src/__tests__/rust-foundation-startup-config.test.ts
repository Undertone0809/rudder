import { describe, expect, it, vi } from "vitest";

const createRudderAppMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ app: {}, close: vi.fn() }),
);

vi.mock("../app.js", () => ({
  createRudderApp: createRudderAppMock,
}));

import { createRudderAppForServerRuntime } from "../runtime/server-app-runtime.js";

describe("Rust member directory supported startup wiring", () => {
  it("passes the active database and explicit bridge config into createRudderApp", async () => {
    const bridgeConfig = {
      rustFoundationMode: "required",
      rustOrganizationBrandingMode: "required",
      rustProjectGoalSetMode: "required",
      rustFoundationBinaryPath: "/tmp/rudder-server-foundation",
      rustFoundationActorEnvelopeKey: "actor-envelope-key",
    } as const;
    const config = {
      uiDevMiddleware: false,
      serveUi: true,
      authPublicBaseUrl: null,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      host: "127.0.0.1",
      workspacePreviewOrigin: null,
      companyDeletionEnabled: false,
      ...bridgeConfig,
    } as const;
    const db = {};
    const authRuntime = {
      authReady: true,
      betterAuthHandler: vi.fn(),
      resolveSession: vi.fn(),
      localAccountExchangePolicy: null,
      localAccountSessionRevocation: null,
    };
    const storageService = {};
    const registerNetworkWaitingRunHandler = vi.fn();
    const activeDatabaseConnectionString = "postgres://active-database";

    await createRudderAppForServerRuntime({
      db: db as never,
      config: config as never,
      listenPort: 3199,
      storageService: storageService as never,
      authRuntime: authRuntime as never,
      localAccountAuth: true,
      activeDatabaseConnectionString,
      instanceId: "instance-1",
      localEnv: "local",
      runtimeOwnerKind: "server" as never,
      registerNetworkWaitingRunHandler,
    });

    expect(createRudderAppMock).toHaveBeenCalledOnce();
    expect(createRudderAppMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        databaseUrl: activeDatabaseConnectionString,
        ...bridgeConfig,
      }),
    );
  });
});
