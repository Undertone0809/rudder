import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRudderApp } from "../app.js";

const mocks = vi.hoisted(() => ({
  configureBrowserCapabilityDeployment: vi.fn(),
  createHttpApp: vi.fn(),
  createPluginHostRuntime: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../bootstrap/create-http-app.js", () => ({
  createHttpApp: mocks.createHttpApp,
  resolveViteHmrPort: (port: number) => port + 10_000,
}));
vi.mock("../bootstrap/plugin-host-runtime.js", () => ({
  createPluginHostRuntime: mocks.createPluginHostRuntime,
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

  it("rolls back the plugin runtime when HTTP app creation fails", async () => {
    const startupError = new Error("HTTP app creation failed");
    const pluginRuntime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    mocks.createPluginHostRuntime.mockReturnValueOnce(pluginRuntime);
    mocks.createHttpApp.mockRejectedValueOnce(startupError);

    await expect(createRudderApp({} as never, opts as never)).rejects.toBe(startupError);

    expect(pluginRuntime.start).not.toHaveBeenCalled();
    expect(pluginRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("rolls back the HTTP app and plugin runtime when plugin startup fails", async () => {
    const startupError = new Error("plugin startup failed");
    const events: string[] = [];
    const pluginRuntime = {
      start: vi.fn(async () => {
        throw startupError;
      }),
      close: vi.fn(async () => {
        events.push("plugin:close");
      }),
    };
    const httpApp = {
      app: {} as never,
      close: vi.fn(async () => {
        events.push("http:close");
      }),
    };
    mocks.createPluginHostRuntime.mockReturnValueOnce(pluginRuntime);
    mocks.createHttpApp.mockResolvedValueOnce(httpApp);

    await expect(createRudderApp({} as never, opts as never)).rejects.toBe(startupError);

    expect(httpApp.close).toHaveBeenCalledTimes(1);
    expect(pluginRuntime.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["http:close", "plugin:close"]);
  });

  it("shares one ordered cleanup across concurrent and repeated close calls", async () => {
    const events: string[] = [];
    let releaseHttp!: () => void;
    const httpClosed = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const pluginRuntime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        events.push("plugin:close");
      }),
    };
    const httpApp = {
      app: {} as never,
      close: vi.fn(async () => {
        events.push("http:start");
        await httpClosed;
        events.push("http:end");
      }),
    };
    mocks.createPluginHostRuntime.mockReturnValueOnce(pluginRuntime);
    mocks.createHttpApp.mockResolvedValueOnce(httpApp);
    const handle = await createRudderApp({} as never, opts as never);

    const firstClose = handle.close();
    const secondClose = handle.close();
    await vi.waitFor(() => expect(events).toEqual(["http:start"]));

    expect(secondClose).toBe(firstClose);
    expect(pluginRuntime.close).not.toHaveBeenCalled();

    releaseHttp();
    await Promise.all([firstClose, secondClose]);
    await handle.close();

    expect(httpApp.close).toHaveBeenCalledTimes(1);
    expect(pluginRuntime.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["http:start", "http:end", "plugin:close"]);
  });
});
