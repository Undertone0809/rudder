import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  runNativeChildProcess,
  runNativeChildProcessOrFallback,
  runNativeChildProcessV2,
  type NativeProcessAuthority,
} from "./native-process-runner.js";

const nativeHostPath = process.env.RUDDER_NATIVE_PROCESS_HOST_PATH;
const supportedTarget = (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch))
  || (process.platform === "win32" && process.arch === "x64")
  || (process.platform === "linux" && process.arch === "x64");
const nativeOnly = it.skipIf(!nativeHostPath || !supportedTarget);

function validAuthority(
  runId: string,
  runtimeRoot: string,
  leaseTtlMs = 60_000,
): NativeProcessAuthority {
  const now = Date.now();
  const authority: NativeProcessAuthority = {
    authorityVersion: 1,
    runtimeIdentity: { organizationId: "org-1", agentId: "agent-1", runId },
    ownership: { epoch: 1, fence: "fence-1" },
    lease: { owner: "worker-1", issuedAtMillis: now - 1_000, expiresAtMillis: now + leaseTtlMs },
    attempt: 1,
    requestId: `request-${runId}`,
    bindingDigest: "0".repeat(64),
    receiptContext: { runtimeRoot, ownerToken: `owner-${runId}` },
  };
  const values = [
    "rudder.native.process-authority.v2",
    authority.authorityVersion,
    authority.runtimeIdentity.organizationId,
    authority.runtimeIdentity.agentId,
    authority.runtimeIdentity.runId,
    authority.ownership.epoch,
    authority.ownership.fence,
    authority.lease.owner,
    authority.lease.issuedAtMillis,
    authority.lease.expiresAtMillis,
    authority.attempt,
    authority.requestId,
    authority.receiptContext.runtimeRoot,
    authority.receiptContext.ownerToken,
  ];
  const material = values.map((value) => `${Buffer.byteLength(String(value), "utf8")}:${value}|`).join("");
  authority.bindingDigest = createHash("sha256").update(material).digest("hex");
  return authority;
}

describe("Rust Agent Run process host", () => {
  it("fails closed before spawning when v2 authority is not a valid server receipt", async () => {
    let spawned = false;
    await expect(runNativeChildProcessV2("v2-run", process.execPath, ["-e", ""], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 1,
      graceSec: 1,
      onLog: async () => {},
      onLogError: () => {},
      binaryPath: path.join(os.tmpdir(), "unused-rudder-process-host"),
      spawnHost: () => {
        spawned = true;
        throw new Error("must not spawn without a valid authority");
      },
      authority: {
        authorityVersion: 1,
        runtimeIdentity: { organizationId: "org-1", agentId: "agent-1", runId: "v2-run" },
        ownership: { epoch: 1, fence: "fence-1" },
        lease: {
          owner: "worker-1",
          issuedAtMillis: Date.now() - 1_000,
          expiresAtMillis: Date.now() + 60_000,
        },
        attempt: 1,
        requestId: "request-1",
        bindingDigest: "0".repeat(64),
        receiptContext: { runtimeRoot: path.join(os.tmpdir(), "rudder-v2"), ownerToken: "owner-1" },
      },
    })).rejects.toMatchObject({ fallbackCode: "authority_invalid", accepted: false });
    expect(spawned).toBe(false);
  });

  nativeOnly("runs a valid authority-bound v2 lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-v2-"));
    const runtimeRoot = path.join(root, "receipts");
    const result = await runNativeChildProcessV2("v2-lifecycle", process.execPath, [
      "-e",
      "process.stdout.write('v2-ok')",
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
      onLogError: () => {},
      binaryPath: nativeHostPath!,
      runtimeRoot,
      authority: validAuthority("v2-lifecycle", runtimeRoot),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("v2-ok");
    expect(result.stderr).toBe("");
  });

  nativeOnly("recovers a child when the host dies after spawn but before spawned", { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-host-loss-"));
    const runtimeRoot = path.join(root, "receipts");
    const authority = validAuthority("host-loss-before-spawned", runtimeRoot);
    const previousInjection = process.env.RUDDER_PROCESS_HOST_TEST_AFTER_SPAWN_BEFORE_SPAWNED;
    process.env.RUDDER_PROCESS_HOST_TEST_AFTER_SPAWN_BEFORE_SPAWNED = "1";
    try {
      await expect(runNativeChildProcessV2("host-loss-before-spawned", process.execPath, [
        "-e",
        "setInterval(()=>{},1000)",
      ], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        onLogError: () => {},
        binaryPath: nativeHostPath!,
        runtimeRoot,
        authority,
      })).rejects.toMatchObject({
        fallbackCode: "control_lost",
        accepted: true,
      });
    } finally {
      if (previousInjection === undefined) delete process.env.RUDDER_PROCESS_HOST_TEST_AFTER_SPAWN_BEFORE_SPAWNED;
      else process.env.RUDDER_PROCESS_HOST_TEST_AFTER_SPAWN_BEFORE_SPAWNED = previousInjection;
    }

    const descriptorPath = path.join(
      runtimeRoot,
      authority.receiptContext.ownerToken,
      "owner-descriptor.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
      childPid?: unknown;
      opaqueOwnerToken?: unknown;
      authority?: unknown;
    };
    expect(descriptor.opaqueOwnerToken).toBe(authority.receiptContext.ownerToken);
    expect(descriptor.authority).toEqual(authority);
    expect(typeof descriptor.childPid).toBe("number");
    expect(() => process.kill(descriptor.childPid as number, 0)).toThrow();
  });

  nativeOnly("expires an active v2 child without waiting for a stop command", { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-agent-lease-expiry-"));
    const runtimeRoot = path.join(root, "receipts");
    const authority = validAuthority("lease-expiry", runtimeRoot, 300);
    const result = await runNativeChildProcessV2("lease-expiry", process.execPath, [
      "-e",
      "setInterval(()=>{},1000)",
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSec: 0,
      graceSec: 1,
      onLog: async () => {},
      onLogError: () => {},
      binaryPath: nativeHostPath!,
      runtimeRoot,
      authority,
    });

    if (process.platform === "win32") {
      expect(result.signal).toBeNull();
    } else {
      expect(result.signal).toBe("SIGTERM");
    }
    expect(result.timedOut).toBe(false);
    const descriptorPath = path.join(
      runtimeRoot,
      authority.receiptContext.ownerToken,
      "owner-descriptor.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as { childPid?: unknown };
    expect(typeof descriptor.childPid).toBe("number");
    expect(() => process.kill(descriptor.childPid as number, 0)).toThrow();

    const receipt = JSON.parse(
      await readFile(path.join(runtimeRoot, authority.receiptContext.ownerToken, "terminal-receipt.json"), "utf8"),
    ) as {
      authority?: unknown;
      opaqueOwnerToken?: unknown;
      terminal?: { status?: string; errorCode?: string; cleanupProven?: boolean; receiptWritten?: boolean };
    };
    expect(receipt.authority).toEqual(authority);
    expect(receipt.opaqueOwnerToken).toBe(authority.receiptContext.ownerToken);
    expect(receipt.terminal).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
      cleanupProven: true,
      receiptWritten: true,
    });
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
      "const chunk='x'.repeat(16384);let i=0;const write=()=>{while(i<64){i+=1;if(!process.stdout.write(chunk)){process.stdout.once('drain',write);return}}};write()",
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

  it("fails closed when the log consumer cannot drain the bounded output spool", { timeout: 15_000 }, async () => {
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
      // Exceed the 4 MiB queue bound without making the fake lifecycle frame
      // unnecessarily expensive for slower platform runners.
      lifecycle.write(Array.from({ length: 320 }, () => `${JSON.stringify({ type: "output", protocolVersion: { major: 1, minor: 0 }, requestId, ownerToken: requestId, stream: "stdout", data })}\n`).join(""));
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
