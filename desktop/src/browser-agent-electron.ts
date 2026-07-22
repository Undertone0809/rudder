import { createBrowserAdvancedDriver } from "./browser-agent-advanced.js";
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
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<any>;
    on(event: "message", listener: (...args: any[]) => void): unknown;
    removeListener(event: "message", listener: (...args: any[]) => void): unknown;
  };
  session: {
    fetch(input: string, init?: { method?: string; redirect?: "follow" }): Promise<Response>;
    cookies: {
      set(details: {
        url: string;
        name: string;
        value: string;
        path?: string;
        secure?: boolean;
        sameSite?: "lax";
        expirationDate?: number;
      }): Promise<void>;
    };
  };
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  stop(): void;
  close(options?: { waitForBeforeUnload?: boolean }): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event: string): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string; url?: string }>,
    userGesture?: boolean,
  ): Promise<unknown>;
  capturePage(): Promise<BrowserAgentNativeImage>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
  };
  reload(): void;
};

const RUDDER_BROWSER_AGENT_WORLD_ID = 10_001;

type BrowserAgentWindow = {
  webContents: BrowserAgentWebContents;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  getContentSize(): number[];
  setContentSize(width: number, height: number): void;
  isVisible(): boolean;
  showInactive(): void;
  hide(): void;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<BrowserAgentNativeImage>;
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
    devTools: false;
    backgroundThrottling: false;
  };
};

export function createElectronBrowserAgentTabFactory(options: {
  partition: string;
  createWindow(windowOptions: BrowserAgentWindowOptions): BrowserAgentWindow;
  registerGuest(guest: BrowserAgentWebContents): void;
  getRudderAppOrigins(): string[];
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
        devTools: false,
        backgroundThrottling: false,
      },
    });
    const contents = browserWindow.webContents;
    const initialContentSize = browserWindow.getContentSize();
    options.registerGuest(contents);
    let advancedDriverPromise: ReturnType<typeof createBrowserAdvancedDriver> | null = null;
    let closePromise: Promise<void> | null = null;
    const getAdvancedDriver = () => {
      advancedDriverPromise ??= createBrowserAdvancedDriver({
        window: browserWindow,
        getRudderAppOrigins: options.getRudderAppOrigins,
      });
      return advancedDriverPromise;
    };
    const disposeAdvancedDriver = async () => {
      if (advancedDriverPromise) await advancedDriverPromise.then((driver) => driver.dispose());
    };

    contents.setWindowOpenHandler(() => ({ action: "deny" }));

    const preventUnsafeNavigation = (event: PreventableEvent, targetUrl: string | undefined) => {
      if (!targetUrl || !isAllowedBrowserNavigationUrl(targetUrl, options.getRudderAppOrigins())) {
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
      legacyDetails?: { url?: string } | string,
    ) => {
      const targetUrl = typeof legacyDetails === "string"
        ? legacyDetails
        : legacyDetails?.url ?? event.url;
      preventUnsafeNavigation(event, targetUrl);
    });

    const waitForHistoryNavigation = (canNavigate: () => boolean, navigate: () => void): Promise<void> => {
      if (!canNavigate()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          contents.removeListener("did-finish-load", handleFinish);
          contents.removeListener("did-fail-load", handleFailure);
        };
        const handleFinish = () => {
          cleanup();
          resolve();
        };
        const handleFailure = () => {
          cleanup();
          reject(new Error("Browser navigation failed."));
        };
        contents.once("did-finish-load", handleFinish);
        contents.once("did-fail-load", handleFailure);
        navigate();
      });
    };

    return {
      loadURL: (url) => browserWindow.loadURL(url),
      goBack: () => waitForHistoryNavigation(
        () => contents.navigationHistory.canGoBack(),
        () => contents.navigationHistory.goBack(),
      ),
      goForward: () => waitForHistoryNavigation(
        () => contents.navigationHistory.canGoForward(),
        () => contents.navigationHistory.goForward(),
      ),
      reload: () => waitForHistoryNavigation(() => true, () => contents.reload()),
      getViewport: () => {
        const [width, height] = browserWindow.getContentSize();
        return { width, height };
      },
      setViewport: (width, height) => browserWindow.setContentSize(width, height),
      resetViewport: () => browserWindow.setContentSize(initialContentSize[0] ?? 1280, initialContentSize[1] ?? 720),
      isVisible: () => browserWindow.isVisible(),
      setVisible: (visible) => {
        if (visible) browserWindow.showInactive();
        else browserWindow.hide();
      },
      advanced: async (action, args) => (await getAdvancedDriver()).execute(action, args),
      getURL: () => contents.getURL(),
      getTitle: () => contents.getTitle(),
      isDestroyed: () => browserWindow.isDestroyed() || contents.isDestroyed(),
      stop: () => contents.stop(),
      close: () => {
        closePromise ??= (async () => {
          try {
            await disposeAdvancedDriver();
          } finally {
            if (!browserWindow.isDestroyed()) browserWindow.destroy();
          }
        })();
        return closePromise;
      },
      onDestroyed: (listener) => {
        contents.on("destroyed", () => {
          void disposeAdvancedDriver().catch(() => undefined);
          listener();
        });
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
