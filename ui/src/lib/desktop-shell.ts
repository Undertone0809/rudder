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
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt: string;
};

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

export type DesktopIdeTarget = {
  id: "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";
  label: string;
};

export type DesktopShellApi = {
  getBootState(): Promise<DesktopBootState>;
  onBootState(listener: (state: DesktopBootState) => void): () => void;
  openPath(targetPath: string): Promise<void>;
  listAvailableIdes(): Promise<DesktopIdeTarget[]>;
  openWorkspaceFileInIde(rootPath: string, filePath: string, ideId?: DesktopIdeTarget["id"]): Promise<void>;
  copyText(value: string): Promise<void>;
  setAppearance(theme: "light" | "dark" | "system"): Promise<void>;
  restart(): Promise<void>;
  getAppVersion(): Promise<string>;
  checkForUpdates(): Promise<DesktopUpdateCheckResult>;
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
