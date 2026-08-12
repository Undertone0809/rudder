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
import {
  DESKTOP_AUTO_UPDATE_INITIAL_DELAY_MS,
  DESKTOP_AUTO_UPDATE_INTERVAL_MS,
  clearAutomaticCandidate,
  hasExactStagedAutomaticArtifact,
  markAutomaticCheckStarted,
  markAutomaticCandidateStatus,
  readDesktopAutoUpdateState,
  resolveDesktopAutoUpdateStatePath,
  scheduleNextAutomaticCheck,
  stageAutomaticCandidate,
  writeDesktopAutoUpdateState,
  type DesktopAutoUpdateCandidate,
} from "./desktop-auto-update-state.js";
import {
  attestExternalDesktopUpdateHelper,
  handoffDesktopUpdateToExternalHelper,
  resolveDesktopUpdateTransactionPaths,
  type DesktopUpdateHelperRequest,
} from "./desktop-update-helper.js";

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
  getUserDataPath?: () => string;
  isAutomaticUpdateAllowed?: () => boolean;
  /** True only when the stable, externally installed updater is attested. */
  hasExternalUpdateHelperCapability?: () => boolean;
  /** True only when an authenticated, replay-protected release policy is loaded. */
  hasSignedUpdatePolicyCapability?: () => boolean;
  /** Refreshes the authenticated policy before an automatic check. */
  refreshSignedUpdatePolicy?: () => Promise<boolean>;
  /** Authorizes the exact immutable release identity selected for staging/apply. */
  authorizeSignedUpdateRelease?: (input: {
    version: string;
    assetName: string;
    assetSha256: string;
    releaseDigest: string;
  }) => boolean;
  /** Prevents downloading a version absent from the authenticated policy. */
  isSignedUpdateVersionAuthorized?: (version: string) => boolean;
  /** Optional explicit helper attestation for tests or an embedding shell. */
  getExternalUpdateHelper?: () => { path: string; protocol: string } | null;
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
  let automaticUpdateTimer: NodeJS.Timeout | null = null;
  let automaticCheckInFlight: Promise<void> | null = null;

  function autoUpdateStatePath(): string {
    return resolveDesktopAutoUpdateStatePath(context.getUserDataPath?.() ?? app.getPath("userData"));
  }

  function readAutomaticState() {
    return readDesktopAutoUpdateState(autoUpdateStatePath());
  }

  function writeAutomaticState(state: ReturnType<typeof readAutomaticState>): void {
    writeDesktopAutoUpdateState(autoUpdateStatePath(), state);
  }

  function automaticInstallId(): string {
    return path.resolve(context.getUserDataPath?.() ?? app.getPath("userData"));
  }

  function clearAutomaticTimer(): void {
    if (!automaticUpdateTimer) return;
    clearTimeout(automaticUpdateTimer);
    automaticUpdateTimer = null;
  }

  async function applyPreparedAutomaticCandidate(): Promise<"handled" | "continue"> {
    if (!app.isPackaged || process.platform !== "darwin" || context.isAutomaticUpdateAllowed?.() === false) return "continue";
    if (context.hasSignedUpdatePolicyCapability?.() !== true) {
      console.warn("[rudder-desktop] automatic update deferred: signed release policy is unavailable");
      return "continue";
    }
    if (context.hasExternalUpdateHelperCapability?.() !== true) {
      console.warn("[rudder-desktop] automatic update deferred: external recovery helper is unavailable");
      return "continue";
    }
    if (context.getBootState().runtime?.mode === "attached") return "continue";
    const state = readAutomaticState();
    const candidate = state.candidate;
    if (!candidate || (candidate.status !== "staged" && candidate.status !== "claimed")) return "continue";
    if (candidate.platform !== "darwin" || candidate.arch !== process.arch) return "continue";
    if (candidate.installId !== automaticInstallId()) return "continue";
    if (!hasExactStagedAutomaticArtifact(candidate)) {
      console.warn("[rudder-desktop] automatic update deferred: staged artifact proof is missing or invalid");
      return "continue";
    }
    if (context.authorizeSignedUpdateRelease && (!candidate.assetName || !candidate.assetChecksum || !candidate.sourceReleaseDigest
      || context.authorizeSignedUpdateRelease({
        version: candidate.version,
        assetName: candidate.assetName,
        assetSha256: candidate.assetChecksum,
        releaseDigest: candidate.sourceReleaseDigest,
      }) !== true)) {
      console.warn("[rudder-desktop] automatic update deferred: candidate is not authorized by the signed release policy");
      return "continue";
    }
    if (candidate.version === resolveRudderAppVersion()) {
      writeAutomaticState(clearAutomaticCandidate(state, candidate.updateId));
      return "continue";
    }

    // Automatic quit must never open the manual blocker prompt. This final
    // read is only a silent race guard for work started after quit began.
    try {
      const activeRuns = await context.listRunningRunsForUpdate();
      if (activeRuns.totalRuns > 0) return "continue";
    } catch (error) {
      console.warn("[rudder-desktop] automatic update blocker inspection failed", error);
      return "continue";
    }

    const transactionId = candidate.updateId;
    const ownerToken = randomUUID();
    const drainToken = randomUUID();
    const bootState = context.getBootState();
    const runtime = bootState.runtime ?? {};
    const instanceId = candidate.instanceId || runtime.instanceId || "default";
    const databaseRevision = String(
      runtime.databaseRevision
      ?? bootState.databaseRevision
      ?? bootState.runtime?.migrationRevision
      ?? runtime.version
      ?? resolveRudderAppVersion(),
    );
    const helper = context.getExternalUpdateHelper?.()
      ?? attestExternalDesktopUpdateHelper({
        userDataPath: context.getUserDataPath?.() ?? app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        env: process.env,
      });
    if (!helper) {
      console.warn("[rudder-desktop] automatic update deferred: external recovery helper is unavailable");
      return "continue";
    }
    const transactionPaths = resolveDesktopUpdateTransactionPaths({
      userDataPath: context.getUserDataPath?.() ?? app.getPath("userData"),
      transactionId,
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
    });
    const request: DesktopUpdateHelperRequest = {
      operation: "apply",
      ownerToken,
      transactionId,
      parentPid: process.pid,
      ...transactionPaths,
      stagedPath: candidate.stagedArtifactPath,
      targetVersion: candidate.version,
      candidateSha256: candidate.stagedArtifactDigest,
      admission: { closed: true, activeRuns: 0, drainToken },
      checkpoint: {
        instanceId,
        databaseRevision,
        migrationCompatible: runtime.migrationCompatible !== false && bootState.migrationCompatible !== false,
      },
    };

    writeAutomaticState({
      ...state,
      generation: state.generation + 1,
      candidate: { ...candidate, status: "claimed", generation: state.generation + 1 },
    });
    try {
      handoffDesktopUpdateToExternalHelper({ request, helperPath: effectiveHelper.path });
      // The helper waits for this Desktop PID to exit before exchanging the
      // bundle, so normal quit finalization must continue immediately.
      return "continue";
    } catch (error) {
      const current = readAutomaticState();
      if (current.candidate?.updateId === candidate.updateId) {
        writeAutomaticState({ ...current, candidate: { ...candidate, status: "staged", generation: current.generation + 1 } });
      }
      console.warn("[rudder-desktop] automatic update helper handoff failed", error);
      return "continue";
    }
  }

  function scheduleAutomaticUpdateCheck(): void {
    clearAutomaticTimer();
    if (
      !app.isPackaged
      || process.platform !== "darwin"
      || context.isAutomaticUpdateAllowed?.() === false
    ) return;
    let state = readAutomaticState();
    const now = new Date();
    if (!state.nextCheckAt) {
      state = scheduleNextAutomaticCheck(state, now);
      writeAutomaticState(state);
    }
    const nextAt = Date.parse(state.nextCheckAt ?? "");
    const delay = Number.isFinite(nextAt) ? Math.max(0, nextAt - now.getTime()) : DESKTOP_AUTO_UPDATE_INITIAL_DELAY_MS;
    automaticUpdateTimer = setTimeout(() => {
      automaticUpdateTimer = null;
      void runAutomaticUpdateCheck();
    }, Math.min(delay, DESKTOP_AUTO_UPDATE_INTERVAL_MS));
    automaticUpdateTimer.unref?.();
  }

  async function prepareAutomaticUpdate(version: string, channel: DesktopUpdateChannel): Promise<void> {
    if (context.hasSignedUpdatePolicyCapability?.() !== true) return;
    if (context.isSignedUpdateVersionAuthorized && !context.isSignedUpdateVersionAuthorized(version)) {
      console.warn("[rudder-desktop] automatic update deferred: version is absent from the signed release policy");
      return;
    }
    const state = readAutomaticState();
    if (state.candidate) return;
    const updateId = randomUUID();
    const childLaunch = resolveDesktopUpdateChildLaunch({
      cliArgs: [
        "start", "--no-cli", "--no-runtime", "--no-open", "--target-version", version,
        "--repo", DESKTOP_GITHUB_REPO, "--no-version-check", "--desktop-progress-json", "--desktop-prepare-only",
      ],
      childEnv: createDesktopUpdateChildEnvironment({ resourcesPath: process.resourcesPath }),
      resourcesPath: process.resourcesPath,
    });
    const child = spawn(childLaunch.command, childLaunch.args, {
      detached: true,
      env: childLaunch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let prepared: {
      assetName?: string;
      assetChecksum?: string;
      releaseDigest?: string;
      stagedArtifactPath?: string;
      stagedArtifactDigest?: string;
    } | null = null;
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseDesktopUpdateProgressLine(updateId, version, line.trim());
        if (event?.phase === "prepared") {
          prepared = {
            assetName: event.assetName,
            assetChecksum: event.assetChecksum,
            releaseDigest: event.releaseDigest,
            stagedArtifactPath: event.stagedArtifactPath,
            stagedArtifactDigest: event.stagedArtifactDigest,
          };
        }
      }
    });
    child.on("close", (code) => {
      if (code !== 0 || !prepared) return;
      const current = readAutomaticState();
      if (!prepared.stagedArtifactPath || !prepared.stagedArtifactDigest) {
        console.warn("[rudder-desktop] automatic update preparation did not return an exact staged artifact proof");
        return;
      }
      if (context.authorizeSignedUpdateRelease && (!prepared.assetName || !prepared.assetChecksum || !prepared.releaseDigest
        || context.authorizeSignedUpdateRelease({
          version,
          assetName: prepared.assetName,
          assetSha256: prepared.assetChecksum,
          releaseDigest: prepared.releaseDigest,
        }) !== true)) {
        console.warn("[rudder-desktop] automatic update preparation is not authorized by the signed release policy");
        return;
      }
      const candidate: DesktopAutoUpdateCandidate = {
        channel,
        version,
        platform: "darwin",
        arch: process.arch,
        installId: automaticInstallId(),
        profile: context.getBootState().runtime?.localEnv ?? "prod_local",
        instanceId: context.getBootState().runtime?.instanceId ?? "default",
        sourceReleaseDigest: prepared.releaseDigest ?? `${channel}:${version}:${prepared.assetChecksum ?? "unknown"}`,
        updateId,
        ...(prepared.assetName ? { assetName: prepared.assetName } : {}),
        ...(prepared.assetChecksum ? { assetChecksum: prepared.assetChecksum } : {}),
        stagedArtifactPath: prepared.stagedArtifactPath,
        stagedArtifactDigest: prepared.stagedArtifactDigest,
        stagedAt: new Date().toISOString(),
        status: "staged",
        generation: current.generation + 1,
      };
      writeAutomaticState(stageAutomaticCandidate(current, candidate));
    });
    child.unref();
  }

  async function runAutomaticUpdateCheck(): Promise<void> {
    if (automaticCheckInFlight) return automaticCheckInFlight;
    automaticCheckInFlight = (async () => {
      if (context.refreshSignedUpdatePolicy && !(await context.refreshSignedUpdatePolicy())) {
        const failedCheckAt = new Date();
        const failedState = markAutomaticCheckStarted(readAutomaticState(), failedCheckAt);
        writeAutomaticState(failedState);
        scheduleAutomaticUpdateCheck();
        return;
      }
      const now = new Date();
      let state = readAutomaticState();
      if (!state.nextCheckAt) state = scheduleNextAutomaticCheck(state, now);
      if (state.nextCheckAt && Date.parse(state.nextCheckAt) > now.getTime()) {
        scheduleAutomaticUpdateCheck();
        return;
      }
      state = markAutomaticCheckStarted(state, now);
      writeAutomaticState(state);
      const result = await checkForUpdates();
      if (result.status === "update-available" && result.latestVersion) {
        await prepareAutomaticUpdate(result.latestVersion, result.channel);
      }
      scheduleAutomaticUpdateCheck();
    })().catch((error) => {
      console.warn("[rudder-desktop] silent automatic update check failed", error);
      scheduleAutomaticUpdateCheck();
    }).finally(() => {
      automaticCheckInFlight = null;
    });
    return automaticCheckInFlight;
  }

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
    | "prepared"
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
    assetName?: string;
    assetChecksum?: string;
    releaseDigest?: string;
    stagedArtifactPath?: string;
    stagedArtifactDigest?: string;
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
      "prepared",
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
      ...(typeof record.assetName === "string" ? { assetName: record.assetName.slice(0, 200) } : {}),
      ...(typeof record.assetChecksum === "string" ? { assetChecksum: record.assetChecksum.slice(0, 128) } : {}),
      ...(typeof record.releaseDigest === "string" ? { releaseDigest: record.releaseDigest.slice(0, 128) } : {}),
      ...(typeof record.stagedArtifactPath === "string" ? { stagedArtifactPath: record.stagedArtifactPath.slice(0, 4096) } : {}),
      ...(typeof record.stagedArtifactDigest === "string" ? { stagedArtifactDigest: record.stagedArtifactDigest.slice(0, 128) } : {}),
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
    if (context.refreshSignedUpdatePolicy && !(await context.refreshSignedUpdatePolicy())) {
      // Keep the startup hook retryable. The hourly timer remains active and
      // will refresh policy again when the network becomes available.
      scheduleAutomaticUpdateCheck();
      return;
    }
    startupUpdateNoticeShown = true;
    const state = readAutomaticState();
    if (!state.nextCheckAt) {
      writeAutomaticState(scheduleNextAutomaticCheck(state, new Date()));
    }
    scheduleAutomaticUpdateCheck();
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

  async function installUpdate(
    version: string | null | undefined,
    options: {
      automatic?: boolean;
      updateId?: string;
      stagedArtifactPath?: string;
      stagedArtifactDigest?: string;
      assetName?: string;
      sourceReleaseDigest?: string;
    } = {},
  ): Promise<DesktopUpdateInstallResult> {
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
    if (options.automatic === true) {
      return {
        status: "unavailable",
        message: "Automatic updates require an exact staged candidate and the external recovery helper.",
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

    const updateId = options.updateId?.trim() || randomUUID();
    const installPromise = Promise.resolve().then(() => installUpdateWithLock(updateId, normalizedVersion, options));
    activeDesktopUpdateAttempt = {
      updateId,
      version: normalizedVersion,
      promise: installPromise,
    };
    return installPromise;
  }

  async function installUpdateWithLock(
    updateId: string,
    normalizedVersion: string,
    options: {
      automatic?: boolean;
      updateId?: string;
      stagedArtifactPath?: string;
      stagedArtifactDigest?: string;
      assetName?: string;
      sourceReleaseDigest?: string;
    } = {},
  ): Promise<DesktopUpdateInstallResult> {
    try {
      updateDesktopUpdateProgress(updateId, normalizedVersion, {
        phase: "starting",
        message: `Starting update to ${formatVersionForDisplay(normalizedVersion)}.`,
      });
      const activeRuns = await context.listRunningRunsForUpdate();
      let waitForActiveRuns = false;
      let forceWhenApplying = false;
      if (activeRuns.totalRuns > 0 && options.automatic !== true) {
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
        ...(options.automatic === true ? ["--no-open"] : []),
        ...(options.automatic === true
          ? [
            "--desktop-asset-path", options.stagedArtifactPath ?? "",
            "--desktop-asset-checksum", options.stagedArtifactDigest ?? "",
            "--desktop-asset-name", options.assetName ?? "",
            "--desktop-release-digest", options.sourceReleaseDigest ?? "",
          ]
          : []),
        "--target-version",
        normalizedVersion,
        "--repo",
        DESKTOP_GITHUB_REPO,
        "--no-version-check",
        "--desktop-progress-json",
        "--desktop-wait-for-apply",
        ...(!forceWhenApplying && options.automatic !== true ? ["--wait-for-active-runs"] : []),
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
        try {
          const automaticState = readAutomaticState();
          if (automaticState.candidate?.updateId === updateId) {
            writeAutomaticState(markAutomaticCandidateStatus(
              automaticState,
              updateId,
              code === 0 ? "committed" : "quarantined",
            ));
          }
        } catch (error) {
          console.warn("[rudder-desktop] failed to finalize automatic update state", error);
        }
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
    scheduleAutomaticUpdateCheck,
    runAutomaticUpdateCheck,
    applyPreparedAutomaticCandidate,
  };
}
