// @ts-nocheck
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DESKTOP_CLI_FLAG } from "./cli-link.js";
import { createDesktopSupportMailtoUrl, DESKTOP_FEEDBACK_EMAIL } from "./desktop-support-mail.js";
import {
  appendBoundedDesktopUpdateOutput,
  summarizeDesktopUpdateChildOutput,
} from "./desktop-update-diagnostics.js";
import {
  clearPostUpdateReloadMarker,
  writePostUpdateReloadMarker,
} from "./post-update-reload.js";
import { createDesktopUpdateChildEnvironment } from "./postgres-runtime.js";
import {
  normalizeDesktopUpdateChannel,
  readDesktopUpdateChannel,
  writeDesktopUpdateChannel,
} from "./update-channel-preference.js";
import {
  checkForRudderDesktopUpdates,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
} from "./update-check.js";

export const DESKTOP_GITHUB_REPO = "Undertone0809/rudder";
const DESKTOP_RELEASES_URL = `https://github.com/${DESKTOP_GITHUB_REPO}/releases`;
export { DESKTOP_FEEDBACK_EMAIL };
export const DESKTOP_UPDATE_QUIT_ARG = "--rudder-update-quit";
export const DESKTOP_UPDATE_FORCE_ARG = "--rudder-update-force";
export const INSTANCE_SETTINGS_GENERAL_PATH = "/instance/settings/general";

export function resolveDesktopUpdateChildLaunch(options: {
  cliArgs: string[];
  childEnv: NodeJS.ProcessEnv;
  execPath?: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const command = options.execPath ?? process.execPath;
  if ((options.platform ?? process.platform) !== "darwin") {
    return {
      command,
      args: [DESKTOP_CLI_FLAG, ...options.cliArgs],
      env: options.childEnv,
    };
  }
  const resourcesPathModule = path.posix;
  const resourcesPath = options.resourcesPath
    ?? resourcesPathModule.resolve(resourcesPathModule.dirname(command), "..", "Resources");
  return {
    command,
    args: [
      resourcesPathModule.join(resourcesPath, "server-package", "desktop-cli-runner.js"),
      ...options.cliArgs,
    ],
    env: {
      ...options.childEnv,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

type DesktopUpdateBlocker = {
  runId: string;
  agentId: string | null;
  agentName: string;
  issueId: string | null;
  organizationId: string;
  organizationName: string;
};
type DesktopUpdateRunSummary = {
  totalRuns: number;
  blockers: DesktopUpdateBlocker[];
};

export function createDesktopUpdateFlow(context: {
  appName: string;
  getMainWindow: () => BrowserWindow | null;
  getServerHandle: () => any;
  getBootState: () => any;
  listRunningRunsForUpdate: () => Promise<DesktopUpdateRunSummary>;
  formatUpdateRunDetail: (summary: DesktopUpdateRunSummary) => string;
  activeRunPollIntervalMs?: number;
  promptForDeferredUpdate?: (prompt: {
    title: string;
    message: string;
    detail: string;
    totalRuns: number;
    blockers: DesktopUpdateBlocker[];
    confirmLabel: string;
    forceLabel: string;
    cancelLabel: string;
  }) => Promise<"wait" | "force" | "cancel" | null | undefined>;
  showMainWindow: () => void;
}) {
  let latestDesktopUpdateProgress: DesktopUpdateProgressEvent | null = null;
  const activeDesktopUpdates = new Map<string, {
    version: string;
    stdin: NodeJS.WritableStream | null;
    blockers: DesktopUpdateBlocker[];
    applyStarted: boolean;
    finalGuardWaiting: boolean;
    forceEscalated: boolean;
    blockerCheckInFlight: boolean;
    blockerPollTimer: NodeJS.Timeout | null;
    invalidate: () => void;
  }>();
  let activeDesktopUpdateAttempt: {
    updateId: string;
    version: string;
    promise: Promise<DesktopUpdateInstallResult>;
  } | null = null;

  function isLocalRuntimeReadyForUpdate(): boolean {
    return Boolean(context.getServerHandle()) && context.getBootState()?.stage === "ready";
  }
  let startupUpdateNoticeShown = false;

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

  type DesktopUpdateApplyOptions = {
    force?: boolean;
  };

  type DesktopUpdateApplyResult =
    | { status: "started"; updateId: string; version: string }
    | { status: "unavailable"; message: string }
    | { status: "failed"; message: string };

  function createFeedbackMailtoUrl(): string {
    const bootState = context.getBootState();
    return createDesktopSupportMailtoUrl({
      version: resolveRudderAppVersion(),
      platform: process.platform,
      arch: process.arch,
      failure: bootState.stage === "error" ? bootState.failure : null,
      profile: bootState.runtime?.localEnv,
      instance: bootState.runtime?.instanceId,
    });
  }

  async function checkForUpdates(): Promise<DesktopUpdateCheckResult> {
    const channel = readDesktopUpdateChannel(app.getPath("userData"));
    return checkForRudderDesktopUpdates({
      currentVersion: resolveRudderAppVersion(),
      appName: app.getName(),
      repo: DESKTOP_GITHUB_REPO,
      releasesUrl: DESKTOP_RELEASES_URL,
      channel,
    });
  }

  function getDesktopUpdateChannel(): DesktopUpdateChannel {
    return readDesktopUpdateChannel(app.getPath("userData"));
  }

  function setDesktopUpdateChannel(channel: unknown): DesktopUpdateChannel {
    return writeDesktopUpdateChannel(app.getPath("userData"), normalizeDesktopUpdateChannel(channel));
  }

  function desktopMessageBoxWindow(): BrowserWindow | undefined {
    return context.getMainWindow() && !context.getMainWindow()!.isDestroyed() ? context.getMainWindow()! : undefined;
  }

  function publishDesktopUpdateProgress(event: DesktopUpdateProgressEvent): void {
    latestDesktopUpdateProgress = event;
    const mainWindow = context.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:update-progress", event);
    }
  }

  function updateDesktopUpdateProgress(
    updateId: string,
    version: string,
    patch: Omit<DesktopUpdateProgressEvent, "updateId" | "version" | "at"> & { at?: string },
  ): void {
    publishDesktopUpdateProgress({
      updateId,
      version,
      ...patch,
      at: patch.at ?? new Date().toISOString(),
    });
  }

  function writePendingPostUpdateReloadMarker(updateId: string, targetVersion: string): void {
    try {
      writePostUpdateReloadMarker(app.getPath("userData"), { updateId, targetVersion });
    } catch (error) {
      console.warn("[rudder-desktop] failed to write post-update reload marker", error);
    }
  }

  function clearPendingPostUpdateReloadMarker(updateId: string): void {
    try {
      clearPostUpdateReloadMarker(app.getPath("userData"), { updateId });
    } catch (error) {
      console.warn("[rudder-desktop] failed to clear post-update reload marker", error);
    }
  }

  function normalizeProgressPercent(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.min(100, Math.floor(value)));
  }

  function normalizeProgressBytes(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.floor(value);
  }

  function normalizeProgressTotalRuns(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value);
  }

  function parseDesktopUpdateProgressLine(
    updateId: string,
    version: string,
    line: string,
  ): DesktopUpdateProgressEvent | null {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof payload !== "object" || payload === null) return null;
    const record = payload as Record<string, unknown>;
    if (record.source !== "rudder-desktop-update") return null;
    if (typeof record.phase !== "string" || typeof record.message !== "string") return null;
    const phase = record.phase as DesktopUpdateProgressPhase;
    if (![
      "starting",
      "resolving_release",
      "downloading_checksums",
      "downloading_asset",
      "verifying_checksum",
      "ready_to_install",
      "waiting_for_active_runs",
      "preparing_restart",
      "closing",
      "complete",
      "failed",
    ].includes(phase)) return null;

    const totalBytes = normalizeProgressBytes(record.totalBytes);
    const transferredBytes = normalizeProgressBytes(record.transferredBytes);
    const totalRuns = normalizeProgressTotalRuns(record.totalRuns);
    return {
      updateId,
      version,
      phase,
      message: record.message,
      ...(normalizeProgressPercent(record.percent) === undefined ? {} : { percent: normalizeProgressPercent(record.percent) }),
      ...(transferredBytes === undefined ? {} : { transferredBytes }),
      ...(totalBytes === undefined ? {} : { totalBytes }),
      ...(totalRuns === undefined ? {} : { totalRuns }),
      ...(typeof record.error === "string" ? { error: record.error.slice(0, 1000) } : {}),
      at: typeof record.at === "string" ? record.at : new Date().toISOString(),
    };
  }

  async function showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const window = desktopMessageBoxWindow();
    return window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }

  function resolveRudderAppVersion(): string {
    return context.getServerHandle()?.runtime.version
      ?? context.getBootState().runtime?.version
      ?? app.getVersion();
  }

  function formatVersionForDisplay(version: string | null | undefined): string {
    if (!version) return "unknown";
    return version.startsWith("v") ? version : `v${version}`;
  }

  function clearActiveDesktopUpdateAttempt(updateId: string): void {
    if (activeDesktopUpdateAttempt?.updateId === updateId) {
      activeDesktopUpdateAttempt = null;
    }
  }

  function reuseActiveDesktopUpdateAttempt(requestedVersion: string): Promise<DesktopUpdateInstallResult> | null {
    const active = activeDesktopUpdateAttempt;
    if (!active) return null;
    if (active.version !== requestedVersion) {
      console.info("[rudder-desktop] update request ignored while another update is active", {
        activeVersion: active.version,
        requestedVersion,
        updateId: active.updateId,
      });
    }
    return active.promise;
  }

  function clearBlockerPoll(updateId: string): void {
    const session = activeDesktopUpdates.get(updateId);
    if (!session?.blockerPollTimer) return;
    clearTimeout(session.blockerPollTimer);
    session.blockerPollTimer = null;
  }

  function scheduleBlockerRefresh(updateId: string): void {
    const session = activeDesktopUpdates.get(updateId);
    if (!session || (session.applyStarted && !session.finalGuardWaiting) || session.blockerPollTimer) return;
    session.blockerPollTimer = setTimeout(() => {
      session.blockerPollTimer = null;
      void refreshRunningBlockersAndApply(updateId);
    }, context.activeRunPollIntervalMs ?? 2_000);
    session.blockerPollTimer.unref?.();
  }

  async function refreshRunningBlockersAndApply(updateId: string): Promise<void> {
    const session = activeDesktopUpdates.get(updateId);
    if (!session || (session.applyStarted && !session.finalGuardWaiting) || session.blockerCheckInFlight) return;
    session.blockerCheckInFlight = true;
    try {
      const summary = await context.listRunningRunsForUpdate();
      const currentSession = activeDesktopUpdates.get(updateId);
      if (!currentSession || (currentSession.applyStarted && !currentSession.finalGuardWaiting)) return;
      currentSession.blockers = summary.blockers;
      if (summary.totalRuns > 0) {
        updateDesktopUpdateProgress(updateId, currentSession.version, {
          phase: "waiting_for_active_runs",
          message:
            `Waiting for ${summary.totalRuns} running agent run${summary.totalRuns === 1 ? "" : "s"} before applying the update.`,
          percent: 100,
          totalRuns: summary.totalRuns,
          blockers: summary.blockers,
          automaticApply: true,
        });
        scheduleBlockerRefresh(updateId);
        return;
      }

      if (currentSession.finalGuardWaiting) {
        currentSession.blockers = [];
        clearBlockerPoll(updateId);
        updateDesktopUpdateProgress(updateId, currentSession.version, {
          phase: "preparing_restart",
          message: "Running work is clear. Completing the final Desktop replacement check...",
          percent: 100,
          automaticApply: true,
        });
        return;
      }
      await applyUpdate(updateId);
    } catch (error) {
      const currentSession = activeDesktopUpdates.get(updateId);
      if (!currentSession || (currentSession.applyStarted && !currentSession.finalGuardWaiting)) return;
      currentSession.blockers = [];
      updateDesktopUpdateProgress(updateId, currentSession.version, {
        phase: "waiting_for_active_runs",
        message: "Rudder could not confirm whether running work is clear. Retrying before applying the update.",
        percent: 100,
        blockers: [],
        automaticApply: true,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleBlockerRefresh(updateId);
    } finally {
      const currentSession = activeDesktopUpdates.get(updateId);
      if (currentSession) currentSession.blockerCheckInFlight = false;
    }
  }

  async function showUpdateInstallFallbackDialog(installResult: Exclude<DesktopUpdateInstallResult, { status: "started" } | { status: "waiting" }>): Promise<void> {
    await showMessageBox({
      type: installResult.status === "blocked" ? "warning" : "error",
      title: context.appName,
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: installResult.status === "blocked" ? "Update paused." : "Update could not start.",
      detail: installResult.message,
    });
  }

  async function promptForDeferredUpdate(summary: DesktopUpdateRunSummary): Promise<"wait" | "force" | "cancel"> {
    const detail = context.formatUpdateRunDetail(summary);
    const message = summary.totalRuns === 1
      ? "There is 1 running agent run in this Rudder instance."
      : `There are ${summary.totalRuns} running agent runs in this Rudder instance.`;
    const prompt = {
      title: context.appName,
      message,
      detail:
        "Rudder can download the installer now, keep running work alive, then apply the update automatically after the runs finish. "
        + "The desktop app may close and reopen automatically when it is safe to replace. "
        + "Choose Stop Runs and Update Now to cancel the listed runs, quit Rudder, and apply the update immediately.\n\n"
        + detail,
      totalRuns: summary.totalRuns,
      blockers: summary.blockers,
      confirmLabel: "Download and Update When Idle",
      forceLabel: "Stop Runs and Update Now",
      cancelLabel: "Cancel",
    };
    const rendererDecision = await context.promptForDeferredUpdate?.(prompt).catch((error) => {
      console.warn("[rudder-desktop] renderer deferred update prompt failed", error);
      return null;
    });
    if (rendererDecision === "wait" || rendererDecision === "force" || rendererDecision === "cancel") {
      return rendererDecision;
    }

    const response = await showMessageBox({
      type: "warning",
      title: context.appName,
      buttons: ["Download and Update When Idle", "Stop Runs and Update Now", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message,
      detail: prompt.detail,
    });

    if (response.response === 0) return "wait";
    if (response.response === 1) return "force";
    return "cancel";
  }

  async function promptToInstallAvailableUpdate(result: DesktopUpdateCheckResult): Promise<void> {
    if (result.status !== "update-available" || !result.latestVersion) return;

    const response = await showMessageBox({
      type: "info",
      title: context.appName,
      buttons: ["Update", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: `Rudder ${formatVersionForDisplay(result.latestVersion)} is available.`,
      detail:
        `You are running ${formatVersionForDisplay(result.currentVersion)}. `
        + (result.channel === "canary"
          ? "The canary update channel is selected, so Rudder will install the newest canary release."
          : "The stable update channel is selected, so Rudder will install the newest stable release."),
    });

    if (response.response !== 0) return;

    const installResult = await installUpdate(result.latestVersion);
    if (installResult.status === "started" || installResult.status === "waiting") return;

    await showUpdateInstallFallbackDialog(installResult);
  }

  async function maybeShowStartupUpdateNotice(): Promise<void> {
    if (startupUpdateNoticeShown || !app.isPackaged || !isLocalRuntimeReadyForUpdate()) return;
    startupUpdateNoticeShown = true;

    const result = await checkForUpdates();
    if (result.status !== "update-available") return;

    await promptToInstallAvailableUpdate(result);
  }

  async function showManualUpdateCheckDialog(): Promise<void> {
    context.showMainWindow();
    if (!isLocalRuntimeReadyForUpdate()) {
      const signedOut = !context.getServerHandle();
      await showMessageBox({
        type: "info",
        title: context.appName,
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: signedOut
          ? "Sign in before checking for updates."
          : "Wait for the Local Workspace to become ready.",
        detail: signedOut
          ? "Rudder will start the Local Workspace after sign-in. Check for updates again when the workspace is ready."
          : "The account session is still connecting. Check for updates again when startup finishes.",
      });
      return;
    }
    const result = await checkForUpdates();

    if (result.status === "update-available") {
      await promptToInstallAvailableUpdate(result);
      return;
    }

    if (result.status === "up-to-date") {
      await showMessageBox({
        type: "info",
        title: context.appName,
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: "Rudder is up to date.",
        detail: `You are running ${formatVersionForDisplay(result.currentVersion)}.`,
      });
      return;
    }

    const response = await showMessageBox({
      type: "warning",
      title: context.appName,
      buttons: ["Open Releases", "OK"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: "Rudder could not check for updates.",
      detail: "Open GitHub Releases to inspect available builds manually.",
    });
    if (response.response === 0) {
      await shell.openExternal(result.releaseUrl ?? DESKTOP_RELEASES_URL);
    }
  }

  async function installUpdate(version: string | null | undefined): Promise<DesktopUpdateInstallResult> {
    const normalizedVersion = version?.trim();
    if (!app.isPackaged) {
      return {
        status: "unavailable",
        message: "In-app updates are available only from packaged Rudder Desktop builds.",
      };
    }
    if (!normalizedVersion) {
      return {
        status: "unavailable",
        message: "The update check did not return a target version.",
      };
    }
    if (!isLocalRuntimeReadyForUpdate()) {
      return {
        status: "blocked",
        message: "Sign in and wait for the Local Workspace to become ready, then start the update again.",
      };
    }

    const existingUpdate = reuseActiveDesktopUpdateAttempt(normalizedVersion);
    if (existingUpdate) return existingUpdate;

    const updateId = randomUUID();
    const installPromise = Promise.resolve().then(() => installUpdateWithLock(updateId, normalizedVersion));
    activeDesktopUpdateAttempt = {
      updateId,
      version: normalizedVersion,
      promise: installPromise,
    };
    return installPromise;
  }

  async function installUpdateWithLock(updateId: string, normalizedVersion: string): Promise<DesktopUpdateInstallResult> {
    try {
      updateDesktopUpdateProgress(updateId, normalizedVersion, {
        phase: "starting",
        message: `Starting update to ${formatVersionForDisplay(normalizedVersion)}.`,
      });
      const activeRuns = await context.listRunningRunsForUpdate();
      let waitForActiveRuns = false;
      let forceWhenApplying = false;
      if (activeRuns.totalRuns > 0) {
        const decision = await promptForDeferredUpdate(activeRuns);
        if (decision === "cancel") {
          updateDesktopUpdateProgress(updateId, normalizedVersion, {
            phase: "failed",
            message: "Update paused because running agent work is still active.",
            totalRuns: activeRuns.totalRuns,
            blockers: activeRuns.blockers,
          });
          clearActiveDesktopUpdateAttempt(updateId);
          return {
            status: "blocked",
            totalRuns: activeRuns.totalRuns,
            message:
              `Rudder has ${activeRuns.totalRuns} running run${activeRuns.totalRuns === 1 ? "" : "s"}.\n\n`
              + `${context.formatUpdateRunDetail(activeRuns)}\n\nRun the update again after running work is finished.`,
          };
        }
        waitForActiveRuns = true;
        forceWhenApplying = decision === "force";
        updateDesktopUpdateProgress(updateId, normalizedVersion, {
          phase: "waiting_for_active_runs",
          message: forceWhenApplying
            ? `Rudder is downloading ${formatVersionForDisplay(normalizedVersion)} and will quit the listed runs when the update is ready.`
            : `Rudder is downloading ${formatVersionForDisplay(normalizedVersion)} and will update automatically after the listed runs finish.`,
          totalRuns: activeRuns.totalRuns,
          blockers: activeRuns.blockers,
          automaticApply: !forceWhenApplying,
        });
      }

      const profileName = context.getBootState().runtime?.localEnv;
      const cliArgs = [
        ...(profileName ? ["--local-env", profileName] : []),
        "start",
        "--no-cli",
        // The Desktop update contract downloads and replaces the portable app.
        // Do not make replacement depend on a separate npm runtime install:
        // that install can stall on registry resolution and leave the updater
        // child alive without ever reaching the apply handoff.
        "--no-runtime",
        "--target-version",
        normalizedVersion,
        "--repo",
        DESKTOP_GITHUB_REPO,
        "--no-version-check",
        "--desktop-progress-json",
        "--desktop-wait-for-apply",
        ...(!forceWhenApplying ? ["--wait-for-active-runs"] : []),
      ];
      const childLaunch = resolveDesktopUpdateChildLaunch({
        cliArgs,
        childEnv: createDesktopUpdateChildEnvironment({
          resourcesPath: process.resourcesPath,
        }),
        resourcesPath: process.resourcesPath,
      });
      const child = spawn(childLaunch.command, childLaunch.args, {
        detached: true,
        env: childLaunch.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let updateChildFinalized = false;
      activeDesktopUpdates.set(updateId, {
        version: normalizedVersion,
        stdin: child.stdin,
        blockers: activeRuns.blockers,
        applyStarted: false,
        finalGuardWaiting: false,
        forceEscalated: false,
        blockerCheckInFlight: false,
        blockerPollTimer: null,
        invalidate: () => {
          updateChildFinalized = true;
        },
      });
      let stdoutBuffer = "";
      let diagnosticStdout = "";
      let diagnosticStderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (updateChildFinalized) return;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseDesktopUpdateProgressLine(updateId, normalizedVersion, line.trim());
          if (event) {
            const session = activeDesktopUpdates.get(updateId);
            if (event.phase === "ready_to_install" && session && !session.applyStarted) {
              publishDesktopUpdateProgress({
                ...event,
                automaticApply: true,
              });
              void refreshRunningBlockersAndApply(updateId);
            } else if (event.phase === "waiting_for_active_runs" && session) {
              session.finalGuardWaiting = true;
              session.blockers = [];
              publishDesktopUpdateProgress({
                ...event,
                automaticApply: true,
              });
              void refreshRunningBlockersAndApply(updateId);
            } else {
              publishDesktopUpdateProgress(event);
            }
          } else {
            diagnosticStdout = appendBoundedDesktopUpdateOutput(diagnosticStdout, `${line}\n`);
          }
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (updateChildFinalized) return;
        const trimmed = chunk.trim();
        if (trimmed) console.warn("[rudder-desktop] update child stderr", trimmed);
        diagnosticStderr = appendBoundedDesktopUpdateOutput(diagnosticStderr, chunk);
      });
      child.on("error", (error) => {
        if (updateChildFinalized) return;
        updateChildFinalized = true;
        clearBlockerPoll(updateId);
        activeDesktopUpdates.delete(updateId);
        clearActiveDesktopUpdateAttempt(updateId);
        clearPendingPostUpdateReloadMarker(updateId);
        updateDesktopUpdateProgress(updateId, normalizedVersion, {
          phase: "failed",
          message: "Update failed to start.",
          error: error.message,
        });
      });
      child.on("close", (code) => {
        if (updateChildFinalized) return;
        updateChildFinalized = true;
        clearBlockerPoll(updateId);
        activeDesktopUpdates.delete(updateId);
        clearActiveDesktopUpdateAttempt(updateId);
        if (stdoutBuffer.trim()) {
          diagnosticStdout = appendBoundedDesktopUpdateOutput(diagnosticStdout, `${stdoutBuffer}\n`);
        }
        if (code && code !== 0) {
          const diagnostic = summarizeDesktopUpdateChildOutput({
            stdout: diagnosticStdout,
            stderr: diagnosticStderr,
          });
          updateDesktopUpdateProgress(updateId, normalizedVersion, {
            phase: "failed",
            message: `Update installer exited with code ${code}.`,
            ...(diagnostic ? { error: diagnostic } : {}),
          });
          clearPendingPostUpdateReloadMarker(updateId);
          return;
        }
        const finalProgress = latestDesktopUpdateProgress?.updateId === updateId ? latestDesktopUpdateProgress : null;
        clearPendingPostUpdateReloadMarker(updateId);
        updateDesktopUpdateProgress(updateId, normalizedVersion, {
          phase: "complete",
          message: finalProgress?.phase === "closing"
            ? finalProgress.message
            : "Rudder Desktop launch handoff completed.",
          percent: 100,
        });
      });
      child.unref();
      if (forceWhenApplying) {
        const applyResult = await applyUpdate(updateId, { force: true });
        if (applyResult.status === "failed") {
          return {
            status: "failed",
            message: applyResult.message,
          };
        }
        return { status: "started", version: normalizedVersion, updateId };
      }
      if (waitForActiveRuns) {
        return {
          status: "waiting",
          version: normalizedVersion,
          updateId,
          totalRuns: activeRuns.totalRuns,
          message:
            `Rudder is downloading ${formatVersionForDisplay(normalizedVersion)} and will update after `
            + `${activeRuns.totalRuns} running run${activeRuns.totalRuns === 1 ? "" : "s"} finish.`,
        };
      }
      return { status: "started", version: normalizedVersion, updateId };
    } catch (error) {
      clearActiveDesktopUpdateAttempt(updateId);
      updateDesktopUpdateProgress(updateId, normalizedVersion ?? "unknown", {
        phase: "failed",
        message: "Update failed to start.",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function applyUpdate(
    updateId: string | null | undefined,
    options: DesktopUpdateApplyOptions = {},
  ): Promise<DesktopUpdateApplyResult> {
    const normalizedUpdateId = updateId?.trim();
    if (!normalizedUpdateId) {
      return { status: "unavailable", message: "No update session was provided." };
    }

    const session = activeDesktopUpdates.get(normalizedUpdateId);
    if (!session?.stdin || session.stdin.destroyed) {
      const version = latestDesktopUpdateProgress?.updateId === normalizedUpdateId
        ? latestDesktopUpdateProgress.version
        : "unknown";
      updateDesktopUpdateProgress(normalizedUpdateId, version, {
        phase: "failed",
        message: "Update session expired.",
        error: "The update session is no longer waiting to apply. Start the update again.",
      });
      return { status: "unavailable", message: "The update session is no longer waiting to apply. Start the update again." };
    }

    if (session.applyStarted && !(options.force && session.finalGuardWaiting && !session.forceEscalated)) {
      return {
        status: "started",
        updateId: normalizedUpdateId,
        version: session.version,
      };
    }

    try {
      const forceEscalation = options.force === true && session.finalGuardWaiting;
      if (!forceEscalation) session.applyStarted = true;
      clearBlockerPoll(normalizedUpdateId);
      if (!forceEscalation) writePendingPostUpdateReloadMarker(normalizedUpdateId, session.version);
      await new Promise<void>((resolve, reject) => {
        session.stdin.write(options.force ? "force-apply\n" : "apply\n", (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (forceEscalation) {
        session.forceEscalated = true;
        session.finalGuardWaiting = false;
      }
      updateDesktopUpdateProgress(normalizedUpdateId, session.version, {
        phase: "preparing_restart",
        message: forceEscalation
          ? "Stopping the newly detected running work and applying the Desktop update..."
          : "Applying the Desktop update. Rudder will close when replacement is ready...",
      });
      return {
        status: "started",
        updateId: normalizedUpdateId,
        version: session.version,
      };
    } catch (error) {
      const forceEscalation = options.force === true && session.finalGuardWaiting;
      if (!forceEscalation) {
        session.applyStarted = false;
        session.invalidate();
        clearBlockerPoll(normalizedUpdateId);
        activeDesktopUpdates.delete(normalizedUpdateId);
        clearActiveDesktopUpdateAttempt(normalizedUpdateId);
        clearPendingPostUpdateReloadMarker(normalizedUpdateId);
        (session.stdin as NodeJS.WritableStream & { destroy?: () => void }).destroy?.();
      }
      const message = error instanceof Error ? error.message : String(error);
      if (forceEscalation) {
        return { status: "failed", message };
      }
      updateDesktopUpdateProgress(normalizedUpdateId, session.version, {
        phase: "failed",
        message: "Update failed to apply.",
        error: message,
      });
      return {
        status: "failed",
        message,
      };
    }
  }


  return {
    checkForUpdates,
    getDesktopUpdateChannel,
    setDesktopUpdateChannel,
    resolveRudderAppVersion,
    maybeShowStartupUpdateNotice,
    showManualUpdateCheckDialog,
    installUpdate,
    applyUpdate,
    createFeedbackMailtoUrl,
    getDesktopUpdateProgress: () => latestDesktopUpdateProgress,
  };
}
