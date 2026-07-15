// @ts-nocheck
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

type ActiveRunSummary = any;

export function createDesktopUpdateFlow(context: {
  appName: string;
  getMainWindow: () => BrowserWindow | null;
  getServerHandle: () => any;
  getBootState: () => any;
  listActiveRunsForQuit: () => Promise<ActiveRunSummary>;
  formatQuitRunDetail: (summary: ActiveRunSummary) => string;
  promptForDeferredUpdate?: (prompt: {
    title: string;
    message: string;
    detail: string;
    totalRuns: number;
    confirmLabel: string;
    forceLabel: string;
    cancelLabel: string;
  }) => Promise<"wait" | "force" | "cancel" | null | undefined>;
  showMainWindow: () => void;
}) {
  let latestDesktopUpdateProgress: DesktopUpdateProgressEvent | null = null;
  const activeDesktopUpdates = new Map<string, { version: string; stdin: NodeJS.WritableStream | null; totalRuns?: number }>();
  let activeDesktopUpdateAttempt: {
    updateId: string;
    version: string;
    promise: Promise<DesktopUpdateInstallResult>;
  } | null = null;
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
    const activeUpdate = activeDesktopUpdates.get(event.updateId);
    const nextEvent: DesktopUpdateProgressEvent = {
      ...event,
      ...(event.totalRuns === undefined
        && activeUpdate?.totalRuns !== undefined
        && (event.phase === "ready_to_install" || event.phase === "preparing_restart")
        ? { totalRuns: activeUpdate.totalRuns }
        : {}),
      ...(event.totalRuns === undefined
        && activeUpdate?.totalRuns === undefined
        && latestDesktopUpdateProgress?.updateId === event.updateId
        && latestDesktopUpdateProgress.totalRuns !== undefined
        && (event.phase === "ready_to_install" || event.phase === "preparing_restart")
        ? { totalRuns: latestDesktopUpdateProgress.totalRuns }
        : {}),
    };
    latestDesktopUpdateProgress = nextEvent;
    const mainWindow = context.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:update-progress", nextEvent);
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

  function clearPendingPostUpdateReloadMarker(): void {
    try {
      clearPostUpdateReloadMarker(app.getPath("userData"));
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

  async function promptForDeferredUpdate(summary: ActiveRunSummary): Promise<"wait" | "force" | "cancel"> {
    const detail = context.formatQuitRunDetail(summary);
    const message = summary.totalRuns === 1
      ? "There is 1 active agent run."
      : `There are ${summary.totalRuns} active agent runs.`;
    const prompt = {
      title: context.appName,
      message,
      detail:
        "Rudder can download the installer now, keep active work running, then apply the update after the runs finish. "
        + "The desktop app may close and reopen automatically when it is safe to replace. "
        + "Choose Stop Runs and Update Now to cancel active runs, quit Rudder, and apply the update immediately.\n\n"
        + detail,
      totalRuns: summary.totalRuns,
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
    if (startupUpdateNoticeShown || !app.isPackaged) return;
    startupUpdateNoticeShown = true;

    const result = await checkForUpdates();
    if (result.status !== "update-available") return;

    await promptToInstallAvailableUpdate(result);
  }

  async function showManualUpdateCheckDialog(): Promise<void> {
    context.showMainWindow();
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
      const activeRuns = await context.listActiveRunsForQuit();
      let waitForActiveRuns = false;
      let forceWhenApplying = false;
      if (activeRuns.totalRuns > 0) {
        const decision = await promptForDeferredUpdate(activeRuns);
        if (decision === "cancel") {
          updateDesktopUpdateProgress(updateId, normalizedVersion, {
            phase: "failed",
            message: "Update paused because active runs are still running.",
            totalRuns: activeRuns.totalRuns,
          });
          clearActiveDesktopUpdateAttempt(updateId);
          return {
            status: "blocked",
            totalRuns: activeRuns.totalRuns,
            message:
              `Rudder has ${activeRuns.totalRuns} active run${activeRuns.totalRuns === 1 ? "" : "s"}.\n\n`
              + `${context.formatQuitRunDetail(activeRuns)}\n\nRun the update again after active work is finished.`,
          };
        }
        waitForActiveRuns = true;
        forceWhenApplying = decision === "force";
        updateDesktopUpdateProgress(updateId, normalizedVersion, {
          phase: "waiting_for_active_runs",
          message: forceWhenApplying
            ? `Rudder is downloading ${formatVersionForDisplay(normalizedVersion)} and will quit active runs when the update is ready.`
            : `Rudder is downloading ${formatVersionForDisplay(normalizedVersion)} and will update after active runs finish.`,
          totalRuns: activeRuns.totalRuns,
        });
      }

      const profileName = context.getBootState().runtime?.localEnv;
      const args = [
        DESKTOP_CLI_FLAG,
        ...(profileName ? ["--local-env", profileName] : []),
        "start",
        "--no-cli",
        "--target-version",
        normalizedVersion,
        "--repo",
        DESKTOP_GITHUB_REPO,
        "--no-version-check",
        "--desktop-progress-json",
        "--desktop-wait-for-apply",
        ...(waitForActiveRuns && !forceWhenApplying ? ["--wait-for-active-runs"] : []),
      ];
      const child = spawn(process.execPath, args, {
        detached: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      activeDesktopUpdates.set(updateId, {
        version: normalizedVersion,
        stdin: child.stdin,
        ...(waitForActiveRuns && activeRuns.totalRuns > 0 ? { totalRuns: activeRuns.totalRuns } : {}),
      });
      let stdoutBuffer = "";
      let diagnosticStdout = "";
      let diagnosticStderr = "";
      let updateChildFinalized = false;
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseDesktopUpdateProgressLine(updateId, normalizedVersion, line.trim());
          if (event) {
            publishDesktopUpdateProgress(event);
          } else {
            diagnosticStdout = appendBoundedDesktopUpdateOutput(diagnosticStdout, `${line}\n`);
          }
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        const trimmed = chunk.trim();
        if (trimmed) console.warn("[rudder-desktop] update child stderr", trimmed);
        diagnosticStderr = appendBoundedDesktopUpdateOutput(diagnosticStderr, chunk);
      });
      child.on("error", (error) => {
        updateChildFinalized = true;
        activeDesktopUpdates.delete(updateId);
        clearActiveDesktopUpdateAttempt(updateId);
        clearPendingPostUpdateReloadMarker();
        updateDesktopUpdateProgress(updateId, normalizedVersion, {
          phase: "failed",
          message: "Update failed to start.",
          error: error.message,
        });
      });
      child.on("close", (code) => {
        if (updateChildFinalized) return;
        updateChildFinalized = true;
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
          clearPendingPostUpdateReloadMarker();
          return;
        }
        const finalProgress = latestDesktopUpdateProgress?.updateId === updateId ? latestDesktopUpdateProgress : null;
        clearPendingPostUpdateReloadMarker();
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
            + `${activeRuns.totalRuns} active run${activeRuns.totalRuns === 1 ? "" : "s"} finish.`,
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

    try {
      writePendingPostUpdateReloadMarker(normalizedUpdateId, session.version);
      await new Promise<void>((resolve, reject) => {
        session.stdin.write(options.force ? "force-apply\n" : "apply\n", (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      updateDesktopUpdateProgress(normalizedUpdateId, session.version, {
        phase: "preparing_restart",
        message: "Applying the Desktop update. Rudder will close when replacement is ready...",
      });
      return {
        status: "started",
        updateId: normalizedUpdateId,
        version: session.version,
      };
    } catch (error) {
      clearPendingPostUpdateReloadMarker();
      const message = error instanceof Error ? error.message : String(error);
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
