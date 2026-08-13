import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialDesktopAutoUpdateState,
  stageAutomaticCandidate,
  writeDesktopAutoUpdateState,
  type DesktopAutoUpdateCandidate,
} from "./desktop-auto-update-state.js";
import {
  RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV,
  RUDDER_POSTGRES_BIN_DIR_ENV,
} from "./postgres-runtime.js";

const spawnMock = vi.hoisted(() => vi.fn());
const showMessageBoxMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getName: vi.fn(() => "Rudder"),
    getPath: vi.fn(() => "/tmp/rudder-desktop-test"),
    getVersion: vi.fn(() => "0.3.3"),
  },
  BrowserWindow: vi.fn(),
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

const {
  createDesktopUpdateFlow,
  resolveDesktopUpdateChildLaunch,
} = await import("./desktop-update-flow.js");

class MockReadableStream extends EventEmitter {
  setEncoding = vi.fn();
}

function createMockUpdateChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: MockReadableStream;
    stderr: MockReadableStream;
    stdin: { destroyed: boolean; write: (chunk: string, callback?: (error?: Error | null) => void) => void };
    unref: () => void;
  };
  child.stdout = new MockReadableStream();
  child.stderr = new MockReadableStream();
  child.stdin = {
    destroyed: false,
    write: vi.fn((_chunk, callback) => callback?.(null)),
  };
  child.unref = vi.fn();
  return child;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createBlocker(runId: string, organizationName = "Z Studio", agentName = "Codex") {
  return {
    runId,
    agentId: `agent-${runId}`,
    agentName,
    issueId: `issue-${runId}`,
    organizationId: `org-${organizationName}`,
    organizationName,
  };
}

function createRunSummary(blockers: ReturnType<typeof createBlocker>[] = []) {
  return { totalRuns: blockers.length, blockers };
}

function createFlow(overrides: Partial<Parameters<typeof createDesktopUpdateFlow>[0]> = {}) {
  const sentProgressEvents: unknown[] = [];
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, event: unknown) => {
        sentProgressEvents.push(event);
      },
    },
  };
  const flow = createDesktopUpdateFlow({
    appName: "Rudder",
    platform: "darwin",
    getMainWindow: () => mainWindow,
    getServerHandle: () => ({ runtime: { version: "0.3.3" } }),
    getBootState: () => ({ stage: "ready", runtime: { localEnv: "prod_local", version: "0.3.3" } }),
    listRunningRunsForUpdate: async () => createRunSummary(),
    formatUpdateRunDetail: (summary) => summary.blockers
      .map((blocker) => `${blocker.organizationName}: ${blocker.agentName} (run ${blocker.runId})`)
      .join("\n"),
    activeRunPollIntervalMs: 10,
    showMainWindow: vi.fn(),
    ...overrides,
  });
  return { flow, sentProgressEvents };
}

describe("desktop update flow", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    showMessageBoxMock.mockReset();
    fs.rmSync("/tmp/rudder-desktop-test/post-update-reload.json", { force: true });
  });

  it("does not show the startup update notice before the local runtime is ready", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const { flow } = createFlow({ getServerHandle: () => null });

      await flow.maybeShowStartupUpdateNotice();

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps manual and direct update entry points recoverable while signed out", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const { flow } = createFlow({ getServerHandle: () => null });

      await flow.showManualUpdateCheckDialog();
      await expect(flow.installUpdate("0.3.4")).resolves.toEqual({
        status: "blocked",
        message: "Sign in and wait for the Local Workspace to become ready, then start the update again.",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(showMessageBoxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ message: "Sign in before checking for updates." }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("blocks update entry points until the account session is ready", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const { flow } = createFlow({
        getServerHandle: () => ({ runtime: { version: "0.3.3" } }),
        getBootState: () => ({ stage: "account_exchange" }),
      });

      await flow.showManualUpdateCheckDialog();
      await expect(flow.installUpdate("0.3.4")).resolves.toEqual({
        status: "blocked",
        message: "Sign in and wait for the Local Workspace to become ready, then start the update again.",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(showMessageBoxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ message: "Wait for the Local Workspace to become ready." }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("fails closed before spawning an updater when protected blocker inspection is unauthorized", async () => {
    const listRunningRunsForUpdate = vi.fn(async () => {
      throw new Error("Desktop API request failed (401 Unauthorized) for /orgs");
    });
    const { flow } = createFlow({ listRunningRunsForUpdate });

    await expect(flow.installUpdate("0.3.4")).resolves.toEqual({
      status: "failed",
      message: "Desktop API request failed (401 Unauthorized) for /orgs",
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "failed",
      error: "Desktop API request failed (401 Unauthorized) for /orgs",
    });
  });

  it("does not apply a prepared automatic candidate without an external helper", async () => {
    const artifactPath = path.join("/tmp/rudder-desktop-test", "staged.zip");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "staged payload\n", { mode: 0o600 });
    const stagedArtifactDigest = createHash("sha256").update("staged payload\n").digest("hex");
    const candidate: DesktopAutoUpdateCandidate = {
      channel: "stable",
      version: "0.3.4",
      platform: "darwin",
      arch: process.arch,
      installId: path.resolve("/tmp/rudder-desktop-test"),
      profile: "prod_local",
      instanceId: "default",
      sourceReleaseDigest: "release-digest",
      updateId: "automatic-helper-required",
      assetName: "Rudder.zip",
      assetChecksum: stagedArtifactDigest,
      stagedArtifactPath: artifactPath,
      stagedArtifactDigest,
      stagedAt: new Date().toISOString(),
      status: "staged",
      generation: 1,
    };
    const statePath = path.join("/tmp/rudder-desktop-test", "desktop-auto-update.json");
    writeDesktopAutoUpdateState(statePath, stageAutomaticCandidate(createInitialDesktopAutoUpdateState(), candidate));
    try {
      const { flow } = createFlow({ hasSignedUpdatePolicyCapability: () => true });
      await expect(flow.applyPreparedAutomaticCandidate()).resolves.toBe("continue");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(artifactPath, { force: true });
      fs.rmSync(statePath, { force: true });
    }
  });

  it("does not apply a candidate when its staged artifact proof is missing", async () => {
    const candidate: DesktopAutoUpdateCandidate = {
      channel: "stable",
      version: "0.3.4",
      platform: "darwin",
      arch: process.arch,
      installId: path.resolve("/tmp/rudder-desktop-test"),
      profile: "prod_local",
      instanceId: "default",
      sourceReleaseDigest: "release-digest",
      updateId: "automatic-artifact-required",
      stagedAt: new Date().toISOString(),
      status: "staged",
      generation: 1,
    };
    const statePath = path.join("/tmp/rudder-desktop-test", "desktop-auto-update.json");
    writeDesktopAutoUpdateState(statePath, stageAutomaticCandidate(createInitialDesktopAutoUpdateState(), candidate));
    try {
      const { flow } = createFlow({
        hasExternalUpdateHelperCapability: () => true,
        hasSignedUpdatePolicyCapability: () => true,
      });
      await expect(flow.applyPreparedAutomaticCandidate()).resolves.toBe("continue");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it("keeps an exact automatic candidate staged for attached runtimes", async () => {
    const artifactPath = path.join("/tmp/rudder-desktop-test", "attached-staged.zip");
    const artifact = Buffer.from("attached staged payload\n", "utf8");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, artifact, { mode: 0o600 });
    const digest = createHash("sha256").update(artifact).digest("hex");
    const candidate: DesktopAutoUpdateCandidate = {
      channel: "stable",
      version: "0.3.4",
      platform: "darwin",
      arch: process.arch,
      installId: path.resolve("/tmp/rudder-desktop-test"),
      profile: "prod_local",
      instanceId: "default",
      sourceReleaseDigest: "b".repeat(64),
      updateId: "automatic-attached-runtime",
      assetName: "Rudder.zip",
      assetChecksum: digest,
      stagedArtifactPath: artifactPath,
      stagedArtifactDigest: digest,
      stagedAt: new Date().toISOString(),
      status: "staged",
      generation: 1,
    };
    const statePath = path.join("/tmp/rudder-desktop-test", "desktop-auto-update.json");
    writeDesktopAutoUpdateState(statePath, stageAutomaticCandidate(createInitialDesktopAutoUpdateState(), candidate));
    try {
      const { flow } = createFlow({
        getBootState: () => ({
          stage: "ready",
          runtime: { mode: "attached", localEnv: "prod_local", instanceId: "default", version: "0.3.3" },
        }),
        hasExternalUpdateHelperCapability: () => true,
        getExternalUpdateHelper: () => ({ path: "/tmp/rudder-update-helper", protocol: "rudder-update-helper 0.7.5 protocol=1" }),
        hasSignedUpdatePolicyCapability: () => true,
      });

      await expect(flow.applyPreparedAutomaticCandidate()).resolves.toBe("continue");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(artifactPath, { force: true });
      fs.rmSync(statePath, { force: true });
    }
  });

  it("hands the exact candidate to automatic apply only after a clear owned-runtime guard", async () => {
    const artifactPath = path.join("/tmp/rudder-desktop-test", "owned-staged.zip");
    const artifact = Buffer.from("owned staged payload\n", "utf8");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, artifact, { mode: 0o600 });
    const digest = createHash("sha256").update(artifact).digest("hex");
    const releaseDigest = "c".repeat(64);
    const candidate: DesktopAutoUpdateCandidate = {
      channel: "stable",
      version: "0.3.4",
      platform: "darwin",
      arch: process.arch,
      installId: path.resolve("/tmp/rudder-desktop-test"),
      profile: "prod_local",
      instanceId: "default",
      sourceReleaseDigest: releaseDigest,
      updateId: "automatic-owned-runtime",
      assetName: "Rudder.zip",
      assetChecksum: digest,
      stagedArtifactPath: artifactPath,
      stagedArtifactDigest: digest,
      stagedAt: new Date().toISOString(),
      status: "staged",
      generation: 1,
    };
    const statePath = path.join("/tmp/rudder-desktop-test", "desktop-auto-update.json");
    writeDesktopAutoUpdateState(statePath, stageAutomaticCandidate(createInitialDesktopAutoUpdateState(), candidate));
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const listRunningRunsForUpdate = vi.fn(async () => createRunSummary());
    try {
      const { flow } = createFlow({
        getBootState: () => ({
          stage: "ready",
          runtime: { mode: "owned", localEnv: "prod_local", instanceId: "default", version: "0.3.3" },
        }),
        hasExternalUpdateHelperCapability: () => true,
        getExternalUpdateHelper: () => ({ path: "/tmp/rudder-update-helper", protocol: "rudder-update-helper 0.7.5 protocol=1" }),
        hasSignedUpdatePolicyCapability: () => true,
        listRunningRunsForUpdate,
      });

      await expect(flow.applyPreparedAutomaticCandidate()).resolves.toBe("continue");
      expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining("rudder-update-helper"), ["--stdin"], expect.objectContaining({ detached: true }));
      const request = JSON.parse(String(child.stdin.write.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(request).toMatchObject({
        operation: "apply",
        transactionId: candidate.updateId,
        stagedPath: artifactPath,
        candidateSha256: digest,
        targetVersion: candidate.version,
        installPath: expect.any(String),
        lkgPath: expect.stringContaining("update-helper/lkg/Rudder.app"),
        journalPath: expect.stringContaining(`${candidate.updateId}.journal.json`),
        checkpointPath: expect.stringContaining(`${candidate.updateId}.checkpoint.json`),
        admission: { closed: true, activeRuns: 0, drainToken: expect.any(String) },
        checkpoint: { instanceId: "default", databaseRevision: expect.any(String), migrationCompatible: true },
      });
      expect(JSON.stringify(request)).not.toContain("sourceReleaseDigest");
      expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(artifactPath, { force: true });
      fs.rmSync(statePath, { force: true });
    }
  });

  it("does not hand an automatic candidate to apply while running work exists", async () => {
    const artifactPath = path.join("/tmp/rudder-desktop-test", "active-run-staged.zip");
    const artifact = Buffer.from("active run staged payload\n", "utf8");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, artifact, { mode: 0o600 });
    const digest = createHash("sha256").update(artifact).digest("hex");
    const statePath = path.join("/tmp/rudder-desktop-test", "desktop-auto-update.json");
    writeDesktopAutoUpdateState(statePath, stageAutomaticCandidate(createInitialDesktopAutoUpdateState(), {
      channel: "stable",
      version: "0.3.4",
      platform: "darwin",
      arch: process.arch,
      installId: path.resolve("/tmp/rudder-desktop-test"),
      profile: "prod_local",
      instanceId: "default",
      sourceReleaseDigest: "d".repeat(64),
      updateId: "automatic-active-run",
      assetName: "Rudder.zip",
      assetChecksum: digest,
      stagedArtifactPath: artifactPath,
      stagedArtifactDigest: digest,
      stagedAt: new Date().toISOString(),
      status: "staged",
      generation: 1,
    }));
    try {
      const listRunningRunsForUpdate = vi.fn(async () => createRunSummary([createBlocker("run-active")]));
      const { flow } = createFlow({
        getBootState: () => ({
          stage: "ready",
          runtime: { mode: "owned", localEnv: "prod_local", instanceId: "default", version: "0.3.3" },
        }),
        hasExternalUpdateHelperCapability: () => true,
        hasSignedUpdatePolicyCapability: () => true,
        listRunningRunsForUpdate,
      });

      await expect(flow.applyPreparedAutomaticCandidate()).resolves.toBe("continue");
      expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(1);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(artifactPath, { force: true });
      fs.rmSync(statePath, { force: true });
    }
  });

  it("uses the Node-mode CLI runner for macOS update children", () => {
    const launch = resolveDesktopUpdateChildLaunch({
      cliArgs: ["start", "--target-version", "0.6.2"],
      childEnv: { RUDDER_HOME: "/tmp/rudder-home" },
      execPath: "/Applications/Rudder.app/Contents/MacOS/Rudder",
      resourcesPath: "/Applications/Rudder.app/Contents/Resources",
      platform: "darwin",
    });

    expect(launch.command).toBe("/Applications/Rudder.app/Contents/MacOS/Rudder");
    expect(launch.args).toEqual([
      "/Applications/Rudder.app/Contents/Resources/server-package/desktop-cli-runner.js",
      "start",
      "--target-version",
      "0.6.2",
    ]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("keeps the desktop CLI flag for non-macOS update children", () => {
    const launch = resolveDesktopUpdateChildLaunch({
      cliArgs: ["start", "--target-version", "0.6.2"],
      childEnv: {},
      execPath: "/opt/Rudder/rudder",
      platform: "linux",
    });

    expect(launch.args).toEqual([
      "--desktop-cli",
      "start",
      "--target-version",
      "0.6.2",
    ]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("waits for child close before publishing final failed update diagnostics", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    await expect(flow.installUpdate("0.3.4")).resolves.toMatchObject({
      status: "started",
      version: "0.3.4",
    });

    child.emit("exit", 1);
    child.stderr.emit("data", "No checksummed Rudder Desktop asset found\n");
    child.emit("close", 1);

    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "failed",
      message: "Update installer exited with code 1.",
      error: "No checksummed Rudder Desktop asset found",
    });
  });

  it("does not overwrite a child spawn error when close also fires", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    await flow.installUpdate("0.3.4");
    child.emit("error", new Error("spawn EACCES"));
    child.stderr.emit("data", "later stderr\n");
    child.emit("close", 1);

    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "failed",
      message: "Update failed to start.",
      error: "spawn EACCES",
    });
  });

  it("publishes a terminal complete event when the update child exits successfully", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    await flow.installUpdate("0.3.4");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "closing",
      message: "Rudder Desktop launched.",
      percent: 100,
    })}\n`);
    child.emit("close", 0);

    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "complete",
      message: "Rudder Desktop launched.",
      percent: 100,
    });
  });

  it("does not pass an incomplete Desktop-managed PostgreSQL path to the update child", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const previousPostgresBinDir = process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
    const previousManagedPostgresBinDir = process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];
    const managedBinDir = path.join("/tmp/previous-rudder-resources", "postgres-18.4", "darwin-arm64", "bin");
    process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = managedBinDir;
    process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] = managedBinDir;

    try {
      const { flow } = createFlow();
      await flow.installUpdate("0.3.4");

      const spawnOptions = spawnMock.mock.calls[0]?.[2];
      expect(spawnOptions.env[RUDDER_POSTGRES_BIN_DIR_ENV]).toBeUndefined();
      expect(spawnOptions.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]).toBeUndefined();
    } finally {
      if (previousPostgresBinDir === undefined) {
        delete process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
      } else {
        process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = previousPostgresBinDir;
      }
      if (previousManagedPostgresBinDir === undefined) {
        delete process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];
      } else {
        process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] = previousManagedPostgresBinDir;
      }
    }
  });

  it("clears the post-update reload marker when an applied update child exits successfully", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    const installResult = await flow.installUpdate("0.3.4");
    await expect(flow.applyUpdate(installResult.updateId)).resolves.toMatchObject({
      status: "started",
    });
    const markerPath = path.join("/tmp/rudder-desktop-test", "post-update-reload.json");
    expect(fs.existsSync(markerPath)).toBe(true);

    child.emit("close", 0);

    expect(fs.existsSync(markerPath)).toBe(false);
    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "complete",
    });
  });

  it("clears the post-update reload marker when an applied update child fails", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    const installResult = await flow.installUpdate("0.3.4");
    await flow.applyUpdate(installResult.updateId);
    const markerPath = path.join("/tmp/rudder-desktop-test", "post-update-reload.json");
    expect(fs.existsSync(markerPath)).toBe(true);

    child.stderr.emit("data", "replace failed\n");
    child.emit("close", 1);

    expect(fs.existsSync(markerPath)).toBe(false);
    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "failed",
      error: "replace failed",
    });
  });

  it("reuses the active update attempt instead of starting a second version download", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const activeRuns = createDeferred<ReturnType<typeof createRunSummary>>();
    const { flow } = createFlow({
      listRunningRunsForUpdate: vi.fn(() => activeRuns.promise),
    });

    const firstInstall = flow.installUpdate("0.3.5-canary.8");
    const secondInstall = flow.installUpdate("0.3.5-canary.9");
    expect(spawnMock).not.toHaveBeenCalled();

    activeRuns.resolve(createRunSummary());
    const [firstResult, secondResult] = await Promise.all([firstInstall, secondInstall]);

    expect(firstResult).toMatchObject({
      status: "started",
      version: "0.3.5-canary.8",
      updateId: secondResult.updateId,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("clears the active attempt when setup fails synchronously", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    let failProgressSend = true;
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: () => {
          if (failProgressSend) throw new Error("send failed");
        },
      },
    };
    const { flow } = createFlow({
      getMainWindow: () => mainWindow,
    });

    await expect(flow.installUpdate("0.3.5-canary.8")).rejects.toThrow("send failed");

    failProgressSend = false;
    await expect(flow.installUpdate("0.3.5-canary.9")).resolves.toMatchObject({
      status: "started",
      version: "0.3.5-canary.9",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("applies automatically after ready when no running blockers exist", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    await expect(flow.installUpdate("0.3.5-canary.8")).resolves.toMatchObject({
      status: "started",
    });
    expect(spawnMock.mock.calls[0]?.[1]).toContain("--wait-for-active-runs");
    expect(spawnMock.mock.calls[0]?.[1]).toContain("--no-runtime");

    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);

    await vi.waitFor(() => {
      expect(child.stdin.write).toHaveBeenCalledWith("apply\n", expect.any(Function));
    });
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(flow.getDesktopUpdateProgress()).toMatchObject({ phase: "preparing_restart" });
  });

  it("does not spawn the Node installer for a direct automatic update request", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    await expect(flow.installUpdate("0.3.5-canary.8", { automatic: true })).resolves.toMatchObject({
      status: "unavailable",
    });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("waits for a blocker discovered at ready time and applies after it clears", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const blocker = createBlocker("run-new", "Remote Org", "Wesley");
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary())
      .mockResolvedValueOnce(createRunSummary([blocker]))
      .mockResolvedValueOnce(createRunSummary());
    const { flow, sentProgressEvents } = createFlow({
      listRunningRunsForUpdate,
      activeRunPollIntervalMs: 1,
    });

    await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);

    await vi.waitFor(() => {
      expect(child.stdin.write).toHaveBeenCalledWith("apply\n", expect.any(Function));
    });
    expect(sentProgressEvents).toContainEqual(expect.objectContaining({
      phase: "waiting_for_active_runs",
      totalRuns: 1,
      blockers: [blocker],
      automaticApply: true,
    }));
    expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(3);
  });

  it("replaces stale blocker identity while waiting and writes apply once", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const blockerA = createBlocker("run-a", "Org A", "Mia");
    const blockerB = createBlocker("run-b", "Org B", "Wesley");
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary([blockerA]))
      .mockResolvedValueOnce(createRunSummary([blockerB]))
      .mockResolvedValueOnce(createRunSummary());
    const { flow, sentProgressEvents } = createFlow({
      listRunningRunsForUpdate,
      promptForDeferredUpdate: vi.fn(async () => "wait"),
      activeRunPollIntervalMs: 1,
    });

    await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Duplicate ready event.",
      percent: 100,
    })}\n`);

    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(1));
    expect(sentProgressEvents).toContainEqual(expect.objectContaining({
      phase: "waiting_for_active_runs",
      blockers: [blockerB],
    }));
  });

  it("fails closed and retries when the ready-time blocker query fails", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary())
      .mockRejectedValueOnce(new Error("run inspection unavailable"))
      .mockResolvedValueOnce(createRunSummary());
    const { flow, sentProgressEvents } = createFlow({
      listRunningRunsForUpdate,
      activeRunPollIntervalMs: 1,
    });

    await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);

    await vi.waitFor(() => {
      expect(sentProgressEvents).toContainEqual(expect.objectContaining({
        phase: "waiting_for_active_runs",
        error: "run inspection unavailable",
      }));
    });
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledWith("apply\n", expect.any(Function)));
  });

  it("hides stale blocker identity and force controls until a failed refresh recovers", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const staleBlocker = createBlocker("run-stale", "Old Org", "Mia");
    const currentBlocker = createBlocker("run-current", "Current Org", "Wesley");
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary([staleBlocker]))
      .mockRejectedValueOnce(new Error("run inspection unavailable"))
      .mockResolvedValue(createRunSummary([currentBlocker]));
    const { flow, sentProgressEvents } = createFlow({
      listRunningRunsForUpdate,
      promptForDeferredUpdate: vi.fn(async () => "wait"),
      activeRunPollIntervalMs: 1,
    });

    await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);

    const readyEvent = sentProgressEvents.find((event) => (
      typeof event === "object"
      && event !== null
      && "phase" in event
      && event.phase === "ready_to_install"
    ));
    expect(readyEvent).not.toHaveProperty("blockers");
    expect(readyEvent).not.toHaveProperty("totalRuns");

    await vi.waitFor(() => expect(sentProgressEvents).toContainEqual(expect.objectContaining({
      phase: "waiting_for_active_runs",
      error: "run inspection unavailable",
      blockers: [],
    })));
    const failedInspectionEvent = sentProgressEvents.find((event) => (
      typeof event === "object"
      && event !== null
      && "error" in event
      && event.error === "run inspection unavailable"
    ));
    expect(failedInspectionEvent).not.toHaveProperty("totalRuns");
    await vi.waitFor(() => expect(sentProgressEvents).toContainEqual(expect.objectContaining({
      phase: "waiting_for_active_runs",
      blockers: [currentBlocker],
      totalRuns: 1,
    })));

    child.emit("close", 1);
  });

  it("stops blocker polling when the update child closes", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const blocker = createBlocker("run-close");
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary())
      .mockResolvedValue(createRunSummary([blocker]));
    const { flow } = createFlow({
      listRunningRunsForUpdate,
      activeRunPollIntervalMs: 10,
    });

    await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);
    await vi.waitFor(() => expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(2));

    child.emit("close", 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(2);
  });

  it("stops blocker polling when the update child errors", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const blocker = createBlocker("run-error");
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary())
      .mockResolvedValue(createRunSummary([blocker]));
    const { flow } = createFlow({
      listRunningRunsForUpdate,
      activeRunPollIntervalMs: 10,
    });

    await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);
    await vi.waitFor(() => expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(2));

    child.emit("error", new Error("spawn failed"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(2);
  });

  it("refreshes final-guard blockers and lets the operator escalate to force apply", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const lateBlocker = createBlocker("run-late", "Late Org", "Wesley");
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary())
      .mockResolvedValueOnce(createRunSummary())
      .mockResolvedValueOnce(createRunSummary([lateBlocker]));
    const { flow, sentProgressEvents } = createFlow({
      listRunningRunsForUpdate,
    });

    const installResult = await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledWith("apply\n", expect.any(Function)));

    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "waiting_for_active_runs",
      message: "Waiting for 1 running agent run before replacing Desktop.",
      totalRuns: 1,
    })}\n`);
    await vi.waitFor(() => expect(sentProgressEvents).toContainEqual(expect.objectContaining({
      phase: "waiting_for_active_runs",
      blockers: [lateBlocker],
      totalRuns: 1,
    })));

    await expect(flow.applyUpdate(installResult.updateId, { force: true })).resolves.toMatchObject({
      status: "started",
    });
    expect(child.stdin.write).toHaveBeenCalledWith("force-apply\n", expect.any(Function));
    expect(child.stdin.write).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying blocker identity when final-guard inspection fails", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const lateBlocker = createBlocker("run-late", "Late Org", "Wesley");
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary())
      .mockResolvedValueOnce(createRunSummary())
      .mockRejectedValueOnce(new Error("final guard inspection unavailable"))
      .mockResolvedValueOnce(createRunSummary([lateBlocker]));
    const { flow, sentProgressEvents } = createFlow({
      listRunningRunsForUpdate,
      activeRunPollIntervalMs: 1,
    });

    await flow.installUpdate("0.3.5-canary.8");
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledWith("apply\n", expect.any(Function)));

    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "waiting_for_active_runs",
      message: "Waiting for 1 running agent run before replacing Desktop.",
      totalRuns: 1,
    })}\n`);

    await vi.waitFor(() => expect(sentProgressEvents).toContainEqual(expect.objectContaining({
      phase: "waiting_for_active_runs",
      error: "final guard inspection unavailable",
    })));
    await vi.waitFor(() => expect(sentProgressEvents).toContainEqual(expect.objectContaining({
      phase: "waiting_for_active_runs",
      blockers: [lateBlocker],
      totalRuns: 1,
    })));
    expect(listRunningRunsForUpdate.mock.calls.length).toBeGreaterThanOrEqual(4);

    child.emit("close", 1);
    const callsAfterClose = listRunningRunsForUpdate.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(callsAfterClose);
  });

  it("releases an update session when the initial apply signal cannot be written", async () => {
    const firstChild = createMockUpdateChild();
    firstChild.stdin.write = vi.fn((_chunk, callback) => callback?.(new Error("stdin closed")));
    const secondChild = createMockUpdateChild();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const { flow } = createFlow();

    await flow.installUpdate("0.3.5-canary.8");
    firstChild.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);
    await vi.waitFor(() => expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "failed",
      error: "stdin closed",
    }));

    const secondResult = await flow.installUpdate("0.3.5-canary.8");
    expect(secondResult).toMatchObject({
      status: "started",
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);

    secondChild.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);
    await vi.waitFor(() => expect(secondChild.stdin.write).toHaveBeenCalledWith("apply\n", expect.any(Function)));
    const markerPath = path.join("/tmp/rudder-desktop-test", "post-update-reload.json");
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
      updateId: secondResult.updateId,
    });

    firstChild.stderr.emit("data", "late old child failure\n");
    firstChild.emit("close", 1);
    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      updateId: secondResult.updateId,
      phase: "preparing_restart",
    });
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
      updateId: secondResult.updateId,
    });
  });

  it("lets the operator force apply a deferred update despite active runs", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow({
      listRunningRunsForUpdate: vi.fn(async () => createRunSummary([
        createBlocker("run-1"),
        createBlocker("run-2"),
      ])),
      promptForDeferredUpdate: vi.fn(async () => "wait"),
    });

    const installResult = await flow.installUpdate("0.3.5-canary.8");
    expect(installResult).toMatchObject({
      status: "waiting",
      totalRuns: 2,
    });

    await expect(flow.applyUpdate(installResult.updateId, { force: true })).resolves.toMatchObject({
      status: "started",
      version: "0.3.5-canary.8",
    });

    expect(child.stdin.write).toHaveBeenCalledWith("force-apply\n", expect.any(Function));
  });

  it("refreshes blockers at ready time and applies automatically when running work finished", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const listRunningRunsForUpdate = vi.fn()
      .mockResolvedValueOnce(createRunSummary([createBlocker("run-1"), createBlocker("run-2")]))
      .mockResolvedValueOnce(createRunSummary());
    const { flow } = createFlow({
      listRunningRunsForUpdate,
      promptForDeferredUpdate: vi.fn(async () => "wait"),
    });

    await expect(flow.installUpdate("0.3.5-canary.8")).resolves.toMatchObject({
      status: "waiting",
      totalRuns: 2,
    });

    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "downloading_asset",
      message: "Downloading desktop asset...",
      percent: 42,
    })}\n`);
    child.stdout.emit("data", `${JSON.stringify({
      source: "rudder-desktop-update",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
    })}\n`);

    await vi.waitFor(() => {
      expect(child.stdin.write).toHaveBeenCalledWith("apply\n", expect.any(Function));
    });
    expect(listRunningRunsForUpdate).toHaveBeenCalledTimes(2);
    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "preparing_restart",
    });
    expect(flow.getDesktopUpdateProgress()).not.toHaveProperty("totalRuns");
    expect(flow.getDesktopUpdateProgress()).not.toHaveProperty("blockers");
  });

  it("force-applies immediately when the deferred update prompt chooses quit and update now", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow({
      listRunningRunsForUpdate: vi.fn(async () => createRunSummary([
        createBlocker("run-1"),
        createBlocker("run-2"),
      ])),
      promptForDeferredUpdate: vi.fn(async () => "force"),
    });

    await expect(flow.installUpdate("0.3.5-canary.8")).resolves.toMatchObject({
      status: "started",
      version: "0.3.5-canary.8",
    });

    expect(child.stdin.write).toHaveBeenCalledWith("force-apply\n", expect.any(Function));
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain("--wait-for-active-runs");
  });

  it("reuses the waiting result when an update is deferred for active runs", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow({
      listRunningRunsForUpdate: vi.fn(async () => createRunSummary([
        createBlocker("run-1"),
        createBlocker("run-2"),
      ])),
      promptForDeferredUpdate: vi.fn(async () => "wait"),
    });

    const firstResult = await flow.installUpdate("0.3.5-canary.8");
    const secondResult = await flow.installUpdate("0.3.5-canary.9");

    expect(secondResult).toMatchObject({
      status: "waiting",
      version: "0.3.5-canary.8",
      updateId: firstResult.updateId,
      totalRuns: 2,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a spawned update child exclusive while it is downloading or waiting to apply", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow();

    const firstResult = await flow.installUpdate("0.3.5-canary.8");
    const secondResult = await flow.installUpdate("0.3.5-canary.9");

    expect(secondResult).toMatchObject({
      status: "started",
      version: "0.3.5-canary.8",
      updateId: firstResult.updateId,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("releases the update lock after the child closes so a later update can start", async () => {
    const firstChild = createMockUpdateChild();
    const secondChild = createMockUpdateChild();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const { flow } = createFlow();

    await expect(flow.installUpdate("0.3.5-canary.8")).resolves.toMatchObject({
      status: "started",
      version: "0.3.5-canary.8",
    });

    firstChild.emit("close", 0);

    await expect(flow.installUpdate("0.3.5-canary.9")).resolves.toMatchObject({
      status: "started",
      version: "0.3.5-canary.9",
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
