import { EventEmitter } from "node:events";
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
    write: (_chunk, callback) => callback?.(null),
  };
  child.unref = vi.fn();
  return child;
}

function createFlow() {
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
  });
  return { flow, sentProgressEvents };
}

describe("desktop update flow", () => {
  beforeEach(() => {
    spawnMock.mockReset();
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
});
