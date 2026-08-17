import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runNativeChildProcess } from "./native-process-runner.js";

const nativeHostPath = process.env.RUDDER_NATIVE_PROCESS_HOST_PATH;
const supportedTarget = (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch))
  || (process.platform === "win32" && process.arch === "x64")
  || (process.platform === "linux" && process.arch === "x64");
const nativeOnly = it.skipIf(!nativeHostPath || !supportedTarget);

describe("Rust Agent Run process host", () => {
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
      "const chunk='x'.repeat(16384);for(let i=0;i<64;i++)process.stdout.write(chunk)",
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
    expect(result.stdout).toHaveLength(64 * 16_384);
    expect(deliveredBytes).toBe(64 * 16_384);
    expect(maxActiveConsumers).toBe(1);
    await expect(access(path.join(root, "receipts"))).resolves.toBeUndefined();
  });

  it("fails closed when the log consumer cannot drain the bounded output spool", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-spool-overflow-"));
    const commandInput = new PassThrough();
    const lifecycle = new PassThrough();
    const rawStdout = new PassThrough();
    const rawStderr = new PassThrough();
    const fakeHost = Object.assign(new EventEmitter(), {
      stdin: commandInput,
      stdio: [null, null, null, lifecycle, rawStdout, rawStderr],
      stderr: rawStderr,
      exitCode: null,
      signalCode: null,
      kill: () => true,
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
      lifecycle.write(Array.from({ length: 1_280 }, () => `${JSON.stringify({ type: "output", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, stream: "stdout", data })}\n`).join(""));
      lifecycle.write(`${JSON.stringify({ type: "app-exit", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, code: 0 })}\n`);
      lifecycle.write(`${JSON.stringify({ type: "terminal", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, cleanupProven: true, receiptWritten: true })}\n`);
      lifecycle.end();
      fakeHost.emit("close", 0, null);
    });
    setImmediate(() => {
      lifecycle.write(`${JSON.stringify({ type: "handshake", protocolVersion: { major: 1, minor: 0 }, capabilities, target: "test", binaryVersion: "test" })}\n`);
    });
    await expect(runNativeChildProcess("spool-overflow", process.execPath, [], {
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
    })).rejects.toMatchObject({
      fallbackCode: "output_spool_overflow",
      accepted: true,
    });
  });

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
