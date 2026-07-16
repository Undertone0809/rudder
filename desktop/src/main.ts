import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, OpenDialogOptions, WebContents } from "electron";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MenuItem, nativeImage, nativeTheme, Notification, session, shell, systemPreferences, Tray } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDesktopAppName } from "./app-identity.js";
import { createBootScreenHtml, createRendererRecoveryScreenHtml, type BootScreenState } from "./boot-screen.js";
import { createElectronBrowserAgentTabFactory } from "./browser-agent-electron.js";
import { BrowserAgentError, createBrowserAgentTabController } from "./browser-agent-tabs.js";
import {
  isDesktopBrowserRunActive,
  readDesktopBrowserSettings,
  registerDesktopBrowserBroker,
  unregisterDesktopBrowserBroker,
} from "./browser-broker-registration.js";
import { startBrowserBrokerServer } from "./browser-broker-server.js";
import { runBrowserCookieImportWorker } from "./browser-cookie-import-worker.js";
import { createBrowserCookieImporter, type BrowserDataImportResult } from "./browser-cookie-import.js";
import {
  cleanupStaleBrowserImportTempDirectories,
  deriveBrowserImportOwnerId,
} from "./browser-import-snapshot.js";
import { createBrowserImportSourceRegistry, type BrowserImportSource } from "./browser-import-sources.js";
import { registerBrowserIpcHandlers } from "./browser-ipc.js";
import { createBrowserPopupRateLimiter } from "./browser-popup-rate-limit.js";
import {
  createBrowserProfileController,
  deriveBrowserPartition,
  type BrowserProfileController,
} from "./browser-profile.js";
import { createDesktopBrowserRuntimeLifecycle } from "./browser-runtime-lifecycle.js";
import {
  createBrowserGuestRegistry,
  installBrowserSessionPolicy,
  installBrowserWebviewPolicy,
  installDefaultWindowOpenDenyPolicy,
} from "./browser-webview-policy.js";
import { ensureDesktopCliLink, resolveDesktopCliArgv, shouldInstallDesktopCliLink } from "./cli-link.js";
import { runDesktopCliMode } from "./cli-runner.js";
import type { DesktopCapabilities } from "./desktop-capabilities.js";
import {
  listAvailableIdeTargets,
  listWorkspaceLaunchTargets,
  openWorkspace,
  openWorkspaceFileInIde,
  openWorkspaceFileLocation,
  type DesktopFileLaunchTargetId,
  type DesktopWorkspaceLaunchTargetId,
} from "./ide-opener.js";
import { previewLocalFile } from "./local-file-preview.js";
import { syncProcessPathFromLoginShell } from "./login-shell-env.js";
import {
  canOpenBlockedNavigationExternally,
  classifyBlockedDesktopNavigation,
  collectDesktopNavigationOrigins,
  isAllowedDesktopNavigation,
  sanitizeDesktopNavigationForLog,
} from "./navigation-guard.js";
import {
  consumePostUpdateReloadMarker,
  resolvePostUpdateReloadDelayMs,
  type PostUpdateReloadMarker,
} from "./post-update-reload.js";
import {
  resolveDesktopPostgresBinDir,
  resolvePreferredDesktopPostgresBinDir,
  RUDDER_POSTGRES_BIN_DIR_ENV,
} from "./postgres-runtime.js";
import {
  markReleaseNotesShown,
  readReleaseNotes,
  resolveReleaseNotesPath,
  resolveReleaseNotesStatePath,
  shouldShowReleaseNotes,
  type DesktopReleaseNotes,
} from "./release-notes.js";
import {
  resolveDesktopOrganizationWorkspaceAllowedRoots,
  resolveDesktopOrganizationWorkspaceHomeEnv,
  resolveExternalRuntimeServerEntrypoint,
  resolveSharedRudderHomeDir,
} from "./runtime-cache.js";
import { resolveDesktopSystemPermissions, type DesktopSystemPermissions } from "./system-permissions.js";
import {
  applyThemePreferenceToNativeTheme,
  resolveAppearanceForThemePreference,
  type DesktopAppearance,
  type DesktopThemePreference,
} from "./theme-preference.js";
import {
  type DesktopUpdateChannel
} from "./update-check.js";

import { imageBufferFromPayload, parseDesktopImageDataPayload, sanitizeDesktopImageFilename } from "./desktop-image-payload.js";
import { resolveDesktopLocalEnvProfile, type LocalEnvProfile } from "./desktop-local-env.js";
import { resolveDesktopCapabilities } from "./desktop-main-capabilities.js";
import { createDesktopQuitFlow } from "./desktop-quit-flow.js";
import {
  createDesktopRecoveryDiagnostic,
  createDesktopStartupFailureView,
  type DesktopStartupFailureView,
} from "./desktop-startup-failure.js";
import { DESKTOP_BUG_REPORT_URL, DESKTOP_FEEDBACK_EMAIL } from "./desktop-support-mail.js";
import { createDesktopUpdateFlow, INSTANCE_SETTINGS_GENERAL_PATH } from "./desktop-update-flow.js";
import {
  toWorkspaceLaunchTargetPayload,
  type DesktopWorkspaceLaunchTargetPayload,
} from "./desktop-workspace-launch-payload.js";
import { resolveProtectedDesktopShortcutRoute } from "./side-panel-close-shortcut.js";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
type BootState = {
  stage: string;
  message: string;
  detail?: string;
  error?: string;
  failure?: DesktopStartupFailureView;
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

type StartServerOptions = {
  printBanner?: boolean;
  openOnListen?: boolean;
  runtimeOverrides?: Record<string, unknown>;
  onEvent?: (event: { stage: string; message: string }) => void;
};

type StartManagedLocalServerOptions = StartServerOptions & {
  ownerKind: "desktop";
  takeoverOnVersionMismatch?: boolean;
};

type StartedServer = {
  apiUrl: string;
  instancePaths: {
    homeDir: string;
    instanceRoot: string;
    configPath: string;
    envPath: string;
  };
  runtime: {
    mode: "owned" | "attached";
    instanceId: string;
    localEnv: string | null;
    ownerKind: string | null;
    version: string;
  };
  stop(): Promise<void>;
};

type ServerModule = {
  startManagedLocalServer(options: StartManagedLocalServerOptions): Promise<StartedServer>;
};

type CliModule = {
  runCli(argv?: string[]): Promise<number>;
};

type ResidentShellStatus = {
  enabled: boolean;
  controlsAvailable: boolean;
};

type DesktopOrganization = {
  id: string;
  name: string;
};

type DesktopLiveRun = {
  id: string;
  status: string;
  agentId?: string | null;
  agentName: string;
  issueId?: string | null;
};

type DesktopUpdateBlocker = {
  runId: string;
  agentId: string | null;
  agentName: string;
  issueId: string | null;
  organizationId: string;
  organizationName: string;
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

type DeferredUpdatePromptDecision = "wait" | "force" | "cancel";

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

type DesktopIdeTarget = {
  id: "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";
  label: string;
};

type ActiveRunSummary = {
  totalRuns: number;
  organizations: Array<{
    id: string;
    name: string;
    runs: DesktopLiveRun[];
  }>;
};

type MacWindowMode = "opaque" | "transparent" | "transparent_vibrant";

type OpenNotificationSettingsResult = {
  opened: boolean;
  platform: NodeJS.Platform;
};

type DesktopReleaseNotesResult =
  | { status: "available"; notes: DesktopReleaseNotes }
  | { status: "unavailable" | "already-shown" };

function normalizeBooleanEnvFlag(value: string | null | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function resolveDesktopResidentShellEnabled(): boolean {
  const override = normalizeBooleanEnvFlag(process.env.RUDDER_DESKTOP_RESIDENT_SHELL);
  return override ?? app.isPackaged;
}

function linuxDesktopLikelySupportsTray(): boolean {
  const shellHints = [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.DESKTOP_SESSION,
    process.env.XDG_SESSION_DESKTOP,
  ]
    .filter(Boolean)
    .join(":")
    .toLowerCase();
  if (!shellHints) return false;
  const supportedMarkers = [
    "kde",
    "plasma",
    "xfce",
    "x-cinnamon",
    "cinnamon",
    "mate",
    "lxqt",
    "lxde",
    "pantheon",
    "deepin",
    "ukui",
    "budgie",
    "unity",
    "ubuntu",
  ];
  if (supportedMarkers.some((marker) => shellHints.includes(marker))) return true;
  if (shellHints.includes("gnome")) return false;
  return false;
}

function platformSupportsResidentShellControls(): boolean {
  if (!residentShellEnabled) return false;
  if (process.platform === "linux") return linuxDesktopLikelySupportsTray();
  return process.platform === "darwin" || process.platform === "win32";
}

function shouldHideDockForResidentShell(): boolean {
  return process.platform === "darwin" && residentControlsAvailable;
}

function resolveResidentTrayTemplatePath(): string | null {
  if (process.platform !== "darwin") return null;

  const candidate = app.isPackaged
    ? path.resolve(process.resourcesPath, "trayTemplate.png")
    : path.resolve(MODULE_DIR, "..", "build", "trayTemplate.png");

  return fs.existsSync(candidate) ? candidate : null;
}

function resolveDesktopResourceAssetPath(fileName: string): string | null {
  const candidates = app.isPackaged
    ? [
        path.resolve(process.resourcesPath, fileName),
        path.resolve(process.resourcesPath, "app", "build", fileName),
      ]
    : [
        path.resolve(MODULE_DIR, "..", "build", fileName),
      ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function createResidentTrayIcon(): string | Electron.NativeImage {
  if (process.platform === "darwin") {
    const templatePath = resolveResidentTrayTemplatePath();
    if (templatePath) {
      return templatePath;
    }
  }

  const iconPath = process.platform === "win32"
    ? resolveDesktopResourceAssetPath("icon.ico") ?? resolveDesktopResourceAssetPath("icon.png")
    : resolveDesktopResourceAssetPath("icon.png");
  if (iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return process.platform === "win32" ? image : image.resize({ width: 16, height: 16 });
    }
  }

  const iconSvg = process.platform === "darwin"
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
        <g fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 5.15 5.35 11.1M9 5.15l3.65 5.95M6.15 12.05h5.7"/>
        </g>
        <g fill="#000">
          <circle cx="9" cy="3.85" r="1.95"/>
          <circle cx="4.45" cy="12.9" r="1.95"/>
          <circle cx="13.55" cy="12.9" r="1.95"/>
        </g>
      </svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
        <g fill="none" stroke="#111827" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="32" cy="12" r="6" fill="#111827"/>
          <circle cx="16" cy="44" r="6" fill="#111827"/>
          <circle cx="48" cy="44" r="6" fill="#111827"/>
          <path d="M32 18 18.5 38.5M32 18l13.5 20.5M22 44h20"/>
        </g>
      </svg>`;
  const image = nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`)
    .resize({ width: process.platform === "darwin" ? 18 : 16, height: process.platform === "darwin" ? 18 : 16 });
  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }
  return image;
}

function applyDesktopAppIdentity(profile: LocalEnvProfile): string {
  const appName = resolveDesktopAppName(profile.name);
  app.setName(appName);
  process.title = appName;
  app.setAboutPanelOptions({
    applicationName: appName,
  });
  return appName;
}

const initialProfile = resolveDesktopLocalEnvProfile();
const APP_NAME = applyDesktopAppIdentity(initialProfile);
const desktopCapabilities = resolveDesktopCapabilities();
function readCurrentDesktopSystemPermissions(): DesktopSystemPermissions {
  return resolveDesktopSystemPermissions({
    isAccessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
  });
}

const residentShellEnabled = resolveDesktopResidentShellEnabled();
const DESKTOP_WINDOW_BACKGROUND: Record<DesktopAppearance, string> = {
  light: process.platform === "darwin" ? "#f6f4f1" : "#f1f0ef",
  dark: process.platform === "darwin" ? "#151618" : "#1f1f1d",
};
const TRANSPARENT_DESKTOP_WINDOW_BACKGROUND: Record<DesktopAppearance, string> = {
  light: "rgba(246, 244, 241, 0.18)",
  dark: "rgba(18, 20, 24, 0.28)",
};
const desktopUserDataOverride = process.env.RUDDER_DESKTOP_USER_DATA_DIR?.trim();
if (desktopUserDataOverride) {
  app.setPath("userData", path.resolve(desktopUserDataOverride));
}

const initialPaths = resolveSharedInstancePaths(initialProfile.instanceId);

let mainWindow: BrowserWindow | null = null;
let currentMainRenderer: WebContents | null = null;
let currentMainWindowKind: "app" | "boot" = "boot";
let residentTray: Tray | null = null;
let sidePanelCloseShortcutActive = false;
let browserSurfaceShortcutActive = false;
let residentControlsAvailable = false;
let desktopWindowIcon: Electron.NativeImage | null = null;
let latestPostUpdateReloadMarker: PostUpdateReloadMarker | null = null;
let currentThemePreference: DesktopThemePreference = nativeTheme.themeSource;
let currentAppearance: DesktopAppearance = resolveAppearanceForThemePreference(
  currentThemePreference,
  nativeTheme.shouldUseDarkColors,
);
const sidePanelCloseShortcutWebContents = new WeakSet<WebContents>();
const operatorBrowserShortcutWebContents = new WeakSet<WebContents>();
const browserGuestRegistry = createBrowserGuestRegistry();
const acceptBrowserPopup = createBrowserPopupRateLimiter();
let browserProfileController: BrowserProfileController | null = null;
let browserAgentTabController: ReturnType<typeof createBrowserAgentTabController> | null = null;
let browserRuntimeLifecycle: ReturnType<typeof createDesktopBrowserRuntimeLifecycle> | null = null;
let browserCookieImporter: {
  listBrowserImportSources(): Promise<BrowserImportSource[]>;
  importBrowserData(input: { sourceId: string; importCookies: true }): Promise<BrowserDataImportResult>;
} | null = null;
let currentBootState: BootState = {
  stage: "starting",
  message: "Resolving shared local Rudder instance…",
  detail: "Preparing the embedded database and board UI.",
  capabilities: desktopCapabilities,
  permissions: readCurrentDesktopSystemPermissions(),
  paths: initialPaths,
  runtime: {
    localEnv: initialProfile.name,
    instanceId: initialProfile.instanceId,
  },
};
let serverHandle: StartedServer | null = null;
let startInFlight: Promise<void> | null = null;
let restartInFlight: Promise<void> | null = null;
let supportDraftInFlight: { contextId: string; promise: Promise<void> } | null = null;
let bugReportInFlight: { failureId: string; promise: Promise<void> } | null = null;
let supportDraftHandoffAttemptCount = 0;
let bugReportHandoffAttemptCount = 0;
let startupAttemptCount = 0;
let pendingDesktopNavigationPath: string | null = null;
let lastKnownAppUrl: string | null = null;
let rendererRecoveryInFlight = false;
let externalServerRuntimeCacheDir: string | null = null;
let deferredUpdatePromptRendererReady = false;
const pendingDeferredUpdatePrompts = new Map<string, {
  resolve: (decision: DeferredUpdatePromptDecision | null) => void;
  timeout: NodeJS.Timeout;
}>();

function promptRendererForDeferredUpdate(
  payload: Omit<DesktopDeferredUpdatePrompt, "promptId">,
): Promise<DeferredUpdatePromptDecision | null> {
  showMainWindow();
  const window = mainWindow;
  if (!deferredUpdatePromptRendererReady || !window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.resolve(null);
  }

  const promptId = randomUUID();
  const prompt: DesktopDeferredUpdatePrompt = { promptId, ...payload };
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingDeferredUpdatePrompts.delete(promptId);
      resolve(null);
    }, 30 * 60 * 1000);
    pendingDeferredUpdatePrompts.set(promptId, { resolve, timeout });
    window.webContents.send("desktop:deferred-update-prompt", prompt);
  });
}

const desktopQuitFlow = createDesktopQuitFlow({
  appName: APP_NAME,
  getMainWindow: () => mainWindow,
  setMainWindow: (value) => { mainWindow = value; },
  getServerHandle: () => serverHandle,
  prepareForQuit: () => browserProfileController?.shutdown() ?? Promise.resolve(),
  stopLocalRudder,
  destroyResidentTray: () => { residentTray?.destroy(); residentTray = null; },
});
const {
  listActiveRunsForQuit,
  listRunningRunsForUpdate,
  formatQuitRunDetail,
  formatUpdateRunDetail,
  beginQuitFlow,
  resolveUpdateQuitResponsePath,
  resolveUpdateQuitForce,
  writeUpdateQuitResponse,
  handleUpdateQuitRequest,
  isQuitting,
  isQuitRequested,
} = desktopQuitFlow;
const desktopUpdateFlow = createDesktopUpdateFlow({
  appName: APP_NAME,
  getMainWindow: () => mainWindow,
  getServerHandle: () => serverHandle,
  getBootState: () => currentBootState,
  listRunningRunsForUpdate,
  formatUpdateRunDetail,
  promptForDeferredUpdate: promptRendererForDeferredUpdate,
  showMainWindow,
});
const {
  checkForUpdates, getDesktopUpdateChannel, setDesktopUpdateChannel, resolveRudderAppVersion,
  maybeShowStartupUpdateNotice, showManualUpdateCheckDialog, installUpdate, applyUpdate,
  createFeedbackMailtoUrl, getDesktopUpdateProgress,
} = desktopUpdateFlow;

function resolveDesktopWindowBackgroundColor(appearance: DesktopAppearance = currentAppearance): string {
  return DESKTOP_WINDOW_BACKGROUND[appearance];
}

function resolveTransparentWindowBackgroundColor(appearance: DesktopAppearance = currentAppearance): string {
  return TRANSPARENT_DESKTOP_WINDOW_BACKGROUND[appearance];
}

function resolveMacWindowMode(): MacWindowMode {
  const value = process.env.RUDDER_DESKTOP_MAC_WINDOW_MODE?.trim().toLowerCase();
  if (value === "opaque") return "opaque";
  if (value === "transparent") return "transparent";
  if (value === "transparent_vibrant" || value === "transparent-vibrant") return "transparent_vibrant";
  return process.platform === "darwin" ? "transparent_vibrant" : "opaque";
}

function resolveMacWindowEffects(): Pick<BrowserWindowConstructorOptions,
  "backgroundColor" | "titleBarStyle" | "transparent" | "vibrancy" | "visualEffectState"> {
  const mode = resolveMacWindowMode();
  if (mode === "transparent") {
    return {
      titleBarStyle: "hiddenInset",
      transparent: true,
      backgroundColor: resolveTransparentWindowBackgroundColor(currentAppearance),
    };
  }
  if (mode === "transparent_vibrant") {
    return {
      titleBarStyle: "hiddenInset",
      transparent: true,
      backgroundColor: resolveTransparentWindowBackgroundColor(currentAppearance),
      vibrancy: "under-window",
      visualEffectState: "active",
    };
  }
  return {
    titleBarStyle: "hiddenInset",
    backgroundColor: resolveDesktopWindowBackgroundColor(),
    vibrancy: "under-window",
    visualEffectState: "active",
  };
}

function createDesktopWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webviewTag: true,
  };
}

function createBootWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webviewTag: false,
  };
}

function applyDesktopAppearance(appearance: DesktopAppearance): void {
  currentAppearance = appearance;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const backgroundColor = process.platform === "darwin" && resolveMacWindowMode() !== "opaque"
      ? resolveTransparentWindowBackgroundColor(appearance)
      : resolveDesktopWindowBackgroundColor(appearance);
    mainWindow.setBackgroundColor(backgroundColor);
  }
}

function applyDesktopThemePreference(preference: DesktopThemePreference): void {
  currentThemePreference = preference;
  applyDesktopAppearance(applyThemePreferenceToNativeTheme(nativeTheme, preference));
}

function refreshDesktopAppearanceFromSystem(): void {
  if (currentThemePreference !== "system") return;
  applyDesktopAppearance(resolveAppearanceForThemePreference("system", nativeTheme.shouldUseDarkColors));
}

function resolveSharedInstancePaths(instanceId: string): NonNullable<BootState["paths"]> {
  const homeDir = resolveSharedRudderHomeDir();
  const instanceRoot = path.resolve(homeDir, "instances", instanceId);
  return {
    homeDir,
    instanceRoot,
    configPath: path.resolve(instanceRoot, "config.json"),
    envPath: path.resolve(instanceRoot, ".env"),
  };
}

function resolveDesktopRuntimeIconPath(profile: LocalEnvProfile): string | null {
  if (process.platform === "win32" && profile.name !== "dev") {
    return resolveDesktopResourceAssetPath("icon.ico") ?? resolveDesktopResourceAssetPath("icon.png");
  }
  return resolveDesktopResourceAssetPath(profile.name === "dev" ? "icon-dev.png" : "icon.png");
}

function applyDesktopRuntimeIcon(profile: LocalEnvProfile): Electron.NativeImage | null {
  const iconPath = resolveDesktopRuntimeIconPath(profile);
  if (!iconPath) return null;

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return null;

  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(icon);
  }

  return icon;
}

function applyDesktopEnvironment(): LocalEnvProfile {
  const profile = resolveDesktopLocalEnvProfile();
  const paths = resolveSharedInstancePaths(profile.instanceId);
  fs.mkdirSync(paths.homeDir ?? resolveSharedRudderHomeDir(), { recursive: true });
  fs.mkdirSync(paths.instanceRoot ?? path.resolve(resolveSharedRudderHomeDir(), "instances", profile.instanceId), {
    recursive: true,
  });
  process.env.RUDDER_LOCAL_ENV = profile.name;
  process.env.RUDDER_INSTANCE_ID = profile.instanceId;
  const workspaceHome = resolveDesktopOrganizationWorkspaceHomeEnv(process.env, profile.instanceId);
  if (workspaceHome) {
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;
  }
  process.env.PORT ??= profile.port;
  process.env.RUDDER_EMBEDDED_POSTGRES_PORT ??= profile.embeddedPostgresPort;
  process.env.RUDDER_DEPLOYMENT_MODE = "local_trusted";
  process.env.RUDDER_DEPLOYMENT_EXPOSURE = "private";
  process.env.HOST = "127.0.0.1";
  process.env.SERVE_UI = "true";
  process.env.RUDDER_UI_DEV_MIDDLEWARE = "false";
  process.env.RUDDER_OPEN_ON_LISTEN = "false";
  const postgresBinDir = resolvePreferredDesktopPostgresBinDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    externalRuntimeCacheDir: externalServerRuntimeCacheDir,
  });
  if (postgresBinDir) {
    process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = postgresBinDir;
  }
  return profile;
}

function requireBrowserProfileController(): BrowserProfileController {
  if (!browserProfileController) {
    throw new Error("Rudder Browser profile has not been initialized.");
  }
  return browserProfileController;
}

function requireBrowserCookieImporter() {
  if (!browserCookieImporter) {
    throw new Error("Rudder Browser data import has not been initialized.");
  }
  return browserCookieImporter;
}

function requireBrowserRuntimeLifecycle() {
  if (!browserRuntimeLifecycle) {
    throw new Error("Rudder Browser runtime has not been initialized.");
  }
  return browserRuntimeLifecycle;
}

function getCurrentMainRenderer(): WebContents | null {
  if (!currentMainRenderer || currentMainRenderer.isDestroyed()) return null;
  return currentMainRenderer;
}

function assertCurrentMainFrame(event: IpcMainInvokeEvent, action: string): void {
  const renderer = getCurrentMainRenderer();
  if (!renderer || event.sender !== renderer || event.senderFrame !== renderer.mainFrame) {
    throw new Error(`${action} is available only to the current Rudder main frame.`);
  }
}

function assertStartupRecoveryFrame(event: IpcMainInvokeEvent, action: string): void {
  assertCurrentMainFrame(event, action);
  if (currentMainWindowKind !== "boot") {
    throw new Error(`${action} is available only from the Desktop startup window.`);
  }
}

function collectBrowserControlPlaneOrigins(...additionalOrigins: Array<string | null | undefined>): string[] {
  const configuredPort = process.env.PORT?.trim();
  const configuredOrigin = configuredPort ? `http://127.0.0.1:${configuredPort}` : null;
  return collectDesktopNavigationOrigins(
    ...additionalOrigins,
    configuredOrigin,
    resolveDesktopAppBaseUrl(),
    currentBootState.runtime?.apiUrl,
    serverHandle?.apiUrl,
    lastKnownAppUrl,
  );
}

function routeDesktopWebLink(url: string, source: "link" | "browser_popup"): void {
  if (source === "browser_popup" && !acceptBrowserPopup()) return;
  const renderer = getCurrentMainRenderer();
  if (renderer?.getURL().startsWith("http")) {
    renderer.send("desktop:open-web-link", { url, source });
    return;
  }
  shell.openExternal(url).catch((error) => {
    console.warn(
      "[rudder-desktop] failed to open routed web link externally",
      sanitizeDesktopNavigationForLog(url),
      error,
    );
  });
}

async function closeAllBrowserGuests(): Promise<void> {
  await browserAgentTabController?.closeAll();
  await browserGuestRegistry.closeAll();
}

async function closeAgentBrowserGuests(): Promise<void> {
  await browserAgentTabController?.closeAll();
}

function initializeBrowserProfile(instanceRoot: string): void {
  const partition = deriveBrowserPartition(instanceRoot);
  const importOwnerId = deriveBrowserImportOwnerId(partition);
  if (browserProfileController) {
    if (browserProfileController.getPartition() !== partition) {
      throw new Error("Rudder Browser profile cannot change instances after Desktop startup.");
    }
    return;
  }

  const browserSession = session.fromPartition(partition);
  installBrowserSessionPolicy(browserSession, {
    getControlPlaneOrigins: collectBrowserControlPlaneOrigins,
  });
  const controller = createBrowserProfileController({
    partition,
    session: browserSession,
    closeBrowserGuests: (scope) => (
      scope === "all" ? closeAllBrowserGuests() : closeAgentBrowserGuests()
    ),
    broadcastReset: (event) => {
      getCurrentMainRenderer()?.send("desktop:browser-reset", event);
    },
  });
  browserProfileController = controller;
  const agentTabs = createBrowserAgentTabController({
    createTab: createElectronBrowserAgentTabFactory({
      partition,
      createWindow: (windowOptions) => new BrowserWindow(windowOptions),
      registerGuest: browserGuestRegistry.register,
      getControlPlaneOrigins: collectBrowserControlPlaneOrigins,
    }),
    getControlPlaneOrigins: collectBrowserControlPlaneOrigins,
  });
  browserAgentTabController = agentTabs;
  browserRuntimeLifecycle = createDesktopBrowserRuntimeLifecycle({
    tabs: agentTabs,
    getProfileEnabled: () => controller.getState().enabled,
    setProfileEnabled: (enabled) => controller.setEnabled(enabled),
    execute: async (command) => {
      if (typeof command.deadlineAt === "number" && command.deadlineAt <= Date.now()) {
        throw new BrowserAgentError("browser_timeout", "Browser action expired before execution.");
      }
      const state = controller.getState();
      if (!state.enabled) {
        throw new BrowserAgentError("browser_disabled", "Rudder Browser is disabled in Settings.");
      }
      if (!state.available) {
        throw new BrowserAgentError("browser_unavailable", "Rudder Browser is temporarily unavailable.");
      }
      return agentTabs.execute(command);
    },
    startBroker: startBrowserBrokerServer,
    registerBroker: registerDesktopBrowserBroker,
    unregisterBroker: unregisterDesktopBrowserBroker,
    readSettings: readDesktopBrowserSettings,
    isRunActive: isDesktopBrowserRunActive,
    sweepIntervalMs: 5_000,
    onWarning: (message, error) => console.warn(`[rudder-desktop] ${message}`, error),
  });
  const sourceRegistry = createBrowserImportSourceRegistry();
  browserCookieImporter = createBrowserCookieImporter({
    sourceRegistry,
    cookies: {
      get: () => browserSession.cookies.get({}),
      set: (details) => browserSession.cookies.set(details),
      flushStore: () => browserSession.cookies.flushStore(),
    },
    runWorker: (source, signal) => runBrowserCookieImportWorker(source, { ownerId: importOwnerId, signal }),
    runExclusive: (operation) => controller.runExclusive(operation),
  });
}

function updateBootState(nextState: Partial<BootState> & Pick<BootState, "stage" | "message">): void {
  currentBootState = {
    ...currentBootState,
    ...nextState,
    capabilities: nextState.capabilities ?? currentBootState.capabilities,
    permissions: nextState.permissions ?? currentBootState.permissions,
    runtime: {
      ...currentBootState.runtime,
      ...nextState.runtime,
    },
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (currentMainWindowKind === "boot") {
      mainWindow.webContents.send("desktop:recovery-state", createBootScreenState());
    } else {
      mainWindow.webContents.send("desktop:boot-state", currentBootState);
    }
  }
  updateResidentShellMenu();
}

function refreshDesktopSystemPermissions(): DesktopSystemPermissions {
  const permissions = readCurrentDesktopSystemPermissions();
  currentBootState = {
    ...currentBootState,
    permissions,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (currentMainWindowKind === "boot") {
      mainWindow.webContents.send("desktop:recovery-state", createBootScreenState());
    } else {
      mainWindow.webContents.send("desktop:boot-state", currentBootState);
    }
  }
  return permissions;
}

function createBootScreenState(): BootScreenState {
  return {
    view: currentBootState.stage === "error" ? "failed" : "loading",
    stage: currentBootState.stage,
    ...(currentBootState.failure ? { failure: currentBootState.failure } : {}),
    runtime: {
      profile: currentBootState.runtime?.localEnv,
      instance: currentBootState.runtime?.instanceId,
      version: currentBootState.runtime?.version,
    },
    instanceRoot: currentBootState.paths?.instanceRoot,
  };
}

function resolveDesktopBrandIconDataUrl(): string | null {
  if (!desktopWindowIcon || desktopWindowIcon.isEmpty()) return null;
  return desktopWindowIcon.resize({ width: 128, height: 128 }).toDataURL();
}

function createCurrentRecoveryDiagnostic(): string {
  if (!currentBootState.failure) {
    throw new Error("No startup diagnostic is available.");
  }
  return createDesktopRecoveryDiagnostic({
    failure: currentBootState.failure,
    version: resolveRudderAppVersion(),
    platform: process.platform,
    arch: process.arch,
    profile: currentBootState.runtime?.localEnv,
    instance: currentBootState.runtime?.instanceId,
  });
}

function resolveBootScreenUrl(): string {
  const html = createBootScreenHtml(APP_NAME, resolveDesktopBrandIconDataUrl(), createBootScreenState());
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function resolveRendererRecoveryScreenUrl(reason: {
  title?: string;
  message?: string;
  detail?: string;
}): string {
  const html = createRendererRecoveryScreenHtml(APP_NAME, reason);
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function rememberAppUrl(targetUrl: string): void {
  if (!targetUrl.startsWith("http")) return;
  lastKnownAppUrl = targetUrl;
}

function fallbackAppUrl(): string | null {
  if (lastKnownAppUrl) return lastKnownAppUrl;
  const baseUrl = resolveDesktopAppBaseUrl();
  return baseUrl;
}

async function reloadAppWindow(): Promise<void> {
  const targetUrl = fallbackAppUrl();
  if (!targetUrl) {
    await restartFromResidentControls();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    await openAppWindow(targetUrl);
    return;
  }
  rendererRecoveryInFlight = false;
  rememberAppUrl(targetUrl);
  await mainWindow.loadURL(targetUrl);
  showMainWindow();
}

async function showRendererRecovery(reason: {
  title?: string;
  message?: string;
  detail?: string;
}): Promise<void> {
  if (isQuitting() || rendererRecoveryInFlight || !mainWindow || mainWindow.isDestroyed()) return;
  rendererRecoveryInFlight = true;
  console.error("[rudder-desktop] renderer recovery screen shown", reason);
  recordRendererRecoveryState(reason);
  await mainWindow.loadURL(resolveRendererRecoveryScreenUrl(reason));
  showMainWindow();
}

function recordRendererRecoveryState(reason: {
  message?: string;
  detail?: string;
}): void {
  updateBootState({
    stage: "renderer_error",
    message: reason.message ?? "Rudder hit a UI failure.",
    detail: reason.detail ?? "The desktop renderer stopped responding.",
  });
}

async function promptForUnresponsiveRenderer(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || isQuitting()) return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: APP_NAME,
    buttons: ["Reload UI", "Restart Rudder", "Wait"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: "Rudder is not responding.",
    detail: "The local runtime may still be running. Reload the UI first; restart Rudder if it stays stuck.",
  });
  if (result.response === 0) {
    await reloadAppWindow();
  } else if (result.response === 1) {
    await restartFromResidentControls();
  }
}

function installRendererRecoveryHandlers(window: BrowserWindow, initialUrl: string): void {
  const allowedOrigins = () => collectDesktopNavigationOrigins(
    initialUrl,
    resolveDesktopAppBaseUrl(),
    serverHandle?.apiUrl,
  );
  const handleBlockedNavigation = (targetUrl: string) => {
    if (isAllowedDesktopNavigation(targetUrl, allowedOrigins(), { allowInternalProtocols: false })) return false;

    const classification = classifyBlockedDesktopNavigation(targetUrl);
    if (classification === "browser_router") {
      routeDesktopWebLink(targetUrl, "link");
    } else if (classification === "external") {
      shell.openExternal(targetUrl).catch((error) => {
        console.warn(
          "[rudder-desktop] failed to open external navigation",
          sanitizeDesktopNavigationForLog(targetUrl),
          error,
        );
      });
    }
    return true;
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (handleBlockedNavigation(url)) return { action: "deny" };

    window.loadURL(url).catch((error) => {
      console.warn(
        "[rudder-desktop] failed to load same-origin navigation",
        sanitizeDesktopNavigationForLog(url),
        error,
      );
    });
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (handleBlockedNavigation(targetUrl)) {
      event.preventDefault();
    }
  });

  window.webContents.on("will-redirect", (event, targetUrl) => {
    if (handleBlockedNavigation(targetUrl)) {
      event.preventDefault();
    }
  });

  window.webContents.on("did-navigate", (_event, targetUrl) => {
    if (isAllowedDesktopNavigation(targetUrl, allowedOrigins())) {
      rememberAppUrl(targetUrl);
    }
    rendererRecoveryInFlight = false;
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || validatedURL.startsWith("data:")) return;
    void showRendererRecovery({
      title: "Load failed",
      message: "Rudder could not load the UI.",
      detail: `${errorDescription || "Unknown load error"} (${errorCode})`,
    });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    void showRendererRecovery({
      title: "Renderer exited",
      message: "Rudder's UI process exited unexpectedly.",
      detail: `${details.reason}${typeof details.exitCode === "number" ? ` (${details.exitCode})` : ""}`,
    });
  });

  window.on("unresponsive", () => {
    void promptForUnresponsiveRenderer();
  });
}

function handleSidePanelCloseShortcutInput(webContents: WebContents, event: Electron.Event, input: Electron.Input): void {
  const route = resolveProtectedDesktopShortcutRoute(input, {
    sidePanelCloseActive: sidePanelCloseShortcutActive,
    browserSurfaceActive: browserSurfaceShortcutActive
      && Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents),
    operatorBrowserGuest: operatorBrowserShortcutWebContents.has(webContents),
  });
  if (!route) return;
  event.preventDefault();
  if (route.kind === "close_side_panel_tab") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:close-side-panel-active-tab");
      return;
    }
    webContents.send("desktop:close-side-panel-active-tab");
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:browser-shortcut", route.action);
  }
}

function installSidePanelCloseShortcutHandler(webContents: WebContents): void {
  if (sidePanelCloseShortcutWebContents.has(webContents)) return;
  sidePanelCloseShortcutWebContents.add(webContents);
  webContents.on("before-input-event", (event, input) => {
    handleSidePanelCloseShortcutInput(webContents, event, input);
  });
}

function installMainWindowSidePanelCloseShortcutHandler(window: BrowserWindow): void {
  installSidePanelCloseShortcutHandler(window.webContents);
  window.webContents.on("did-start-navigation", (_event, _targetUrl, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    sidePanelCloseShortcutActive = false;
    browserSurfaceShortcutActive = false;
  });
}

async function createDesktopWindow(initialUrl: string, kind: "app" | "boot"): Promise<BrowserWindow> {
  const preloadPath = path.resolve(MODULE_DIR, kind === "boot" ? "boot-preload.js" : "preload.js");
  const macWindowEffects = process.platform === "darwin"
    ? resolveMacWindowEffects()
    : {
        backgroundColor: resolveDesktopWindowBackgroundColor(),
      };
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: process.platform !== "darwin",
    ...macWindowEffects,
    ...(desktopWindowIcon ? { icon: desktopWindowIcon } : {}),
    webPreferences: kind === "boot"
      ? createBootWebPreferences(preloadPath)
      : createDesktopWebPreferences(preloadPath),
  });

  if (process.platform !== "darwin") {
    window.setMenuBarVisibility(false);
  }

  if (kind === "app") {
    const browserProfile = requireBrowserProfileController();
    installBrowserWebviewPolicy(window.webContents, {
      partition: browserProfile.getPartition(),
      getControlPlaneOrigins: () => collectBrowserControlPlaneOrigins(initialUrl),
      isBrowserAvailable: () => browserProfile.isOperatorAvailable(),
      registerGuest: (guest) => {
        browserGuestRegistry.register(guest);
        operatorBrowserShortcutWebContents.add(guest as WebContents);
      },
      openBrowserPopup: (url) => routeDesktopWebLink(url, "browser_popup"),
    });
  }

  window.on("close", (event) => {
    if (!shouldHideToResidentShell() || isQuitRequested() || isQuitting()) return;
    event.preventDefault();
    hideMainWindowToResident();
  });

  window.on("show", () => {
    applyDesktopAppearance(currentAppearance);
    if (shouldHideDockForResidentShell() && app.dock) {
      app.dock.show();
    }
    updateResidentShellMenu();
  });

  window.on("hide", () => {
    updateResidentShellMenu();
  });

  try {
    await window.loadURL(initialUrl);
  } catch (error) {
    if (kind === "boot") {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    const reason = {
      title: "Load failed",
      message: "Rudder could not load the UI.",
      detail: "The initial Rudder page could not be loaded. Reload the UI or restart Rudder.",
    };
    console.error("[rudder-desktop] initial renderer load failed; showing recovery", error);
    recordRendererRecoveryState(reason);
    await window.loadURL(resolveRendererRecoveryScreenUrl(reason));
  }

  installRendererRecoveryHandlers(window, initialUrl);
  if (kind === "app") installMainWindowSidePanelCloseShortcutHandler(window);
  return window;
}

async function replaceMainWindow(nextWindow: BrowserWindow, kind: "app" | "boot"): Promise<void> {
  const previousWindow = mainWindow;
  if (previousWindow && !previousWindow.isDestroyed()) {
    previousWindow.hide();
  }

  mainWindow = nextWindow;
  currentMainRenderer = nextWindow.webContents;
  currentMainWindowKind = kind;
  mainWindow.setTitle(APP_NAME);
  mainWindow.show();

  if (previousWindow && previousWindow !== nextWindow && !previousWindow.isDestroyed()) {
    previousWindow.destroy();
  }
}

async function openBootWindow(): Promise<void> {
  await replaceMainWindow(await createDesktopWindow(resolveBootScreenUrl(), "boot"), "boot");
}

async function openAppWindow(loadUrl: string): Promise<void> {
  rememberAppUrl(loadUrl);
  await replaceMainWindow(await createDesktopWindow(loadUrl, "app"), "app");
}

function schedulePostUpdateRendererReloadIfNeeded(): void {
  const marker = consumePostUpdateReloadMarker(app.getPath("userData"));
  if (!marker) return;
  latestPostUpdateReloadMarker = marker;

  const delayMs = resolvePostUpdateReloadDelayMs();
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl.startsWith("http")) return;
    console.info("[rudder-desktop] reloading renderer after Desktop update", {
      updateId: marker.updateId,
      targetVersion: marker.targetVersion,
      delayMs,
    });
    mainWindow.webContents.reloadIgnoringCache();
  }, delayMs);
}

function normalizeDesktopNavigationPath(targetPath: string): string {
  const trimmed = targetPath.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveDesktopAppBaseUrl(): string | null {
  const bootUrl = currentBootState.runtime?.apiUrl?.trim();
  if (bootUrl) return bootUrl.replace(/\/$/, "");

  const apiUrl = serverHandle?.apiUrl?.trim();
  if (apiUrl) return apiUrl.replace(/\/api\/?$/, "").replace(/\/$/, "");

  return null;
}

function resolveDesktopRouteUrl(targetPath: string): string | null {
  const baseUrl = resolveDesktopAppBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl}${normalizeDesktopNavigationPath(targetPath)}`;
}

async function navigateExistingAppWindowToRoute(targetPath: string, targetUrl: string): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const currentUrl = mainWindow.webContents.getURL();
  if (!currentUrl.startsWith("http")) return false;

  try {
    if (new URL(currentUrl).origin !== new URL(targetUrl).origin) return false;
  } catch {
    return false;
  }

  try {
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        const targetPath = ${JSON.stringify(targetPath)};
        const overlayStateKey = "settingsOverlayBackgroundPath";
        const overlayStorageKey = "rudder.settingsOverlayBackgroundPath";
        const currentPath = window.location.pathname + window.location.search + window.location.hash;
        const currentIsSettings = currentPath.startsWith("/instance/settings")
          || currentPath.includes("/organization/settings");
        const state = currentIsSettings
          ? (window.history.state || {})
          : { ...(window.history.state || {}), [overlayStateKey]: currentPath };
        if (!currentIsSettings) {
          window.sessionStorage.setItem(overlayStorageKey, currentPath);
        }
        window.history.pushState(state, "", targetPath);
        window.dispatchEvent(new PopStateEvent("popstate", { state }));
      })();
    `);
    return true;
  } catch (error) {
    console.warn("[rudder-desktop] failed to navigate existing app window", error);
    return false;
  }
}

async function openDesktopRoute(targetPath: string): Promise<void> {
  const normalizedPath = normalizeDesktopNavigationPath(targetPath);
  const targetUrl = resolveDesktopRouteUrl(normalizedPath);

  if (!targetUrl) {
    pendingDesktopNavigationPath = normalizedPath;
    showMainWindow();
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    await openAppWindow(targetUrl);
    return;
  }

  showMainWindow();
  rememberAppUrl(targetUrl);
  if (mainWindow.webContents.getURL() !== targetUrl && !(await navigateExistingAppWindowToRoute(normalizedPath, targetUrl))) {
    await mainWindow.loadURL(targetUrl);
  }
  showMainWindow();
}

function installApplicationMenu(appName: string): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  const menu = Menu.getApplicationMenu();
  const appMenu = menu?.items[0]?.submenu;
  if (!menu || !appMenu || appMenu.getMenuItemById("rudder-settings")) return;

  const aboutIndex = appMenu.items.findIndex((item) => item.label === `About ${appName}`);
  let insertIndex = aboutIndex >= 0 ? aboutIndex + 1 : 0;

  if (appMenu.items[insertIndex]?.type === "separator") {
    insertIndex += 1;
  } else {
    appMenu.insert(insertIndex, new MenuItem({ type: "separator" }));
    insertIndex += 1;
  }

  appMenu.insert(insertIndex, new MenuItem({
    id: "rudder-settings",
    label: "Settings...",
    accelerator: "Command+,",
    click: () => {
      void openDesktopRoute(INSTANCE_SETTINGS_GENERAL_PATH);
    },
  }));
  appMenu.insert(insertIndex + 1, new MenuItem({
    id: "rudder-check-for-updates",
    label: "Check for Updates...",
    click: () => {
      void showManualUpdateCheckDialog();
    },
  }));

  if (appMenu.items[insertIndex + 2]?.type !== "separator") {
    appMenu.insert(insertIndex + 2, new MenuItem({ type: "separator" }));
  }

  Menu.setApplicationMenu(menu);
}

function currentResidentShellStatus(): ResidentShellStatus {
  return {
    enabled: residentShellEnabled,
    controlsAvailable: residentControlsAvailable,
  };
}

function shouldHideToResidentShell(): boolean {
  const status = currentResidentShellStatus();
  return status.enabled && status.controlsAvailable;
}

function runtimeStatusLabel(): string {
  const profile = currentBootState.runtime?.localEnv ?? initialProfile.name;
  const mode = currentBootState.runtime?.mode;
  const ownerKind = currentBootState.runtime?.ownerKind;
  const stage = currentBootState.stage;
  if (mode === "owned") return `${profile} • owned`;
  if (mode === "attached") return `${profile} • attached to ${ownerKind ?? "local"}`;
  if (stage === "error") return `${profile} • startup failed`;
  return `${profile} • ${stage}`;
}

function updateResidentShellMenu(): void {
  if (!residentTray) return;
  const windowVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  residentTray.setToolTip(`${APP_NAME}\n${runtimeStatusLabel()}`);
  const menu = Menu.buildFromTemplate([
    {
      label: windowVisible ? `Hide ${APP_NAME}` : `Show ${APP_NAME}`,
      click: () => {
        if (windowVisible) {
          hideMainWindowToResident();
        } else {
          showMainWindow();
        }
      },
    },
    {
      label: `Runtime: ${runtimeStatusLabel()}`,
      enabled: false,
    },
    {
      label: "Restart local runtime",
      click: () => {
        void restartFromResidentControls();
      },
    },
    { type: "separator" },
    {
      label: `Quit ${APP_NAME}`,
      click: () => {
        requestQuit();
      },
    },
  ]);
  residentTray.setContextMenu(menu);
}

function createResidentShellControls(): void {
  if (!platformSupportsResidentShellControls()) return;
  try {
    const trayIcon = createResidentTrayIcon();
    residentTray = new Tray(trayIcon);
    residentTray.on("click", () => {
      showMainWindow();
    });
    residentControlsAvailable = true;
    console.info("[rudder-desktop] Resident shell controls active", {
      packaged: app.isPackaged,
      platform: process.platform,
      profile: currentBootState.runtime?.localEnv ?? initialProfile.name,
      iconSource: typeof trayIcon === "string" ? path.basename(trayIcon) : "generated",
    });
    updateResidentShellMenu();
  } catch (error) {
    residentTray = null;
    residentControlsAvailable = false;
    console.warn("[rudder-desktop] Resident shell controls unavailable, falling back to windowed lifecycle", error);
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (shouldHideDockForResidentShell() && app.dock) {
    app.dock.show();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  updateResidentShellMenu();
}

function hideMainWindowToResident(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (shouldHideDockForResidentShell() && app.dock) {
    app.dock.hide();
  }
  updateResidentShellMenu();
}

async function restartFromResidentControls(): Promise<void> {
  if (restartInFlight) return restartInFlight;
  restartInFlight = (async () => {
    showMainWindow();
    await openBootWindow();
    await startLocalRudder();
  })().finally(() => {
    restartInFlight = null;
  });
  return restartInFlight;
}

async function retryStartupFromBootScreen(): Promise<void> {
  if (restartInFlight) return restartInFlight;
  restartInFlight = (async () => {
    if (startInFlight) await startInFlight;
    updateBootState({
      stage: "starting",
      message: "Resolving shared local Rudder instance…",
      detail: "Preparing the embedded database and board UI.",
      error: undefined,
      failure: undefined,
    });
    await startLocalRudder();
  })().finally(() => {
    restartInFlight = null;
  });
  return restartInFlight;
}

function requestQuit(): void {
  void beginQuitFlow();
}

function serverRuntimeOptions(): StartServerOptions {
  return {
    printBanner: false,
    openOnListen: false,
    runtimeOverrides: {
      host: "127.0.0.1",
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      serveUi: true,
      uiDevMiddleware: false,
    },
    onEvent: (event) => {
      updateBootState({
        stage: event.stage,
        message: event.message,
        detail: event.stage === "database"
          ? "Preparing the embedded database."
          : event.stage === "app"
            ? "Booting the shared board UI and API."
            : event.stage === "listening"
              ? "Opening the shared local board."
              : event.stage === "shutdown"
                ? "Stopping the owned local runtime."
                : "Preparing the embedded database and board UI.",
      });
    },
  };
}

async function startLocalRudder(): Promise<void> {
  if (startInFlight) return startInFlight;
  startInFlight = (async () => {
    startupAttemptCount += 1;
    const attempt = startupAttemptCount;
    const profile = resolveDesktopLocalEnvProfile();
    const sharedPaths = resolveSharedInstancePaths(profile.instanceId);

    updateBootState({
      stage: "starting",
      message: "Resolving shared local Rudder instance…",
      detail: `Target profile: ${profile.name}`,
      error: undefined,
      failure: undefined,
      paths: sharedPaths,
      runtime: {
        localEnv: profile.name,
        instanceId: profile.instanceId,
        mode: undefined,
        ownerKind: undefined,
        version: undefined,
        apiUrl: undefined,
      },
    });

    try {
      await stopLocalRudder();
      const serverModule = await importServerModule();
      updateBootState({
        stage: "config",
        message: "Checking for an existing shared runtime…",
        detail: `Desktop will attach to ${profile.name} when possible, or start it if needed.`,
      });
      serverHandle = await serverModule.startManagedLocalServer({
        ownerKind: "desktop",
        takeoverOnVersionMismatch: true,
        ...serverRuntimeOptions(),
      });
      try {
        await requireBrowserRuntimeLifecycle().connect(serverHandle.apiUrl);
      } catch (error) {
        console.warn("[rudder-desktop] Browser Broker unavailable; continuing without Agent Browser control", error);
      }
      const baseUrl = serverHandle.apiUrl.replace(/\/api$/, "");
      const runtimeLabel = serverHandle.runtime.mode === "attached"
        ? `Attached to ${serverHandle.runtime.ownerKind ?? "local"} runtime`
        : "Desktop owns this local runtime";
      updateBootState({
        stage: "ready",
        message: "Rudder is ready.",
        detail: `${runtimeLabel} at ${baseUrl}`,
        paths: serverHandle.instancePaths,
        runtime: {
          localEnv: serverHandle.runtime.localEnv,
          instanceId: serverHandle.runtime.instanceId,
          mode: serverHandle.runtime.mode,
          ownerKind: serverHandle.runtime.ownerKind,
          version: serverHandle.runtime.version,
          apiUrl: baseUrl,
        },
      });
      if (desktopSkipAppLoad()) {
        if (desktopDebugEnabled()) {
          console.info("[rudder-desktop] startLocalRudder:skip-app-load", { baseUrl });
        }
        return;
      }
      const requestedPath = pendingDesktopNavigationPath;
      pendingDesktopNavigationPath = null;
      const defaultLoadUrl = requestedPath ? `${baseUrl}${requestedPath}` : baseUrl;
      const loadUrl = requestedPath ? defaultLoadUrl : resolveDesktopLoadUrl(defaultLoadUrl);
      if (desktopDebugEnabled()) {
        console.info("[rudder-desktop] startLocalRudder:load-url", {
          loadUrl,
          transport: "fresh-window",
        });
      }
      await openAppWindow(loadUrl);
      schedulePostUpdateRendererReloadIfNeeded();
      await captureDesktopWindowIfRequested();
    } catch (error) {
      console.error("[rudder-desktop] managed local server startup failed", error);
      const failure = createDesktopStartupFailureView({
        error,
        stage: currentBootState.stage,
        attempt,
      });
      updateBootState({
        stage: "error",
        message: "Rudder failed to start.",
        detail: "The shared local instance did not come up cleanly.",
        error: failure.summary,
        failure,
        paths: serverHandle?.instancePaths ?? currentBootState.paths,
      });
    } finally {
      startInFlight = null;
    }
  })();
  return startInFlight;
}

async function importServerModule(): Promise<ServerModule> {
  if (app.isPackaged) {
    const packagedCliEntry = path.resolve(process.resourcesPath, "server-package", "desktop-cli.js");
    if (fs.existsSync(packagedCliEntry)) {
      process.env.RUDDER_DESKTOP_CLI_ENTRY = packagedCliEntry;
    }

    const externalRuntime = resolveExternalRuntimeServerEntrypoint({
      version: app.getVersion(),
      onWarning: (message, error) => console.warn(`[rudder-desktop] ${message}`, error),
    });
    if (externalRuntime) {
      const previousPostgresBinDir = process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
      const hasExplicitPostgresBinDir = Boolean(previousPostgresBinDir?.trim());
      const postgresBinDir = hasExplicitPostgresBinDir ? null : resolveDesktopPostgresBinDir(externalRuntime.cacheDir);
      if (postgresBinDir) process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = postgresBinDir;
      console.info("[rudder-desktop] loading server runtime from shared cache", {
        entrypoint: externalRuntime.entrypoint,
      });
      try {
        const mod = await import(pathToFileURL(externalRuntime.entrypoint).href) as ServerModule;
        externalServerRuntimeCacheDir = externalRuntime.cacheDir;
        return mod;
      } catch (error) {
        if (previousPostgresBinDir === undefined) {
          delete process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
        } else {
          process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = previousPostgresBinDir;
        }
        externalServerRuntimeCacheDir = null;
        console.warn("[rudder-desktop] failed to load shared server runtime cache, falling back to bundled runtime", error);
      }
    }

    const packagedServerEntry = path.resolve(
      process.resourcesPath,
      "server-package",
      "dist",
      "index.js",
    );
    if (!fs.existsSync(packagedServerEntry)) {
      throw new Error(
        "This Rudder Desktop shell install requires a prepared server runtime cache. Re-run `rudder start` to install the matching runtime, or install the full portable Desktop asset.",
      );
    }
    return import(pathToFileURL(packagedServerEntry).href) as Promise<ServerModule>;
  }

  const { tsImport } = await import("tsx/esm/api");
  const repoServerEntry = path.resolve(MODULE_DIR, "../../server/src/index.ts");
  return tsImport(pathToFileURL(repoServerEntry).href, import.meta.url) as Promise<ServerModule>;
}

async function importCliModule(): Promise<CliModule> {
  if (app.isPackaged) {
    const packagedCliEntry = path.resolve(process.resourcesPath, "server-package", "desktop-cli.js");
    return import(pathToFileURL(packagedCliEntry).href) as Promise<CliModule>;
  }

  const { tsImport } = await import("tsx/esm/api");
  const repoCliEntry = path.resolve(MODULE_DIR, "../../cli/src/program.ts");
  return tsImport(pathToFileURL(repoCliEntry).href, import.meta.url) as Promise<CliModule>;
}

async function stopLocalRudder(): Promise<void> {
  await browserRuntimeLifecycle?.disconnect();
  if (!serverHandle) return;
  const handle = serverHandle;
  serverHandle = null;
  await handle.stop();
}

function desktopWorkspaceFileAllowedRoots() {
  const instanceId = process.env.RUDDER_INSTANCE_ID?.trim() || initialProfile.instanceId;
  return resolveDesktopOrganizationWorkspaceAllowedRoots(process.env, instanceId);
}

async function openDesktopSupportDraft(): Promise<void> {
  const url = createFeedbackMailtoUrl();
  const smokeRecordPath = process.env.RUDDER_DESKTOP_SMOKE_SUPPORT_HANDOFF_PATH?.trim();
  if (!smokeRecordPath) {
    await shell.openExternal(url);
    return;
  }

  supportDraftHandoffAttemptCount += 1;
  const attempt = supportDraftHandoffAttemptCount;
  fs.appendFileSync(
    path.resolve(smokeRecordPath),
    `${JSON.stringify({ attempt, url })}\n`,
    "utf8",
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  const outcomes = (process.env.RUDDER_DESKTOP_SMOKE_SUPPORT_HANDOFF_SEQUENCE ?? "resolve")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  if (outcomes[attempt - 1] === "reject") {
    throw new Error("Simulated support draft handoff rejection.");
  }
}

async function openDesktopBugReport(): Promise<void> {
  const smokeRecordPath = process.env.RUDDER_DESKTOP_SMOKE_BUG_REPORT_HANDOFF_PATH?.trim();
  if (!smokeRecordPath) {
    await shell.openExternal(DESKTOP_BUG_REPORT_URL);
    return;
  }

  bugReportHandoffAttemptCount += 1;
  const attempt = bugReportHandoffAttemptCount;
  fs.appendFileSync(
    path.resolve(smokeRecordPath),
    `${JSON.stringify({ attempt, url: DESKTOP_BUG_REPORT_URL })}\n`,
    "utf8",
  );
  const delayValues = (process.env.RUDDER_DESKTOP_SMOKE_BUG_REPORT_HANDOFF_DELAY_SEQUENCE ?? "80")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10));
  const delayMs = Math.min(5_000, Math.max(0, delayValues[attempt - 1] ?? 80));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const outcomes = (process.env.RUDDER_DESKTOP_SMOKE_BUG_REPORT_HANDOFF_SEQUENCE ?? "resolve")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  if (outcomes[attempt - 1] === "reject") {
    throw new Error("Simulated bug report handoff rejection.");
  }
}

function registerIpc(): void {
  registerBrowserIpcHandlers(ipcMain, {
    getMainRenderer: getCurrentMainRenderer,
    controller: requireBrowserProfileController(),
    importer: requireBrowserCookieImporter(),
  });
  ipcMain.handle("desktop:get-boot-state", async (event) => {
    assertCurrentMainFrame(event, "Desktop boot state");
    refreshDesktopSystemPermissions();
    return currentBootState;
  });
  ipcMain.handle("desktop:get-recovery-state", async (event) => {
    assertStartupRecoveryFrame(event, "Desktop recovery state");
    return createBootScreenState();
  });
  ipcMain.handle("desktop:retry-startup", async (event) => {
    assertStartupRecoveryFrame(event, "Desktop startup retry");
    if (currentBootState.stage !== "error") {
      throw new Error("Desktop startup retry is available only after startup fails.");
    }
    await retryStartupFromBootScreen();
  });
  ipcMain.handle("desktop:copy-support-email", async (event) => {
    assertStartupRecoveryFrame(event, "Support email copy");
    clipboard.writeText(DESKTOP_FEEDBACK_EMAIL);
  });
  ipcMain.handle("desktop:open-bug-report", async (event) => {
    assertStartupRecoveryFrame(event, "GitHub bug report");
    if (currentBootState.stage !== "error") {
      throw new Error("Bug reporting is available only after startup fails.");
    }
    const failureId = currentBootState.failure?.id;
    if (!failureId) throw new Error("No failed startup report context is available.");
    if (bugReportInFlight?.failureId === failureId) return bugReportInFlight.promise;
    const promise = openDesktopBugReport().finally(() => {
      if (bugReportInFlight?.promise === promise) bugReportInFlight = null;
    });
    bugReportInFlight = { failureId, promise };
    return promise;
  });
  ipcMain.handle("desktop:copy-bug-report-url", async (event) => {
    assertStartupRecoveryFrame(event, "GitHub bug report link copy");
    if (currentBootState.stage !== "error") {
      throw new Error("Bug reporting is available only after startup fails.");
    }
    clipboard.writeText(DESKTOP_BUG_REPORT_URL);
  });
  ipcMain.handle("desktop:copy-recovery-diagnostic", async (event) => {
    assertStartupRecoveryFrame(event, "Recovery diagnostic copy");
    if (currentBootState.stage !== "error") {
      throw new Error("No failed startup diagnostic is available.");
    }
    clipboard.writeText(createCurrentRecoveryDiagnostic());
  });
  ipcMain.handle("desktop:open-recovery-instance-folder", async (event) => {
    assertStartupRecoveryFrame(event, "Recovery instance folder");
    if (currentBootState.stage !== "error" || !currentBootState.paths?.instanceRoot) {
      throw new Error("No failed startup instance folder is available.");
    }
    const openError = await shell.openPath(currentBootState.paths.instanceRoot);
    if (openError) throw new Error(openError);
  });
  ipcMain.handle("desktop:get-system-permissions", async () => refreshDesktopSystemPermissions());
  ipcMain.handle("desktop:get-app-version", async () => resolveRudderAppVersion());
  ipcMain.handle("desktop:get-release-notes", async (): Promise<DesktopReleaseNotesResult> => {
    const version = resolveRudderAppVersion();
    const statePath = resolveReleaseNotesStatePath(app.getPath("userData"));
    const updatedAfterInstall = latestPostUpdateReloadMarker?.targetVersion === version;
    if (!shouldShowReleaseNotes({ statePath, version, updatedAfterInstall })) {
      return { status: "already-shown" };
    }
    const notes = readReleaseNotes({
      version,
      releaseNotesPath: resolveReleaseNotesPath({
        moduleDir: MODULE_DIR,
        packaged: app.isPackaged,
        version,
      }),
    });
    return notes ? { status: "available", notes } : { status: "unavailable" };
  });
  ipcMain.handle("desktop:mark-release-notes-shown", async (_event, version: string) => {
    markReleaseNotesShown({
      version,
      statePath: resolveReleaseNotesStatePath(app.getPath("userData")),
    });
  });
  ipcMain.handle("desktop:open-path", async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });
  ipcMain.handle("desktop:preview-local-file", async (event, targetPath: string) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error("Local file preview is only available to the main Rudder window.");
    }
    return await previewLocalFile(targetPath);
  });
  ipcMain.handle("desktop:list-available-ides", async (): Promise<DesktopIdeTarget[]> => {
    return await listAvailableIdeTargets();
  });
  ipcMain.handle("desktop:list-workspace-launch-targets", async (): Promise<DesktopWorkspaceLaunchTargetPayload[]> => {
    const targets = await listWorkspaceLaunchTargets();
    return await Promise.all(targets.map(toWorkspaceLaunchTargetPayload));
  });
  ipcMain.handle(
    "desktop:open-workspace",
    async (_event, payload: { rootPath: string; targetId?: DesktopWorkspaceLaunchTargetId }) => {
      await openWorkspace(payload.rootPath, payload.targetId);
    },
  );
  ipcMain.handle(
    "desktop:open-workspace-file-in-ide",
    async (_event, payload: { rootPath: string; filePath: string; ideId?: DesktopFileLaunchTargetId }) => {
      await openWorkspaceFileInIde(payload.rootPath, payload.filePath, payload.ideId, {
        allowedRootPaths: desktopWorkspaceFileAllowedRoots(),
      });
    },
  );
  ipcMain.handle(
    "desktop:open-workspace-file-location",
    async (_event, payload: { rootPath: string; filePath: string; targetId: DesktopWorkspaceLaunchTargetId }) => {
      await openWorkspaceFileLocation(payload.rootPath, payload.filePath, payload.targetId, {
        allowedRootPaths: desktopWorkspaceFileAllowedRoots(),
        revealFile: async (absolutePath) => shell.showItemInFolder(absolutePath),
      });
    },
  );
  ipcMain.handle("desktop:copy-text", async (_event, value: string) => {
    clipboard.writeText(value);
  });
  ipcMain.handle("desktop:copy-image", async (_event, rawPayload: unknown) => {
    const payload = parseDesktopImageDataPayload(rawPayload);
    const image = nativeImage.createFromBuffer(imageBufferFromPayload(payload));
    if (image.isEmpty()) {
      throw new Error("Unable to copy this image.");
    }
    clipboard.writeImage(image);
  });
  ipcMain.handle("desktop:show-image-in-folder", async (_event, rawPayload: unknown) => {
    const payload = parseDesktopImageDataPayload(rawPayload);
    const directoryPath = path.join(app.getPath("temp"), "rudder-chat-images");
    const filename = sanitizeDesktopImageFilename(payload.filename, payload.contentType);
    const targetPath = path.join(directoryPath, `${Date.now()}-${randomUUID()}-${filename}`);

    await fs.promises.mkdir(directoryPath, { recursive: true });
    await fs.promises.writeFile(targetPath, imageBufferFromPayload(payload));
    shell.showItemInFolder(targetPath);
  });
  ipcMain.handle("desktop:set-appearance", async (_event, preference: DesktopThemePreference) => {
    applyDesktopThemePreference(preference);
  });
  ipcMain.handle("desktop:get-update-channel", async () => getDesktopUpdateChannel());
  ipcMain.handle("desktop:set-update-channel", async (_event, channel: DesktopUpdateChannel) =>
    setDesktopUpdateChannel(channel),
  );
  ipcMain.handle("desktop:reload-app", async () => {
    await reloadAppWindow();
  });
  ipcMain.handle("desktop:restart", async (event) => {
    assertCurrentMainFrame(event, "Desktop restart");
    await restartFromResidentControls();
  });
  ipcMain.handle("desktop:check-for-updates", async () => checkForUpdates());
  ipcMain.handle("desktop:install-update", async (_event, version: string) => installUpdate(version));
  ipcMain.handle("desktop:apply-update", async (_event, updateId: string, options?: { force?: boolean }) =>
    applyUpdate(updateId, { force: options?.force === true }));
  ipcMain.handle("desktop:get-update-progress", async () => getDesktopUpdateProgress());
  ipcMain.handle("desktop:set-deferred-update-prompt-ready", async (event, ready: boolean) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    deferredUpdatePromptRendererReady = Boolean(ready);
  });
  ipcMain.handle("desktop:set-side-panel-close-shortcut-active", async (event, active: boolean) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    sidePanelCloseShortcutActive = Boolean(active);
  });
  ipcMain.handle("desktop:set-browser-surface-shortcut-active", async (event, active: boolean) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    browserSurfaceShortcutActive = Boolean(active);
  });
  ipcMain.handle("desktop:respond-deferred-update-prompt", async (event, payload: {
    promptId?: string;
    decision?: DeferredUpdatePromptDecision;
  }) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const promptId = payload.promptId?.trim();
    if (!promptId) return;
    const pending = pendingDeferredUpdatePrompts.get(promptId);
    if (!pending) return;
    pendingDeferredUpdatePrompts.delete(promptId);
    clearTimeout(pending.timeout);
    pending.resolve(payload.decision === "wait" || payload.decision === "force" ? payload.decision : "cancel");
  });
  ipcMain.handle("desktop:send-feedback", async (event) => {
    assertCurrentMainFrame(event, "Feedback draft");
    if (currentMainWindowKind === "boot" && currentBootState.stage !== "error") {
      throw new Error("Startup support is available only after startup fails.");
    }
    if (currentMainWindowKind === "boot" && !currentBootState.failure?.id) {
      throw new Error("No failed startup support context is available.");
    }
    const contextId = currentMainWindowKind === "boot"
      ? `boot:${currentBootState.failure?.id}`
      : "app";
    if (supportDraftInFlight?.contextId === contextId) return supportDraftInFlight.promise;
    const promise = openDesktopSupportDraft().finally(() => {
      if (supportDraftInFlight?.promise === promise) supportDraftInFlight = null;
    });
    supportDraftInFlight = { contextId, promise };
    return promise;
  });
  ipcMain.handle("desktop:open-external", async (event, target: string) => {
    if (event.sender !== getCurrentMainRenderer()) {
      throw new Error("External navigation is available only to the current Rudder renderer.");
    }
    if (classifyBlockedDesktopNavigation(target) === "browser_router") {
      routeDesktopWebLink(target, "link");
      return;
    }
    if (classifyBlockedDesktopNavigation(target) === "deny") {
      throw new Error("This URL protocol cannot be opened from Rudder.");
    }
    await shell.openExternal(target);
  });
  ipcMain.handle("desktop:force-open-external", async (event, target: string) => {
    if (event.sender !== getCurrentMainRenderer()) {
      throw new Error("External navigation is available only to the current Rudder renderer.");
    }
    if (!canOpenBlockedNavigationExternally(target)) {
      throw new Error("Only approved external URL protocols can be opened.");
    }
    await shell.openExternal(target);
  });
  ipcMain.handle("desktop:pick-path", async (event, options: DesktopPathPickOptions): Promise<DesktopPathPickResult> => {
    const kind = options.kind === "file" ? "file" : "directory";
    const properties: OpenDialogOptions["properties"] = kind === "directory"
      ? ["openDirectory", "createDirectory"]
      : ["openFile"];
    const dialogOptions: OpenDialogOptions = {
      title: options.title?.trim() || (kind === "directory" ? "Choose directory" : "Choose file"),
      buttonLabel: options.buttonLabel?.trim() || (kind === "directory" ? "Choose directory" : "Choose file"),
      defaultPath: options.defaultPath?.trim() || undefined,
      properties,
    };
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return {
      canceled: result.canceled,
      path: result.filePaths[0] ?? null,
    };
  });
  ipcMain.handle("desktop:open-notification-settings", async (): Promise<OpenNotificationSettingsResult> => {
    if (process.platform === "darwin") {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.notifications");
      return { opened: true, platform: process.platform };
    }
    if (process.platform === "win32") {
      await shell.openExternal("ms-settings:notifications");
      return { opened: true, platform: process.platform };
    }
    return { opened: false, platform: process.platform };
  });
  ipcMain.handle("desktop:set-badge-count", async (_event, count: number) => {
    const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const badgeSyncResult = app.setBadgeCount(normalized);
    updateBootState({
      stage: currentBootState.stage,
      message: currentBootState.message,
      diagnostics: {
        ...currentBootState.diagnostics,
        lastBadgeCount: normalized,
        badgeSyncSucceeded: badgeSyncResult !== false,
        lastBadgeSyncAt: new Date().toISOString(),
      },
    });
  });
  ipcMain.handle("desktop:show-notification", async (_event, payload: { title?: string; body?: string }) => {
    const title = payload.title?.trim();
    if (!title || !Notification.isSupported()) return;
    const body = payload.body?.trim() || undefined;
    const notification = new Notification({
      title,
      body,
      silent: false,
      ...(desktopWindowIcon ? { icon: desktopWindowIcon } : {}),
    });
    updateBootState({
      stage: currentBootState.stage,
      message: currentBootState.message,
      diagnostics: {
        ...currentBootState.diagnostics,
        lastNotificationTitle: title,
        lastNotificationBody: body,
        lastNotificationTriggeredAt: new Date().toISOString(),
      },
    });
    notification.show();
  });
}

nativeTheme.on("updated", () => {
  refreshDesktopAppearanceFromSystem();
});

function desktopDebugEnabled(): boolean {
  return normalizeBooleanEnvFlag(process.env.RUDDER_DESKTOP_DEBUG_STARTUP) ?? false;
}

function desktopBootOnlyMode(): boolean {
  return normalizeBooleanEnvFlag(process.env.RUDDER_DESKTOP_BOOT_ONLY) ?? false;
}

function desktopSkipAppLoad(): boolean {
  return normalizeBooleanEnvFlag(process.env.RUDDER_DESKTOP_SKIP_APP_LOAD) ?? false;
}

function resolveDesktopLoadUrl(defaultUrl: string): string {
  const override = process.env.RUDDER_DESKTOP_LOAD_URL?.trim();
  return override && override.length > 0 ? override : defaultUrl;
}

async function captureDesktopWindowIfRequested(): Promise<void> {
  const targetPath = process.env.RUDDER_DESKTOP_CAPTURE_PATH?.trim();
  if (!targetPath || !mainWindow || mainWindow.isDestroyed()) return;

  const delayMs = Number.parseInt(process.env.RUDDER_DESKTOP_CAPTURE_DELAY_MS ?? "1200", 10);
  const resolvedDelayMs = Number.isFinite(delayMs) ? Math.max(delayMs, 0) : 1200;
  await new Promise((resolve) => setTimeout(resolve, resolvedDelayMs));

  if (!mainWindow || mainWindow.isDestroyed()) return;
  const image = await mainWindow.capturePage();
  fs.writeFileSync(path.resolve(targetPath), image.toPNG());
  console.info("[rudder-desktop] wrote window capture", path.resolve(targetPath));
}

async function bootstrap(): Promise<void> {
  const profile = applyDesktopEnvironment();
  const appName = applyDesktopAppIdentity(profile);
  const instancePaths = resolveSharedInstancePaths(profile.instanceId);
  const instanceRoot = instancePaths.instanceRoot
    ?? path.resolve(resolveSharedRudderHomeDir(), "instances", profile.instanceId);
  const browserImportOwnerId = deriveBrowserImportOwnerId(deriveBrowserPartition(instanceRoot));
  try {
    await cleanupStaleBrowserImportTempDirectories({ ownerId: browserImportOwnerId });
  } catch (error) {
    console.warn("[rudder-desktop] failed to clean stale Browser import data", error);
  }
  initializeBrowserProfile(instanceRoot);
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:start", {
      profile: profile.name,
      macWindowMode: process.platform === "darwin" ? resolveMacWindowMode() : "opaque",
      bootOnly: desktopBootOnlyMode(),
    });
  }
  desktopWindowIcon = applyDesktopRuntimeIcon(profile);
  /**
   * Finder/launcher-started packaged apps often inherit a stripped PATH that omits
   * login-shell-managed toolchains such as nvm, mise, or Homebrew shims. Refresh
   * PATH before starting the local runtime so local adapter commands keep working.
   */
  if (app.isPackaged && process.platform !== "win32") {
    try {
      const pathSync = await syncProcessPathFromLoginShell();
      if (pathSync.changed) {
        console.info("[rudder-desktop] synchronized PATH from login shell", {
          shellPath: pathSync.shellPath,
        });
      } else if (desktopDebugEnabled()) {
        console.info("[rudder-desktop] login shell PATH sync produced no changes", {
          shellPath: pathSync.shellPath,
        });
      }
    } catch (error) {
      console.warn("[rudder-desktop] failed to synchronize PATH from login shell", error);
    }
  }
  if (shouldInstallDesktopCliLink(app.isPackaged)) {
    try {
      const cliInstall = await ensureDesktopCliLink();
      if (cliInstall.status === "installed") {
        console.info("[rudder-desktop] installed CLI wrapper", cliInstall.targetPath);
      } else if (cliInstall.status === "skipped_temporary_install") {
        console.info("[rudder-desktop] CLI wrapper not installed:", cliInstall.detail);
      } else if (cliInstall.status === "skipped_existing_file" || cliInstall.status === "unavailable") {
        console.warn("[rudder-desktop] CLI wrapper not installed:", cliInstall.detail);
      }
      if (cliInstall.needsPathUpdate && cliInstall.targetPath) {
        console.warn("[rudder-desktop] CLI wrapper target is not currently on PATH:", cliInstall.targetPath);
      }
    } catch (error) {
      console.warn("[rudder-desktop] failed to ensure desktop CLI wrapper", error);
    }
  }
  currentBootState = {
    ...currentBootState,
    capabilities: desktopCapabilities,
    paths: instancePaths,
    runtime: {
      ...currentBootState.runtime,
      localEnv: profile.name,
      instanceId: profile.instanceId,
    },
  };
  registerIpc();
  installApplicationMenu(appName);
  createResidentShellControls();
  await openBootWindow();
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:window-created");
  }
  if (desktopBootOnlyMode()) {
    if (desktopDebugEnabled()) {
      console.info("[rudder-desktop] bootstrap:boot-only");
    }
    return;
  }
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:start-runtime");
  }
  await startLocalRudder();
  void maybeShowStartupUpdateNotice();
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:ready");
  }
}

const desktopCliArgv = resolveDesktopCliArgv(process.argv);
const updateQuitResponsePath = resolveUpdateQuitResponsePath(process.argv);

if (desktopCliArgv) {
  void runDesktopCliMode({
    argv: desktopCliArgv,
    importCliModule,
    exit: (exitCode) => app.exit(exitCode),
  });
} else {
  const singleInstanceLock = app.requestSingleInstanceLock();
  if (updateQuitResponsePath && singleInstanceLock) {
    writeUpdateQuitResponse(updateQuitResponsePath, { ok: true, status: "not_running" });
    app.exit(0);
  } else if (!singleInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      const responsePath = resolveUpdateQuitResponsePath(argv);
      if (responsePath) {
        void handleUpdateQuitRequest(responsePath, { force: resolveUpdateQuitForce(argv) });
        return;
      }
      showMainWindow();
    });

    app.on("activate", () => {
      showMainWindow();
    });

    app.on("browser-window-focus", () => {
      refreshDesktopSystemPermissions();
    });

    app.on("web-contents-created", (_event, contents) => {
      installDefaultWindowOpenDenyPolicy(contents);
      installSidePanelCloseShortcutHandler(contents);
    });

    app.on("window-all-closed", () => {
      if (shouldHideToResidentShell()) return;
      app.quit();
    });

    app.on("before-quit", (event) => {
      if (isQuitting()) return;
      event.preventDefault();
      void beginQuitFlow();
    });

    void app.whenReady().then(() => bootstrap()).catch((error) => {
      console.error("[rudder-desktop] Failed to bootstrap desktop app", error);
      app.exit(1);
    });
  }
}
