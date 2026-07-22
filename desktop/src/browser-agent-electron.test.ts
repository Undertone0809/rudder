import { describe, expect, it, vi } from "vitest";
import { createElectronBrowserAgentTabFactory } from "./browser-agent-electron.js";

function createHarness() {
  const handlers = new Map<string, (...args: any[]) => void>();
  let openHandler: ((details: { url: string }) => { action: "deny" }) | null = null;
  const image = { toPNG: vi.fn(() => Buffer.from("png")) };
  const debuggerHandlers = new Map<string, (...args: any[]) => void>();
  let debuggerAttached = false;
  const browserDebugger = {
    isAttached: vi.fn(() => debuggerAttached),
    attach: vi.fn(() => { debuggerAttached = true; }),
    detach: vi.fn(() => { debuggerAttached = false; }),
    sendCommand: vi.fn(async () => ({})),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => { debuggerHandlers.set(event, handler); }),
    removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (debuggerHandlers.get(event) === handler) debuggerHandlers.delete(event);
    }),
  };
  const webContents = {
    debugger: browserDebugger,
    session: { fetch: vi.fn(), cookies: { set: vi.fn(async () => undefined) } },
    getURL: vi.fn(() => "https://example.com"),
    getTitle: vi.fn(() => "Example"),
    isDestroyed: vi.fn(() => false),
    stop: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
    }),
    once: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
    }),
    removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (handlers.get(event) === handler) handlers.delete(event);
    }),
    removeAllListeners: vi.fn((event: string) => { handlers.delete(event); }),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: "deny" }) => {
      openHandler = handler;
    }),
    executeJavaScript: vi.fn(async () => undefined),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ ok: true })),
    capturePage: vi.fn(async () => image),
    navigationHistory: {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true),
      goBack: vi.fn(() => queueMicrotask(() => handlers.get("did-finish-load")?.())),
      goForward: vi.fn(() => queueMicrotask(() => handlers.get("did-finish-load")?.())),
    },
    reload: vi.fn(() => queueMicrotask(() => handlers.get("did-finish-load")?.())),
  };
  let contentSize: [number, number] = [1280, 720];
  let visible = false;
  const browserWindow = {
    webContents,
    loadURL: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    getContentSize: vi.fn(() => contentSize),
    setContentSize: vi.fn((width: number, height: number) => { contentSize = [width, height]; }),
    isVisible: vi.fn(() => visible),
    showInactive: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    capturePage: vi.fn(async () => image),
    destroy: vi.fn(),
  };
  const createWindow = vi.fn(() => browserWindow);
  const registerGuest = vi.fn();
  const factory = createElectronBrowserAgentTabFactory({
    partition: "persist:rudder-browser-v1-test",
    createWindow,
    registerGuest,
    getRudderAppOrigins: () => ["http://127.0.0.1:3100"],
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
    const { browserWindow, createWindow, factory, registerGuest, webContents } = createHarness();
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
        backgroundThrottling: false,
      }),
    });
    expect(createWindow.mock.calls[0]?.[0].webPreferences).not.toHaveProperty("preload");
    expect(createWindow.mock.calls[0]?.[0].webPreferences).not.toHaveProperty("disableDialogs");
    expect(createWindow.mock.calls[0]?.[0].webPreferences).not.toHaveProperty("safeDialogs");
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
    await tab.goBack();
    await tab.goForward();
    await tab.reload();
    expect(webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(webContents.navigationHistory.goForward).toHaveBeenCalledTimes(1);
    expect(webContents.reload).toHaveBeenCalledTimes(1);
    expect(tab.getViewport()).toEqual({ width: 1280, height: 720 });
    tab.setViewport(390, 844);
    expect(tab.getViewport()).toEqual({ width: 390, height: 844 });
    tab.resetViewport();
    expect(tab.getViewport()).toEqual({ width: 1280, height: 720 });
    expect(tab.isVisible()).toBe(false);
    tab.setVisible(true);
    expect(browserWindow.showInactive).toHaveBeenCalledTimes(1);
    expect(tab.isVisible()).toBe(true);
    tab.setVisible(false);
    expect(browserWindow.hide).toHaveBeenCalledTimes(1);
    expect(tab.isVisible()).toBe(false);
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
    handlers.get("will-frame-navigate")?.(safeEvent, "https://example.com/frame");
    handlers.get("will-navigate")?.(safeEvent, "https://example.com/next");

    expect(unsafeEvent.preventDefault).toHaveBeenCalledTimes(3);
    expect(safeEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("waits for the advanced driver to dispose before destroying the Browser window", async () => {
    const { browserWindow, factory, webContents } = createHarness();
    const tab = await factory({
      tabId: "tab-1",
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
    });
    await tab.advanced("logs", {});

    await tab.close();

    expect(webContents.debugger.detach).toHaveBeenCalledOnce();
    expect(browserWindow.destroy).toHaveBeenCalledOnce();
  });
});
