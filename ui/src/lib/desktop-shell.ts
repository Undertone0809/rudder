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
  | "complete"
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

export type DesktopUpdateApplyOptions = {
  force?: boolean;
};

export type DesktopDeferredUpdatePrompt = {
  promptId: string;
  title: string;
  message: string;
  detail: string;
  totalRuns: number;
  confirmLabel: string;
  forceLabel: string;
  cancelLabel: string;
};

export type DesktopDeferredUpdatePromptDecision = "wait" | "force" | "cancel";

export type OpenNotificationSettingsResult = {
  opened: boolean;
  platform: string;
};

export type DesktopReleaseNotes = {
  version: string;
  title: string;
  sections: Array<{
    title: string;
    items: string[];
  }>;
};

export type DesktopReleaseNotesResult =
  | { status: "available"; notes: DesktopReleaseNotes }
  | { status: "unavailable" | "already-shown" };

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

export type DesktopLocalFilePreview = {
  canonicalPath: string;
  fileName: string;
  parentPath: string;
  contentType: string;
  previewKind: "markdown" | "csv" | "text" | "image" | "pdf";
  content: string | null;
  base64: string | null;
  sizeBytes: number;
  modifiedAt: string;
  truncated: boolean;
};

export type DesktopIdeTarget = {
  id: "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";
  label: string;
};

export type DesktopFileLaunchTargetId = DesktopIdeTarget["id"] | "defaultApp";

export type DesktopWorkspaceLaunchTarget = {
  id: DesktopIdeTarget["id"] | "xcode" | "terminal" | "warp" | "commandPrompt" | "powershell" | "finder";
  label: string;
  kind: "ide" | "terminal" | "folder";
  iconDataUrl?: string;
};

export type DesktopBrowserImportSource = {
  id: string;
  displayName: string;
  browserName: string;
  profileName: string;
  supported: {
    cookies: boolean;
    passwords: boolean;
  };
};

export type DesktopBrowserImportError = {
  errorCode: string;
  message: string;
};

export type DesktopBrowserImportResult = {
  status: "succeeded" | "partial" | "failed";
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  errors?: DesktopBrowserImportError[];
};

export type DesktopBrowserResetEvent = {
  reason: "clear" | "disabled";
  enabled: boolean;
  available: boolean;
};

export type DesktopShellApi = {
  getBootState(): Promise<DesktopBootState>;
  onBootState(listener: (state: DesktopBootState) => void): () => void;
  openPath(targetPath: string): Promise<void>;
  previewLocalFile(targetPath: string): Promise<DesktopLocalFilePreview>;
  listAvailableIdes(): Promise<DesktopIdeTarget[]>;
  listWorkspaceLaunchTargets?(): Promise<DesktopWorkspaceLaunchTarget[]>;
  openWorkspace?(rootPath: string, targetId?: DesktopWorkspaceLaunchTarget["id"]): Promise<void>;
  openWorkspaceFileInIde(rootPath: string, filePath: string, ideId?: DesktopFileLaunchTargetId): Promise<void>;
  openWorkspaceFileLocation?(rootPath: string, filePath: string, targetId: DesktopWorkspaceLaunchTarget["id"]): Promise<void>;
  copyText(value: string): Promise<void>;
  copyImage?(payload: DesktopImageDataPayload): Promise<void>;
  showImageInFolder?(payload: DesktopImageDataPayload): Promise<void>;
  setAppearance(theme: "light" | "dark" | "system"): Promise<void>;
  getUpdateChannel?(): Promise<DesktopUpdateChannel>;
  setUpdateChannel?(channel: DesktopUpdateChannel): Promise<DesktopUpdateChannel>;
  reloadApp?(): Promise<void>;
  restart(): Promise<void>;
  getAppVersion(): Promise<string>;
  getReleaseNotes?(): Promise<DesktopReleaseNotesResult>;
  markReleaseNotesShown?(version: string): Promise<void>;
  checkForUpdates(): Promise<DesktopUpdateCheckResult>;
  installUpdate(version: string): Promise<DesktopUpdateInstallResult>;
  applyUpdate?(updateId: string, options?: DesktopUpdateApplyOptions): Promise<DesktopUpdateApplyResult>;
  getUpdateProgress?(): Promise<DesktopUpdateProgressEvent | null>;
  onUpdateProgress?(listener: (event: DesktopUpdateProgressEvent) => void): () => void;
  setDeferredUpdatePromptReady?(ready: boolean): Promise<void>;
  setSidePanelCloseShortcutActive?(active: boolean): Promise<void>;
  onCloseSidePanelActiveTab?(listener: () => void): () => void;
  onDeferredUpdatePrompt?(listener: (prompt: DesktopDeferredUpdatePrompt) => void): () => void;
  respondDeferredUpdatePrompt?(promptId: string, decision: DesktopDeferredUpdatePromptDecision): Promise<void>;
  getSystemPermissions?(): Promise<DesktopSystemPermissions>;
  sendFeedback(): Promise<void>;
  openExternal(target: string): Promise<void>;
  openNotificationSettings(): Promise<OpenNotificationSettingsResult>;
  setBadgeCount(count: number): Promise<void>;
  showNotification(payload: DesktopNotificationPayload): Promise<void>;
  pickPath(options: DesktopPathPickOptions): Promise<DesktopPathPickResult>;
  listBrowserImportSources?(): Promise<DesktopBrowserImportSource[]>;
  importBrowserData?(input: { sourceId: string; importCookies: true }): Promise<DesktopBrowserImportResult>;
  getBrowserPartition?(): Promise<string>;
  clearBrowserData?(): Promise<void>;
  setBrowserEnabled?(enabled: boolean): Promise<void>;
  onBrowserReset?(listener: (event: DesktopBrowserResetEvent) => void): () => void;
};

export function readDesktopShell(): DesktopShellApi | null {
  if (typeof window === "undefined") return null;
  return (window as typeof window & { desktopShell?: DesktopShellApi }).desktopShell ?? null;
}
