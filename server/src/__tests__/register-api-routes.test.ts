import { describe, expect, it } from "vitest";
import { registerApiRoutes } from "../bootstrap/register-api-routes.js";

describe("registerApiRoutes", () => {
  it("builds the API router without bootstrapping the plugin host", () => {
    const router = registerApiRoutes(
      {} as never,
      {
        uiMode: "none",
        serverPort: 3100,
        storageService: {} as never,
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        authReady: true,
        companyDeletionEnabled: false,
      },
      {
        loader: {} as never,
        scheduler: {} as never,
        jobStore: {} as never,
        workerManager: {} as never,
        toolDispatcher: {} as never,
        start: async () => undefined,
        close: async () => undefined,
      },
    );

    expect(router).toBeTruthy();
    expect((router as { stack?: unknown[] }).stack?.length ?? 0).toBeGreaterThan(10);
  });
});
