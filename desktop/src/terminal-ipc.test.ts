import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { NativeProcessHost } from "./local-app-native-host.js";
import {
  createTerminalController,
  registerTerminalIpcHandlers,
  resolveTerminalWorkspaceFromApi,
  TERMINAL_IPC_CHANNELS,
} from "./terminal-ipc.js";

function fakeHost() {
  const host = new EventEmitter() as NativeProcessHost;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const send = vi.fn((message: unknown) => {
    if ((message as { type?: unknown }).type === "stop") queueMicrotask(() => {
      host.emit("message", { type: "terminal", cleanupProven: true });
      host.emit("exit", 0, null);
    });
    return true;
  });
  Object.defineProperties(host, {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
    pid: { value: 42 },
    connected: { value: true },
    exitCode: { value: null },
    signalCode: { value: null },
    send: { value: send },
    kill: { value: vi.fn(() => true) },
  });
  return { host, send, stdout };
}

async function controllerFixture(options: { terminateTree?: (pid: number) => Promise<void> } = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "rudder-terminal-ipc-"));
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const controller = createTerminalController({
    resolveWorkspace: vi.fn(async () => ({ cwd: workspace, agentName: "Noah" })),
    resolveHostPath: () => process.execPath,
    resolveShell: async () => ({ executable: process.execPath, argv: [] }),
    spawnHost: () => {
      const next = fakeHost();
      hosts.push(next);
      return next.host;
    },
    terminateTree: options.terminateTree,
  });
  const renderer = { mainFrame: {}, send: vi.fn(), once: vi.fn(), isDestroyed: () => false };
  return { controller, hosts, renderer, workspace };
}

const createInput = (sessionId: string) => ({
  orgId: "org-1",
  agentId: "agent-1",
  sessionId,
  cols: 80,
  rows: 24,
});

describe("Terminal IPC", () => {
  it("restricts commands to the current renderer main frame and forwards only typed session payloads", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) };
    const mainFrame = {};
    const renderer = { mainFrame, send: vi.fn() };
    const controller = {
      create: vi.fn(async () => ({ sessionId: "terminal-1", replay: "", status: "running" as const })),
      input: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(async () => undefined),
      closeOwner: vi.fn(),
      shutdown: vi.fn(),
      sessionCount: vi.fn(() => 0),
    };
    registerTerminalIpcHandlers(ipcMain, { getMainRenderer: () => renderer, controller: controller as never });

    const close = handlers.get(TERMINAL_IPC_CHANNELS.close)!;
    await expect(Promise.resolve(close({ sender: renderer, senderFrame: mainFrame }, { sessionId: "terminal-1" }))).resolves.toBeUndefined();
    expect(controller.close).toHaveBeenCalledWith(renderer, "terminal-1");
    expect(() => close({ sender: renderer, senderFrame: {} }, { sessionId: "terminal-1" })).toThrow("main frame");
    expect(() => close({ sender: renderer, senderFrame: mainFrame }, { sessionId: "terminal-1", cwd: "/tmp" })).toThrow("documented fields");
  });

  it("resolves only the immutable Agent workspace returned for the requested organization", () => {
    expect(resolveTerminalWorkspaceFromApi(
      "org-1",
      "agent-1",
      { id: "agent-1", orgId: "org-1", name: "Renamed Agent" },
      {
        rootPath: "/var/rudder/org-1",
        directoryPath: "agents",
        rootExists: true,
        entries: [{ entityType: "agent_workspace", agentId: "agent-1", workspaceKey: "original--agent-1" }],
      },
    )).toEqual({ cwd: "/var/rudder/org-1/agents/original--agent-1", agentName: "Renamed Agent" });

    expect(() => resolveTerminalWorkspaceFromApi(
      "org-1",
      "agent-1",
      { id: "agent-1", orgId: "org-2" },
      { rootPath: "/var/rudder/org-1", directoryPath: "agents", rootExists: true, entries: [] },
    )).toThrow("does not belong");
    expect(() => resolveTerminalWorkspaceFromApi(
      "org-1",
      "agent-1",
      { id: "agent-1", orgId: "org-1" },
      {
        rootPath: "/var/rudder/org-1",
        directoryPath: "agents",
        rootExists: true,
        entries: [{ entityType: "agent_workspace", agentId: "agent-1", workspaceKey: "../../outside" }],
      },
    )).toThrow("could not be validated");
    expect(() => resolveTerminalWorkspaceFromApi(
      "org-1",
      "agent-1",
      { id: "agent-1", orgId: "org-1" },
      { rootPath: "/var/rudder/org-1", directoryPath: "", rootExists: true, entries: [] },
    )).toThrow("unavailable");
  });

  it("rejects renderer cwd injection and isolates sessions by renderer owner", async () => {
    const { controller, renderer } = await controllerFixture();
    await expect(controller.create(renderer, { ...createInput("terminal-1"), cwd: "/tmp" })).rejects.toThrow("documented fields");
    await expect(controller.create(renderer, createInput("terminal-1"))).resolves.toMatchObject({ status: "running", agentName: "Noah" });
    const otherRenderer = { mainFrame: {}, send: vi.fn() };
    await expect(controller.create(otherRenderer, createInput("terminal-1"))).rejects.toThrow("another renderer");
    expect(() => controller.input(otherRenderer, { sessionId: "terminal-1", data: "pwd\n" })).toThrow("unavailable");
    expect(() => controller.resize(otherRenderer, { sessionId: "terminal-1", cols: 100, rows: 30 })).toThrow("unavailable");
    await expect(controller.close(otherRenderer, "terminal-1")).rejects.toThrow("not owned");
    await controller.shutdown();
  });

  it("caps sessions, bounds replay, routes output, and closes every shell on shutdown", async () => {
    const { controller, hosts, renderer } = await controllerFixture();
    for (let index = 0; index < 8; index += 1) {
      await controller.create(renderer, createInput(`terminal-${index}`));
    }
    await expect(controller.create(renderer, createInput("terminal-8"))).rejects.toThrow("maximum number");
    hosts[0]!.stdout.write("x".repeat(1024 * 1024 + 32));
    expect(renderer.send).toHaveBeenCalledWith(
      TERMINAL_IPC_CHANNELS.output,
      expect.objectContaining({ sessionId: "terminal-0" }),
    );
    await expect(controller.create(renderer, createInput("terminal-0"))).resolves.toMatchObject({
      replay: "x".repeat(1024 * 1024),
    });

    await controller.shutdown();
    expect(controller.sessionCount()).toBe(0);
    for (const entry of hosts) expect(entry.send).toHaveBeenCalledWith(expect.objectContaining({ type: "stop" }));
  });

  it("bounds replay by UTF-8 bytes without exposing a partial leading character", async () => {
    const { controller, hosts, renderer } = await controllerFixture();
    await controller.create(renderer, createInput("terminal-unicode"));
    hosts[0]!.stdout.write("界".repeat(400_000));

    const resumed = await controller.create(renderer, createInput("terminal-unicode"));
    expect(Buffer.byteLength(resumed.replay, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(resumed.replay).not.toContain("�");
    await controller.shutdown();
  });

  it("uses parent EOF cleanup when a process host does not answer stop", async () => {
    vi.useFakeTimers();
    try {
      const { controller, hosts, renderer } = await controllerFixture();
      await controller.create(renderer, createInput("terminal-stuck"));
      const host = hosts[0]!.host;
      host.emit("message", { type: "spawned", pid: 42 });
      hosts[0]!.send.mockImplementation(() => true);
      hosts[0]!.host.stdin.once("finish", () => {
        host.emit("message", { type: "terminal", cleanupProven: true });
        queueMicrotask(() => host.emit("exit", null, "SIGKILL"));
      });

      const closing = controller.close(renderer, "terminal-stuck");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(closing).resolves.toBeUndefined();
      expect(host.stdin.writableEnded).toBe(true);
      expect(host.kill).not.toHaveBeenCalled();
      expect(controller.sessionCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unverified process-tree cleanup instead of treating a killed host as success", async () => {
    vi.useFakeTimers();
    try {
      const terminateTree = vi.fn(async () => { throw new Error("tree still alive"); });
      const { controller, hosts, renderer } = await controllerFixture({ terminateTree });
      await controller.create(renderer, createInput("terminal-unkillable"));
      hosts[0]!.host.emit("message", { type: "spawned", pid: 42 });
      hosts[0]!.send.mockImplementation(() => true);
      vi.mocked(hosts[0]!.host.kill).mockReturnValue(false);

      const closing = controller.close(renderer, "terminal-unkillable");
      const rejected = expect(closing).rejects.toThrow("could not verify");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(hosts[0]!.host.stdin.writableEnded).toBe(true);
      expect(terminateTree).toHaveBeenCalledWith(42);
      expect(controller.sessionCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports renderer cleanup failures without creating an unhandled rejection", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { controller, hosts, renderer } = await controllerFixture({
        terminateTree: async () => { throw new Error("tree still alive"); },
      });
      await controller.create(renderer, createInput("terminal-destroyed"));
      hosts[0]!.host.emit("message", { type: "spawned", pid: 42 });
      hosts[0]!.send.mockImplementation(() => true);
      vi.mocked(hosts[0]!.host.kill).mockReturnValue(false);

      const destroyed = vi.mocked(renderer.once).mock.calls.find(([event]) => event === "destroyed")?.[1];
      expect(destroyed).toBeTypeOf("function");
      destroyed?.();
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();

      expect(error).toHaveBeenCalledWith(
        "[desktop] Terminal renderer cleanup could not be verified",
        expect.any(AggregateError),
      );
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it("lets the owner close an already-exited shell but rejects another renderer", async () => {
    const { controller, hosts, renderer } = await controllerFixture();
    await controller.create(renderer, createInput("terminal-exited"));
    hosts[0]!.host.emit("message", { type: "terminal", cleanupProven: true });
    hosts[0]!.host.emit("exit", 0, null);
    const otherRenderer = { mainFrame: {}, send: vi.fn() };

    await expect(controller.close(otherRenderer, "terminal-exited")).rejects.toThrow("not owned");
    await expect(controller.close(renderer, "terminal-exited")).resolves.toBeUndefined();
  });

  it("cleans an unproven shell tree after the native host exits unexpectedly", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const { controller, hosts, renderer } = await controllerFixture({ terminateTree });
    await controller.create(renderer, createInput("terminal-crashed"));
    hosts[0]!.host.emit("message", { type: "spawned", pid: 42 });
    hosts[0]!.host.emit("exit", 1, null);

    await expect(controller.close(renderer, "terminal-crashed")).resolves.toBeUndefined();
    expect(terminateTree).toHaveBeenCalledWith(42);
  });

  it("proves cleanup before restarting a session whose native host exited unexpectedly", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const { controller, hosts, renderer } = await controllerFixture({ terminateTree });
    await controller.create(renderer, createInput("terminal-restart-crash"));
    hosts[0]!.host.emit("message", { type: "spawned", pid: 42 });
    hosts[0]!.host.emit("exit", 1, null);

    await expect(controller.create(renderer, createInput("terminal-restart-crash"))).resolves.toMatchObject({
      status: "running",
    });
    expect(terminateTree).toHaveBeenCalledWith(42);
    expect(hosts).toHaveLength(2);
    await controller.shutdown();
  });

  it("closes and restarts after a native PTY failure before a shell was spawned", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const { controller, hosts, renderer } = await controllerFixture({ terminateTree });

    await controller.create(renderer, createInput("terminal-pre-spawn-close"));
    hosts[0]!.host.emit("message", { type: "terminal", status: "failed", cleanupProven: true });
    hosts[0]!.host.emit("exit", 1, null);
    await expect(controller.close(renderer, "terminal-pre-spawn-close")).resolves.toBeUndefined();

    await controller.create(renderer, createInput("terminal-pre-spawn-restart"));
    hosts[1]!.host.emit("message", { type: "terminal", status: "failed", cleanupProven: true });
    hosts[1]!.host.emit("exit", 1, null);
    await expect(controller.create(renderer, createInput("terminal-pre-spawn-restart"))).resolves.toMatchObject({
      status: "running",
    });
    expect(terminateTree).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(3);
    await controller.shutdown();
  });

  it("keeps an unverified completed session when cleanup blocks restart", async () => {
    const terminateTree = vi.fn(async () => { throw new Error("tree still alive"); });
    const { controller, hosts, renderer } = await controllerFixture({ terminateTree });
    await controller.create(renderer, createInput("terminal-restart-blocked"));
    hosts[0]!.host.emit("message", { type: "spawned", pid: 42 });
    hosts[0]!.host.emit("exit", 1, null);

    await expect(controller.create(renderer, createInput("terminal-restart-blocked"))).rejects.toThrow("tree still alive");
    await expect(controller.create(renderer, createInput("terminal-restart-blocked"))).rejects.toThrow("tree still alive");
    expect(terminateTree).toHaveBeenCalledTimes(2);
    expect(hosts).toHaveLength(1);
  });

  it("accepts a late native cleanup proof for an already-completed session", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const { controller, hosts, renderer } = await controllerFixture({ terminateTree });
    await controller.create(renderer, createInput("terminal-late-proof"));
    hosts[0]!.host.emit("message", { type: "spawned", pid: 42 });
    hosts[0]!.host.emit("exit", 0, null);
    hosts[0]!.host.emit("message", { type: "terminal", cleanupProven: true });

    await expect(controller.create(renderer, createInput("terminal-late-proof"))).resolves.toMatchObject({ status: "running" });
    expect(terminateTree).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(2);
    await controller.shutdown();
  });
});
