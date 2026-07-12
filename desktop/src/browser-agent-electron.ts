import type { BrowserAgentTabFactory } from "./browser-agent-tabs.js";
import { isAllowedBrowserNavigationUrl } from "./browser-profile.js";

type PreventableEvent = {
  preventDefault(): void;
  url?: string;
};

type BrowserAgentNativeImage = {
  toPNG(): Buffer;
};

type BrowserAgentWebContents = {
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  stop(): void;
  close(options?: { waitForBeforeUnload?: boolean }): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string; url?: string }>,
    userGesture?: boolean,
  ): Promise<unknown>;
  capturePage(): Promise<BrowserAgentNativeImage>;
};

const RUDDER_BROWSER_AGENT_WORLD_ID = 10_001;

type BrowserAgentWindow = {
  webContents: BrowserAgentWebContents;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
};

type BrowserAgentWindowOptions = {
  show: false;
  webPreferences: {
    partition: string;
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
    nodeIntegrationInSubFrames: false;
    webSecurity: true;
    allowRunningInsecureContent: false;
    safeDialogs: true;
    disableDialogs: true;
    devTools: false;
    backgroundThrottling: false;
  };
};

export function createElectronBrowserAgentTabFactory(options: {
  partition: string;
  createWindow(windowOptions: BrowserAgentWindowOptions): BrowserAgentWindow;
  registerGuest(guest: BrowserAgentWebContents): void;
  getControlPlaneOrigins(): string[];
}): BrowserAgentTabFactory {
  return async () => {
    const browserWindow = options.createWindow({
      show: false,
      webPreferences: {
        partition: options.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        disableDialogs: true,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    const contents = browserWindow.webContents;
    options.registerGuest(contents);

    contents.setWindowOpenHandler(() => ({ action: "deny" }));

    const preventUnsafeNavigation = (event: PreventableEvent, targetUrl: string | undefined) => {
      if (!targetUrl || !isAllowedBrowserNavigationUrl(targetUrl, options.getControlPlaneOrigins())) {
        event.preventDefault();
      }
    };
    contents.on("will-navigate", (event: PreventableEvent, targetUrl: string) => {
      preventUnsafeNavigation(event, targetUrl);
    });
    contents.on("will-redirect", (event: PreventableEvent, targetUrl: string) => {
      preventUnsafeNavigation(event, targetUrl);
    });
    contents.on("will-frame-navigate", (
      event: PreventableEvent,
      legacyDetails?: { url?: string },
    ) => {
      preventUnsafeNavigation(event, legacyDetails?.url ?? event.url);
    });

    return {
      loadURL: (url) => browserWindow.loadURL(url),
      getURL: () => contents.getURL(),
      getTitle: () => contents.getTitle(),
      isDestroyed: () => browserWindow.isDestroyed() || contents.isDestroyed(),
      stop: () => contents.stop(),
      close: () => {
        if (!browserWindow.isDestroyed()) browserWindow.destroy();
      },
      onDestroyed: (listener) => {
        contents.on("destroyed", listener);
      },
      executeIsolatedJavaScript: (script) => contents.executeJavaScriptInIsolatedWorld(
        RUDDER_BROWSER_AGENT_WORLD_ID,
        [{ code: script }],
        true,
      ),
      capturePng: async () => (await contents.capturePage()).toPNG(),
    };
  };
}
