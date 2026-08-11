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
    fetch(input: string, init?: { method?: string; redirect?: "follow" | "manual"; signal?: AbortSignal }): Promise<Response>;
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
  driverDisposeGraceMs?: number;
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
    let nativeDestroyed = browserWindow.isDestroyed() || contents.isDestroyed();
    let resolveNativeDestroyed!: () => void;
    const nativeDestroyedPromise = new Promise<void>((resolve) => {
      resolveNativeDestroyed = resolve;
    });
    const destroyedListeners = new Set<() => void>();
    const driverDisposeGraceMs = Math.max(1, options.driverDisposeGraceMs ?? 5_000);
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
    const markNativeDestroyed = () => {
      if (nativeDestroyed) return;
      nativeDestroyed = true;
      resolveNativeDestroyed();
      void disposeAdvancedDriver().catch(() => undefined);
      for (const listener of destroyedListeners) {
        try {
          listener();
        } catch {
          // One cleanup listener must not prevent capacity and record release for the others.
        }
      }
      destroyedListeners.clear();
    };
    if (nativeDestroyed) resolveNativeDestroyed();
    contents.on("destroyed", markNativeDestroyed);
    const forceDestroyNativeWindow = (): unknown | null => {
      try {
        if (!nativeDestroyed && !browserWindow.isDestroyed()) browserWindow.destroy();
        if (!nativeDestroyed && (browserWindow.isDestroyed() || contents.isDestroyed())) {
          markNativeDestroyed();
        }
        return null;
      } catch (error) {
        return error;
      }
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
          contents.removeListener("did-navigate-in-page", handleInPageNavigation);
          contents.removeListener("did-fail-load", handleFailure);
        };
        const handleFinish = () => {
          cleanup();
          resolve();
        };
        const handleInPageNavigation = (_event: unknown, _url: string, isMainFrame: boolean) => {
          if (!isMainFrame) return;
          cleanup();
          resolve();
        };
        const handleFailure = (
          _event: unknown,
          _errorCode?: number,
          _errorDescription?: string,
          _validatedURL?: string,
          isMainFrame = true,
        ) => {
          if (!isMainFrame) return;
          cleanup();
          reject(new Error("Browser navigation failed."));
        };
        contents.once("did-finish-load", handleFinish);
        contents.on("did-navigate-in-page", handleInPageNavigation);
        contents.on("did-fail-load", handleFailure);
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
          const disposal = disposeAdvancedDriver();
          if (nativeDestroyed || browserWindow.isDestroyed() || contents.isDestroyed()) {
            markNativeDestroyed();
            void disposal.catch(() => undefined);
            return;
          }
          let forceTimer: ReturnType<typeof setTimeout> | null = null;
          try {
            const outcome = await Promise.race([
              disposal.then(() => ({ kind: "disposed" as const })),
              nativeDestroyedPromise.then(() => ({ kind: "destroyed" as const })),
              new Promise<{ kind: "forced"; error: unknown | null }>((resolve) => {
                forceTimer = setTimeout(() => {
                  resolve({ kind: "forced", error: forceDestroyNativeWindow() });
                }, driverDisposeGraceMs);
                forceTimer.unref?.();
              }),
            ]);
            if (outcome.kind !== "disposed") {
              void disposal.catch(() => undefined);
              if (outcome.kind === "forced" && outcome.error) throw outcome.error;
              return;
            }
            const destroyError = forceDestroyNativeWindow();
            if (destroyError) throw destroyError;
          } catch (error) {
            const destroyError = forceDestroyNativeWindow();
            if (destroyError && destroyError !== error) {
              throw new AggregateError([error, destroyError], "Browser tab cleanup and native destruction failed");
            }
            throw error;
          } finally {
            if (forceTimer) clearTimeout(forceTimer);
          }
        })();
        return closePromise;
      },
      onDestroyed: (listener) => {
        if (nativeDestroyed || browserWindow.isDestroyed() || contents.isDestroyed()) {
          markNativeDestroyed();
          listener();
          return;
        }
        destroyedListeners.add(listener);
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
