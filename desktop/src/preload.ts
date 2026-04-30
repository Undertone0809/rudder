import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { readDesktopCapabilities, type DesktopCapabilities } from "./desktop-capabilities.js";
import type { DesktopSystemPermissions } from "./system-permissions.js";

type BootState = {
  stage: string;
  message: string;
  detail?: string;
  error?: string;
  capabilities?: DesktopCapabilities;
  permissions?: DesktopSystemPermissions;
  diagnostics?: {
    lastBadgeCount?: number;
    badgeSyncSucceeded?: boolean;
    lastBadgeSyncAt?: string;
    lastNotificationTitle?: string;
    lastNotificationBody?: string;
    lastNotificationTriggeredAt?: string;
  };
  paths?: {
    homeDir?: string;
    instanceRoot?: string;
    configPath?: string;
    envPath?: string;
  };
  runtime?: {
    localEnv?: string | null;
    instanceId?: string;
    mode?: "owned" | "attached";
    ownerKind?: string | null;
    version?: string;
    apiUrl?: string;
  };
};

type DesktopUpdateCheckResult = {
  status: "update-available" | "up-to-date" | "unavailable";
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt: string;
};

type OpenNotificationSettingsResult = {
  opened: boolean;
  platform: NodeJS.Platform;
};

type DesktopInboxNotificationPayload = {
  title: string;
  body?: string;
};

type DesktopPathPickOptions = {
  kind: "file" | "directory";
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
};

type DesktopPathPickResult = {
  canceled: boolean;
  path: string | null;
};

type DesktopIdeTarget = {
  id: "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";
  label: string;
};

type DesktopWorkspaceLaunchTarget = {
  id: "vscode" | "cursor" | "xcode" | "windsurf" | "zed" | "webstorm" | "intellij" | "terminal" | "warp" | "finder";
  label: string;
  kind: "ide" | "terminal" | "folder";
  iconDataUrl?: string;
};

let desktopCapabilitiesPromise: Promise<DesktopCapabilities> | null = null;

async function getDesktopCapabilities(): Promise<DesktopCapabilities> {
  if (!desktopCapabilitiesPromise) {
    desktopCapabilitiesPromise = (ipcRenderer.invoke("desktop:get-boot-state") as Promise<BootState>)
      .then((state) => readDesktopCapabilities(state))
      .catch(() => ({
        badgeCount: false,
        notifications: false,
      }));
  }
  return desktopCapabilitiesPromise;
}

async function invokeOptionalDesktopChannel(
  capability: keyof DesktopCapabilities,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  const capabilities = await getDesktopCapabilities();
  if (!capabilities[capability]) return;
  await ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld("desktopShell", {
  getBootState: () => ipcRenderer.invoke("desktop:get-boot-state") as Promise<BootState>,
  onBootState: (listener: (state: BootState) => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: BootState) => {
      listener(payload);
    };
    ipcRenderer.on("desktop:boot-state", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:boot-state", wrapped);
    };
  },
  openPath: (targetPath: string) => ipcRenderer.invoke("desktop:open-path", targetPath),
  listAvailableIdes: () => ipcRenderer.invoke("desktop:list-available-ides") as Promise<DesktopIdeTarget[]>,
  listWorkspaceLaunchTargets: () =>
    ipcRenderer.invoke("desktop:list-workspace-launch-targets") as Promise<DesktopWorkspaceLaunchTarget[]>,
  openWorkspace: (rootPath: string, targetId?: DesktopWorkspaceLaunchTarget["id"]) =>
    ipcRenderer.invoke("desktop:open-workspace", { rootPath, targetId }) as Promise<void>,
  openWorkspaceFileInIde: (rootPath: string, filePath: string, ideId?: DesktopIdeTarget["id"]) =>
    ipcRenderer.invoke("desktop:open-workspace-file-in-ide", { rootPath, filePath, ideId }) as Promise<void>,
  copyText: (value: string) => ipcRenderer.invoke("desktop:copy-text", value),
  setAppearance: (theme: "light" | "dark" | "system") => ipcRenderer.invoke("desktop:set-appearance", theme),
  restart: () => ipcRenderer.invoke("desktop:restart"),
  getAppVersion: () => ipcRenderer.invoke("desktop:get-app-version") as Promise<string>,
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates") as Promise<DesktopUpdateCheckResult>,
  getSystemPermissions: () =>
    ipcRenderer.invoke("desktop:get-system-permissions") as Promise<DesktopSystemPermissions>,
  sendFeedback: () => ipcRenderer.invoke("desktop:send-feedback") as Promise<void>,
  openExternal: (target: string) => ipcRenderer.invoke("desktop:open-external", target) as Promise<void>,
  openNotificationSettings: () =>
    ipcRenderer.invoke("desktop:open-notification-settings") as Promise<OpenNotificationSettingsResult>,
  setBadgeCount: (count: number) => invokeOptionalDesktopChannel("badgeCount", "desktop:set-badge-count", count),
  showNotification: (payload: DesktopInboxNotificationPayload) =>
    invokeOptionalDesktopChannel("notifications", "desktop:show-notification", payload),
  pickPath: (options: DesktopPathPickOptions) =>
    ipcRenderer.invoke("desktop:pick-path", options) as Promise<DesktopPathPickResult>,
});

declare global {
  interface Window {
    desktopShell: {
      getBootState(): Promise<BootState>;
      onBootState(listener: (state: BootState) => void): () => void;
      openPath(targetPath: string): Promise<void>;
      listAvailableIdes(): Promise<DesktopIdeTarget[]>;
      listWorkspaceLaunchTargets(): Promise<DesktopWorkspaceLaunchTarget[]>;
      openWorkspace(rootPath: string, targetId?: DesktopWorkspaceLaunchTarget["id"]): Promise<void>;
      openWorkspaceFileInIde(rootPath: string, filePath: string, ideId?: DesktopIdeTarget["id"]): Promise<void>;
      copyText(value: string): Promise<void>;
      setAppearance(theme: "light" | "dark" | "system"): Promise<void>;
      restart(): Promise<void>;
      getAppVersion(): Promise<string>;
      checkForUpdates(): Promise<DesktopUpdateCheckResult>;
      getSystemPermissions(): Promise<DesktopSystemPermissions>;
      sendFeedback(): Promise<void>;
      openExternal(target: string): Promise<void>;
      openNotificationSettings(): Promise<OpenNotificationSettingsResult>;
      setBadgeCount(count: number): Promise<void>;
      showNotification(payload: DesktopInboxNotificationPayload): Promise<void>;
      pickPath(options: DesktopPathPickOptions): Promise<DesktopPathPickResult>;
    };
  }
}
