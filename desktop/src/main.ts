import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, OpenDialogOptions, Session, WebContents } from "electron";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MenuItem, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, screen, session, shell, systemPreferences, Tray } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDesktopApiRequestUrl } from "./api-url.js";
import { AppBuilderDataManager } from "./app-builder-data.js";
import {
  AppBuilderController,
  registerAppBuilderIpcHandlers,
} from "./app-builder-ipc.js";
import {
  APP_BUILDER_INHERITED_ENV_NAMES,
  createAppBuilderInheritedEnvironment,
} from "./app-builder-package-store.mjs";
import { AppBuilderPreviewController } from "./app-builder-preview.js";
import { resolveAppBuilderWorkspaceRoot } from "./app-builder-workspace.js";
import { shouldOverrideDesktopDockIcon } from "./app-icon.js";
import { resolveDesktopAppName } from "./app-identity.js";
import { createBootScreenHtml, createRendererRecoveryScreenHtml, deriveBootScreenState } from "./boot-screen.js";
import { resolveOfficialRudderLogoDataUrl } from "./brand-logo.js";
import { createElectronBrowserAgentTabFactory } from "./browser-agent-electron.js";
import {
  BrowserAgentError,
  createBrowserAgentTabCapacity,
  createBrowserAgentTabController,
} from "./browser-agent-tabs.js";
import {
  createDesktopBrowserApiClient,
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
  installLocalAppSessionPolicy,
} from "./browser-webview-policy.js";
import { ensureDesktopCliLink, resolveDesktopCliArgv, shouldInstallDesktopCliLink } from "./cli-link.js";
import { runDesktopCliMode } from "./cli-runner.js";
import {
  allocateComputerBrokerGeneration,
  createDesktopComputerApiClient,
} from "./computer-broker-registration.js";
import { startComputerBrokerServer } from "./computer-broker-server.js";
import {
  openComputerUseScreenRecordingSettings,
  readComputerUseReadiness,
  requestComputerUsePermissions,
} from "./computer-permissions.js";
import { createDesktopComputerRuntimeLifecycle } from "./computer-runtime-lifecycle.js";
import { createComputerRuntime } from "./computer-runtime.js";
import { createCuaComputerDriver } from "./cua-computer-driver.js";
import {
  clearAutomaticCandidate,
  readDesktopAutoUpdateState,
  resolveDesktopAutoUpdateStatePath,
  withAutomaticUpdateStateLock,
  writeDesktopAutoUpdateState,
} from "./desktop-auto-update-state.js";
import type { DesktopCapabilities } from "./desktop-capabilities.js";
import { imageBufferFromPayload, parseDesktopImageDataPayload, sanitizeDesktopImageFilename } from "./desktop-image-payload.js";
import { resolveDesktopLocalEnvProfile, resolveDesktopOwnedPorts, type LocalEnvProfile } from "./desktop-local-env.js";
import { resolveDesktopCapabilities } from "./desktop-main-capabilities.js";
import { createDesktopQuitFlow } from "./desktop-quit-flow.js";
import { shouldPreferDesktopRuntimeOwnership } from "./desktop-runtime-ownership.js";
import { stopDesktopRuntime } from "./desktop-runtime-shutdown.js";
import {
  createDesktopRecoveryDiagnostic,
  createDesktopStartupFailureView,
  type DesktopStartupFailureView,
} from "./desktop-startup-failure.js";
import { DESKTOP_BUG_REPORT_URL, DESKTOP_FEEDBACK_EMAIL } from "./desktop-support-mail.js";
import { createDesktopUpdateFlow, INSTANCE_SETTINGS_GENERAL_PATH } from "./desktop-update-flow.js";
import {
  ensureExternalDesktopUpdateHelper,
  isDesktopUpdateRequestFresh,
  quarantineDesktopUpdateRequest,
  readDesktopUpdateHelperRequest,
  readDesktopUpdateJournal,
  recoverDesktopUpdateWithExternalHelper,
  requestMatchesAutomaticCandidate,
  resolveDesktopUpdateTransactionPaths,
  spawnDesktopUpdateHelper,
  type DesktopUpdateHelperRequest,
} from "./desktop-update-helper.js";
import { createDesktopUpdatePolicyLoader } from "./desktop-update-policy-loader.js";
import { resolveDesktopUpdateTrustKeys } from "./desktop-update-trust.js";
import {
  toWorkspaceLaunchTargetPayload,
  type DesktopWorkspaceLaunchTargetPayload,
} from "./desktop-workspace-launch-payload.js";
import {
  listAvailableIdeTargets,
  listWorkspaceLaunchTargets,
  openWorkspace,
  openWorkspaceFileInIde,
  openWorkspaceFileLocation,
  type DesktopFileLaunchTargetId,
  type DesktopWorkspaceLaunchTargetId,
} from "./ide-opener.js";
import {
  createDesktopIdentityRuntime,
  type DesktopLocalAccountAuth,
} from "./identity-runtime.js";
import { registerLocalAppsIpcHandlers } from "./local-apps-ipc.js";
import { createDesktopLocalAppsRuntime } from "./local-apps-main-runtime.js";
import { registerLocalFileIpcHandlers } from "./local-file-ipc.js";
import { syncProcessPathFromLoginShell } from "./login-shell-env.js";
import {
  canOpenBlockedNavigationExternally,
  classifyBlockedDesktopNavigation,
  collectDesktopNavigationOrigins,
  isAllowedDesktopNavigation,
  sanitizeDesktopNavigationForLog,
} from "./navigation-guard.js";
import {
  clearPostUpdateReloadMarker,
  readPostUpdateReloadMarker,
  resolvePostUpdateReloadDelayMs,
  type PostUpdateReloadMarker,
} from "./post-update-reload.js";
import {
  acquireDesktopPostgresLifecycleLock,
  captureDesktopPostgresEnvironment,
  finalizeSharedPostgresRuntime,
  reconcilePackagedDesktopPostgresBinDir,
  restoreDesktopPostgresEnvironment,
} from "./postgres-runtime.js";
import { startDesktopProductAnalyticsScheduler } from "./product-analytics-main-scheduler.js";
import type { DesktopProductAnalyticsScheduler } from "./product-analytics-scheduler.js";
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
import { resolveProtectedDesktopShortcutRoute } from "./side-panel-close-shortcut.js";
import {
  createSpeechRuntime,
  SpeechRuntimeError,
} from "./speech-runtime.js";
import {
  isDesktopSystemPermissionId,
  resolveDesktopSystemPermissions,
  resolveSystemPermissionSettingsUrl,
  type DesktopSystemPermissions,
} from "./system-permissions.js";
import { createTerminalController, registerTerminalIpcHandlers, resolveTerminalWorkspaceFromApi } from "./terminal-ipc.js";
import {
  applyThemePreferenceToNativeTheme,
  resolveAppearanceForThemePreference,
  type DesktopAppearance,
  type DesktopThemePreference,
} from "./theme-preference.js";
import { readDesktopUpdateChannel } from "./update-channel-preference.js";
import {
  type DesktopUpdateChannel
} from "./update-check.js";
import { resolveInitialDesktopWindowSize } from "./window-size.js";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_BUILDER_RUNNER_PATH = path.join(MODULE_DIR, "app-builder-runner.mjs");
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
  identityProviders?: {
    google: boolean;
    github: boolean;
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
  preferredOwner?: boolean;
  localAccountAuth?: DesktopLocalAccountAuth;
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

type ResidentTrayIcon = {
  image: Electron.NativeImage;
  source: string;
};

function writeResidentShellSmokeStatus(status: Record<string, unknown>): void {
  const targetPath = process.env.RUDDER_DESKTOP_SMOKE_RESIDENT_STATUS_PATH?.trim();
  if (!targetPath) return;

  const resolvedPath = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

function writeLifecycleSmokeEvent(event: string, details: Record<string, unknown> = {}): void {
  const targetPath = process.env.RUDDER_DESKTOP_SMOKE_LIFECYCLE_PATH?.trim();
  if (!targetPath || !app.getName().startsWith("Rudder-smoke-")) return;
  const resolvedPath = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.appendFileSync(resolvedPath, `${JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid, ...details })}\n`, "utf8");
}

function resolveLifecycleSmokeAction(): string | null {
  if (!app.isPackaged || !app.getName().startsWith("Rudder-smoke-")) return null;
  const action = process.env.RUDDER_DESKTOP_SMOKE_LIFECYCLE_ACTION?.trim().toLowerCase();
  return action && ["close", "menu-quit", "tray-quit", "shutdown", "auto-update-quit"].includes(action) ? action : null;
}

function scheduleLifecycleSmokeAction(): void {
  const action = resolveLifecycleSmokeAction();
  if (!action) return;
  const configuredDelayMs = Number.parseInt(process.env.RUDDER_DESKTOP_SMOKE_LIFECYCLE_DELAY_MS ?? "", 10);
  const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
    ? configuredDelayMs
    : action === "auto-update-quit" ? 8_000 : 2_000;
  const trigger = () => {
    if (action === "close") {
      writeLifecycleSmokeEvent("close-requested");
      mainWindow?.close();
      return;
    }
    if (action === "menu-quit") {
      const item = Menu.getApplicationMenu()?.items[0]?.submenu?.getMenuItemById("rudder-quit");
      writeLifecycleSmokeEvent("application-menu-quit-requested", { found: Boolean(item) });
      item?.click?.();
      return;
    }
    if (action === "tray-quit") {
      writeLifecycleSmokeEvent("tray-quit-requested", { found: Boolean(residentTrayQuitAction), trayAvailable: Boolean(residentTray) });
      residentTrayQuitAction?.();
      return;
    }
    if (action === "auto-update-quit") {
      writeLifecycleSmokeEvent("natural-quit-requested", { source: "auto-update-public" });
      requestQuit();
      return;
    }
    writeLifecycleSmokeEvent("system-shutdown-requested");
    desktopSystemShutdown = true;
    powerMonitor.emit("shutdown");
    // The shutdown event owns the non-blocking runtime cleanup. Calling
    // app.quit() here races that cleanup and leaves the managed API/Postgres
    // listeners behind in packaged lifecycle verification.
  };
  if (action === "auto-update-quit" && process.env.RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC === "1") {
    const statePath = resolveDesktopAutoUpdateStatePath(app.getPath("userData"));
    const deadline = Date.now() + 90_000;
    const waitForPolicy = () => {
      let acceptedPolicySequence = -1;
      let candidateStatus: string | null = null;
      try {
        const state = readDesktopAutoUpdateState(statePath);
        acceptedPolicySequence = state.acceptedPolicySequence;
        candidateStatus = state.candidate?.status ?? null;
      } catch {
        // Keep polling until the packaged bootstrap has created the state.
      }
      if ((acceptedPolicySequence >= 42 && currentBootState.stage === "ready" && candidateStatus === "staged") || Date.now() >= deadline) {
        writeLifecycleSmokeEvent("auto-update-policy-ready", {
          acceptedPolicySequence,
          candidateStatus,
          statePath,
          runtimeReady: currentBootState.stage === "ready",
        });
        trigger();
        return;
      }
      setTimeout(waitForPolicy, 250).unref?.();
    };
    setTimeout(waitForPolicy, delayMs).unref?.();
    return;
  }
  setTimeout(trigger, delayMs).unref?.();
}

function createResidentTrayIcon(): ResidentTrayIcon {
  if (process.platform === "darwin") {
    const templatePath = resolveResidentTrayTemplatePath();
    if (templatePath) {
      const templateImage = nativeImage.createFromPath(templatePath);
      if (!templateImage.isEmpty()) {
        templateImage.setTemplateImage(true);
        return {
          image: templateImage,
          source: path.basename(templatePath),
        };
      }
    }
  }

  const iconPath = process.platform === "win32"
    ? resolveDesktopResourceAssetPath("icon.ico") ?? resolveDesktopResourceAssetPath("icon.png")
    : resolveDesktopResourceAssetPath("icon.png");
  if (iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return {
        image: process.platform === "win32" ? image : image.resize({ width: 16, height: 16 }),
        source: path.basename(iconPath),
      };
    }
  }

  const iconSvg = process.platform === "darwin"
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
        <g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="9" r="7.25" stroke-width="1.5"/>
          <path d="M4.55 11.45A5.35 5.35 0 0 1 13.8 7.2" stroke-width="1.75"/>
        </g>
        <path d="M4.45 11.7 14.65 7.55 8.15 14.65c.7-2.45.05-3.55-3.7-2.95Z" fill="#000"/>
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
  return {
    image,
    source: "generated",
  };
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
const speechRuntime = createSpeechRuntime({
  isPackaged: app.isPackaged,
  moduleDir: MODULE_DIR,
  resourcesPath: process.resourcesPath,
});
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
let desktopUserQuitIntent = false;
let desktopSystemShutdown = false;
let currentMainRenderer: WebContents | null = null;
let currentMainWindowKind: "app" | "boot" = "boot";
let residentTray: Tray | null = null;
let residentTrayQuitAction: (() => void) | null = null;
let sidePanelCloseShortcutActive = false;
let browserSurfaceShortcutActive = false;
let browserSurfaceShortcutOwner: "main_workbench" | "side_panel" | null = null;
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
const localAppGuestRegistry = createBrowserGuestRegistry();
const browserAgentTabCapacity = createBrowserAgentTabCapacity();
const desktopBrowserBrokerOwnerId = randomUUID();
let desktopBrowserBrokerGeneration = 0;
const localAppSessions = new Map<string, Session>();
const acceptBrowserPopup = createBrowserPopupRateLimiter();
let browserProfileController: BrowserProfileController | null = null;
let browserAgentTabController: ReturnType<typeof createBrowserAgentTabController> | null = null;
let browserRuntimeLifecycle: ReturnType<typeof createDesktopBrowserRuntimeLifecycle> | null = null;
let computerRuntimeLifecycle: ReturnType<typeof createDesktopComputerRuntimeLifecycle> | null = null;
let localAppsController: ReturnType<typeof createDesktopLocalAppsRuntime>["controller"] | null = null;
let localAppsRuntime: ReturnType<typeof createDesktopLocalAppsRuntime>["runtime"] | null = null;
let localAppsFeatureGateTimer: NodeJS.Timeout | null = null;
let appBuilderController: AppBuilderController | null = null;
const terminalController = createTerminalController({
  resolveWorkspace: async (orgId, agentId) => {
    const apiUrl = serverHandle?.apiUrl;
    if (!apiUrl) throw new Error("The local Rudder runtime is not ready.");
    const [agentResponse, filesResponse] = await Promise.all([
      session.defaultSession.fetch(buildDesktopApiRequestUrl(apiUrl, `/agents/${encodeURIComponent(agentId)}`), { credentials: "include" }),
      session.defaultSession.fetch(buildDesktopApiRequestUrl(apiUrl, `/orgs/${encodeURIComponent(orgId)}/workspace/files?path=agents`), { credentials: "include" }),
    ]);
    if (!agentResponse.ok) throw new Error(agentResponse.status === 404 ? "The selected Agent no longer exists." : "Could not validate the selected Agent.");
    const agent = await agentResponse.json() as { id?: unknown; orgId?: unknown; name?: unknown };
    if (!filesResponse.ok) throw new Error("The Agent workspace is unavailable on this machine.");
    const listing = await filesResponse.json() as { rootPath?: unknown; directoryPath?: unknown; rootExists?: unknown; entries?: unknown };
    const workspace = resolveTerminalWorkspaceFromApi(orgId, agentId, agent, listing);
    if (!fs.statSync(workspace.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error("The Agent workspace is unavailable on this machine.");
    return workspace;
  },
});
let desktopIdentityRuntime: ReturnType<typeof createDesktopIdentityRuntime> | null = null;
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
let productAnalyticsScheduler: DesktopProductAnalyticsScheduler | null = null;
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
let releaseNotesPresentedVersion: string | null = null;
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

let applyPreparedAutomaticCandidateForQuit: (() => Promise<"handled" | "continue">) | null = null;
let handoffPreparedAutomaticCandidateForQuit: (() => Promise<"handled" | "continue">) | null = null;
type DesktopUpdatePolicyLoader = ReturnType<typeof createDesktopUpdatePolicyLoader>;
let desktopUpdatePolicyLoader: DesktopUpdatePolicyLoader | null = null;
function getDesktopUpdatePolicyLoader(): DesktopUpdatePolicyLoader {
  // Resolve this after bootstrap applies the smoke/profile userData path and
  // app identity. Electron can return its default path before ready even when
  // a launch-specific path was supplied through the environment.
  if (!desktopUpdatePolicyLoader) {
    desktopUpdatePolicyLoader = createDesktopUpdatePolicyLoader({
      userDataPath: app.getPath("userData"),
      channel: () => readDesktopUpdateChannel(app.getPath("userData")),
      arch: process.arch,
      keys: resolveDesktopUpdateTrustKeys(),
      policyUrl: process.env.RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC === "1"
        ? process.env.RUDDER_DESKTOP_UPDATE_POLICY_URL?.trim()
        : undefined,
    });
  }
  return desktopUpdatePolicyLoader;
}
/**
 * Resolve the helper at the point of use. Packaged resources can finish
 * staging after Electron has initialized; a one-shot module-level probe would
 * otherwise disable silent updates for the entire session after a transient
 * filesystem or process failure.
 */
function getDesktopUpdateHelperAttestation() {
  return ensureExternalDesktopUpdateHelper({
    userDataPath: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
    env: process.env,
  });
}
const desktopQuitFlow = createDesktopQuitFlow({
  appName: APP_NAME,
  getMainWindow: () => mainWindow,
  setMainWindow: (value) => { mainWindow = value; },
  getServerHandle: () => serverHandle,
  fetchApi: (input, init) => session.defaultSession.fetch(input, init),
  prepareForQuit: async () => {
    speechRuntime.dispose();
    await Promise.all([
      browserProfileController?.shutdown() ?? Promise.resolve(),
      localAppGuestRegistry.closeAll(),
      terminalController.shutdown(),
    ]);
  },
  prepareLocalAppsForQuit: async () => {
    await (localAppsController?.shutdown() ?? Promise.resolve());
  },
  beforeFinalizeQuit: async () => {
    if (!desktopUserQuitIntent || desktopSystemShutdown) return "continue";
    const before = readDesktopAutoUpdateState(resolveDesktopAutoUpdateStatePath(app.getPath("userData")));
    writeLifecycleSmokeEvent("auto-update-before-quit", {
      candidateStatus: before.candidate?.status ?? null,
      helperAvailable: getDesktopUpdateHelperAttestation() !== null,
      policyAvailable: getDesktopUpdatePolicyLoader().hasUsablePolicy(),
      runtimeReady: currentBootState.stage === "ready",
    });
    await applyPreparedAutomaticCandidateForQuit?.();
    const after = readDesktopAutoUpdateState(resolveDesktopAutoUpdateStatePath(app.getPath("userData")));
    writeLifecycleSmokeEvent("auto-update-after-claim", {
      candidateStatus: after.candidate?.status ?? null,
      recoveryRequired: after.recoveryRequired,
    });
    return "continue";
  },
  afterRuntimeDrain: async () => {
    if (!desktopUserQuitIntent || desktopSystemShutdown) return;
    writeLifecycleSmokeEvent("auto-update-after-runtime-drain");
    await handoffPreparedAutomaticCandidateForQuit?.();
    writeLifecycleSmokeEvent("auto-update-after-helper-handoff");
  },
  isSystemShutdown: () => desktopSystemShutdown,
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
  getUpdateInstallPath: () => (
    app.getName().startsWith("Rudder-smoke-")
      ? process.env.RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_INSTALL_PATH?.trim()
      : undefined
  ),
  hasExternalUpdateHelperCapability: () => getDesktopUpdateHelperAttestation() !== null,
  getExternalUpdateHelper: () => getDesktopUpdateHelperAttestation(),
  hasSignedUpdatePolicyCapability: () => getDesktopUpdatePolicyLoader().hasUsablePolicy(),
  refreshSignedUpdatePolicy: async () => {
    const policyLoader = getDesktopUpdatePolicyLoader();
    const result = await policyLoader.refresh();
    if (process.env.RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC === "1") {
      writeLifecycleSmokeEvent("auto-update-policy-refresh", {
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        acceptedPolicySequence: readDesktopAutoUpdateState(resolveDesktopAutoUpdateStatePath(app.getPath("userData"))).acceptedPolicySequence,
      });
    }
    if (!result.ok) {
      console.warn("[rudder-desktop] signed update policy unavailable", result.reason);
      return false;
    }
    return true;
  },
  authorizeSignedUpdateRelease: (input) => getDesktopUpdatePolicyLoader().authorizeRelease(input) !== null,
  isSignedUpdateVersionAuthorized: (version) => {
    const policy = getDesktopUpdatePolicyLoader().getPolicy();
    return Boolean(policy?.releases.some((release) => release.version === version && !release.revoked));
  },
});
const {
  checkForUpdates, getDesktopUpdateChannel, setDesktopUpdateChannel, resolveRudderAppVersion,
  maybeShowStartupUpdateNotice, showManualUpdateCheckDialog, installUpdate, applyUpdate,
  createFeedbackMailtoUrl, getDesktopUpdateProgress,
  scheduleAutomaticUpdateCheck,
  applyPreparedAutomaticCandidate,
  prepareAutomaticCandidateForQuit,
  handoffPreparedAutomaticCandidate,
} = desktopUpdateFlow;
applyPreparedAutomaticCandidateForQuit = prepareAutomaticCandidateForQuit;
handoffPreparedAutomaticCandidateForQuit = handoffPreparedAutomaticCandidate;

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

  if (shouldOverrideDesktopDockIcon(process.platform, app.isPackaged) && app.dock) {
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
  // The Desktop profile owns its local ports. A restarted Desktop can inherit
  // the CLI/updater's dev port from its parent process; preserving that value
  // makes the new release look for PostgreSQL in the wrong instance/port and
  // surfaces as a generic database startup failure. Smoke runs deliberately
  // provide isolated ports and are the only caller allowed to override them.
  const ownedPorts = resolveDesktopOwnedPorts(profile);
  process.env.PORT = ownedPorts.port;
  process.env.RUDDER_EMBEDDED_POSTGRES_PORT = ownedPorts.embeddedPostgresPort;
  process.env.RUDDER_DEPLOYMENT_MODE = "local_trusted";
  process.env.RUDDER_DEPLOYMENT_EXPOSURE = "private";
  process.env.HOST = "127.0.0.1";
  process.env.SERVE_UI = "true";
  process.env.RUDDER_UI_DEV_MIDDLEWARE = "false";
  process.env.RUDDER_OPEN_ON_LISTEN = "false";
  if (app.isPackaged) reconcilePackagedDesktopPostgresBinDir(process.resourcesPath, externalServerRuntimeCacheDir);
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

function requireComputerRuntimeLifecycle() {
  if (!computerRuntimeLifecycle) throw new Error("Computer Use runtime has not been initialized.");
  return computerRuntimeLifecycle;
}

function requireLocalAppsController(): ReturnType<typeof createDesktopLocalAppsRuntime>["controller"] {
  if (!localAppsController) throw new Error("Desktop Local Apps have not been initialized.");
  return localAppsController;
}

function requireAppBuilderController(): AppBuilderController {
  if (!appBuilderController) throw new Error("Desktop App Builder has not been initialized.");
  return appBuilderController;
}

async function readPluginsFeatureEnabled(): Promise<boolean> {
  if (!serverHandle?.apiUrl) return false;
  const response = await fetch(new URL("/api/health", serverHandle.apiUrl), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Unable to read Plugins feature state (${response.status})`);
  }
  const payload = await response.json() as {
    features?: { experimentalPluginsEnabled?: unknown; experimentalSitesEnabled?: unknown };
  };
  return (payload.features?.experimentalPluginsEnabled
    ?? payload.features?.experimentalSitesEnabled) === true;
}

async function refreshLocalAppsFeatureGate(): Promise<boolean> {
  const enabled = await readPluginsFeatureEnabled();
  await requireLocalAppsController().setFeatureEnabled(enabled);
  return enabled;
}

async function assertPluginsFeatureEnabled(): Promise<void> {
  if (!await refreshLocalAppsFeatureGate()) {
    throw new Error("Plugins is disabled in Experimental settings");
  }
}

function stopLocalAppsFeatureGateWatcher(): void {
  if (!localAppsFeatureGateTimer) return;
  clearInterval(localAppsFeatureGateTimer);
  localAppsFeatureGateTimer = null;
}

async function startLocalAppsFeatureGateWatcher(): Promise<void> {
  stopLocalAppsFeatureGateWatcher();
  await refreshLocalAppsFeatureGate();
  localAppsFeatureGateTimer = setInterval(() => {
    void refreshLocalAppsFeatureGate().catch((error) => {
      console.warn("[rudder-desktop] Plugins feature reconciliation failed", error);
    });
  }, 1_000);
  localAppsFeatureGateTimer.unref();
}

function initializeLocalApps(desktopInstallationId: string): void {
  if (localAppsController) return;
  const userDataPath = app.getPath("userData");
  const localApps = createDesktopLocalAppsRuntime({
    installationId: desktopInstallationId,
    appName: APP_NAME,
    userDataPath,
    getOwner: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
  });
  ({ controller: localAppsController, runtime: localAppsRuntime } = localApps);

  const templateRoot = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "server-package",
        "resources",
        "bundled-skills",
        "app-builder",
        "assets",
        "scaffold",
      )
    : path.resolve(
        MODULE_DIR,
        "..",
        "..",
        "server",
        "resources",
        "bundled-skills",
        "app-builder",
        "assets",
        "scaffold",
      );
  const preview = new AppBuilderPreviewController({
    registry: localApps.registry,
    localApps: localAppsController,
    runnerExecutable: process.execPath,
    buildRunnerArgv: ({ appRoot }) => [APP_BUILDER_RUNNER_PATH, appRoot, "preview"],
    inheritedEnvNames: APP_BUILDER_INHERITED_ENV_NAMES,
  });
  appBuilderController = new AppBuilderController({
    templateRoot,
    preview,
    data: new AppBuilderDataManager(path.join(userDataPath, "app-builder")),
    resolveProjectRoot: async (organizationId) => {
      if (!serverHandle?.apiUrl) {
        throw new Error("Rudder must finish starting before App Builder can resolve its workspace.");
      }
      return resolveAppBuilderWorkspaceRoot({
        apiBaseUrl: serverHandle.apiUrl,
        organizationId,
        fetchApi: (input, init) => session.defaultSession.fetch(input, init),
      });
    },
    selectExportDirectory: async ({ appId, snapshotId }) => {
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const options = {
        title: "Export App data",
        buttonLabel: "Export",
        defaultPath: `${appId}-${snapshotId}`,
      };
      const result = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? null : result.filePath ?? null;
    },
    selectImportPackage: async ({ appId }) => {
      const options: OpenDialogOptions = {
        title: `Import data for ${appId}`,
        buttonLabel: "Import",
        properties: ["openDirectory"],
      };
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    migrateRelease: ({ releaseRoot, stagedDataRoot }) => new Promise((resolve, reject) => {
      const migrationEnvironment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        ...createAppBuilderInheritedEnvironment(process.env),
      };
      if (process.platform === "win32") {
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        migrationEnvironment.SystemRoot = systemRoot;
        migrationEnvironment.WINDIR = process.env.WINDIR ?? systemRoot;
        migrationEnvironment.TEMP =
          process.env.TEMP ?? process.env.TMP ?? path.win32.join(systemRoot, "Temp");
        migrationEnvironment.TMP = process.env.TMP ?? migrationEnvironment.TEMP;
      } else {
        migrationEnvironment.TMPDIR = process.env.TMPDIR ?? "/tmp";
      }
      const child = spawn(
        process.execPath,
        [APP_BUILDER_RUNNER_PATH, releaseRoot, "migrate", stagedDataRoot],
        {
          cwd: releaseRoot,
          env: migrationEnvironment,
          shell: false,
          stdio: "pipe",
          windowsHide: true,
        },
      );
      let diagnostics = "";
      child.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
      child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0 && !signal) {
          resolve();
          return;
        }
        reject(new Error(
          `App migration rehearsal failed${signal ? ` (${signal})` : ` (${code ?? 1})`}: ${diagnostics.slice(-4_000)}`,
        ));
      });
    }),
  });
}

function initializeDesktopIdentity(desktopInstallationId: string): void {
  if (desktopIdentityRuntime) return;
  desktopIdentityRuntime = createDesktopIdentityRuntime({
    installationId: desktopInstallationId,
    appName: APP_NAME,
    safeStorage,
    getMainRenderer: getCurrentMainRenderer,
    getLocalApiUrl: () => serverHandle?.apiUrl ?? lastKnownAppUrl,
    onSignedIn: startLocalRudder,
    onLocalExchange: () => updateBootState({
      stage: "account_exchange",
      message: "Connecting your Rudder Account…",
      detail: "Creating a private session for this Local Workspace.",
    }),
    onSignedOut: async () => {
      await stopLocalRudder();
      updateBootState({
        stage: "account_required",
        message: "Sign in to Rudder Account",
        detail: "Your Local Workspace stays on this device.",
        error: undefined,
        failure: undefined,
      });
      await openBootWindow();
    },
  });
}

function requireDesktopIdentityRuntime(): ReturnType<typeof createDesktopIdentityRuntime> {
  if (!desktopIdentityRuntime) throw new Error("Rudder Account has not been initialized.");
  return desktopIdentityRuntime;
}

function prepareLocalAppPartition(partition: string): void {
  if (localAppSessions.has(partition)) return;
  const localAppSession = session.fromPartition(partition);
  installLocalAppSessionPolicy(localAppSession, {
    getAttestedOrigin: () => localAppsRuntime?.attestedTargetForPartition(partition)?.origin ?? null,
  });
  localAppSessions.set(partition, localAppSession);
}

function resolveLocalAppGuestPartition(guest: { session?: unknown }): string | null {
  for (const [partition, localAppSession] of localAppSessions) {
    if (guest.session === localAppSession) return partition;
  }
  return null;
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

type DesktopMicrophonePermissionStatus =
  | "authorized"
  | "denied"
  | "restricted"
  | "unsupported"
  | "unknown";

async function requestDesktopMicrophoneAccess(): Promise<DesktopMicrophonePermissionStatus> {
  if (!speechRuntime.getStatus().available) return "denied";
  if (process.platform !== "darwin") return "authorized";

  try {
    const current = systemPreferences.getMediaAccessStatus("microphone");
    if (current === "granted") return "authorized";
    if (current === "restricted") return "restricted";
    if (current === "denied") return "denied";
    return (await systemPreferences.askForMediaAccess("microphone")) ? "authorized" : "denied";
  } catch {
    return "unknown";
  }
}

function installDesktopSpeechPermissionPolicy(): void {
  if (!speechRuntime.getStatus().available) return;
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    if (permission !== "media") return true;
    const renderer = getCurrentMainRenderer();
    return Boolean(
      renderer
      && webContents === renderer
      && details.isMainFrame,
    );
  });
  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(true);
      return;
    }
    const mediaTypes = (details as { mediaTypes?: unknown } | undefined)?.mediaTypes;
    const requestsOnlyAudio = Array.isArray(mediaTypes)
      && mediaTypes.length === 1
      && mediaTypes[0] === "audio";
    const renderer = getCurrentMainRenderer();
    callback(Boolean(
      requestsOnlyAudio
      && renderer
      && webContents === renderer
      && details?.isMainFrame === true,
    ));
  });
}

function collectRudderAppOrigins(...additionalOrigins: Array<string | null | undefined>): string[] {
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

function routeDesktopWebLink(
  url: string,
  source: "link" | "browser_popup",
  sourceWebContentsId?: number,
): void {
  if (source === "browser_popup" && !acceptBrowserPopup()) return;
  const renderer = getCurrentMainRenderer();
  if (renderer?.getURL().startsWith("http")) {
    renderer.send("desktop:open-web-link", {
      url,
      source,
      ...(sourceWebContentsId ? { sourceWebContentsId } : {}),
    });
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
  const results = await Promise.allSettled([
    browserGuestRegistry.closeAll(),
    browserAgentTabController?.closeAll() ?? Promise.resolve(),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function closeAgentBrowserGuests(): Promise<void> {
  const results = await Promise.allSettled([
    browserGuestRegistry.closeAll("agent"),
    browserAgentTabController?.closeAll() ?? Promise.resolve(),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

function replaceBrowserRuntimeLifecycle(): void {
  const controller = requireBrowserProfileController();
  const browserApi = createDesktopBrowserApiClient(
    (input, init) => session.defaultSession.fetch(
      input instanceof URL ? input.toString() : input,
      init,
    ),
  );
  const partition = controller.getPartition();
  const agentTabs = createBrowserAgentTabController({
    createTab: createElectronBrowserAgentTabFactory({
      partition,
      createWindow: (windowOptions) => new BrowserWindow(windowOptions),
      registerGuest: (guest) => browserGuestRegistry.register(guest, "agent"),
      getRudderAppOrigins: collectRudderAppOrigins,
    }),
    getRudderAppOrigins: collectRudderAppOrigins,
    listUserTabs: browserGuestRegistry.listUserTabs,
    capacity: browserAgentTabCapacity,
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
    allocateRegistrationGeneration: () => ++desktopBrowserBrokerGeneration,
    registerBroker: (apiUrl, broker, generation, refresh) => {
      if (generation === undefined) {
        throw new Error("Rudder Browser Broker registration generation is missing.");
      }
      return browserApi.registerBroker(apiUrl, {
        ...broker,
        ownerId: desktopBrowserBrokerOwnerId,
        generation,
        ...(refresh ? { refresh: true } : {}),
      });
    },
    unregisterBroker: browserApi.unregisterBroker,
    readSettings: browserApi.readSettings,
    isRunActive: browserApi.isRunActive,
    sweepIntervalMs: 5_000,
    onWarning: (message, error) => console.warn(`[rudder-desktop] ${message}`, error),
  });
}

function replaceComputerRuntimeLifecycle(): void {
  const runtime = createComputerRuntime({ createDriver: createCuaComputerDriver });
  const computerApi = createDesktopComputerApiClient(
    (input, init) => session.defaultSession.fetch(
      input instanceof URL ? input.toString() : input,
      init,
    ),
  );
  computerRuntimeLifecycle = createDesktopComputerRuntimeLifecycle({
    runtime,
    readSettings: computerApi.readSettings,
    readReadiness: () => readComputerUseReadiness(),
    isRunActive: computerApi.isRunActive,
    startBroker: startComputerBrokerServer,
    allocateGeneration: allocateComputerBrokerGeneration,
    registerBroker: (apiUrl, broker, generation, refresh) =>
      computerApi.registerBroker(apiUrl, broker, generation, refresh),
    unregisterBroker: computerApi.unregisterBroker,
    pollIntervalMs: 5_000,
    onWarning: (message, error) => console.warn(`[rudder-desktop] ${message}`, error),
  });
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
    getRudderAppOrigins: collectRudderAppOrigins,
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
  replaceBrowserRuntimeLifecycle();
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
  if (nextState.stage !== currentBootState.stage && process.env.RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC === "1") {
    writeLifecycleSmokeEvent("boot-state", {
      stage: nextState.stage,
      message: nextState.message,
      detail: nextState.detail ?? null,
      error: nextState.error ?? null,
      failure: nextState.failure ?? null,
    });
  }
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
      mainWindow.webContents.send("desktop:recovery-state", deriveBootScreenState(currentBootState));
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
      mainWindow.webContents.send("desktop:recovery-state", deriveBootScreenState(currentBootState));
    } else {
      mainWindow.webContents.send("desktop:boot-state", currentBootState);
    }
  }
  return permissions;
}

function resolveDesktopBrandIconDataUrl(): string | null {
  return resolveOfficialRudderLogoDataUrl({ isPackaged: app.isPackaged, moduleDir: MODULE_DIR, resourcesPath: process.resourcesPath });
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
  const html = createBootScreenHtml(APP_NAME, resolveDesktopBrandIconDataUrl(), deriveBootScreenState(currentBootState));
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
  const operatorBrowserGuest = operatorBrowserShortcutWebContents.has(webContents);
  const route = resolveProtectedDesktopShortcutRoute(input, {
    sidePanelCloseActive: sidePanelCloseShortcutActive,
    browserSurfaceActive: browserSurfaceShortcutActive
      && Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents),
    operatorBrowserGuest,
    browserSurfaceOwner: browserSurfaceShortcutOwner,
  });
  if (!route) return;
  event.preventDefault();
  if (route.kind === "close_browser_owner_tab") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:browser-shortcut", {
        action: "close_tab",
        sourceWebContentsId: webContents.id,
      });
    }
    return;
  }
  if (route.kind === "close_side_panel_tab") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:close-side-panel-active-tab");
      return;
    }
    webContents.send("desktop:close-side-panel-active-tab");
    return;
  }
  if (route.kind === "open_empty_side_panel") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:open-empty-side-panel");
      return;
    }
    webContents.send("desktop:open-empty-side-panel");
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:browser-shortcut", {
      action: route.action,
      ...(operatorBrowserGuest
        ? { sourceWebContentsId: webContents.id }
        : {}),
    });
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
    browserSurfaceShortcutOwner = null;
  });
}

async function createDesktopWindow(initialUrl: string, kind: "app" | "boot"): Promise<BrowserWindow> {
  const preloadPath = path.resolve(MODULE_DIR, kind === "boot" ? "boot-preload.js" : "preload.js");
  const macWindowEffects = process.platform === "darwin"
    ? resolveMacWindowEffects()
    : {
        backgroundColor: resolveDesktopWindowBackgroundColor(),
      };
  const initialWindowSize = resolveInitialDesktopWindowSize(
    screen.getPrimaryDisplay().workAreaSize,
  );
  const window = new BrowserWindow({
    ...initialWindowSize,
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
      getRudderAppOrigins: () => collectRudderAppOrigins(initialUrl),
      isBrowserAvailable: () => browserProfile.isOperatorAvailable(),
      registerGuest: (guest) => {
        browserGuestRegistry.register(guest);
        operatorBrowserShortcutWebContents.add(guest as WebContents);
      },
      openBrowserPopup: (url, sourceWebContentsId) => (
        routeDesktopWebLink(url, "browser_popup", sourceWebContentsId)
      ),
      resolveLocalAppBootstrap: (url, partition) =>
        localAppsRuntime?.isAttestedBootstrap(url, partition) ?? false,
      prepareLocalAppPartition,
      isLocalAppGuest: (guest) => resolveLocalAppGuestPartition(guest) !== null,
      isAllowedLocalAppNavigation: (guest, url) => {
        const partition = resolveLocalAppGuestPartition(guest);
        return partition !== null && (localAppsRuntime?.isAttestedNavigation(url, partition) ?? false);
      },
      registerLocalAppGuest: localAppGuestRegistry.register,
    });
  }

  window.on("close", (event) => {
    writeLifecycleSmokeEvent("window-close", {
      hiddenToResident: shouldHideToResidentShell() && !isQuitRequested() && !isQuitting() && !desktopSystemShutdown,
    });
    if (!shouldHideToResidentShell() || isQuitRequested() || isQuitting() || desktopSystemShutdown) return;
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
  latestPostUpdateReloadMarker = readPostUpdateReloadMarker(app.getPath("userData"));
}

async function openAppWindow(loadUrl: string): Promise<void> {
  rememberAppUrl(loadUrl);
  await replaceMainWindow(await createDesktopWindow(loadUrl, "app"), "app");
}

function schedulePostUpdateRendererReloadIfNeeded(): void {
  if (!latestPostUpdateReloadMarker) {
    latestPostUpdateReloadMarker = readPostUpdateReloadMarker(app.getPath("userData"));
  }
  const marker = latestPostUpdateReloadMarker;
  if (!marker) return;

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
  if (!menu || !appMenu) return;

  const quitIndex = appMenu.items.findIndex((item) => item.role === "quit" || item.label === `Quit ${appName}`);
  if (quitIndex >= 0 && !appMenu.getMenuItemById("rudder-quit")) {
    const quitItem = appMenu.items[quitIndex];
    // Electron 37 exposes role as read-only on MenuItem. Keep the native quit
    // role and attach the guarded handler through the menu item's click hook.
    quitItem.id = "rudder-quit";
    quitItem.click = () => requestQuit();
  }

  if (appMenu.getMenuItemById("rudder-settings")) {
    Menu.setApplicationMenu(menu);
    return;
  }

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
  residentTrayQuitAction = () => requestQuit();
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
      click: residentTrayQuitAction,
    },
  ]);
  residentTray.setContextMenu(menu);
}

function createResidentShellControls(): void {
  if (!platformSupportsResidentShellControls()) return;
  try {
    const trayIcon = createResidentTrayIcon();
    residentTray = new Tray(trayIcon.image);
    residentTray.on("click", () => {
      showMainWindow();
    });
    residentControlsAvailable = true;
    const iconSize = trayIcon.image.getSize();
    const iconScaleFactors = trayIcon.image.getScaleFactors();
    const iconIsTemplate = trayIcon.image.isTemplateImage();
    console.info("[rudder-desktop] Resident shell controls active", {
      packaged: app.isPackaged,
      platform: process.platform,
      profile: currentBootState.runtime?.localEnv ?? initialProfile.name,
      iconSource: trayIcon.source,
      iconSize,
      iconScaleFactors,
      iconIsTemplate,
    });
    writeResidentShellSmokeStatus({
      enabled: residentShellEnabled,
      controlsAvailable: residentControlsAvailable,
      packaged: app.isPackaged,
      platform: process.platform,
      iconSource: trayIcon.source,
      iconSize,
      iconScaleFactors,
      iconIsTemplate,
    });
    updateResidentShellMenu();
  } catch (error) {
    residentTray = null;
    residentControlsAvailable = false;
    writeResidentShellSmokeStatus({
      enabled: residentShellEnabled,
      controlsAvailable: residentControlsAvailable,
      packaged: app.isPackaged,
      platform: process.platform,
    });
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
  writeLifecycleSmokeEvent("natural-quit-requested");
  desktopUserQuitIntent = true;
  void beginQuitFlow().finally(() => {
    if (!isQuitting()) desktopUserQuitIntent = false;
  });
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
  const pendingProfile = resolveDesktopLocalEnvProfile();
  const identityRuntime = requireDesktopIdentityRuntime();
  if (identityRuntime.accountRequired && identityRuntime.controller.getState().status !== "signed-in") {
    // The account gate must not wait on a remote capability probe. A transient
    // network failure should preserve the production sign-in choices, then a
    // successful probe may hide only providers explicitly reported disabled.
    const identityProviders = identityRuntime.getAuthProvidersFallback();
    updateBootState({
      stage: "account_required",
      message: "Sign in to Rudder Account",
      detail: "Sign in before Rudder starts your Local Workspace. Local workspace content stays on this device.",
      error: undefined,
      failure: undefined,
      paths: resolveSharedInstancePaths(pendingProfile.instanceId),
      runtime: {
        localEnv: pendingProfile.name,
        instanceId: pendingProfile.instanceId,
        mode: undefined,
        ownerKind: undefined,
        version: undefined,
        apiUrl: undefined,
      },
      identityProviders,
    });
    void identityRuntime.getAuthProviders().then((resolvedProviders) => {
      if (
        currentBootState.stage !== "account_required"
        || identityRuntime.controller.getState().status !== "signed-out"
      ) return;
      updateBootState({
        stage: "account_required",
        message: "Sign in to Rudder Account",
        identityProviders: resolvedProviders,
      });
    }).catch((error) => {
      console.warn("[rudder-desktop] Identity provider capability refresh failed", error);
    });
    return;
  }
  startInFlight = (async () => {
    let releasePostgresLifecycleLock: (() => Promise<void>) | null = null;
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
      if (app.isPackaged) {
        releasePostgresLifecycleLock = await acquireDesktopPostgresLifecycleLock();
        reconcilePackagedDesktopPostgresBinDir(
          process.resourcesPath,
          externalServerRuntimeCacheDir,
        );
      }
      const serverModule = await importServerModule();
      const localAccountSession = identityRuntime.prepareLocalSession(profile.instanceId);
      updateBootState({
        stage: "config",
        message: "Checking for an existing shared runtime…",
        detail: `Desktop will attach to ${profile.name} when possible, or start it if needed.`,
      });
      serverHandle = await serverModule.startManagedLocalServer({
        ownerKind: "desktop",
        takeoverOnVersionMismatch: true,
        preferredOwner: shouldPreferDesktopRuntimeOwnership(app.isPackaged),
        ...(localAccountSession.localAccountAuth
          ? { localAccountAuth: localAccountSession.localAccountAuth }
          : {}),
        ...serverRuntimeOptions(),
      });
      if (releasePostgresLifecycleLock) {
        await releasePostgresLifecycleLock();
        releasePostgresLifecycleLock = null;
      }
      if (app.isPackaged) {
        try {
          const healthUrl = new URL("/api/health", serverHandle.apiUrl);
          const healthResponse = await fetch(healthUrl);
          if (!healthResponse.ok) {
            throw new Error(`health check returned ${healthResponse.status}`);
          }
          const cleanup = await finalizeSharedPostgresRuntime({
            expectedInstanceId: serverHandle.runtime.instanceId,
            expectedVersion: serverHandle.runtime.version,
          });
          console.info("[rudder-desktop] finalized shared PostgreSQL runtime", cleanup);
        } catch (error) {
          console.warn(
            "[rudder-desktop] shared PostgreSQL runtime cleanup deferred until a verified shared cold start",
            error,
          );
        }
      }
      await localAccountSession.connect(serverHandle.apiUrl);
      void startDesktopProductAnalyticsScheduler(serverHandle.apiUrl, {
        collectorUrl: process.env.RUDDER_TELEMETRY_COLLECTOR_URL?.trim(),
        identityRuntime: requireDesktopIdentityRuntime(),
        scheduler: productAnalyticsScheduler,
        setScheduler: (scheduler) => { productAnalyticsScheduler = scheduler; },
        fetchImpl: (input, init) => session.defaultSession.fetch(input instanceof URL ? input.toString() : input, init),
      }).catch((error) => {
        console.warn("[rudder-desktop] Product analytics scheduler unavailable; continuing without telemetry upload", error);
      });
      await startLocalAppsFeatureGateWatcher();
      try {
        await requireBrowserRuntimeLifecycle().connect(serverHandle.apiUrl);
      } catch (error) {
        console.warn("[rudder-desktop] Browser Broker unavailable; continuing without Agent Browser control", error);
      }
      try {
        await requireComputerRuntimeLifecycle().connect(serverHandle.apiUrl);
      } catch (error) {
        console.warn("[rudder-desktop] Computer Broker unavailable; continuing without Computer Use", error);
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
      // Keep the bootstrap-anchored silent-update timer active after the local
      // runtime is ready; policy/download work still runs through its durable
      // slot and never races runtime ownership or migrations.
      scheduleAutomaticUpdateCheck();
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
      void maybeShowStartupUpdateNotice();
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
      if (releasePostgresLifecycleLock) {
        await releasePostgresLifecycleLock();
      }
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
      const previousPostgresEnvironment = captureDesktopPostgresEnvironment();
      reconcilePackagedDesktopPostgresBinDir(process.resourcesPath, externalRuntime.cacheDir);
      console.info("[rudder-desktop] loading server runtime from shared cache", {
        entrypoint: externalRuntime.entrypoint,
      });
      try {
        const mod = await import(pathToFileURL(externalRuntime.entrypoint).href) as ServerModule;
        externalServerRuntimeCacheDir = externalRuntime.cacheDir;
        return mod;
      } catch (error) {
        restoreDesktopPostgresEnvironment(previousPostgresEnvironment);
        externalServerRuntimeCacheDir = null;
        reconcilePackagedDesktopPostgresBinDir(process.resourcesPath);
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
  const browserLifecycle = browserRuntimeLifecycle;
  const computerLifecycle = computerRuntimeLifecycle;
  const handle = serverHandle;
  productAnalyticsScheduler?.stop();
  productAnalyticsScheduler = null;
  stopLocalAppsFeatureGateWatcher();
  await localAppsController?.setFeatureEnabled(false).catch((error) => {
    console.warn("[rudder-desktop] failed to stop Local Apps while the runtime was stopping", error);
  });
  serverHandle = null;
  await computerLifecycle?.disconnect().catch((error) => {
    console.warn("[rudder-desktop] failed to stop Computer Use while the runtime was stopping", error);
  });
  await stopDesktopRuntime({
    browserDisconnect: browserLifecycle
      ? () => browserLifecycle.disconnect()
      : undefined,
    runtimeHandle: handle,
    onBrowserDisconnectTimeout: () => {
      if (!isQuitting() && browserRuntimeLifecycle === browserLifecycle) {
        replaceBrowserRuntimeLifecycle();
      }
    },
    onWarning: (message, error) => {
      if (error === undefined) {
        console.warn(`[rudder-desktop] ${message}`);
        return;
      }
      console.warn(`[rudder-desktop] ${message}`, error);
    },
  });
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
  const profileController = requireBrowserProfileController();
  registerBrowserIpcHandlers(ipcMain, {
    getMainRenderer: getCurrentMainRenderer,
    controller: {
      getPartition: () => profileController.getPartition(),
      clearBrowserData: () => profileController.clearBrowserData(),
      setEnabled: async (enabled) => {
        await profileController.setEnabled(enabled);
        if (serverHandle) await requireBrowserRuntimeLifecycle().connect(serverHandle.apiUrl);
      },
    },
    importer: requireBrowserCookieImporter(),
  });
  registerLocalAppsIpcHandlers(ipcMain, {
    getMainRenderer: getCurrentMainRenderer,
    controller: requireLocalAppsController(),
    assertEnabled: assertPluginsFeatureEnabled,
  });
  registerTerminalIpcHandlers(ipcMain, {
    getMainRenderer: getCurrentMainRenderer,
    controller: terminalController,
  });
  registerAppBuilderIpcHandlers(ipcMain, {
    getMainRenderer: getCurrentMainRenderer,
    controller: requireAppBuilderController(),
    assertEnabled: assertPluginsFeatureEnabled,
  });
  requireDesktopIdentityRuntime().registerIpc();
  installDesktopSpeechPermissionPolicy();
  ipcMain.handle("desktop:speech-status", async (event) => {
    assertCurrentMainFrame(event, "Desktop speech status");
    return speechRuntime.getStatus();
  });
  ipcMain.handle("desktop:speech-request-microphone", async (event) => {
    assertCurrentMainFrame(event, "Desktop speech microphone permission");
    return requestDesktopMicrophoneAccess();
  });
  ipcMain.handle("desktop:speech-transcribe", async (event, input: unknown) => {
    assertCurrentMainFrame(event, "Desktop speech transcription");
    try {
      return await speechRuntime.transcribe(input);
    } catch (error) {
      if (error instanceof SpeechRuntimeError) {
        throw new Error(`speech:${error.code}`);
      }
      throw error;
    }
  });
  ipcMain.handle("desktop:speech-cancel", async (event, requestId: unknown) => {
    assertCurrentMainFrame(event, "Desktop speech cancellation");
    if (typeof requestId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/u.test(requestId.trim())) {
      throw new Error("speech:invalid_audio");
    }
    speechRuntime.cancel(requestId.trim());
  });
  ipcMain.handle("desktop:get-boot-state", async (event) => {
    assertCurrentMainFrame(event, "Desktop boot state");
    refreshDesktopSystemPermissions();
    return currentBootState;
  });
  ipcMain.handle("desktop:get-recovery-state", async (event) => {
    assertStartupRecoveryFrame(event, "Desktop recovery state");
    return deriveBootScreenState(currentBootState);
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
  ipcMain.handle("desktop:computer-use-readiness", async (event) => {
    assertCurrentMainFrame(event, "Computer Use readiness");
    return readComputerUseReadiness();
  });
  ipcMain.handle("desktop:computer-use-request-permissions", async (event) => {
    assertCurrentMainFrame(event, "Computer Use permission request");
    const readiness = await requestComputerUsePermissions();
    await computerRuntimeLifecycle?.refresh().catch((error) => {
      console.warn("[rudder-desktop] failed to refresh Computer Use after permission request", error);
    });
    return readiness;
  });
  ipcMain.handle("desktop:computer-use-open-screen-recording", async (event) => {
    assertCurrentMainFrame(event, "Computer Use Screen Recording settings");
    return openComputerUseScreenRecordingSettings();
  });
  ipcMain.handle("desktop:open-system-permission-settings", async (event, permission: unknown) => {
    assertCurrentMainFrame(event, "System permission settings");
    if (!isDesktopSystemPermissionId(permission)) {
      throw new Error("Unknown system permission settings target.");
    }
    const target = resolveSystemPermissionSettingsUrl({ permission });
    if (!target) {
      throw new Error("System permission settings are available only on macOS.");
    }
    await shell.openExternal(target);
  });
  ipcMain.handle("desktop:get-app-version", async () => resolveRudderAppVersion());
  ipcMain.handle("desktop:get-release-notes", async (): Promise<DesktopReleaseNotesResult> => {
    const version = resolveRudderAppVersion();
    if (releaseNotesPresentedVersion === version) {
      return { status: "already-shown" };
    }
    const statePath = resolveReleaseNotesStatePath(app.getPath("userData"));
    const updatedAfterInstall = latestPostUpdateReloadMarker?.targetVersion === version;
    if (!shouldShowReleaseNotes({ statePath, version, updatedAfterInstall })) {
      clearPostUpdateReloadMarker(app.getPath("userData"));
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
    if (!notes) {
      clearPostUpdateReloadMarker(app.getPath("userData"));
      return { status: "unavailable" };
    }
    // Reserve the entitlement for this process so repeated renderer mounts do
    // not duplicate the dialog. Durable consumption happens only after the
    // renderer acknowledges the notes, allowing a crash to retry on next boot.
    releaseNotesPresentedVersion = version;
    return { status: "available", notes };
  });
  ipcMain.handle("desktop:mark-release-notes-shown", async (_event, version: string) => {
    if (typeof version !== "string" || version.trim().length === 0) return;
    markReleaseNotesShown({
      version,
      statePath: resolveReleaseNotesStatePath(app.getPath("userData")),
    });
    releaseNotesPresentedVersion = null;
    clearPostUpdateReloadMarker(app.getPath("userData"));
  });
  ipcMain.handle("desktop:open-path", async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });
  registerLocalFileIpcHandlers(ipcMain, {
    getMainRenderer: getCurrentMainRenderer,
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
  ipcMain.handle("desktop:set-browser-surface-shortcut-active", async (
    event,
    active: boolean,
    owner?: "main_workbench" | "side_panel",
  ) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    browserSurfaceShortcutActive = Boolean(active);
    browserSurfaceShortcutOwner = owner === "main_workbench" || owner === "side_panel"
      ? owner
      : null;
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
  // Install and attest the helper while the packaged resources are known to be
  // present. Natural quit must only consume a capability that was already
  // verified during bootstrap; doing the copy lazily at quit can race with
  // shutdown and makes the public update path appear unavailable.
  if (app.isPackaged && process.platform === "darwin") {
    const helper = getDesktopUpdateHelperAttestation();
    if (process.env.RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC === "1") {
      writeLifecycleSmokeEvent("auto-update-helper-ready", {
        available: helper !== null,
        path: helper?.path ?? null,
        sha256: helper?.sha256 ?? null,
      });
    }
  }
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
  replaceComputerRuntimeLifecycle();
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
  if (desktopDebugEnabled()) console.info("[rudder-desktop] bootstrap:initialize-local-apps");
  initializeLocalApps(profile.instanceId);
  if (desktopDebugEnabled()) console.info("[rudder-desktop] bootstrap:initialize-identity");
  initializeDesktopIdentity(profile.instanceId);
  if (desktopDebugEnabled()) console.info("[rudder-desktop] bootstrap:register-ipc");
  registerIpc();
  installApplicationMenu(appName);
  createResidentShellControls();
  await openBootWindow();
  scheduleLifecycleSmokeAction();
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:window-created");
  }
  if (desktopBootOnlyMode()) {
    if (desktopDebugEnabled()) {
      console.info("[rudder-desktop] bootstrap:boot-only");
    }
    return;
  }
  try {
    const autoUpdateStatePath = resolveDesktopAutoUpdateStatePath(app.getPath("userData"));
    let autoUpdateState = readDesktopAutoUpdateState(autoUpdateStatePath);
    if (autoUpdateState.candidate) {
      const candidate = autoUpdateState.candidate;
      const journal = readDesktopUpdateJournal(app.getPath("userData"), candidate.updateId);
      if (candidate.status === "claimed" && !journal) {
      const requestPath = `${resolveDesktopUpdateTransactionPaths({
          userDataPath: app.getPath("userData"),
          transactionId: candidate.updateId,
          resourcesPath: process.resourcesPath,
          execPath: process.execPath,
      }).journalPath}.request.json`;
        const requestPending = isDesktopUpdateRequestFresh(requestPath);
        if (requestPending) {
          const transactionPaths = resolveDesktopUpdateTransactionPaths({
            userDataPath: app.getPath("userData"),
            transactionId: candidate.updateId,
            resourcesPath: process.resourcesPath,
            execPath: process.execPath,
          });
          const request = readDesktopUpdateHelperRequest(requestPath);
          const helper = getDesktopUpdateHelperAttestation();
          if (!request || !requestMatchesAutomaticCandidate({
            request,
            candidate,
            statePath: autoUpdateStatePath,
            paths: transactionPaths,
            helper: helper ?? undefined,
          })) {
            quarantineDesktopUpdateRequest(requestPath);
            autoUpdateState = withAutomaticUpdateStateLock(autoUpdateStatePath, () => {
              const current = readDesktopAutoUpdateState(autoUpdateStatePath);
              const next = {
                ...current,
                recoveryRequired: true,
                recoveryCode: "automatic_update_claim_request_mismatch",
              };
              writeDesktopAutoUpdateState(autoUpdateStatePath, next);
              return next;
            });
          } else {
          // A crash can occur after the immutable request is durably written
          // but before the old process reaches spawn(). Re-issue the helper
          // handoff on the next boot. The native helper's transaction lock
          // makes this idempotent if another helper already owns the request.
          if (helper) {
            const restoreClaimedCandidate = (reason: unknown) => {
              if (readDesktopUpdateJournal(app.getPath("userData"), candidate.updateId)) return;
              try {
                fs.rmSync(requestPath, { force: true });
                clearPostUpdateReloadMarker(app.getPath("userData"), { updateId: candidate.updateId });
                autoUpdateState = withAutomaticUpdateStateLock(autoUpdateStatePath, () => {
                  const current = readDesktopAutoUpdateState(autoUpdateStatePath);
                  if (current.candidate?.updateId !== candidate.updateId || current.candidate.status !== "claimed") return current;
                  const next = {
                    ...current,
                    generation: current.generation + 1,
                    candidate: { ...current.candidate, status: "staged" as const, generation: current.generation + 1 },
                  };
                  writeDesktopAutoUpdateState(autoUpdateStatePath, next);
                  return next;
                });
                console.warn("[rudder-desktop] automatic update helper re-handoff failed; candidate returned to staged", reason);
              } catch (restoreError) {
                console.error("[rudder-desktop] automatic update helper re-handoff recovery failed", restoreError);
              }
            };
            try {
              const child = spawnDesktopUpdateHelper({ requestPath, helperPath: helper.path });
              child.once("error", restoreClaimedCandidate);
              child.once("exit", (code) => {
                if (code !== 0) restoreClaimedCandidate(new Error(`helper exited with code ${code ?? "unknown"}`));
              });
              writeLifecycleSmokeEvent("auto-update-helper-rehandoff", {
                transactionId: candidate.updateId,
              });
            } catch (error) {
              restoreClaimedCandidate(error);
              console.warn("[rudder-desktop] automatic update helper re-handoff failed", error);
            }
          }
          }
        } else {
          quarantineDesktopUpdateRequest(requestPath);
          autoUpdateState = withAutomaticUpdateStateLock(autoUpdateStatePath, () => {
            const current = readDesktopAutoUpdateState(autoUpdateStatePath);
            const next = {
              ...current,
              recoveryRequired: true,
              recoveryCode: "automatic_update_claim_request_stale",
            };
            writeDesktopAutoUpdateState(autoUpdateStatePath, next);
            return next;
          });
        }
      } else if (journal && (journal.recoveryRequired || journal.stage === "previous_moved")) {
        const helper = getDesktopUpdateHelperAttestation();
        const journalHelper = journal.helper;
        const expectedTransactionPaths = resolveDesktopUpdateTransactionPaths({
          userDataPath: app.getPath("userData"),
          transactionId: journal.transactionId,
          resourcesPath: process.resourcesPath,
          execPath: process.execPath,
        });
        const helperMatchesJournal = Boolean(helper && journalHelper
          && helper.path === journalHelper.path
          && helper.ownerUid === journalHelper.ownerUid
          && helper.mode === journalHelper.mode
          && helper.sha256 === journalHelper.sha256);
        const journalPathsMatch = journal.installPath === expectedTransactionPaths.installPath
          && journal.lkgPath === expectedTransactionPaths.lkgPath
          && journal.checkpointPath === expectedTransactionPaths.checkpointPath
          && journal.stagedPath === candidate.stagedArtifactPath;
        const journalCandidateMatch = journal.candidateSha256 === candidate.stagedArtifactDigest
          && journal.targetVersion === candidate.version;
        if (!helper || !helperMatchesJournal || !journalPathsMatch || !journalCandidateMatch || !journal.ownerToken
          || !journal.admission || !journal.checkpoint || !journal.installPath
          || !journal.stagedPath || !journal.lkgPath || !journal.checkpointPath
          || !journal.targetVersion || !journal.candidateSha256) {
          autoUpdateState = withAutomaticUpdateStateLock(autoUpdateStatePath, () => {
            const current = readDesktopAutoUpdateState(autoUpdateStatePath);
            const next = {
              ...current,
              recoveryRequired: true,
              recoveryCode: "automatic_update_recovery_identity_unavailable",
            };
            writeDesktopAutoUpdateState(autoUpdateStatePath, next);
            return next;
          });
        } else {
          const recoveryRequest: DesktopUpdateHelperRequest = {
            operation: "recover",
            ownerToken: journal.ownerToken,
            transactionId: journal.transactionId,
            ...{
              installPath: journal.installPath,
              stagedPath: journal.stagedPath,
              lkgPath: journal.lkgPath,
              journalPath: expectedTransactionPaths.journalPath,
            checkpointPath: journal.checkpointPath,
            ...(journal.statePath ? { statePath: journal.statePath } : {}),
            },
            targetVersion: journal.targetVersion,
            candidateSha256: journal.candidateSha256,
            admission: journal.admission,
            checkpoint: journal.checkpoint,
            helper: journalHelper!,
            probation: {
              executable: path.join(journal.installPath, "Contents", "MacOS", "Rudder"),
              args: ["--rudder-update-probation"],
              timeoutMs: 10_000,
            },
          };
          const recovery = recoverDesktopUpdateWithExternalHelper({ request: recoveryRequest, helperPath: helper.path });
          if (recovery.recoveryRequired || !recovery.stage || !["rolled_back", "committed"].includes(recovery.stage)) {
            autoUpdateState = withAutomaticUpdateStateLock(autoUpdateStatePath, () => {
              const current = readDesktopAutoUpdateState(autoUpdateStatePath);
              const next = {
                ...current,
                recoveryRequired: true,
                recoveryCode: recovery.recoveryCode ?? recovery.error ?? "automatic_update_recovery_failed",
              };
              writeDesktopAutoUpdateState(autoUpdateStatePath, next);
              return next;
            });
          } else {
            autoUpdateState = withAutomaticUpdateStateLock(autoUpdateStatePath, () => {
              const current = readDesktopAutoUpdateState(autoUpdateStatePath);
              const next = clearAutomaticCandidate({ ...current, recoveryRequired: false, recoveryCode: undefined }, candidate.updateId);
              writeDesktopAutoUpdateState(autoUpdateStatePath, next);
              return next;
            });
          }
        }
      } else if (journal && ["committed", "rolled_back"].includes(journal.stage)) {
        // A terminal helper journal is authoritative. Clear the durable
        // candidate so a successful install or rollback cannot be claimed on
        // every subsequent launch.
        autoUpdateState = withAutomaticUpdateStateLock(autoUpdateStatePath, () => {
          const current = readDesktopAutoUpdateState(autoUpdateStatePath);
          const next = current.candidate
            ? clearAutomaticCandidate(current, current.candidate.updateId)
            : current;
          writeDesktopAutoUpdateState(autoUpdateStatePath, next);
          return next;
        });
      }
    }
    if (autoUpdateState.recoveryRequired) {
      updateBootState({
        stage: "error",
        message: "Rudder could not start safely after an automatic update.",
        detail: "Open Technical details or contact support before attempting manual repair.",
        error: autoUpdateState.recoveryCode ?? "automatic_update_recovery_required",
        failure: {
          id: `auto-update-${autoUpdateState.generation}`,
          occurredAt: new Date().toISOString(),
          stage: "automatic_update_recovery",
          attempt: 1,
          category: "runtime",
          summary: "Rudder could not start safely after an automatic update.",
        },
      });
      return;
    }
  } catch (error) {
    console.error("[rudder-desktop] automatic update state recovery check failed", error);
    updateBootState({
      stage: "error",
      message: "Rudder could not verify automatic update state safely.",
      detail: "Open Technical details or contact support before attempting manual repair.",
      error: "automatic_update_state_unreadable",
      failure: {
        id: `auto-update-state-${Date.now()}`,
        occurredAt: new Date().toISOString(),
        stage: "automatic_update_recovery",
        attempt: 1,
        category: "runtime",
        summary: "Rudder could not verify automatic update state safely.",
      },
    });
    return;
  }
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:start-runtime");
  }
  await startLocalRudder();
  // Start the silent scheduler only after the account gate or managed local
  // runtime has reached a stable boot state. This prevents policy/download work
  // from racing migrations while still allowing signed-out installs to stage
  // an update after the account-required state is rendered.
  scheduleAutomaticUpdateCheck();
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:ready");
  }
}

async function runAutomaticUpdateProbation(): Promise<void> {
  // The helper launches the exact replacement binary with this flag. Probe the
  // same managed local runtime and served renderer as a normal boot, then hold
  // the runtime through a bounded stability window. The hidden BrowserWindow
  // below makes renderer/preload readiness an observed gate instead of a raw
  // HTTP shell check.
  // No normal Desktop window is created and the managed runtime is always
  // stopped before this process exits.
  if (!process.argv.includes("--rudder-update-probation")) return;
  let handle: StartedServer | null = null;
  let probationWindow: BrowserWindow | null = null;
  const probationVersionChannel = "desktop:get-app-version";
  try {
    const profile = applyDesktopEnvironment();
    initializeDesktopIdentity(profile.instanceId);
    if (desktopIdentityRuntime?.accountRequired
      && desktopIdentityRuntime.controller.getState().status !== "signed-in") {
      // A signed-out installation cannot safely start or migrate the local
      // workspace during a hidden replacement probe. The normal boot will
      // enforce the account gate after the candidate is installed.
      process.stdout.write("rudder-update-probation account-gated\n");
      app.exit(0);
      return;
    }
    const serverModule = await importServerModule();
    handle = await serverModule.startManagedLocalServer({
      ownerKind: "desktop",
      takeoverOnVersionMismatch: true,
      preferredOwner: true,
      ...serverRuntimeOptions(),
    });
    if (handle.runtime.mode !== "owned"
      || handle.runtime.instanceId !== profile.instanceId
      || handle.runtime.localEnv !== profile.name
      || (handle.runtime.version !== app.getVersion()
        && !(app.getName().startsWith("Rudder-smoke-")
          && process.env.RUDDER_DESKTOP_SMOKE_AUTO_UPDATE_PUBLIC === "1"))) {
      throw new Error("probation runtime identity or ownership mismatch");
    }
    const healthUrl = new URL("/api/health", handle.apiUrl);
    const rendererUrl = new URL("/", handle.apiUrl);
    const readHealth = async () => {
      const healthResponse = await fetch(healthUrl, {
        signal: AbortSignal.timeout(8_000),
        headers: { Accept: "application/json" },
      });
      if (!healthResponse.ok) throw new Error(`probation health returned ${healthResponse.status}`);
      const health = await healthResponse.json() as {
        instanceId?: unknown;
        localEnv?: unknown;
        status?: unknown;
        bootstrapStatus?: unknown;
      };
      if (health.status !== "ok"
        || health.instanceId !== profile.instanceId
        || health.localEnv !== profile.name) {
        throw new Error("probation health identity mismatch");
      }
      if (health.bootstrapStatus === "bootstrap_pending") {
        throw new Error("probation database bootstrap is incomplete");
      }
    };
    await readHealth();
    ipcMain.handle(probationVersionChannel, () => app.getVersion());
    probationWindow = new BrowserWindow({
      show: false,
      webPreferences: createDesktopWebPreferences(path.resolve(MODULE_DIR, "preload.js")),
    });
    await probationWindow.loadURL(rendererUrl.toString());
    const rendererReady = await probationWindow.webContents.executeJavaScript(
      "Boolean(window.desktopShell && typeof window.desktopShell.getAppVersion === 'function')",
      true,
    );
    if (rendererReady !== true) throw new Error("probation renderer/preload bridge is unavailable");
    const rendererVersion = await probationWindow.webContents.executeJavaScript(
      "window.desktopShell.getAppVersion()",
      true,
    );
    if (rendererVersion !== app.getVersion()) throw new Error("probation renderer IPC version mismatch");
    const stabilityWindowMs = 1_500;
    const stabilityDeadline = Date.now() + stabilityWindowMs;
    while (Date.now() < stabilityDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await readHealth();
    }
    ipcMain.removeHandler(probationVersionChannel);
    probationWindow.destroy();
    probationWindow = null;
    await handle.stop();
    handle = null;
    process.stdout.write("rudder-update-probation ready\n");
    app.exit(0);
  } catch (error) {
    ipcMain.removeHandler(probationVersionChannel);
    probationWindow?.destroy();
    await handle?.stop().catch(() => undefined);
    console.error("[rudder-desktop] update probation failed", error);
    app.exit(1);
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
      if (isQuitting()) return;
      if (shouldHideToResidentShell()) return;
      app.quit();
    });

    powerMonitor.on("shutdown", () => {
      desktopSystemShutdown = true;
      // OS shutdown must never wait for update installation or a user prompt,
      // but an already-owned local runtime still gets a best-effort drain so
      // the process does not strand its loopback listeners during logoff.
      void stopLocalRudder()
        .catch((error) => {
          console.warn("[rudder-desktop] failed to drain local runtime during OS shutdown", error);
        })
        .finally(() => app.quit());
    });
    app.on("before-quit", (event) => {
      if (desktopSystemShutdown) return;
      if (isQuitting()) return;
      event.preventDefault();
      void beginQuitFlow();
    });

    void app.whenReady().then(async () => {
      if (process.argv.includes("--rudder-update-probation")) return runAutomaticUpdateProbation();
      return bootstrap();
    }).catch((error) => {
      console.error("[rudder-desktop] Failed to bootstrap desktop app", error);
      app.exit(1);
    });
  }
}
