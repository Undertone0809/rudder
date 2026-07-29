import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { BrowserDataImportResult } from "./browser-cookie-import.js";
import type { BrowserImportSource } from "./browser-import-sources.js";
import type { DesktopBrowserResetEvent } from "./browser-profile.js";
import { isDesktopBrowserShortcutAction, type DesktopBrowserShortcutAction } from "./browser-shortcuts.js";
import { readDesktopCapabilities, type DesktopCapabilities } from "./desktop-capabilities.js";
import {
  DESKTOP_IDENTITY_IPC_CHANNELS,
  type DesktopIdentityDeviceSession,
  type DesktopIdentityState,
} from "./identity-ipc.js";
import type {
  LocalAppDefinition,
  LocalAppDefinitionDraft,
  PreparedLocalAppDefinition,
} from "./local-apps-registry.js";
import type { LocalAppRuntimeView } from "./local-apps-runtime.js";
import type { DesktopLocalFilePreview } from "./local-file-preview.js";
import type { DesktopSystemPermissionId, DesktopSystemPermissions } from "./system-permissions.js";

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
  channel: "stable" | "canary";
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt: string;
};

type DesktopUpdateChannel = DesktopUpdateCheckResult["channel"];

type DesktopUpdateBlocker = {
  runId: string;
  agentId: string | null;
  agentName: string;
  issueId: string | null;
  organizationId: string;
  organizationName: string;
};

type DesktopUpdateInstallResult =
  | { status: "started"; version: string; updateId?: string }
  | { status: "waiting"; version: string; updateId?: string; totalRuns: number; message: string }
  | { status: "unavailable"; message: string }
  | { status: "blocked"; totalRuns: number; message: string }
  | { status: "failed"; message: string };

type DesktopUpdateProgressPhase =
  | "starting"
  | "resolving_release"
  | "downloading_checksums"
  | "downloading_asset"
  | "verifying_checksum"
  | "ready_to_install"
  | "waiting_for_active_runs"
  | "preparing_restart"
  | "closing"
  | "complete"
  | "failed";

type DesktopUpdateProgressEvent = {
  updateId: string;
  version: string;
  phase: DesktopUpdateProgressPhase;
  message: string;
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  totalRuns?: number;
  blockers?: DesktopUpdateBlocker[];
  automaticApply?: boolean;
  error?: string;
  at: string;
};

type DesktopUpdateApplyResult =
  | { status: "started"; updateId: string; version: string }
  | { status: "unavailable"; message: string }
  | { status: "failed"; message: string };

type DesktopUpdateApplyOptions = {
  force?: boolean;
};

type DesktopDeferredUpdatePrompt = {
  promptId: string;
  title: string;
  message: string;
  detail: string;
  totalRuns: number;
  blockers: DesktopUpdateBlocker[];
  confirmLabel: string;
  forceLabel: string;
  cancelLabel: string;
};

type DesktopDeferredUpdatePromptDecision = "wait" | "force" | "cancel";

type OpenNotificationSettingsResult = {
  opened: boolean;
  platform: NodeJS.Platform;
};

type DesktopReleaseNotes = {
  version: string;
  title: string;
  sections: Array<{
    title: string;
    items: string[];
  }>;
};

type DesktopReleaseNotesResult =
  | { status: "available"; notes: DesktopReleaseNotes }
  | { status: "unavailable" | "already-shown" };

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

type DesktopImageDataPayload = {
  filename?: string | null;
  contentType: string;
  base64: string;
};

type DesktopIdeTarget = {
  id: "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";
  label: string;
};

type DesktopFileLaunchTargetId = DesktopIdeTarget["id"] | "defaultApp";

type DesktopWorkspaceLaunchTarget = {
  id: "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij" | "xcode" | "terminal" | "warp" | "commandPrompt" | "powershell" | "finder";
  label: string;
  kind: "ide" | "terminal" | "folder";
  iconDataUrl?: string;
};

type DesktopLocalAppDraftInput = LocalAppDefinitionDraft & { trustFingerprint?: string };
type DesktopLocalAppDiscoveryResult =
  | { canceled: true }
  | { canceled: false; draft: PreparedLocalAppDefinition };
type DesktopLocalAppAttestedTarget = { origin: string; openPath: string; partition: string };

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

function parseDesktopIdentityState(value: unknown): DesktopIdentityState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (state.status === "signed-out") return { status: "signed-out" };
  if (state.status === "signing-in") return { status: "signing-in" };
  if (state.status === "error" && typeof state.message === "string") {
    return {
      status: "error",
      message: state.message,
      ...(typeof state.recoverable === "boolean" ? { recoverable: state.recoverable } : {}),
    };
  }
  if (state.status !== "signed-in" || !state.account || typeof state.account !== "object") return null;
  const account = state.account as Record<string, unknown>;
  if (
    typeof account.id !== "string"
    || (typeof account.email !== "string" && account.email !== null)
    || typeof state.deviceId !== "string"
  ) return null;
  return {
    status: "signed-in",
    account: { id: account.id, email: account.email },
    deviceId: state.deviceId,
  };
}

contextBridge.exposeInMainWorld("desktopIdentity", {
  getState: () =>
    ipcRenderer.invoke(DESKTOP_IDENTITY_IPC_CHANNELS.getState) as Promise<DesktopIdentityState>,
  signIn: () =>
    ipcRenderer.invoke(DESKTOP_IDENTITY_IPC_CHANNELS.signIn) as Promise<DesktopIdentityState>,
  signOut: () =>
    ipcRenderer.invoke(DESKTOP_IDENTITY_IPC_CHANNELS.signOut) as Promise<DesktopIdentityState>,
  listDeviceSessions: () =>
    ipcRenderer.invoke(
      DESKTOP_IDENTITY_IPC_CHANNELS.listDeviceSessions,
    ) as Promise<DesktopIdentityDeviceSession[]>,
  revokeDeviceSession: (deviceId: string) =>
    ipcRenderer.invoke(
      DESKTOP_IDENTITY_IPC_CHANNELS.revokeDeviceSession,
      { deviceId },
    ) as Promise<void>,
  onStateChanged: (listener: (state: DesktopIdentityState) => void) => {
    const wrapped = (_event: IpcRendererEvent, state: unknown) => {
      const parsed = parseDesktopIdentityState(state);
      if (parsed) listener(parsed);
    };
    ipcRenderer.on(DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged, wrapped);
    };
  },
});

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
  previewLocalFile: (targetPath: string) =>
    ipcRenderer.invoke("desktop:preview-local-file", targetPath) as Promise<DesktopLocalFilePreview>,
  listAvailableIdes: () => ipcRenderer.invoke("desktop:list-available-ides") as Promise<DesktopIdeTarget[]>,
  listWorkspaceLaunchTargets: () =>
    ipcRenderer.invoke("desktop:list-workspace-launch-targets") as Promise<DesktopWorkspaceLaunchTarget[]>,
  openWorkspace: (rootPath: string, targetId?: DesktopWorkspaceLaunchTarget["id"]) =>
    ipcRenderer.invoke("desktop:open-workspace", { rootPath, targetId }) as Promise<void>,
  openWorkspaceFileInIde: (rootPath: string, filePath: string, ideId?: DesktopFileLaunchTargetId) =>
    ipcRenderer.invoke("desktop:open-workspace-file-in-ide", { rootPath, filePath, ideId }) as Promise<void>,
  openWorkspaceFileLocation: (rootPath: string, filePath: string, targetId: DesktopWorkspaceLaunchTarget["id"]) =>
    ipcRenderer.invoke("desktop:open-workspace-file-location", { rootPath, filePath, targetId }) as Promise<void>,
  copyText: (value: string) => ipcRenderer.invoke("desktop:copy-text", value),
  copyImage: (payload: DesktopImageDataPayload) => ipcRenderer.invoke("desktop:copy-image", payload),
  showImageInFolder: (payload: DesktopImageDataPayload) => ipcRenderer.invoke("desktop:show-image-in-folder", payload),
  setAppearance: (theme: "light" | "dark" | "system") => ipcRenderer.invoke("desktop:set-appearance", theme),
  getUpdateChannel: () => ipcRenderer.invoke("desktop:get-update-channel") as Promise<DesktopUpdateChannel>,
  setUpdateChannel: (channel: DesktopUpdateChannel) =>
    ipcRenderer.invoke("desktop:set-update-channel", channel) as Promise<DesktopUpdateChannel>,
  reloadApp: () => ipcRenderer.invoke("desktop:reload-app"),
  restart: () => ipcRenderer.invoke("desktop:restart"),
  getAppVersion: () => ipcRenderer.invoke("desktop:get-app-version") as Promise<string>,
  getReleaseNotes: () =>
    ipcRenderer.invoke("desktop:get-release-notes") as Promise<DesktopReleaseNotesResult>,
  markReleaseNotesShown: (version: string) =>
    ipcRenderer.invoke("desktop:mark-release-notes-shown", version) as Promise<void>,
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates") as Promise<DesktopUpdateCheckResult>,
  installUpdate: (version: string) =>
    ipcRenderer.invoke("desktop:install-update", version) as Promise<DesktopUpdateInstallResult>,
  applyUpdate: (updateId: string, options?: DesktopUpdateApplyOptions) =>
    ipcRenderer.invoke("desktop:apply-update", updateId, options) as Promise<DesktopUpdateApplyResult>,
  getUpdateProgress: () =>
    ipcRenderer.invoke("desktop:get-update-progress") as Promise<DesktopUpdateProgressEvent | null>,
  onUpdateProgress: (listener: (event: DesktopUpdateProgressEvent) => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopUpdateProgressEvent) => {
      listener(payload);
    };
    ipcRenderer.on("desktop:update-progress", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:update-progress", wrapped);
    };
  },
  setDeferredUpdatePromptReady: (ready: boolean) =>
    ipcRenderer.invoke("desktop:set-deferred-update-prompt-ready", Boolean(ready)) as Promise<void>,
  setSidePanelCloseShortcutActive: (active: boolean) =>
    ipcRenderer.invoke("desktop:set-side-panel-close-shortcut-active", Boolean(active)) as Promise<void>,
  setBrowserSurfaceShortcutActive: (
    active: boolean,
    owner?: "main_workbench" | "side_panel",
  ) => ipcRenderer.invoke(
    "desktop:set-browser-surface-shortcut-active",
    Boolean(active),
    owner,
  ) as Promise<void>,
  onBrowserShortcut: (
    listener: (request: {
      action: DesktopBrowserOwnerShortcutAction;
      sourceWebContentsId?: number;
    }) => void,
  ) => {
    const wrapped = (_event: IpcRendererEvent, request: unknown) => {
      if (
        !request
        || typeof request !== "object"
        || (
          !isDesktopBrowserShortcutAction(
            (request as { action?: unknown }).action,
          )
          && (request as { action?: unknown }).action !== "close_tab"
        )
      ) return;
      const sourceWebContentsId =
        (request as { sourceWebContentsId?: unknown }).sourceWebContentsId;
      if (
        sourceWebContentsId !== undefined
        && (
          !Number.isSafeInteger(sourceWebContentsId)
          || Number(sourceWebContentsId) <= 0
        )
      ) return;
      listener(request as {
        action: DesktopBrowserOwnerShortcutAction;
        sourceWebContentsId?: number;
      });
    };
    ipcRenderer.on("desktop:browser-shortcut", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:browser-shortcut", wrapped);
    };
  },
  onCloseSidePanelActiveTab: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on("desktop:close-side-panel-active-tab", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:close-side-panel-active-tab", wrapped);
    };
  },
  onOpenEmptySidePanel: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on("desktop:open-empty-side-panel", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:open-empty-side-panel", wrapped);
    };
  },
  onDeferredUpdatePrompt: (listener: (prompt: DesktopDeferredUpdatePrompt) => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopDeferredUpdatePrompt) => {
      listener(payload);
    };
    ipcRenderer.on("desktop:deferred-update-prompt", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:deferred-update-prompt", wrapped);
    };
  },
  respondDeferredUpdatePrompt: (promptId: string, decision: DesktopDeferredUpdatePromptDecision) =>
    ipcRenderer.invoke("desktop:respond-deferred-update-prompt", { promptId, decision }) as Promise<void>,
  getSystemPermissions: () =>
    ipcRenderer.invoke("desktop:get-system-permissions") as Promise<DesktopSystemPermissions>,
  openSystemPermissionSettings: (permission: DesktopSystemPermissionId) =>
    ipcRenderer.invoke("desktop:open-system-permission-settings", permission) as Promise<void>,
  sendFeedback: () => ipcRenderer.invoke("desktop:send-feedback") as Promise<void>,
  openExternal: (target: string) => ipcRenderer.invoke("desktop:open-external", target) as Promise<void>,
  forceOpenExternal: (target: string) => ipcRenderer.invoke("desktop:force-open-external", target) as Promise<void>,
  onOpenWebLink: (listener: (request: {
    url: string;
    source: "link" | "browser_popup";
    sourceWebContentsId?: number;
  }) => void) => {
    const wrapped = (_event: IpcRendererEvent, request: unknown) => {
      if (
        !request
        || typeof request !== "object"
        || typeof (request as { url?: unknown }).url !== "string"
        || !["link", "browser_popup"].includes(
          String((request as { source?: unknown }).source),
        )
      ) return;
      const typedRequest = request as {
        url: string;
        source: "link" | "browser_popup";
        sourceWebContentsId?: number;
      };
      if (
        typedRequest.source === "browser_popup"
        && (
          !Number.isSafeInteger(typedRequest.sourceWebContentsId)
          || Number(typedRequest.sourceWebContentsId) <= 0
        )
      ) return;
      listener(typedRequest);
    };
    ipcRenderer.on("desktop:open-web-link", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:open-web-link", wrapped);
    };
  },
  openNotificationSettings: () =>
    ipcRenderer.invoke("desktop:open-notification-settings") as Promise<OpenNotificationSettingsResult>,
  setBadgeCount: (count: number) => invokeOptionalDesktopChannel("badgeCount", "desktop:set-badge-count", count),
  showNotification: (payload: DesktopInboxNotificationPayload) =>
    invokeOptionalDesktopChannel("notifications", "desktop:show-notification", payload),
  pickPath: (options: DesktopPathPickOptions) =>
    ipcRenderer.invoke("desktop:pick-path", options) as Promise<DesktopPathPickResult>,
  listBrowserImportSources: () =>
    ipcRenderer.invoke("desktop:list-browser-import-sources") as Promise<BrowserImportSource[]>,
  importBrowserData: (input: { sourceId: string; importCookies: true }) =>
    ipcRenderer.invoke("desktop:import-browser-data", input) as Promise<BrowserDataImportResult>,
  getBrowserPartition: () =>
    ipcRenderer.invoke("desktop:get-browser-partition") as Promise<string>,
  clearBrowserData: () =>
    ipcRenderer.invoke("desktop:clear-browser-data") as Promise<void>,
  setBrowserEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("desktop:set-browser-enabled", enabled) as Promise<void>,
  onBrowserReset: (listener: (event: DesktopBrowserResetEvent) => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopBrowserResetEvent) => {
      listener(payload);
    };
    ipcRenderer.on("desktop:browser-reset", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:browser-reset", wrapped);
    };
  },
  localApps: {
    supported: process.platform === "darwin",
    list: () => ipcRenderer.invoke("desktop:local-apps:list") as Promise<LocalAppDefinition[]>,
    discover: () => ipcRenderer.invoke("desktop:local-apps:discover") as Promise<DesktopLocalAppDiscoveryResult>,
    create: (definition: DesktopLocalAppDraftInput) =>
      ipcRenderer.invoke("desktop:local-apps:create", { definition }) as Promise<LocalAppDefinition>,
    update: (id: string, definition: DesktopLocalAppDraftInput) =>
      ipcRenderer.invoke("desktop:local-apps:update", { id, definition }) as Promise<LocalAppDefinition>,
    delete: (id: string) => ipcRenderer.invoke("desktop:local-apps:delete", { id }) as Promise<void>,
    start: (id: string) => ipcRenderer.invoke("desktop:local-apps:start", { id }) as Promise<LocalAppRuntimeView>,
    stop: (id: string) => ipcRenderer.invoke("desktop:local-apps:stop", { id }) as Promise<LocalAppRuntimeView>,
    status: (id: string) => ipcRenderer.invoke("desktop:local-apps:status", { id }) as Promise<LocalAppRuntimeView>,
    logs: (id: string) => ipcRenderer.invoke("desktop:local-apps:logs", { id }) as Promise<string[]>,
    attestedTarget: (id: string) =>
      ipcRenderer.invoke("desktop:local-apps:attested-target", { id }) as Promise<DesktopLocalAppAttestedTarget | null>,
  },
});

declare global {
  interface Window {
    desktopIdentity: {
      getState(): Promise<DesktopIdentityState>;
      signIn(): Promise<DesktopIdentityState>;
      signOut(): Promise<DesktopIdentityState>;
      listDeviceSessions(): Promise<DesktopIdentityDeviceSession[]>;
      revokeDeviceSession(deviceId: string): Promise<void>;
      onStateChanged(listener: (state: DesktopIdentityState) => void): () => void;
    };
    desktopShell: {
      getBootState(): Promise<BootState>;
      onBootState(listener: (state: BootState) => void): () => void;
      openPath(targetPath: string): Promise<void>;
      previewLocalFile(targetPath: string): Promise<DesktopLocalFilePreview>;
      listAvailableIdes(): Promise<DesktopIdeTarget[]>;
      listWorkspaceLaunchTargets(): Promise<DesktopWorkspaceLaunchTarget[]>;
      openWorkspace(rootPath: string, targetId?: DesktopWorkspaceLaunchTarget["id"]): Promise<void>;
      openWorkspaceFileInIde(rootPath: string, filePath: string, ideId?: DesktopFileLaunchTargetId): Promise<void>;
      openWorkspaceFileLocation(rootPath: string, filePath: string, targetId: DesktopWorkspaceLaunchTarget["id"]): Promise<void>;
      copyText(value: string): Promise<void>;
      copyImage(payload: DesktopImageDataPayload): Promise<void>;
      showImageInFolder(payload: DesktopImageDataPayload): Promise<void>;
      setAppearance(theme: "light" | "dark" | "system"): Promise<void>;
      getUpdateChannel(): Promise<DesktopUpdateChannel>;
      setUpdateChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateChannel>;
      reloadApp(): Promise<void>;
      restart(): Promise<void>;
      getAppVersion(): Promise<string>;
      getReleaseNotes(): Promise<DesktopReleaseNotesResult>;
      markReleaseNotesShown(version: string): Promise<void>;
      checkForUpdates(): Promise<DesktopUpdateCheckResult>;
      installUpdate(version: string): Promise<DesktopUpdateInstallResult>;
      applyUpdate(updateId: string, options?: DesktopUpdateApplyOptions): Promise<DesktopUpdateApplyResult>;
      getUpdateProgress(): Promise<DesktopUpdateProgressEvent | null>;
      onUpdateProgress(listener: (event: DesktopUpdateProgressEvent) => void): () => void;
      setDeferredUpdatePromptReady(ready: boolean): Promise<void>;
      setSidePanelCloseShortcutActive(active: boolean): Promise<void>;
      setBrowserSurfaceShortcutActive(
        active: boolean,
        owner?: "main_workbench" | "side_panel",
      ): Promise<void>;
      onBrowserShortcut(listener: (request: {
        action: DesktopBrowserOwnerShortcutAction;
        sourceWebContentsId?: number;
      }) => void): () => void;
      onCloseSidePanelActiveTab(listener: () => void): () => void;
      onOpenEmptySidePanel(listener: () => void): () => void;
      onDeferredUpdatePrompt(listener: (prompt: DesktopDeferredUpdatePrompt) => void): () => void;
      respondDeferredUpdatePrompt(promptId: string, decision: DesktopDeferredUpdatePromptDecision): Promise<void>;
      getSystemPermissions(): Promise<DesktopSystemPermissions>;
      openSystemPermissionSettings(permission: DesktopSystemPermissionId): Promise<void>;
      sendFeedback(): Promise<void>;
      openExternal(target: string): Promise<void>;
      forceOpenExternal(target: string): Promise<void>;
      onOpenWebLink(listener: (request: {
        url: string;
        source: "link" | "browser_popup";
        sourceWebContentsId?: number;
      }) => void): () => void;
      openNotificationSettings(): Promise<OpenNotificationSettingsResult>;
      setBadgeCount(count: number): Promise<void>;
      showNotification(payload: DesktopInboxNotificationPayload): Promise<void>;
      pickPath(options: DesktopPathPickOptions): Promise<DesktopPathPickResult>;
      listBrowserImportSources(): Promise<BrowserImportSource[]>;
      importBrowserData(input: { sourceId: string; importCookies: true }): Promise<BrowserDataImportResult>;
      getBrowserPartition(): Promise<string>;
      clearBrowserData(): Promise<void>;
      setBrowserEnabled(enabled: boolean): Promise<void>;
      onBrowserReset(listener: (event: DesktopBrowserResetEvent) => void): () => void;
      localApps: {
        supported: boolean;
        list(): Promise<LocalAppDefinition[]>;
        discover(): Promise<DesktopLocalAppDiscoveryResult>;
        create(definition: DesktopLocalAppDraftInput): Promise<LocalAppDefinition>;
        update(id: string, definition: DesktopLocalAppDraftInput): Promise<LocalAppDefinition>;
        delete(id: string): Promise<void>;
        start(id: string): Promise<LocalAppRuntimeView>;
        stop(id: string): Promise<LocalAppRuntimeView>;
        status(id: string): Promise<LocalAppRuntimeView>;
        logs(id: string): Promise<string[]>;
        attestedTarget(id: string): Promise<DesktopLocalAppAttestedTarget | null>;
      };
    };
  }
}
type DesktopBrowserOwnerShortcutAction =
  | DesktopBrowserShortcutAction
  | "close_tab";
