export type DesktopSystemPermissionStatus =
  | "authorized"
  | "needs_access"
  | "per_app"
  | "unknown"
  | "unsupported";

export type DesktopSystemPermissions = {
  fullDiskAccess?: DesktopSystemPermissionStatus;
  accessibility?: DesktopSystemPermissionStatus;
  automation?: DesktopSystemPermissionStatus;
};

export type DesktopBootState = {
  capabilities?: {
    badgeCount?: boolean;
    notifications?: boolean;
  };
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
    instanceRoot?: string;
  };
  runtime?: {
    localEnv?: string | null;
    mode?: "owned" | "attached";
    ownerKind?: string | null;
    version?: string;
    apiUrl?: string;
  };
};

export type DesktopUpdateCheckResult = {
  status: "update-available" | "up-to-date" | "unavailable";
  channel: "stable" | "canary";
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt: string;
};

export type DesktopUpdateChannel = DesktopUpdateCheckResult["channel"];

export type DesktopUpdateInstallResult =
  | { status: "started"; version: string; updateId?: string }
  | { status: "waiting"; version: string; updateId?: string; totalRuns: number; message: string }
  | { status: "unavailable"; message: string }
  | { status: "blocked"; totalRuns: number; message: string }
  | { status: "failed"; message: string };

export type DesktopUpdateProgressPhase =
  | "starting"
  | "resolving_release"
  | "downloading_checksums"
  | "downloading_asset"
  | "verifying_checksum"
  | "ready_to_install"
  | "waiting_for_active_runs"
  | "preparing_restart"
  | "closing"
  | "failed";

export type DesktopUpdateProgressEvent = {
  updateId: string;
  version: string;
  phase: DesktopUpdateProgressPhase;
  message: string;
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  totalRuns?: number;
  error?: string;
  at: string;
};

export type DesktopUpdateApplyResult =
  | { status: "started"; updateId: string; version: string }
  | { status: "unavailable"; message: string }
  | { status: "failed"; message: string };

export type OpenNotificationSettingsResult = {
  opened: boolean;
  platform: string;
};

export type DesktopNotificationPayload = {
  title: string;
  body?: string;
};

export type DesktopPathPickOptions = {
  kind: "file" | "directory";
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
};

export type DesktopPathPickResult = {
  canceled: boolean;
  path: string | null;
};

export type DesktopImageDataPayload = {
  filename?: string | null;
  contentType: string;
  base64: string;
};

export type DesktopIdeTarget = {
  id: "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";
  label: string;
};

export type DesktopWorkspaceLaunchTarget = {
  id: DesktopIdeTarget["id"] | "xcode" | "terminal" | "warp" | "finder";
  label: string;
  kind: "ide" | "terminal" | "folder";
  iconDataUrl?: string;
};

export type DesktopShellApi = {
  getBootState(): Promise<DesktopBootState>;
  onBootState(listener: (state: DesktopBootState) => void): () => void;
  openPath(targetPath: string): Promise<void>;
  listAvailableIdes(): Promise<DesktopIdeTarget[]>;
  listWorkspaceLaunchTargets?(): Promise<DesktopWorkspaceLaunchTarget[]>;
  openWorkspace?(rootPath: string, targetId?: DesktopWorkspaceLaunchTarget["id"]): Promise<void>;
  openWorkspaceFileInIde(rootPath: string, filePath: string, ideId?: DesktopIdeTarget["id"]): Promise<void>;
  copyText(value: string): Promise<void>;
  copyImage?(payload: DesktopImageDataPayload): Promise<void>;
  showImageInFolder?(payload: DesktopImageDataPayload): Promise<void>;
  setAppearance(theme: "light" | "dark" | "system"): Promise<void>;
  getUpdateChannel?(): Promise<DesktopUpdateChannel>;
  setUpdateChannel?(channel: DesktopUpdateChannel): Promise<DesktopUpdateChannel>;
  reloadApp?(): Promise<void>;
  restart(): Promise<void>;
  getAppVersion(): Promise<string>;
  checkForUpdates(): Promise<DesktopUpdateCheckResult>;
  installUpdate(version: string): Promise<DesktopUpdateInstallResult>;
  applyUpdate?(updateId: string): Promise<DesktopUpdateApplyResult>;
  getUpdateProgress?(): Promise<DesktopUpdateProgressEvent | null>;
  onUpdateProgress?(listener: (event: DesktopUpdateProgressEvent) => void): () => void;
  getSystemPermissions?(): Promise<DesktopSystemPermissions>;
  sendFeedback(): Promise<void>;
  openExternal(target: string): Promise<void>;
  openNotificationSettings(): Promise<OpenNotificationSettingsResult>;
  setBadgeCount(count: number): Promise<void>;
  showNotification(payload: DesktopNotificationPayload): Promise<void>;
  pickPath(options: DesktopPathPickOptions): Promise<DesktopPathPickResult>;
};

export function readDesktopShell(): DesktopShellApi | null {
  if (typeof window === "undefined") return null;
  return (window as typeof window & { desktopShell?: DesktopShellApi }).desktopShell ?? null;
}
