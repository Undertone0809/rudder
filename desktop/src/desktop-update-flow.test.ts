import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
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
    showMessageBox: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

const { createDesktopUpdateFlow } = await import("./desktop-update-flow.js");

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
    getMainWindow: () => mainWindow,
    getServerHandle: () => ({ runtime: { version: "0.3.3" } }),
    getBootState: () => ({ runtime: { localEnv: "prod_local", version: "0.3.3" } }),
    listActiveRunsForQuit: async () => ({ totalRuns: 0 }),
    formatQuitRunDetail: () => "",
    showMainWindow: vi.fn(),
    ...overrides,
  });
  return { flow, sentProgressEvents };
}

describe("desktop update flow", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    fs.rmSync("/tmp/rudder-desktop-test/post-update-reload.json", { force: true });
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
    const activeRuns = createDeferred<{ totalRuns: number }>();
    const { flow } = createFlow({
      listActiveRunsForQuit: vi.fn(() => activeRuns.promise),
    });

    const firstInstall = flow.installUpdate("0.3.5-canary.8");
    const secondInstall = flow.installUpdate("0.3.5-canary.9");
    expect(spawnMock).not.toHaveBeenCalled();

    activeRuns.resolve({ totalRuns: 0 });
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

  it("lets the operator force apply a deferred update despite active runs", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow({
      listActiveRunsForQuit: vi.fn(async () => ({ totalRuns: 2 })),
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

  it("preserves active-run count on the final ready event after download progress", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow({
      listActiveRunsForQuit: vi.fn(async () => ({ totalRuns: 2 })),
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

    expect(flow.getDesktopUpdateProgress()).toMatchObject({
      phase: "ready_to_install",
      totalRuns: 2,
    });
  });

  it("force-applies immediately when the deferred update prompt chooses quit and update now", async () => {
    const child = createMockUpdateChild();
    spawnMock.mockReturnValue(child);
    const { flow } = createFlow({
      listActiveRunsForQuit: vi.fn(async () => ({ totalRuns: 2 })),
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
      listActiveRunsForQuit: vi.fn(async () => ({ totalRuns: 2 })),
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
