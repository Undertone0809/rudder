import { describe, expect, it, vi } from "vitest";
import {
  createBrowserGuestRegistry,
  denyBrowserDownload,
  denyBrowserPermissionCheck,
  denyBrowserPermissionRequest,
  hardenBrowserWebviewParams,
  hardenBrowserWebviewPreferences,
  installBrowserSessionPolicy,
  installBrowserWebviewPolicy,
} from "./browser-webview-policy.js";

describe("Rudder Browser webview preferences", () => {
  it("forces the dedicated partition and hardened renderer preferences", () => {
    const hostileSession = { id: "hostile" };
    const preferences = {
      preload: "/tmp/untrusted-preload.cjs",
      partition: "persist:other-profile",
      session: hostileSession,
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      webSecurity: false,
    };
    const params: Record<string, string> = {
      src: "https://example.com",
      preload: "/tmp/untrusted-preload.cjs",
      partition: "persist:other-profile",
      allowpopups: "true",
      webpreferences: "nodeIntegration=yes,sandbox=no",
    };

    hardenBrowserWebviewPreferences(preferences, "persist:rudder-browser-v1-safe");
    hardenBrowserWebviewParams(params, "persist:rudder-browser-v1-safe");

    expect(preferences).toMatchObject({
      partition: "persist:rudder-browser-v1-safe",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
    });
    expect(preferences).not.toHaveProperty("preload");
    expect(preferences).not.toHaveProperty("session");
    expect(params).toMatchObject({
      src: "https://example.com",
      partition: "persist:rudder-browser-v1-safe",
    });
    expect(params).not.toHaveProperty("preload");
    expect(params).not.toHaveProperty("allowpopups");
    expect(params).not.toHaveProperty("webpreferences");
  });
});

describe("Rudder Browser session policy", () => {
  it("denies permission checks, permission requests, and downloads", () => {
    expect(denyBrowserPermissionCheck()).toBe(false);
    const permissionCallback = vi.fn();
    denyBrowserPermissionRequest(permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
    const downloadEvent = { preventDefault: vi.fn() };
    denyBrowserDownload(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("installs deny-by-default handlers on the dedicated session", async () => {
    let permissionCheckHandler: (() => boolean) | undefined;
    let permissionRequestHandler: ((...args: unknown[]) => void) | undefined;
    let downloadHandler: ((event: { preventDefault(): void }) => void) | undefined;
    let requestHandler: ((
      details: { url: string; resourceType?: string },
      callback: (response: { cancel?: boolean }) => void,
    ) => void) | undefined;
    const browserSession = {
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheckHandler = handler;
      }),
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionRequestHandler = handler;
      }),
      on: vi.fn((event, handler) => {
        if (event === "will-download") downloadHandler = handler;
      }),
      webRequest: {
        onBeforeRequest: vi.fn((_filter, handler) => {
          requestHandler = handler;
        }),
      },
    };

    installBrowserSessionPolicy(browserSession, {
      getControlPlaneOrigins: () => ["http://127.0.0.1:3100"],
    });

    expect(permissionCheckHandler?.()).toBe(false);
    const permissionCallback = vi.fn();
    permissionRequestHandler?.({}, "notifications", permissionCallback, {});
    expect(permissionCallback).toHaveBeenCalledWith(false);
    const downloadEvent = { preventDefault: vi.fn() };
    downloadHandler?.(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledTimes(1);

    expect(browserSession.webRequest.onBeforeRequest).toHaveBeenCalledWith(
      { urls: ["<all_urls>"] },
      expect.any(Function),
    );
    const blockedRequest = vi.fn();
    requestHandler?.({ url: "http://localhost:3100/api/orgs", resourceType: "mainFrame" }, blockedRequest);
    await vi.waitFor(() => expect(blockedRequest).toHaveBeenCalledWith({ cancel: true }));
    const blockedWebSocket = vi.fn();
    requestHandler?.({ url: "ws://[::1]:3100/socket", resourceType: "webSocket" }, blockedWebSocket);
    await vi.waitFor(() => expect(blockedWebSocket).toHaveBeenCalledWith({ cancel: true }));
    const allowedRequest = vi.fn();
    requestHandler?.({ url: "https://example.com/app.js", resourceType: "script" }, allowedRequest);
    await vi.waitFor(() => expect(allowedRequest).toHaveBeenCalledWith({ cancel: false }));
    const blockedDnsAlias = vi.fn();
    requestHandler?.({ url: "http://localtest.me:3100/api/orgs", resourceType: "xhr" }, blockedDnsAlias);
    await vi.waitFor(() => expect(blockedDnsAlias).toHaveBeenCalledWith({ cancel: true }));
    const blockedFileNavigation = vi.fn();
    requestHandler?.({ url: "file:///Users/example/.ssh/id_rsa", resourceType: "mainFrame" }, blockedFileNavigation);
    await vi.waitFor(() => expect(blockedFileNavigation).toHaveBeenCalledWith({ cancel: true }));
    const allowedDataSubresource = vi.fn();
    requestHandler?.({ url: "data:image/png;base64,AA==", resourceType: "image" }, allowedDataSubresource);
    await vi.waitFor(() => expect(allowedDataSubresource).toHaveBeenCalledWith({ cancel: false }));
  });
});

describe("Rudder Browser guest policy", () => {
  it("blocks unsafe initial URLs, navigation, redirects, and every popup", () => {
    const hostHandlers = new Map<string, (...args: any[]) => void>();
    const hostContents = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        hostHandlers.set(event, handler);
      }),
    };
    const registry = createBrowserGuestRegistry();
    let browserAvailable = true;
    installBrowserWebviewPolicy(hostContents, {
      partition: "persist:rudder-browser-v1-safe",
      getControlPlaneOrigins: () => ["http://127.0.0.1:3100"],
      isBrowserAvailable: () => browserAvailable,
      registerGuest: registry.register,
    });

    const unsafeAttachEvent = { preventDefault: vi.fn() };
    hostHandlers.get("will-attach-webview")?.(
      unsafeAttachEvent,
      {},
      { src: "javascript:alert(1)", allowpopups: "true" },
    );
    expect(unsafeAttachEvent.preventDefault).toHaveBeenCalledTimes(1);

    const allowedAttachEvent = { preventDefault: vi.fn() };
    hostHandlers.get("will-attach-webview")?.(allowedAttachEvent, {}, { src: "about:blank" });
    expect(allowedAttachEvent.preventDefault).not.toHaveBeenCalled();

    browserAvailable = false;
    const unavailableAttachEvent = { preventDefault: vi.fn() };
    hostHandlers.get("will-attach-webview")?.(unavailableAttachEvent, {}, { src: "https://example.com" });
    expect(unavailableAttachEvent.preventDefault).toHaveBeenCalledTimes(1);
    browserAvailable = true;

    const guestHandlers = new Map<string, (...args: any[]) => void>();
    let popupHandler: ((details: { url: string }) => { action: string }) | undefined;
    const guest = {
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
      setWindowOpenHandler: vi.fn((handler) => {
        popupHandler = handler;
      }),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        guestHandlers.set(event, handler);
      }),
    };
    hostHandlers.get("did-attach-webview")?.({}, guest);

    expect(popupHandler?.({ url: "https://example.com/new" })).toEqual({ action: "deny" });
    const unsafeNavigation = { preventDefault: vi.fn() };
    guestHandlers.get("will-navigate")?.(unsafeNavigation, "file:///tmp/private.txt");
    expect(unsafeNavigation.preventDefault).toHaveBeenCalledTimes(1);
    const controlPlaneRedirect = { preventDefault: vi.fn() };
    guestHandlers.get("will-redirect")?.(controlPlaneRedirect, "http://127.0.0.1:3100/api/orgs");
    expect(controlPlaneRedirect.preventDefault).toHaveBeenCalledTimes(1);
    const controlPlaneSubframe = { url: "http://localhost:3100/", preventDefault: vi.fn() };
    guestHandlers.get("will-frame-navigate")?.(controlPlaneSubframe);
    expect(controlPlaneSubframe.preventDefault).toHaveBeenCalledTimes(1);
    const allowedLegacyFrameNavigation = { preventDefault: vi.fn() };
    guestHandlers.get("will-frame-navigate")?.(
      allowedLegacyFrameNavigation,
      { url: "https://example.com/frame" },
    );
    expect(allowedLegacyFrameNavigation.preventDefault).not.toHaveBeenCalled();
    const allowedNavigation = { preventDefault: vi.fn() };
    guestHandlers.get("will-navigate")?.(allowedNavigation, "https://example.com/next");
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it("closes registered guests and forgets destroyed guests", async () => {
    const registry = createBrowserGuestRegistry();
    const destroyedHandlers: Array<() => void> = [];
    const activeGuest = {
      isDestroyed: () => false,
      close: vi.fn(),
      on: (event: string, handler: () => void) => {
        if (event === "destroyed") destroyedHandlers.push(handler);
      },
    };
    const destroyedGuest = {
      isDestroyed: () => false,
      close: vi.fn(),
      on: (event: string, handler: () => void) => {
        if (event === "destroyed") destroyedHandlers.push(handler);
      },
    };
    registry.register(activeGuest);
    registry.register(destroyedGuest);
    destroyedHandlers[1]?.();

    await registry.closeAll();

    expect(activeGuest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(destroyedGuest.close).not.toHaveBeenCalled();
  });
});
