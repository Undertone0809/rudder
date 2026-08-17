import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
