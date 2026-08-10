import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRudderApp } from "../app.js";

const mocks = vi.hoisted(() => ({
  configureBrowserCapabilityDeployment: vi.fn(),
  createHttpApp: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../bootstrap/create-http-app.js", () => ({
  createHttpApp: mocks.createHttpApp,
  resolveViteHmrPort: (port: number) => port + 10_000,
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: mocks.warn },
}));
vi.mock("../services/browser-capability.js", () => ({
  configureBrowserCapabilityDeployment: mocks.configureBrowserCapabilityDeployment,
}));

const opts = {
  uiMode: "none",
  serverPort: 3100,
  storageService: {},
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  allowedHostnames: [],
  bindHost: "127.0.0.1",
  authReady: false,
  companyDeletionEnabled: false,
} as const;

describe("createRudderApp lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates HTTP app creation failures", async () => {
    const startupError = new Error("HTTP app creation failed");
    mocks.createHttpApp.mockRejectedValueOnce(startupError);

    await expect(createRudderApp({} as never, opts as never)).rejects.toBe(startupError);
  });

  it("shares one ordered cleanup across concurrent and repeated close calls", async () => {
    const events: string[] = [];
    let releaseHttp!: () => void;
    const httpClosed = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const httpApp = {
      app: {} as never,
      close: vi.fn(async () => {
        events.push("http:start");
        await httpClosed;
        events.push("http:end");
      }),
    };
    mocks.createHttpApp.mockResolvedValueOnce(httpApp);
    const handle = await createRudderApp({} as never, opts as never);

    const firstClose = handle.close();
    const secondClose = handle.close();
    await vi.waitFor(() => expect(events).toEqual(["http:start"]));

    expect(secondClose).toBe(firstClose);
    releaseHttp();
    await Promise.all([firstClose, secondClose]);
    await handle.close();

    expect(httpApp.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["http:start", "http:end"]);
  });
});
