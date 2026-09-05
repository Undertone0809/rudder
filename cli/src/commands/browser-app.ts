import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyDataDirOverride } from "../config/data-dir.js";
import { describeLocalInstancePaths, resolveRudderHomeDir, resolveRudderInstanceId } from "../config/home.js";
import { applyLocalEnvProfile, resolveActiveLocalEnvProfile } from "../config/local-env.js";
import { startManagedServerFromRuntime, type StartedServer } from "../runtime/server-entry.js";
import { resolveCliVersion } from "../version.js";

export type SmartAppControlState = "on" | "off" | "evaluation" | "unknown";
export type DesktopLaunchMode = "auto" | "native" | "browser";

export interface BrowserAppLaunchResult {
  apiUrl: string;
  boardUrl: string;
  browser: "edge" | "default" | null;
  logPath: string;
  runtimeMode: "owned" | "attached";
}

interface BrowserAppCommandOptions {
  child?: boolean;
  dataDir?: string;
  localEnv?: string;
  open?: boolean;
  readyFile?: string;
  runtimeVersion?: string;
}

interface BrowserAppReadyRecord {
  ok: boolean;
  apiUrl?: string;
  boardUrl?: string;
  runtimeMode?: "owned" | "attached";
  error?: string;
}

const SMART_APP_CONTROL_REGISTRY_KEY = String.raw`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`;
const SMART_APP_CONTROL_REGISTRY_VALUE = "VerifiedAndReputablePolicyState";
const BROWSER_APP_READY_TIMEOUT_MS = 90_000;
const RUNTIME_HEALTH_POLL_MS = 2_000;
const DESKTOP_TAKEOVER_LEASE_DIR = "browser-app-desktop-takeover.lock";
const DESKTOP_TAKEOVER_PARTIAL_LEASE_GRACE_MS = 30_000;

function resolveBrowserAppRuntimeVersion(env: NodeJS.ProcessEnv = process.env): string {
  const version = resolveCliVersion(import.meta.url, env);
  return version === "0.0.0" ? "latest" : version;
}

export function parseSmartAppControlState(output: string): SmartAppControlState {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.toLowerCase().includes(SMART_APP_CONTROL_REGISTRY_VALUE.toLowerCase()));
  if (!line) return "unknown";
  const match = line.match(/REG_DWORD\s+0x([0-9a-f]+)/iu);
  if (!match) return "unknown";
  const value = Number.parseInt(match[1], 16);
  if (value === 0) return "off";
  if (value === 1) return "on";
  if (value === 2) return "evaluation";
  return "unknown";
}

export function detectSmartAppControlState(
  platform: NodeJS.Platform = process.platform,
  spawnSyncImpl: typeof spawnSync = spawnSync,
): SmartAppControlState {
  if (platform !== "win32") return "unknown";
  const result = spawnSyncImpl("reg.exe", [
    "query",
    SMART_APP_CONTROL_REGISTRY_KEY,
    "/v",
    SMART_APP_CONTROL_REGISTRY_VALUE,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return "unknown";
  return parseSmartAppControlState(result.stdout);
}

export function parseDesktopLaunchMode(value: string | null | undefined): DesktopLaunchMode {
  const normalized = value?.trim().toLowerCase() || "auto";
  if (normalized === "auto" || normalized === "native" || normalized === "browser") return normalized;
  throw new Error(`Desktop mode must be auto, native, or browser. Received ${value}.`);
}

export function resolveDesktopLaunchMode(options: {
  requested?: string | null;
  platform?: NodeJS.Platform;
  smartAppControlState?: SmartAppControlState;
} = {}): Exclude<DesktopLaunchMode, "auto"> {
  const requested = parseDesktopLaunchMode(options.requested);
  if (requested !== "auto") return requested;
  const platform = options.platform ?? process.platform;
  const state = options.smartAppControlState ?? detectSmartAppControlState(platform);
  return platform === "win32" && state === "on" ? "browser" : "native";
}

export function resolveEdgeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (candidate: string) => boolean = existsSync,
): string | null {
  const candidates = [
    env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(pathExists) ?? null;
}

export function buildEdgeBrowserAppArgs(boardUrl: string): string[] {
  return [
    `--app=${boardUrl}`,
    "--start-maximized",
    "--no-first-run",
  ];
}

function quoteWindowsArgument(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

function quotePowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildWindowsBrowserAppShortcutScript(options: {
  shortcutPath: string;
  nodePath: string;
  cliEntryPath: string;
  localEnv: string;
  dataDir: string;
  runtimeVersion: string;
  workingDirectory: string;
  iconPath?: string | null;
}): string {
  const args = [
    options.cliEntryPath,
    "--local-env",
    options.localEnv,
    "browser-app",
    "--data-dir",
    options.dataDir,
    "--runtime-version",
    options.runtimeVersion,
  ].map(quoteWindowsArgument).join(" ");
  return [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${quotePowerShellString(options.shortcutPath)})`,
    `$shortcut.TargetPath = ${quotePowerShellString(options.nodePath)}`,
    `$shortcut.Arguments = ${quotePowerShellString(args)}`,
    `$shortcut.WorkingDirectory = ${quotePowerShellString(options.workingDirectory)}`,
    "$shortcut.WindowStyle = 7",
    ...(options.iconPath ? [`$shortcut.IconLocation = ${quotePowerShellString(options.iconPath)}`] : []),
    "$shortcut.Save()",
  ].join("; ");
}

export function createWindowsBrowserAppShortcut(options: {
  nodePath: string;
  cliEntryPath: string;
  localEnv: string;
  dataDir: string;
  runtimeVersion: string;
  workingDirectory: string;
  iconPath?: string | null;
  env?: NodeJS.ProcessEnv;
  spawnSyncImpl?: typeof spawnSync;
}): string {
  const env = options.env ?? process.env;
  const appData = env.APPDATA?.trim() || path.join(homedir(), "AppData", "Roaming");
  const shortcutPath = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Rudder.lnk");
  mkdirSync(path.dirname(shortcutPath), { recursive: true });
  const result = (options.spawnSyncImpl ?? spawnSync)("powershell.exe", [
    "-NoProfile",
    "-Command",
    buildWindowsBrowserAppShortcutScript({
      shortcutPath,
      nodePath: options.nodePath,
      cliEntryPath: options.cliEntryPath,
      localEnv: options.localEnv,
      dataDir: path.resolve(options.dataDir),
      runtimeVersion: options.runtimeVersion,
      workingDirectory: options.workingDirectory,
      iconPath: options.iconPath,
    }),
  ], { stdio: "ignore", windowsHide: true });
  if (result.status !== 0) throw new Error("Could not create the Windows Rudder browser-app shortcut.");
  return shortcutPath;
}

export function launchBrowserAppWindow(
  boardUrl: string,
  options: {
    env?: NodeJS.ProcessEnv;
    spawnImpl?: typeof spawn;
    pathExists?: (candidate: string) => boolean;
  } = {},
): "edge" | "default" {
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawn;
  const edge = resolveEdgeExecutable(env, options.pathExists);
  if (edge) {
    spawnImpl(edge, buildEdgeBrowserAppArgs(boardUrl), {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
    return "edge";
  }
  spawnImpl("cmd.exe", ["/c", "start", "", boardUrl], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  return "default";
}

export function terminateDetachedBrowserAppProcess(
  child: Pick<ReturnType<typeof spawn>, "pid" | "kill">,
  options: {
    platform?: NodeJS.Platform;
    processKill?: (pid: number, signal: NodeJS.Signals) => void;
    spawnSyncImpl?: typeof spawnSync;
  } = {},
): void {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
    child.kill?.("SIGKILL");
    return;
  }

  if ((options.platform ?? process.platform) === "win32") {
    (options.spawnSyncImpl ?? spawnSync)("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  const processKill = options.processKill ?? ((targetPid: number, signal: NodeJS.Signals) => {
    process.kill(targetPid, signal);
  });
  try {
    // Detached children become process-group leaders on Unix; kill the group
    // so a browser-app server cannot leave PostgreSQL or other descendants.
    processKill(-pid, "SIGKILL");
  } catch {
    try {
      processKill(pid, "SIGKILL");
    } catch {
      // The child may have exited between readiness failure and cleanup.
    }
  }
  child.kill?.("SIGKILL");
}

function applyBrowserAppEnvironment(options: BrowserAppCommandOptions = {}): void {
  applyLocalEnvProfile(options);
  applyDataDirOverride(options);
  const profile = resolveActiveLocalEnvProfile() ?? applyLocalEnvProfile({ localEnv: "prod_local" });
  if (!profile) throw new Error("Rudder browser-app requires a local environment profile.");
  process.env.RUDDER_LOCAL_ENV = profile.name;
  process.env.RUDDER_INSTANCE_ID = profile.instanceId;
  process.env.PORT = String(profile.port);
  process.env.RUDDER_EMBEDDED_POSTGRES_PORT = String(profile.embeddedPostgresPort);
  process.env.RUDDER_DEPLOYMENT_MODE = "local_trusted";
  process.env.RUDDER_DEPLOYMENT_EXPOSURE = "private";
  process.env.HOST = "127.0.0.1";
  process.env.SERVE_UI = "true";
  process.env.RUDDER_UI_DEV_MIDDLEWARE = "false";
  process.env.RUDDER_OPEN_ON_LISTEN = "false";
}

async function writeReadyRecord(readyFile: string | undefined, record: BrowserAppReadyRecord): Promise<void> {
  if (!readyFile) return;
  await writeFile(readyFile, `${JSON.stringify(record)}\n`, "utf8");
}

function boardUrlFromServer(startedServer: StartedServer): string {
  return startedServer.apiUrl.replace(/\/api\/?$/u, "");
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function runtimeStillHealthy(apiUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/health", apiUrl), {
      signal: AbortSignal.timeout(1_000),
      headers: { Accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireDesktopTakeoverLease(instanceId: string): (() => void) | null {
  const instanceRoot = describeLocalInstancePaths(instanceId).instanceRoot;
  mkdirSync(instanceRoot, { recursive: true });
  const leaseDir = path.join(instanceRoot, DESKTOP_TAKEOVER_LEASE_DIR);
  const leaseRecordPath = path.join(leaseDir, "owner.json");
  const token = randomUUID();
  const processStartedAt = Math.round(Date.now() - process.uptime() * 1_000);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Directory creation is the ownership transaction. Metadata is written
      // only after that atomic step, and a fresh partial directory is never
      // reclaimed by a concurrent contender.
      mkdirSync(leaseDir);
      try {
        writeFileSync(
          leaseRecordPath,
          `${JSON.stringify({ pid: process.pid, processStartedAt, token })}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        try {
          rmdirSync(leaseDir);
        } catch {
          // Preserve unexpected contents for diagnosis rather than deleting them.
        }
        throw error;
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(leaseRecordPath, "utf8")) as { pid?: number; token?: string };
          if (current.pid !== process.pid || current.token !== token) return;
          unlinkSync(leaseRecordPath);
          rmdirSync(leaseDir);
        } catch {
          // The lease was already removed or replaced; never remove another process's lease.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingPid: number | null = null;
      let existingProcessStartedAt: number | null = null;
      try {
        const existing = JSON.parse(readFileSync(leaseRecordPath, "utf8")) as {
          pid?: number;
          processStartedAt?: number;
        };
        existingPid = typeof existing.pid === "number" ? existing.pid : null;
        existingProcessStartedAt = typeof existing.processStartedAt === "number"
          ? existing.processStartedAt
          : null;
      } catch {
        let ageMs: number;
        try {
          ageMs = Date.now() - statSync(leaseDir).mtimeMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (ageMs < DESKTOP_TAKEOVER_PARTIAL_LEASE_GRACE_MS) return null;
      }
      const sameProcess = existingPid === process.pid
        && existingProcessStartedAt !== null
        && Math.abs(existingProcessStartedAt - processStartedAt) < 2_000;
      if (sameProcess || (existingPid !== null && existingPid !== process.pid && processIsAlive(existingPid))) {
        return null;
      }
      try {
        unlinkSync(leaseRecordPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      try {
        rmdirSync(leaseDir);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function runBrowserAppChild(options: BrowserAppCommandOptions): Promise<void> {
  applyBrowserAppEnvironment(options);
  const runtimeVersion = options.runtimeVersion?.trim() || resolveBrowserAppRuntimeVersion();
  let startedServer: StartedServer | null = null;
  let readyWritten = false;
  let releaseDesktopTakeoverLease: (() => void) | null = null;
  try {
    while (true) {
      startedServer = await startManagedServerFromRuntime({
        version: runtimeVersion,
        // A native Desktop runtime owns the process while it is alive. Never
        // terminate it just to replace a mismatched browser-app version.
        takeoverOnVersionMismatch: false,
      });
      const boardUrl = boardUrlFromServer(startedServer);
      if (!readyWritten) {
        await writeReadyRecord(options.readyFile, {
          ok: true,
          apiUrl: startedServer.apiUrl,
          boardUrl,
          runtimeMode: startedServer.runtime.mode,
        });
        readyWritten = true;
        if (options.open !== false) launchBrowserAppWindow(boardUrl);
      }
      if (startedServer.runtime.mode === "owned") {
        releaseDesktopTakeoverLease?.();
        releaseDesktopTakeoverLease = null;
        await waitForShutdownSignal();
        await startedServer.dispose();
        return;
      }

      if (startedServer.runtime.ownerKind !== "desktop") return;
      releaseDesktopTakeoverLease ??= acquireDesktopTakeoverLease(startedServer.runtime.instanceId);
      if (!releaseDesktopTakeoverLease) return;

      while (await runtimeStillHealthy(startedServer.apiUrl)) {
        await delay(RUNTIME_HEALTH_POLL_MS);
      }
      await delay(500);
    }
  } catch (error) {
    if (!readyWritten) {
      await writeReadyRecord(options.readyFile, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    releaseDesktopTakeoverLease?.();
  }
}

async function readReadyRecord(readyFile: string): Promise<BrowserAppReadyRecord> {
  return JSON.parse(await readFile(readyFile, "utf8")) as BrowserAppReadyRecord;
}

async function waitForReadyRecord(options: {
  readyFile: string;
  child: ReturnType<typeof spawn>;
  logPath: string;
  timeoutMs?: number;
}): Promise<BrowserAppReadyRecord> {
  const timeoutMs = options.timeoutMs ?? BROWSER_APP_READY_TIMEOUT_MS;
  const startedAt = Date.now();
  const childState: {
    stopped: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | null;
  } = { stopped: null };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    childState.stopped = { code, signal };
  };
  const onError = (error: Error) => {
    childState.stopped = { code: null, signal: null, error };
  };
  options.child.once("exit", onExit);
  options.child.once("error", onError);
  try {
    while (Date.now() - startedAt < timeoutMs) {
      try {
        // Read first: an attached child may have completed the handoff and
        // exited between polls, but its record remains authoritative.
        return await readReadyRecord(options.readyFile);
      } catch {
        const stopped = childState.stopped;
        if (stopped) {
          if (stopped.error) {
            throw new Error(`Rudder browser-app process failed before it was ready. See ${options.logPath}.`, {
              cause: stopped.error,
            });
          }
          const outcome = stopped.signal
            ? `signal ${stopped.signal}`
            : `exit code ${stopped.code ?? "unknown"}`;
          throw new Error(
            `Rudder browser-app process stopped before it was ready (${outcome}). See ${options.logPath}.`,
          );
        }
        await delay(200);
      }
    }
    throw new Error("Rudder browser-app did not become ready in time.");
  } finally {
    options.child.off("exit", onExit);
    options.child.off("error", onError);
  }
}

export async function launchDetachedBrowserApp(options: {
  cliEntryPath: string;
  localEnv?: string;
  dataDir?: string;
  runtimeVersion: string;
  open?: boolean;
  nodePath?: string;
  readyTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
  spawnSyncImpl?: typeof spawnSync;
}): Promise<BrowserAppLaunchResult> {
  applyLocalEnvProfile(options);
  applyDataDirOverride(options);
  const localProfile = resolveActiveLocalEnvProfile() ?? applyLocalEnvProfile({ localEnv: "prod_local" });
  if (!localProfile) throw new Error("Rudder browser-app requires a local environment profile.");
  const dataDir = resolveRudderHomeDir();
  const instanceId = resolveRudderInstanceId(localProfile.instanceId);
  const paths = describeLocalInstancePaths(instanceId);
  const logDir = path.join(paths.instanceRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "browser-app.log");
  const readyFile = path.join(tmpdir(), `rudder-browser-app-${process.pid}-${randomUUID()}.json`);
  const logFd = openSync(logPath, "a");
  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ReturnType<typeof spawn> | null = null;
  let launchSucceeded = false;
  try {
    const spawnedChild = spawnImpl(options.nodePath ?? process.execPath, [
      options.cliEntryPath,
      "--local-env",
      localProfile.name,
      "browser-app",
      "--data-dir",
      dataDir,
      "--child",
      "--no-open",
      "--ready-file",
      readyFile,
      "--runtime-version",
      options.runtimeVersion,
    ], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    child = spawnedChild;
    await new Promise<void>((resolve, reject) => {
      spawnedChild.once("spawn", resolve);
      spawnedChild.once("error", reject);
    });
    spawnedChild.unref();
  } catch (error) {
    if (child) {
      terminateDetachedBrowserAppProcess(child, {
        platform: options.platform,
        processKill: options.processKill,
        spawnSyncImpl: options.spawnSyncImpl,
      });
    }
    throw error;
  } finally {
    closeSync(logFd);
  }

  try {
    const ready = await waitForReadyRecord({
      readyFile,
      child: child as ReturnType<typeof spawn>,
      logPath,
      timeoutMs: options.readyTimeoutMs,
    });
    if (!ready.ok || !ready.apiUrl || !ready.boardUrl || !ready.runtimeMode) {
      throw new Error(ready.error || `Rudder browser-app failed to start. See ${logPath}.`);
    }
    const browser = options.open === false ? null : launchBrowserAppWindow(ready.boardUrl);
    launchSucceeded = true;
    return {
      apiUrl: ready.apiUrl,
      boardUrl: ready.boardUrl,
      browser,
      logPath,
      runtimeMode: ready.runtimeMode,
    };
  } finally {
    await rm(readyFile, { force: true });
    if (!launchSucceeded && child) {
      terminateDetachedBrowserAppProcess(child, {
        platform: options.platform,
        processKill: options.processKill,
        spawnSyncImpl: options.spawnSyncImpl,
      });
    }
  }
}

export async function browserAppCommand(options: BrowserAppCommandOptions): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Rudder browser-app compatibility mode is currently available on Windows only.");
  }
  const runtimeVersion = options.runtimeVersion?.trim() || resolveBrowserAppRuntimeVersion();
  if (options.child) {
    await runBrowserAppChild({ ...options, runtimeVersion });
    return;
  }
  const result = await launchDetachedBrowserApp({
    cliEntryPath: process.argv[1],
    localEnv: options.localEnv,
    dataDir: options.dataDir,
    runtimeVersion,
    open: options.open !== false,
  });
  process.stdout.write(
    options.open === false
      ? `Rudder browser-app runtime is ready at ${result.boardUrl} (${result.runtimeMode})\n`
      : `Rudder browser app opened at ${result.boardUrl} (${result.runtimeMode})\n`,
  );
}
