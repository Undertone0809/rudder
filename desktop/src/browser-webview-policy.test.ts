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
  installDefaultWindowOpenDenyPolicy,
  installLocalAppSessionPolicy,
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
      allowpopups: "true",
    });
    expect(params).not.toHaveProperty("preload");
    expect(params).not.toHaveProperty("webpreferences");
  });
});

describe("Rudder Browser default window-open policy", () => {
  it("fails closed before a WebContents receives a more specific policy", () => {
    let handler: (() => { action: "deny" }) | undefined;
    const contents = {
      setWindowOpenHandler: vi.fn((nextHandler) => {
        handler = nextHandler;
      }),
    };

    installDefaultWindowOpenDenyPolicy(contents);

    expect(handler?.()).toEqual({ action: "deny" });
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
      getRudderAppOrigins: () => ["http://127.0.0.1:3100"],
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
    const allowedFileNavigation = vi.fn();
    requestHandler?.({ url: "file:///Users/example/report.html", resourceType: "mainFrame" }, allowedFileNavigation);
    await vi.waitFor(() => expect(allowedFileNavigation).toHaveBeenCalledWith({ cancel: false }));
    const blockedRemoteFileNavigation = vi.fn();
    requestHandler?.({ url: "file://remote-host/share/report.html", resourceType: "mainFrame" }, blockedRemoteFileNavigation);
    await vi.waitFor(() => expect(blockedRemoteFileNavigation).toHaveBeenCalledWith({ cancel: true }));
    const blockedUncFileNavigation = vi.fn();
    requestHandler?.({ url: "file:////server/share/report.html", resourceType: "mainFrame" }, blockedUncFileNavigation);
    await vi.waitFor(() => expect(blockedUncFileNavigation).toHaveBeenCalledWith({ cancel: true }));
    const blockedFileSubframe = vi.fn();
    requestHandler?.({ url: "file:///Users/example/frame.html", resourceType: "subFrame" }, blockedFileSubframe);
    await vi.waitFor(() => expect(blockedFileSubframe).toHaveBeenCalledWith({ cancel: true }));
    const allowedDataSubresource = vi.fn();
    requestHandler?.({ url: "data:image/png;base64,AA==", resourceType: "image" }, allowedDataSubresource);
    await vi.waitFor(() => expect(allowedDataSubresource).toHaveBeenCalledWith({ cancel: false }));
  });
});

describe("Desktop Local App session policy", () => {
  it("allows only the currently attested loopback origin in the per-app partition", () => {
    let requestHandler: ((
      details: { url: string; resourceType?: string },
      callback: (response: { cancel: boolean }) => void,
    ) => void) | undefined;
    const localSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      on: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn((_filter, handler) => { requestHandler = handler; }),
      },
    };
    installLocalAppSessionPolicy(localSession, {
      getAttestedOrigin: () => "http://127.0.0.1:43123",
    });
    for (const target of [
      "http://127.0.0.1:43123/outreach",
      "ws://127.0.0.1:43123/hmr",
    ]) {
      const callback = vi.fn();
      requestHandler?.({ url: target }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: false });
    }
    for (const target of [
      "http://127.0.0.1:43124/outreach",
      "http://localhost:43123/outreach",
      "https://example.com/script.js",
      "data:text/plain,secret",
    ]) {
      const callback = vi.fn();
      requestHandler?.({ url: target }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
  });
});

describe("Rudder Browser guest policy", () => {
  it("preserves only an attested per-app partition and confines its guest to that origin", () => {
    const hostHandlers = new Map<string, (...args: any[]) => void>();
    const hostContents = { on: (event: string, handler: (...args: any[]) => void) => hostHandlers.set(event, handler) };
    const prepareLocalAppPartition = vi.fn();
    const localSession = {};
    installBrowserWebviewPolicy(hostContents, {
      partition: "persist:rudder-browser-v1-safe",
      getRudderAppOrigins: () => ["http://127.0.0.1:3100"],
      isBrowserAvailable: () => true,
      registerGuest: vi.fn(),
      resolveLocalAppBootstrap: (url, partition) =>
        url === "http://127.0.0.1:43123/outreach" && partition === "persist:rudder-local-app-safe",
      prepareLocalAppPartition,
      isLocalAppGuest: (guest) => guest.session === localSession,
      isAllowedLocalAppNavigation: (_guest, url) => new URL(url).origin === "http://127.0.0.1:43123",
    });
    const params = {
      src: "http://127.0.0.1:43123/outreach",
      partition: "persist:rudder-local-app-safe",
      allowpopups: "true",
    };
    const preferences: Record<string, unknown> = { nodeIntegration: true };
    const attachEvent = { preventDefault: vi.fn() };
    hostHandlers.get("will-attach-webview")?.(attachEvent, preferences, params);
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(params.partition).toBe("persist:rudder-local-app-safe");
    expect(params).not.toHaveProperty("allowpopups");
    expect(preferences).toMatchObject({ partition: "persist:rudder-local-app-safe", nodeIntegration: false, sandbox: true });
    expect(prepareLocalAppPartition).toHaveBeenCalledWith("persist:rudder-local-app-safe");

    const guestHandlers = new Map<string, (...args: any[]) => void>();
    let popupHandler: ((details: { url: string }) => { action: string }) | undefined;
    const guest = {
      session: localSession,
      isDestroyed: () => false,
      close: vi.fn(),
      setWindowOpenHandler: (handler: typeof popupHandler) => { popupHandler = handler; },
      on: (event: string, handler: (...args: any[]) => void) => guestHandlers.set(event, handler),
    };
    hostHandlers.get("did-attach-webview")?.({}, guest);
    expect(popupHandler?.({ url: "http://127.0.0.1:43123/new" })).toEqual({ action: "deny" });
    const sameOrigin = { preventDefault: vi.fn() };
    guestHandlers.get("will-navigate")?.(sameOrigin, "http://127.0.0.1:43123/next");
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    const otherOrigin = { preventDefault: vi.fn() };
    guestHandlers.get("will-redirect")?.(otherOrigin, "http://127.0.0.1:43124/next");
    expect(otherOrigin.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("blocks unsafe initial URLs, navigation, and redirects while routing safe popups", async () => {
    const hostHandlers = new Map<string, (...args: any[]) => void>();
    const hostContents = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        hostHandlers.set(event, handler);
      }),
    };
    const registry = createBrowserGuestRegistry();
    const openBrowserPopup = vi.fn();
    let browserAvailable = true;
    installBrowserWebviewPolicy(hostContents, {
      partition: "persist:rudder-browser-v1-safe",
      getRudderAppOrigins: () => ["http://127.0.0.1:3100"],
      isBrowserAvailable: () => browserAvailable,
      registerGuest: registry.register,
      openBrowserPopup,
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
    const allowedFileAttachEvent = { preventDefault: vi.fn() };
    hostHandlers.get("will-attach-webview")?.(allowedFileAttachEvent, {}, { src: "file:///tmp/report.html" });
    expect(allowedFileAttachEvent.preventDefault).not.toHaveBeenCalled();
    const remoteFileAttachEvent = { preventDefault: vi.fn() };
    hostHandlers.get("will-attach-webview")?.(
      remoteFileAttachEvent,
      {},
      { src: "file://remote-host/share/report.html" },
    );
    expect(remoteFileAttachEvent.preventDefault).toHaveBeenCalledTimes(1);
    const uncFileAttachEvent = { preventDefault: vi.fn() };
    hostHandlers.get("will-attach-webview")?.(uncFileAttachEvent, {}, { src: "file:////server/share/report.html" });
    expect(uncFileAttachEvent.preventDefault).toHaveBeenCalledTimes(1);

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
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(openBrowserPopup).toHaveBeenCalledWith("https://example.com/new");
    expect(popupHandler?.({ url: "file:///tmp/private.txt" })).toEqual({ action: "deny" });
    expect(popupHandler?.({ url: "file://remote-host/share/private.txt" })).toEqual({ action: "deny" });
    expect(popupHandler?.({ url: "http://localhost:3100/api/orgs" })).toEqual({ action: "deny" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(openBrowserPopup).toHaveBeenCalledTimes(1);
    const fileNavigation = { preventDefault: vi.fn() };
    guestHandlers.get("will-navigate")?.(fileNavigation, "file:///tmp/private.txt");
    expect(fileNavigation.preventDefault).toHaveBeenCalledTimes(1);
    const fileRedirect = { preventDefault: vi.fn() };
    guestHandlers.get("will-redirect")?.(fileRedirect, "file:///tmp/private.txt");
    expect(fileRedirect.preventDefault).toHaveBeenCalledTimes(1);
    const rudderAppRedirect = { preventDefault: vi.fn() };
    guestHandlers.get("will-redirect")?.(rudderAppRedirect, "http://127.0.0.1:3100/api/orgs");
    expect(rudderAppRedirect.preventDefault).toHaveBeenCalledTimes(1);
    const rudderAppSubframe = { url: "http://localhost:3100/", preventDefault: vi.fn() };
    guestHandlers.get("will-frame-navigate")?.(rudderAppSubframe);
    expect(rudderAppSubframe.preventDefault).toHaveBeenCalledTimes(1);
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

  it("lists only live user Browser tabs with opaque ids", () => {
    const registry = createBrowserGuestRegistry();
    const userGuest = {
      isDestroyed: () => false,
      close: vi.fn(),
      getTitle: () => "Private document title",
      getURL: () => "https://user:password@example.com/path?token=secret#private",
      on: vi.fn(),
    };
    const agentGuest = {
      isDestroyed: () => false,
      close: vi.fn(),
      getTitle: () => "Agent tab",
      getURL: () => "https://agent.example.com",
      on: vi.fn(),
    };
    registry.register(userGuest, "user");
    registry.register(agentGuest, "agent");

    expect(registry.listUserTabs()).toEqual([
      expect.objectContaining({ title: "example.com", url: "https://example.com/" }),
    ]);
    expect(registry.listUserTabs()[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(registry.listUserTabs())).not.toContain("Agent tab");
    expect(JSON.stringify(registry.listUserTabs())).not.toContain("secret");
    expect(JSON.stringify(registry.listUserTabs())).not.toContain("Private document title");
  });

  it("closes every retired Agent guest without closing user Browser tabs", async () => {
    const registry = createBrowserGuestRegistry();
    const userGuest = { isDestroyed: () => false, close: vi.fn(), on: vi.fn() };
    const firstAgentGuest = { isDestroyed: () => false, close: vi.fn(), on: vi.fn() };
    const retiredAgentGuest = { isDestroyed: () => false, close: vi.fn(), on: vi.fn() };
    registry.register(userGuest, "user");
    registry.register(firstAgentGuest, "agent");
    registry.register(retiredAgentGuest, "agent");

    expect(registry.count("agent")).toBe(2);
    await registry.closeAll("agent");

    expect(firstAgentGuest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(retiredAgentGuest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(userGuest.close).not.toHaveBeenCalled();
    expect(registry.count("agent")).toBe(0);
    expect(registry.count("user")).toBe(1);
  });

  it("continues closing retired Agent guests after one native close throws", async () => {
    const registry = createBrowserGuestRegistry();
    const closeError = new Error("native close failed");
    let failingGuestDestroyed = false;
    const failingGuest = {
      isDestroyed: () => failingGuestDestroyed,
      close: vi.fn()
        .mockImplementationOnce(() => { throw closeError; })
        .mockImplementationOnce(() => { failingGuestDestroyed = true; }),
      on: vi.fn(),
    };
    const remainingGuest = { isDestroyed: () => false, close: vi.fn(), on: vi.fn() };
    registry.register(failingGuest, "agent");
    registry.register(remainingGuest, "agent");

    await expect(registry.closeAll("agent")).rejects.toBe(closeError);

    expect(remainingGuest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(registry.count("agent")).toBe(1);

    await registry.closeAll("agent");
    expect(failingGuest.close).toHaveBeenCalledTimes(2);
    expect(registry.count("agent")).toBe(0);
  });
});
