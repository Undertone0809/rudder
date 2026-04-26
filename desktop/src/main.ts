import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Notification, app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell, systemPreferences } from "electron";
import type { BrowserWindowConstructorOptions, OpenDialogOptions } from "electron";
import { createBootScreenHtml } from "./boot-screen.js";
import { ensureDesktopCliLink, resolveDesktopCliArgv, shouldInstallDesktopCliLink } from "./cli-link.js";
import type { DesktopCapabilities } from "./desktop-capabilities.js";
import { syncProcessPathFromLoginShell } from "./login-shell-env.js";
import { resolveDesktopSystemPermissions, type DesktopSystemPermissions } from "./system-permissions.js";
import {
  applyThemePreferenceToNativeTheme,
  resolveAppearanceForThemePreference,
  type DesktopAppearance,
  type DesktopThemePreference,
} from "./theme-preference.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

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

type LocalEnvProfile = {
  name: "dev" | "prod_local" | "e2e";
  instanceId: string;
  port: string;
  embeddedPostgresPort: string;
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
  agentName: string;
  issueId?: string | null;
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

type ActiveRunSummary = {
  totalRuns: number;
  organizations: Array<{
    id: string;
    name: string;
    runs: DesktopLiveRun[];
  }>;
};

type MacWindowMode = "opaque" | "transparent" | "transparent_vibrant";

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

const DESKTOP_GITHUB_REPO = "Undertone0809/rudder";
const DESKTOP_RELEASES_URL = `https://github.com/${DESKTOP_GITHUB_REPO}/releases`;
const DESKTOP_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${DESKTOP_GITHUB_REPO}/releases/latest`;
const DESKTOP_FEEDBACK_EMAIL = "zeeland4work@gmail.com";
const DESKTOP_UPDATE_QUIT_ARG = "--rudder-update-quit";

const LOCAL_ENV_PROFILES: Record<LocalEnvProfile["name"], LocalEnvProfile> = {
  dev: {
    name: "dev",
    instanceId: "dev",
    port: "3100",
    embeddedPostgresPort: "54329",
  },
  prod_local: {
    name: "prod_local",
    instanceId: "default",
    port: "3200",
    embeddedPostgresPort: "54339",
  },
  e2e: {
    name: "e2e",
    instanceId: "e2e",
    port: "3300",
    embeddedPostgresPort: "54349",
  },
};

function parseSemver(value: string): { major: number; minor: number; patch: number; prerelease: string | null } | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);

  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch - parsedB.patch;

  if (parsedA.prerelease === parsedB.prerelease) return 0;
  if (!parsedA.prerelease) return 1;
  if (!parsedB.prerelease) return -1;
  return parsedA.prerelease.localeCompare(parsedB.prerelease);
}

function createFeedbackMailtoUrl(): string {
  const params = new URLSearchParams({
    subject: `Rudder feedback (${app.getVersion()})`,
  });
  return `mailto:${DESKTOP_FEEDBACK_EMAIL}?${params.toString()}`;
}

function resolveDesktopCapabilities(): DesktopCapabilities {
  let notifications = false;
  try {
    notifications = Notification.isSupported();
  } catch {
    notifications = false;
  }

  return {
    badgeCount: typeof app.setBadgeCount === "function",
    notifications,
  };
}

async function checkForUpdates(): Promise<DesktopUpdateCheckResult> {
  const currentVersion = app.getVersion();
  try {
    const response = await fetch(DESKTOP_LATEST_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${app.getName()}/${currentVersion}`,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub release lookup failed (${response.status})`);
    }

    const payload = await response.json() as {
      tag_name?: string;
      html_url?: string;
    };
    const latestVersion = typeof payload.tag_name === "string" ? payload.tag_name.replace(/^v/, "") : undefined;
    if (!latestVersion) {
      throw new Error("GitHub release lookup returned no tag");
    }

    return {
      status: compareSemver(latestVersion, currentVersion) > 0 ? "update-available" : "up-to-date",
      currentVersion,
      latestVersion,
      releaseUrl: typeof payload.html_url === "string" ? payload.html_url : DESKTOP_RELEASES_URL,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("[rudder-desktop] update check failed", error);
    return {
      status: "unavailable",
      currentVersion,
      releaseUrl: DESKTOP_RELEASES_URL,
      checkedAt: new Date().toISOString(),
    };
  }
}

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

function createResidentTrayIcon(): string | Electron.NativeImage {
  if (process.platform === "darwin") {
    const templatePath = resolveResidentTrayTemplatePath();
    if (templatePath) {
      // Pass the Template image path directly so macOS keeps Template/@2x semantics.
      return templatePath;
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

function resolveDesktopAppName(profile: LocalEnvProfile): string {
  return profile.name === "dev" ? "Rudder-dev" : "Rudder";
}

function applyDesktopAppIdentity(profile: LocalEnvProfile): string {
  const appName = resolveDesktopAppName(profile);
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
let residentTray: Tray | null = null;
let residentControlsAvailable = false;
let desktopWindowIcon: Electron.NativeImage | null = null;
let currentThemePreference: DesktopThemePreference = nativeTheme.themeSource;
let currentAppearance: DesktopAppearance = resolveAppearanceForThemePreference(
  currentThemePreference,
  nativeTheme.shouldUseDarkColors,
);
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
let quitInFlight: Promise<void> | null = null;
let quitRequested = false;
let quitting = false;
let quitExceptionGuardInstalled = false;

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

function normalizeLocalEnvName(value: string | null | undefined): LocalEnvProfile["name"] | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  return Object.hasOwn(LOCAL_ENV_PROFILES, normalized) ? (normalized as LocalEnvProfile["name"]) : null;
}

function resolveDesktopLocalEnvProfile(): LocalEnvProfile {
  const explicit = normalizeLocalEnvName(process.env.RUDDER_LOCAL_ENV);
  if (explicit) return LOCAL_ENV_PROFILES[explicit];
  return app.isPackaged ? LOCAL_ENV_PROFILES.prod_local : LOCAL_ENV_PROFILES.dev;
}

function resolveSharedRudderHomeDir(): string {
  const envHome = process.env.RUDDER_HOME?.trim();
  if (envHome) {
    if (envHome === "~") return os.homedir();
    if (envHome.startsWith("~/")) return path.resolve(os.homedir(), envHome.slice(2));
    return path.resolve(envHome);
  }
  return path.resolve(os.homedir(), ".rudder");
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
  const iconFile = profile.name === "dev" ? "icon-dev.png" : "icon.png";
  const candidate = path.resolve(MODULE_DIR, "..", "build", iconFile);
  return fs.existsSync(candidate) ? candidate : null;
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
  process.env.PORT ??= profile.port;
  process.env.RUDDER_EMBEDDED_POSTGRES_PORT ??= profile.embeddedPostgresPort;
  process.env.RUDDER_DEPLOYMENT_MODE = "local_trusted";
  process.env.RUDDER_DEPLOYMENT_EXPOSURE = "private";
  process.env.HOST = "127.0.0.1";
  process.env.SERVE_UI = "true";
  process.env.RUDDER_UI_DEV_MIDDLEWARE = "false";
  process.env.RUDDER_OPEN_ON_LISTEN = "false";
  return profile;
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
    mainWindow.webContents.send("desktop:boot-state", currentBootState);
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
    mainWindow.webContents.send("desktop:boot-state", currentBootState);
  }
  return permissions;
}

async function loadBootScreen(): Promise<void> {
  if (!mainWindow) return;
  const html = createBootScreenHtml(APP_NAME);
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function resolveBootScreenUrl(): string {
  const html = createBootScreenHtml(APP_NAME);
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function createDesktopWindow(initialUrl: string): Promise<BrowserWindow> {
  const preloadPath = path.resolve(MODULE_DIR, "preload.js");
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
    ...macWindowEffects,
    ...(desktopWindowIcon ? { icon: desktopWindowIcon } : {}),
    webPreferences: createDesktopWebPreferences(preloadPath),
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("close", (event) => {
    if (!shouldHideToResidentShell() || quitRequested || quitting) return;
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

  await window.loadURL(initialUrl);
  return window;
}

async function replaceMainWindow(nextWindow: BrowserWindow): Promise<void> {
  const previousWindow = mainWindow;
  if (previousWindow && !previousWindow.isDestroyed()) {
    previousWindow.hide();
  }

  mainWindow = nextWindow;
  mainWindow.setTitle(APP_NAME);

  if (previousWindow && previousWindow !== nextWindow && !previousWindow.isDestroyed()) {
    previousWindow.destroy();
  }
}

async function openBootWindow(): Promise<void> {
  await replaceMainWindow(await createDesktopWindow(resolveBootScreenUrl()));
}

async function openAppWindow(loadUrl: string): Promise<void> {
  await replaceMainWindow(await createDesktopWindow(loadUrl));
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
  showMainWindow();
  await openBootWindow();
  await startLocalRudder();
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
    const profile = resolveDesktopLocalEnvProfile();
    const sharedPaths = resolveSharedInstancePaths(profile.instanceId);

    updateBootState({
      stage: "starting",
      message: "Resolving shared local Rudder instance…",
      detail: `Target profile: ${profile.name}`,
      error: undefined,
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

    if (serverHandle) {
      await serverHandle.stop();
      serverHandle = null;
    }

    try {
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
      const defaultLoadUrl = baseUrl;
      const loadUrl = resolveDesktopLoadUrl(defaultLoadUrl);
      if (desktopDebugEnabled()) {
        console.info("[rudder-desktop] startLocalRudder:load-url", {
          loadUrl,
          transport: "fresh-window",
        });
      }
      await openAppWindow(loadUrl);
      await captureDesktopWindowIfRequested();
    } catch (error) {
      updateBootState({
        stage: "error",
        message: "Rudder failed to start.",
        detail: "The shared local instance did not come up cleanly.",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        paths: serverHandle?.instancePaths ?? currentBootState.paths,
      });
      await loadBootScreen();
    } finally {
      startInFlight = null;
    }
  })();
  return startInFlight;
}

async function importServerModule(): Promise<ServerModule> {
  if (app.isPackaged) {
    const packagedServerEntry = path.resolve(
      process.resourcesPath,
      "server-package",
      "dist",
      "index.js",
    );
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
  if (!serverHandle) return;
  const handle = serverHandle;
  serverHandle = null;
  await handle.stop();
}

async function desktopApiRequest<T>(apiPath: string, init?: RequestInit): Promise<T> {
  const apiBase = serverHandle?.apiUrl;
  if (!apiBase) {
    throw new Error("Local Rudder runtime is not ready");
  }

  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${apiBase}${apiPath}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Desktop API request failed (${response.status} ${response.statusText}) for ${apiPath}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function listActiveRunsForQuit(): Promise<ActiveRunSummary> {
  if (!serverHandle) {
    return {
      totalRuns: 0,
      organizations: [],
    };
  }

  const organizations = await desktopApiRequest<DesktopOrganization[]>("/orgs");
  const summaries = await Promise.all(organizations.map(async (organization) => {
    const runs = await desktopApiRequest<DesktopLiveRun[]>(
      `/orgs/${encodeURIComponent(organization.id)}/live-runs`,
    );
    return {
      id: organization.id,
      name: organization.name,
      runs,
    };
  }));

  const activeOrganizations = summaries.filter((organization) => organization.runs.length > 0);
  return {
    totalRuns: activeOrganizations.reduce((total, organization) => total + organization.runs.length, 0),
    organizations: activeOrganizations,
  };
}

function formatQuitRunDetail(summary: ActiveRunSummary): string {
  const lines = summary.organizations.map((organization) => {
    const runningCount = organization.runs.filter((run) => run.status === "running").length;
    const queuedCount = organization.runs.filter((run) => run.status === "queued").length;
    const parts: string[] = [];
    if (runningCount > 0) parts.push(`${runningCount} running`);
    if (queuedCount > 0) parts.push(`${queuedCount} queued`);
    if (parts.length === 0) parts.push(`${organization.runs.length} active`);
    return `${organization.name}: ${parts.join(", ")}`;
  });

  const maxVisibleLines = 6;
  const visible = lines.slice(0, maxVisibleLines);
  if (lines.length > maxVisibleLines) {
    visible.push(`+${lines.length - maxVisibleLines} more organizations`);
  }

  return visible.join("\n");
}

async function promptForQuitBehavior(summary: ActiveRunSummary): Promise<"cancel" | "quit" | "stop-runs"> {
  const runtimeMode = serverHandle?.runtime.mode;
  const attachedRuntime = runtimeMode === "attached";
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const detail = formatQuitRunDetail(summary);

  if (attachedRuntime) {
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: APP_NAME,
      buttons: ["Keep Runs Running", "Stop Runs and Quit", "Cancel"],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
      message: summary.totalRuns === 1
        ? "There is 1 active run."
        : `There are ${summary.totalRuns} active runs.`,
      detail:
        "Rudder is attached to an existing local runtime. You can quit the desktop app and leave those runs running, or stop them first.\n\n"
        + detail,
    };
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    if (result.response === 0) return "quit";
    if (result.response === 1) return "stop-runs";
    return "cancel";
  }

  const options: Electron.MessageBoxOptions = {
    type: "warning",
    title: APP_NAME,
    buttons: ["Stop Runs and Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: summary.totalRuns === 1
      ? "There is 1 active run. Quitting will stop it."
      : `There are ${summary.totalRuns} active runs. Quitting will stop them.`,
    detail:
      "This desktop app currently owns the local runtime, so quitting will stop any active work.\n\n"
      + detail,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);

  return result.response === 0 ? "stop-runs" : "cancel";
}

async function cancelActiveRunsBeforeQuit(summary: ActiveRunSummary): Promise<void> {
  const runIds = summary.organizations.flatMap((organization) => organization.runs.map((run) => run.id));
  if (runIds.length === 0) return;

  const results = await Promise.allSettled(runIds.map((runId) =>
    desktopApiRequest(`/heartbeat-runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    })));

  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    console.warn(
      `[rudder-desktop] failed to cancel ${failed.length}/${runIds.length} active runs before quit`,
      failed.map((result) => result.status === "rejected" ? result.reason : null),
    );
  }
}

function isThreadStreamWorkerExitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message}\n${error.stack ?? ""}`.toLowerCase();
  return text.includes("the worker has exited") || text.includes("thread-stream");
}

function installQuitExceptionGuard(): void {
  if (quitExceptionGuardInstalled) return;
  quitExceptionGuardInstalled = true;

  process.on("uncaughtException", (error) => {
    if (isThreadStreamWorkerExitError(error)) {
      console.warn("[rudder-desktop] suppressed shutdown-time logging transport error", error);
      return;
    }

    console.error("[rudder-desktop] uncaught exception while quitting", error);
    app.exit(1);
  });
}

async function finalizeQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  quitRequested = true;
  installQuitExceptionGuard();

  try {
    await stopLocalRudder();
  } finally {
    residentTray?.destroy();
    residentTray = null;
    app.quit();
  }
}

async function beginQuitFlow(): Promise<void> {
  if (quitting) return;
  if (quitInFlight) {
    await quitInFlight;
    return;
  }

  quitInFlight = (async () => {
    try {
      let activeRuns: ActiveRunSummary = { totalRuns: 0, organizations: [] };
      try {
        activeRuns = await listActiveRunsForQuit();
      } catch (error) {
        console.warn("[rudder-desktop] failed to inspect active runs before quit; continuing with normal quit", error);
      }

      if (activeRuns.totalRuns > 0) {
        const decision = await promptForQuitBehavior(activeRuns);
        if (decision === "cancel") {
          return;
        }
        if (decision === "stop-runs") {
          await cancelActiveRunsBeforeQuit(activeRuns);
        }
      }

      await finalizeQuit();
    } finally {
      quitInFlight = null;
      if (!quitting) {
        quitRequested = false;
      }
    }
  })();

  await quitInFlight;
}

function resolveUpdateQuitResponsePath(argv: string[] = process.argv): string | null {
  const inline = argv.find((arg) => arg.startsWith(`${DESKTOP_UPDATE_QUIT_ARG}=`));
  if (inline) return inline.slice(`${DESKTOP_UPDATE_QUIT_ARG}=`.length).trim() || null;

  const flagIndex = argv.indexOf(DESKTOP_UPDATE_QUIT_ARG);
  if (flagIndex === -1) return null;
  return argv[flagIndex + 1]?.trim() || null;
}

function writeUpdateQuitResponse(responsePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(responsePath), { recursive: true });
  fs.writeFileSync(responsePath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function handleUpdateQuitRequest(responsePath: string): Promise<void> {
  try {
    let activeRuns: ActiveRunSummary = { totalRuns: 0, organizations: [] };
    try {
      activeRuns = await listActiveRunsForQuit();
    } catch (error) {
      console.warn("[rudder-desktop] failed to inspect active runs for update quit; continuing with quit", error);
    }

    if (activeRuns.totalRuns > 0) {
      writeUpdateQuitResponse(responsePath, {
        ok: false,
        status: "active_runs",
        totalRuns: activeRuns.totalRuns,
      });
      return;
    }

    writeUpdateQuitResponse(responsePath, { ok: true, status: "quitting" });
    await finalizeQuit();
  } catch (error) {
    writeUpdateQuitResponse(responsePath, {
      ok: false,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function registerIpc(): void {
  ipcMain.handle("desktop:get-boot-state", async () => {
    refreshDesktopSystemPermissions();
    return currentBootState;
  });
  ipcMain.handle("desktop:get-system-permissions", async () => refreshDesktopSystemPermissions());
  ipcMain.handle("desktop:get-app-version", async () => app.getVersion());
  ipcMain.handle("desktop:open-path", async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });
  ipcMain.handle("desktop:copy-text", async (_event, value: string) => {
    clipboard.writeText(value);
  });
  ipcMain.handle("desktop:set-appearance", async (_event, preference: DesktopThemePreference) => {
    applyDesktopThemePreference(preference);
  });
  ipcMain.handle("desktop:restart", async () => {
    await restartFromResidentControls();
  });
  ipcMain.handle("desktop:check-for-updates", async () => checkForUpdates());
  ipcMain.handle("desktop:send-feedback", async () => {
    await shell.openExternal(createFeedbackMailtoUrl());
  });
  ipcMain.handle("desktop:open-external", async (_event, target: string) => {
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
    paths: resolveSharedInstancePaths(profile.instanceId),
    runtime: {
      ...currentBootState.runtime,
      localEnv: profile.name,
      instanceId: profile.instanceId,
    },
  };
  registerIpc();
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
  if (desktopDebugEnabled()) {
    console.info("[rudder-desktop] bootstrap:ready");
  }
}

const desktopCliArgv = resolveDesktopCliArgv(process.argv);
const updateQuitResponsePath = resolveUpdateQuitResponsePath(process.argv);

if (desktopCliArgv) {
  void importCliModule()
    .then((cliModule) => cliModule.runCli(desktopCliArgv))
    .then((exitCode) => {
      app.exit(exitCode);
    })
    .catch((error) => {
      console.error("[rudder-desktop] failed to run desktop CLI mode", error);
      app.exit(1);
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
        void handleUpdateQuitRequest(responsePath);
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

    app.on("window-all-closed", () => {
      if (shouldHideToResidentShell()) return;
      app.quit();
    });

    app.on("before-quit", (event) => {
      if (quitting) return;
      event.preventDefault();
      void beginQuitFlow();
    });

    void app.whenReady().then(() => bootstrap()).catch((error) => {
      console.error("[rudder-desktop] Failed to bootstrap desktop app", error);
      app.exit(1);
    });
  }
}
