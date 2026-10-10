import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeProcessUnavailableError, runNativeChildProcess, runNativeChildProcessOrFallback } from "./native-process-runner.js";

const spawnSafety = vi.hoisted(() => ({ interceptedTaskkills: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, argv] = args;
      const pidIndex = Array.isArray(argv) ? argv.indexOf("/pid") : -1;
      if (command === "taskkill.exe" && Array.isArray(argv) && pidIndex >= 0
        && ["12345", "45678"].includes(argv[pidIndex + 1] ?? "")) {
        spawnSafety.interceptedTaskkills++;
        const fakeKiller = new Emitter();
        queueMicrotask(() => fakeKiller.emit("close", 0, null));
        return fakeKiller as ChildProcess;
      }
      return actual.spawn(...args);
    },
  };
});

const nativeHostPath = process.env.RUDDER_NATIVE_PROCESS_HOST_PATH;
const supportedTarget = (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch))
  || (process.platform === "win32" && process.arch === "x64")
  || (process.platform === "linux" && process.arch === "x64");
const nativeOnly = it.skipIf(!nativeHostPath || !supportedTarget);

// Fake lifecycle frames never authorize a signal to a real process or group.
// Keep this guard in the fixture itself, including cleanup-negative tests.
const kernelKill = process.kill.bind(process);
let restoreSyntheticPidGuard: (() => void) | undefined;
beforeAll(() => {
  const syntheticPidGuard = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if ([12345, 45678].includes(Math.abs(pid))) {
      throw Object.assign(new Error("Synthetic process identity has no OS owner"), { code: "ESRCH" });
    }
    return kernelKill(pid, signal);
  });
  restoreSyntheticPidGuard = () => syntheticPidGuard.mockRestore();
});
afterAll(() => restoreSyntheticPidGuard?.());

function terminalHost(terminal: Record<string, unknown>, exitCode: number | null = 0) {
  const stdin = new PassThrough();
  const lifecycle = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const host = Object.assign(new EventEmitter(), {
    stdin, stdio: [null, null, null, lifecycle, stdout, stderr],
    stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true,
  }) as unknown as ChildProcess;
  let started = false;
  stdin.on("data", (chunk) => {
    if (started) return;
    started = true;
    const { requestId } = JSON.parse(String(chunk)) as { requestId: string };
    const frame = (value: Record<string, unknown>) => lifecycle.write(`${JSON.stringify({
      protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, ...value,
    })}\n`);
    frame({ type: "accepted", outputTransport: "raw" });
    frame({ type: "spawned", pid: 12345 });
    stdout.write("startup-output");
    frame({ type: "app-exit", code: exitCode, signal: null });
    frame({ type: "terminal", cleanupProven: true, receiptWritten: true, ...terminal });
    lifecycle.end();
    host.emit("close", 0, null);
    setImmediate(() => { stdout.end(); stderr.end("startup-diagnostic"); });
  });
  setImmediate(() => lifecycle.write(`${JSON.stringify({
    type: "handshake", protocolVersion: { major: 1, minor: 0 }, target: "test", binaryVersion: "test",
    capabilities: ["process_spawn", "process_group_cleanup", "parent_eof_cleanup", "owner_receipt", "stdout_relay", "stderr_relay"],
  })}\n`));
  return host;
}

describe("Rust Agent Run process host", () => {
  it("never signals a fabricated process or process group during fixture cleanup", () => {
    for (const pid of [12345, -12345, 45678, -45678]) {
      for (const signal of [0, "SIGTERM", "SIGKILL"] as const) {
        expect(() => process.kill(pid, signal)).toThrow("Synthetic process identity has no OS owner");
      }
    }
  });

  it("intercepts synthetic Windows cleanup while preserving real child spawning", async () => {
    const before = spawnSafety.interceptedTaskkills;
    for (const pid of ["12345", "45678"]) {
      const child = spawn("taskkill.exe", ["/pid", pid, "/t", "/f"]);
      expect(child.pid).toBeUndefined();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
    expect(spawnSafety.interceptedTaskkills - before).toBe(2);
    const realChild = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    expect(realChild.pid).toBeGreaterThan(1);
    await expect(new Promise((resolve, reject) => {
      realChild.once("error", reject);
      realChild.once("close", resolve);
    })).resolves.toBe(0);
    expect(spawnSafety.interceptedTaskkills - before).toBe(2);
  });

  it.each([0, 23, null])("rejects trusted failed terminal despite app exit %s without fallback, retaining drained diagnostics", async (exitCode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-terminal-failed-"));
    const errorCode = exitCode === null ? "child_wait_failed" : "stdin_write_failed";
    const host = terminalHost({ status: "failed", errorCode }, exitCode);
    const logs: string[] = [];
    const controller = new AbortController();
    const error = await runNativeChildProcessOrFallback("terminal-failed", process.execPath, [], {
      RUDDER_NATIVE_MODE: "auto",
    }, {
      cwd: root, timeoutSec: 10, graceSec: 1, binaryPath: "fake-process-host",
      runtimeRoot: path.join(root, "receipts"), spawnHost: () => host,
      abortSignal: controller.signal,
      onSpawn: async () => { if (exitCode === 23) controller.abort(); },
      onLog: async (_stream, data) => { logs.push(data); }, onLogError: () => {},
    }).then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(NativeProcessUnavailableError);
    expect(error).toMatchObject({ accepted: true, fallbackCode: errorCode,
      processResult: { exitCode, signal: null, stdout: "startup-output", stderr: "startup-diagnostic", timedOut: false },
    });
    expect(logs.join("")).toContain("startup-diagnostic");
  });

  it.each([undefined, "cancelled", "unknown"])("fails closed for unsupported trusted terminal status %s", async (status) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-terminal-status-"));
    const host = terminalHost({ status });
    await expect(runNativeChildProcess("terminal-status", process.execPath, [], {
      cwd: root, env: {}, timeoutSec: 10, graceSec: 1, binaryPath: "fake-process-host",
      runtimeRoot: path.join(root, "receipts"), spawnHost: () => host,
      onLog: async () => {}, onLogError: () => {},
    })).rejects.toMatchObject({ accepted: true, fallbackCode: "terminal_status_invalid" });
  });

  it.each([
    { cleanupProven: false, receiptWritten: true },
    { cleanupProven: true, receiptWritten: false },
  ])("still requires both cleanup and durable receipt: %j", async (proof) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-terminal-proof-"));
    const host = terminalHost({ status: "succeeded", ...proof });
    await expect(runNativeChildProcess("terminal-proof", process.execPath, [], {
      cwd: root, env: {}, timeoutSec: 10, graceSec: 1, binaryPath: "fake-process-host",
      runtimeRoot: path.join(root, "receipts"), spawnHost: () => host,
      onLog: async () => {}, onLogError: () => {},
    })).rejects.toMatchObject({ accepted: true, fallbackCode: "cleanup_unproven" });
  });
  it.each([
    { cleanupProven: false, receiptWritten: true },
    { cleanupProven: true, receiptWritten: false },
  ])("isolates the Windows host-loss branch for synthetic cleanup rejection: %j", async (proof) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-windows-proof-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const before = spawnSafety.interceptedTaskkills;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      await expect(runNativeChildProcess("windows-proof", process.execPath, [], {
        cwd: root, env: {}, timeoutSec: 10, graceSec: 1, binaryPath: "fake-process-host",
        runtimeRoot: path.join(root, "receipts"),
        spawnHost: () => terminalHost({ status: "succeeded", ...proof }),
        onLog: async () => {}, onLogError: () => {},
      })).rejects.toMatchObject({ accepted: true, fallbackCode: "cleanup_unproven" });
      expect(spawnSafety.interceptedTaskkills - before).toBe(1);
    } finally {
      Object.defineProperty(process, "platform", platform);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("honors a per-run Node rollback mode before attempting the native host", async () => {
    const result = await runNativeChildProcessOrFallback("node-mode", process.execPath, ["-e", ""], {
      RUDDER_NATIVE_MODE: "node",
    }, {
      cwd: process.cwd(),
      timeoutSec: 1,
      graceSec: 1,
      onLog: async () => {},
      onLogError: () => {},
      binaryPath: path.join(os.tmpdir(), "missing-rudder-process-host"),
    });
    expect(result).toBeNull();
  });

  nativeOnly("preserves the bounded rejection code before ownership acceptance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-reject-"));
    await expect(runNativeChildProcess("preaccept-rejection", path.join(root, "missing"), [], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
      onLogError: () => {},
      binaryPath: nativeHostPath!,
      runtimeRoot: path.join(root, "receipts"),
    })).rejects.toMatchObject({
      fallbackCode: "launch_path_unavailable",
      accepted: false,
    });
  });

  nativeOnly("waits for cleanup receipt after an accepted protocol error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-protocol-"));
    const runtimeRoot = path.join(root, "receipts");
    let pid: number | null = null;
    const previousInjection = process.env.RUDDER_PROCESS_HOST_TEST_AFTER_ACCEPT_FRAME;
    process.env.RUDDER_PROCESS_HOST_TEST_AFTER_ACCEPT_FRAME = "unknown";
    try {
      await expect(runNativeChildProcess("accepted-protocol-error", process.execPath, [
        "-e",
        "setInterval(()=>{},1000)",
      ], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        onLogError: () => {},
        onSpawn: async (meta) => { pid = meta.pid; },
        binaryPath: nativeHostPath!,
        runtimeRoot,
      })).rejects.toMatchObject({
        fallbackCode: "unknown_frame",
        accepted: true,
      });
    } finally {
      if (previousInjection === undefined) delete process.env.RUDDER_PROCESS_HOST_TEST_AFTER_ACCEPT_FRAME;
      else process.env.RUDDER_PROCESS_HOST_TEST_AFTER_ACCEPT_FRAME = previousInjection;
    }

    expect(pid).not.toBeNull();
    expect(() => process.kill(pid!, 0)).toThrow();
    const operationNames = await import("node:fs/promises").then((fs) => fs.readdir(runtimeRoot));
    expect(operationNames).toHaveLength(1);
    const receipt = JSON.parse(
      await readFile(path.join(runtimeRoot, operationNames[0]!, "terminal-receipt.json"), "utf8"),
    ) as { terminal?: { cleanupProven?: boolean; receiptWritten?: boolean } };
    expect(receipt.terminal).toMatchObject({ cleanupProven: true, receiptWritten: true });
  });

  nativeOnly("does not fall back after a child was spawned but native setup failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-setup-failure-"));
    const previousInjection = process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE;
    process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE = "after_spawn";
    try {
      await expect(runNativeChildProcess("post-spawn-setup-failure", process.execPath, [
        "-e", "setInterval(()=>{},1000)",
      ], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        onLogError: () => {},
        binaryPath: nativeHostPath!,
        runtimeRoot: path.join(root, "receipts"),
      })).rejects.toMatchObject({
        fallbackCode: "process_setup_failed",
        accepted: true,
      });
    } finally {
      if (previousInjection === undefined) delete process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE;
      else process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE = previousInjection;
    }
  });

  nativeOnly("backpressures a flood behind one bounded slow log consumer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-flood-"));
    let activeConsumers = 0;
    let maxActiveConsumers = 0;
    let deliveredBytes = 0;
    const result = await runNativeChildProcess("slow-consumer-flood", process.execPath, [
      "-e",
      "const chunk='x'.repeat(16384);let i=0;const write=()=>{while(i<320){i+=1;if(!process.stdout.write(chunk)){process.stdout.once('drain',write);return}}};write()",
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 10,
      graceSec: 1,
      onLog: async (_stream, chunk) => {
        activeConsumers += 1;
        maxActiveConsumers = Math.max(maxActiveConsumers, activeConsumers);
        await new Promise((resolve) => setTimeout(resolve, 3));
        deliveredBytes += Buffer.byteLength(chunk);
        activeConsumers -= 1;
      },
      onLogError: () => {},
      binaryPath: nativeHostPath!,
      runtimeRoot: path.join(root, "receipts"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(4 * 1024 * 1024);
    expect(deliveredBytes).toBe(320 * 16_384);
    expect(maxActiveConsumers).toBe(1);
    await expect(access(path.join(root, "receipts"))).resolves.toBeUndefined();
  });

  it("backpressures a slow log consumer instead of stopping the accepted process", { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-spool-overflow-"));
    const commandInput = new PassThrough();
    const lifecycle = new PassThrough();
    const rawStdout = new PassThrough();
    const rawStderr = new PassThrough();
    let hostKilled = false;
    const fakeHost = Object.assign(new EventEmitter(), {
      stdin: commandInput,
      stdio: [null, null, null, lifecycle, rawStdout, rawStderr],
      stderr: rawStderr,
      exitCode: null,
      signalCode: null,
      kill: () => {
        hostKilled = true;
        return true;
      },
    }) as unknown as ChildProcess;
    const capabilities = ["process_spawn", "process_group_cleanup", "parent_eof_cleanup", "owner_receipt", "stdout_relay", "stderr_relay"];
    let started = false;
    commandInput.on("data", (chunk) => {
      if (started) return;
      started = true;
      const start = JSON.parse(String(chunk)) as { requestId?: string };
      const requestId = start.requestId!;
      lifecycle.write(`${JSON.stringify({ type: "accepted", protocolVersion: { major: 1, minor: 0 }, requestId })}\n`);
      lifecycle.write(`${JSON.stringify({ type: "spawned", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, pid: 12345 })}\n`);
      const data = "x".repeat(16_384);
      // Exceed the 4 MiB queue bound while keeping the fake host deterministic.
      lifecycle.write(Array.from({ length: 320 }, () => `${JSON.stringify({ type: "output", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, stream: "stdout", data })}\n`).join(""));
      lifecycle.write(`${JSON.stringify({ type: "app-exit", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, code: 0 })}\n`);
      lifecycle.write(`${JSON.stringify({ type: "terminal", status: "succeeded", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, cleanupProven: true, receiptWritten: true })}\n`);
      lifecycle.end();
      fakeHost.emit("close", 0, null);
    });
    setImmediate(() => {
      lifecycle.write(`${JSON.stringify({ type: "handshake", protocolVersion: { major: 1, minor: 0 }, capabilities, target: "test", binaryVersion: "test" })}\n`);
    });
    const result = await runNativeChildProcess("spool-overflow", process.execPath, [], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      onLogError: () => {},
      binaryPath: "fake-process-host",
      runtimeRoot: path.join(root, "receipts"),
      spawnHost: () => fakeHost,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(4 * 1024 * 1024);
    expect(hostKilled).toBe(false);
  });

  it("buffers raw output before acceptance and drains it after terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-raw-order-"));
    const commandInput = new PassThrough();
    const lifecycle = new PassThrough();
    const rawStdout = new PassThrough();
    const rawStderr = new PassThrough();
    const fakeHost = Object.assign(new EventEmitter(), {
      stdin: commandInput,
      stdio: [null, null, null, lifecycle, rawStdout, rawStderr],
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    const capabilities = [
      "process_spawn",
      "process_group_cleanup",
      "parent_eof_cleanup",
      "owner_receipt",
      "stdout_relay",
      "stderr_relay",
    ];
    let started = false;
    commandInput.on("data", (chunk) => {
      if (started) return;
      started = true;
      const requestId = (JSON.parse(String(chunk)) as { requestId: string }).requestId;
      rawStdout.write("before-accepted-");
      lifecycle.write(`${JSON.stringify({
        type: "accepted",
        protocolVersion: { major: 1, minor: 0 },
        requestId,
        outputTransport: "raw",
      })}\n`);
      lifecycle.write(`${JSON.stringify({
        type: "spawned",
        protocolVersion: { major: 1, minor: 0 },
        requestId,
        ownerToken: requestId,
        pid: 12345,
      })}\n`);
      lifecycle.write(`${JSON.stringify({
        type: "app-exit",
        protocolVersion: { major: 1, minor: 0 },
        requestId,
        ownerToken: requestId,
        code: 0,
      })}\n`);
      lifecycle.write(`${JSON.stringify({
        type: "terminal",
        status: "succeeded",
        protocolVersion: { major: 1, minor: 0 },
        requestId,
        ownerToken: requestId,
        cleanupProven: true,
        receiptWritten: true,
      })}\n`);
      lifecycle.end();
      fakeHost.emit("close", 0, null);
      setTimeout(() => {
        rawStdout.end("after-terminal");
        rawStderr.end();
      }, 10);
    });
    setImmediate(() => {
      lifecycle.write(`${JSON.stringify({
        type: "handshake",
        protocolVersion: { major: 1, minor: 0 },
        capabilities,
        target: "test",
        binaryVersion: "test",
      })}\n`);
    });

    const logs: string[] = [];
    const result = await runNativeChildProcess("raw-order", process.execPath, [], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 10,
      graceSec: 1,
      onLog: async (_stream, data) => { logs.push(data); },
      onLogError: () => {},
      binaryPath: "fake-process-host",
      runtimeRoot: path.join(root, "receipts"),
      spawnHost: () => fakeHost,
    });

    expect(result.stdout).toBe("before-accepted-after-terminal");
    expect(logs.join("")).toBe(result.stdout);
  });

  nativeOnly("cancels through host Stop without treating a legal succeeded terminal as failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-cancel-"));
    const controller = new AbortController();
    const result = await runNativeChildProcess("native-cancel", process.execPath, [
      "-e", "setInterval(()=>{},1000)",
    ], {
      cwd: root, env: { PATH: process.env.PATH ?? "" }, timeoutSec: 10, graceSec: 0.2,
      onLog: async () => {}, onLogError: () => {},
      onSpawn: async () => { controller.abort(); }, abortSignal: controller.signal,
      binaryPath: nativeHostPath!, runtimeRoot: path.join(root, "receipts"),
    });
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.pid).not.toBeNull();
    expect(() => process.kill(result.pid!, 0)).toThrow();
  }, 10_000);

  nativeOnly("times out through host Stop and leaves no owned process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-timeout-"));
    const result = await runNativeChildProcess("native-timeout", process.execPath, [
      "-e",
      "setInterval(()=>{},1000)",
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 0.1,
      graceSec: 0.2,
      onLog: async () => {},
      onLogError: () => {},
      binaryPath: nativeHostPath!,
      runtimeRoot: path.join(root, "receipts"),
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(result.pid).not.toBeNull();
    expect(() => process.kill(result.pid!, 0)).toThrow();
  }, 10_000);
});
