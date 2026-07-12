import { describe, expect, it, vi } from "vitest";
import { createElectronBrowserAgentTabFactory } from "./browser-agent-electron.js";

function createHarness() {
  const handlers = new Map<string, (...args: any[]) => void>();
  let openHandler: ((details: { url: string }) => { action: "deny" }) | null = null;
  const image = { toPNG: vi.fn(() => Buffer.from("png")) };
  const webContents = {
    getURL: vi.fn(() => "https://example.com"),
    getTitle: vi.fn(() => "Example"),
    isDestroyed: vi.fn(() => false),
    stop: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
    }),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: "deny" }) => {
      openHandler = handler;
    }),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ ok: true })),
    capturePage: vi.fn(async () => image),
  };
  const browserWindow = {
    webContents,
    loadURL: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
  };
  const createWindow = vi.fn(() => browserWindow);
  const registerGuest = vi.fn();
  const factory = createElectronBrowserAgentTabFactory({
    partition: "persist:rudder-browser-v1-test",
    createWindow,
    registerGuest,
    getControlPlaneOrigins: () => ["http://127.0.0.1:3100"],
  });
  return {
    browserWindow,
    createWindow,
    factory,
    getOpenHandler: () => openHandler,
    handlers,
    image,
    registerGuest,
    webContents,
  };
}

describe("Electron Browser Agent tab adapter", () => {
  it("creates a hidden sandboxed window on the dedicated Browser partition", async () => {
    const { createWindow, factory, registerGuest, webContents } = createHarness();
    const tab = await factory({
      tabId: "tab-1",
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
    });

    expect(createWindow).toHaveBeenCalledWith({
      show: false,
      webPreferences: expect.objectContaining({
        partition: "persist:rudder-browser-v1-test",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        devTools: false,
        disableDialogs: true,
        backgroundThrottling: false,
      }),
    });
    expect(createWindow.mock.calls[0]?.[0].webPreferences).not.toHaveProperty("preload");
    expect(registerGuest).toHaveBeenCalledWith(webContents);

    await tab.loadURL("https://example.com");
    expect(tab.getURL()).toBe("https://example.com");
    expect(tab.getTitle()).toBe("Example");
    await expect(tab.executeIsolatedJavaScript("fixed-script")).resolves.toEqual({ ok: true });
    expect(webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      10_001,
      [{ code: "fixed-script" }],
      true,
    );
    await expect(tab.capturePng()).resolves.toEqual(Buffer.from("png"));
  });

  it("denies every popup without creating an unaudited Agent tab", async () => {
    const { factory, getOpenHandler } = createHarness();
    await factory({
      tabId: "tab-1",
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
    });

    expect(getOpenHandler()?.({ url: "https://example.com/popup" })).toEqual({ action: "deny" });
    expect(getOpenHandler()?.({ url: "file:///tmp/private.txt" })).toEqual({ action: "deny" });
    expect(getOpenHandler()?.({ url: "http://localhost:3100/api/orgs" })).toEqual({ action: "deny" });
  });

  it("prevents unsafe navigation and redirect events before the request commits", async () => {
    const { factory, handlers } = createHarness();
    await factory({
      tabId: "tab-1",
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
    });
    const unsafeEvent = { preventDefault: vi.fn() };
    const safeEvent = { preventDefault: vi.fn() };

    handlers.get("will-navigate")?.(unsafeEvent, "file:///tmp/private.txt");
    handlers.get("will-redirect")?.(unsafeEvent, "http://127.0.0.1:3100/api/orgs");
    handlers.get("will-frame-navigate")?.({ ...unsafeEvent, url: "javascript:alert(1)" });
    handlers.get("will-navigate")?.(safeEvent, "https://example.com/next");

    expect(unsafeEvent.preventDefault).toHaveBeenCalledTimes(3);
    expect(safeEvent.preventDefault).not.toHaveBeenCalled();
  });
});
