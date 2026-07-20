import {
  isAllowedBrowserBootstrapUrl,
  isAllowedBrowserNavigationUrl,
  isBlockedBrowserOperatingLayerUrl,
  isLocalAbsoluteFileUrl,
} from "./browser-profile.js";

type PreventableEvent = {
  preventDefault(): void;
};

type BrowserWebPreferences = {
  preload?: unknown;
  partition?: string;
  session?: unknown;
  sandbox?: boolean;
  contextIsolation?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  webSecurity?: boolean;
};

type BrowserSessionPolicyTarget = {
  setPermissionCheckHandler(handler: (...args: any[]) => boolean): void;
  setPermissionRequestHandler(handler: (...args: any[]) => void): void;
  on(event: "will-download", handler: (event: PreventableEvent, ...args: any[]) => void): unknown;
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      handler: (
        details: { url: string; resourceType?: string },
        callback: (response: { cancel: boolean }) => void,
      ) => void,
    ): void;
  };
};

export type BrowserGuest = {
  isDestroyed(): boolean;
  close(options?: { waitForBeforeUnload?: boolean }): void;
  on(event: string, handler: (...args: any[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
};

type BrowserWebviewHost = {
  on(event: string, handler: (...args: any[]) => void): unknown;
};

type WindowOpenPolicyTarget = {
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
};

export function installDefaultWindowOpenDenyPolicy(contents: WindowOpenPolicyTarget): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function hardenBrowserWebviewPreferences(
  preferences: BrowserWebPreferences,
  partition: string,
): void {
  delete preferences.preload;
  delete preferences.session;
  preferences.partition = partition;
  preferences.sandbox = true;
  preferences.contextIsolation = true;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.webSecurity = true;
}

export function hardenBrowserWebviewParams(params: Record<string, string>, partition: string): void {
  delete params.preload;
  delete params.allowPopups;
  delete params.webpreferences;
  params.partition = partition;
}

export function denyBrowserPermissionCheck(): false {
  return false;
}

export function denyBrowserPermissionRequest(callback: (granted: boolean) => void): void {
  callback(false);
}

export function denyBrowserDownload(event: PreventableEvent): void {
  event.preventDefault();
}

function isWebProtocolUrl(target: string): boolean {
  try {
    const protocol = new URL(target).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isAllowedMainFrameRequestUrl(target: string): boolean {
  return isWebProtocolUrl(target) || isLocalAbsoluteFileUrl(target);
}

export function installBrowserSessionPolicy(browserSession: BrowserSessionPolicyTarget, options: {
  getOperatingLayerOrigins(): string[];
}): void {
  browserSession.setPermissionCheckHandler(denyBrowserPermissionCheck);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback: (granted: boolean) => void) => {
    denyBrowserPermissionRequest(callback);
  });
  browserSession.on("will-download", denyBrowserDownload);
  browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (details.resourceType === "mainFrame" && !isAllowedMainFrameRequestUrl(details.url)) {
      callback({ cancel: true });
      return;
    }
    if (details.resourceType === "subFrame" && !isWebProtocolUrl(details.url)) {
      callback({ cancel: true });
      return;
    }
    callback({
      cancel: isBlockedBrowserOperatingLayerUrl(details.url, options.getOperatingLayerOrigins()),
    });
  });
}

export function createBrowserGuestRegistry(): {
  register(guest: BrowserGuest): void;
  closeAll(): Promise<void>;
} {
  const guests = new Set<BrowserGuest>();

  const register = (guest: BrowserGuest): void => {
    guests.add(guest);
    guest.on("destroyed", () => {
      guests.delete(guest);
    });
  };

  const closeAll = async (): Promise<void> => {
    for (const guest of Array.from(guests)) {
      guests.delete(guest);
      if (!guest.isDestroyed()) {
        guest.close({ waitForBeforeUnload: false });
      }
    }
  };

  return { register, closeAll };
}

export function installBrowserWebviewPolicy(hostContents: BrowserWebviewHost, options: {
  partition: string;
  getOperatingLayerOrigins(): string[];
  isBrowserAvailable(): boolean;
  registerGuest(guest: BrowserGuest): void;
  openBrowserPopup?(url: string): void;
}): void {
  hostContents.on("will-attach-webview", (
    event: PreventableEvent,
    preferences: BrowserWebPreferences,
    params: Record<string, string>,
  ) => {
    hardenBrowserWebviewPreferences(preferences, options.partition);
    hardenBrowserWebviewParams(params, options.partition);
    const initialUrl = params.src || "about:blank";
    if (!options.isBrowserAvailable()
      || !isAllowedBrowserBootstrapUrl(initialUrl, options.getOperatingLayerOrigins())) {
      event.preventDefault();
    }
  });

  hostContents.on("did-attach-webview", (_event: unknown, guest: BrowserGuest) => {
    if (!options.isBrowserAvailable()) {
      if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
      return;
    }

    options.registerGuest(guest);
    guest.setWindowOpenHandler(({ url }) => {
      if (options.isBrowserAvailable()
        && isAllowedBrowserNavigationUrl(url, options.getOperatingLayerOrigins())) {
        setImmediate(() => options.openBrowserPopup?.(url));
      }
      return { action: "deny" };
    });
    const preventUnsafeNavigation = (event: PreventableEvent, targetUrl: string) => {
      if (!isAllowedBrowserNavigationUrl(targetUrl, options.getOperatingLayerOrigins())) {
        event.preventDefault();
      }
    };
    guest.on("will-navigate", preventUnsafeNavigation);
    guest.on("will-redirect", preventUnsafeNavigation);
    guest.on("will-frame-navigate", (
      event: PreventableEvent & { url?: string },
      legacyDetails?: { url?: string },
    ) => {
      const targetUrl = legacyDetails?.url ?? event.url;
      if (!targetUrl) {
        event.preventDefault();
        return;
      }
      preventUnsafeNavigation(event, targetUrl);
    });
  });
}
