import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  captureManagedWindowsProcessIdentity,
  createWindowsProcessController,
  parseWindowsProcessTable,
  terminateWindowsProcessInstances,
  windowsProcessCreationCommand,
  windowsProcessTreeSnapshotCommand,
  windowsTerminateInstancesCommand,
} from "./local-app-windows-processes.mjs";

function createHelperFixture({ requestTimeoutMs = 10 } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let spawnArguments;
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    stdin: { unref() {}, write() {} },
    stdout,
    stderr,
    unref() {},
  });
  const controller = createWindowsProcessController({
    spawnProcess: (...args) => {
      spawnArguments = args;
      return child;
    },
    isProcessAlive: () => true,
    requestTimeoutMs,
  });
  stdout.write('{"id":0,"ok":true}\n');
  return { child, controller, stdout, stderr, spawnArguments };
}

async function nextImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function withCaptureDiagnostics(run) {
  const name = "RUDDER_WINDOWS_PROCESS_HELPER_CAPTURE_DIAGNOSTICS";
  const previous = process.env[name];
  process.env[name] = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe("Windows Local App process-instance authority", () => {
  it.each(["capture", "snapshot"])("reports bounded, payload-free %s timeout diagnostics", async (type) => {
    const { child, controller, stdout, stderr } = createHelperFixture();
    const request = controller.request(type, { pid: 76543 });
    await nextImmediate();
    stderr.emit("data", `${"x".repeat(9_000)}PRIVATE_COMMAND_AND_PAYLOAD`);

    const error = await request.then(() => null, (reason) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`type=${type}, id=1`);
    expect(error.message).toContain("helperPid=4321, helperState=alive");
    expect(error.message).toMatch(/stderr=redacted:8192B:sha256=[a-f0-9]{12}/);
    expect(error.message).not.toContain("PRIVATE_COMMAND_AND_PAYLOAD");
    expect(error.message).not.toContain("76543");

    child.exitCode = 0;
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
  });

  it("keeps opt-in capture phase markers off the JSONL response channel", async () => {
    await withCaptureDiagnostics(async () => {
      const { child, controller, stdout, stderr, spawnArguments } = createHelperFixture({ requestTimeoutMs: 500 });
      const helperScript = spawnArguments[1][3];
      expect(helperScript).toContain("$env:RUDDER_WINDOWS_PROCESS_HELPER_CAPTURE_DIAGNOSTICS -eq '1'");
      expect(helperScript).toContain("[Console]::Error.WriteLine(");
      expect(helperScript).not.toContain('[Console]::Out.WriteLine("RUDDER_WINDOWS_CAPTURE_PHASE');
      for (const phase of [
        "handler_enter",
        "process_enumeration_start",
        "process_enumeration_end",
        "response_write_start",
        "response_write_end",
      ]) {
        expect(helperScript).toContain(`Write-RudderCapturePhase '${phase}'`);
      }

      const request = controller.request("capture", { pid: 76543 });
      await nextImmediate();
      stderr.write("RUDDER_WINDOWS_CAPTURE_PHASE id=1 phase=handler_enter\r\n");
      stdout.write('{"id":1,"ok":true,"result":{"pid":76543,"createdAt":"134309052500356063"}}\n');
      await expect(request).resolves.toEqual({ pid: 76543, createdAt: "134309052500356063" });

      child.exitCode = 0;
      child.emit("exit", 0, null);
      stdout.end();
      stderr.end();
    });
  });

  it("reports the last allowlisted opt-in capture phase on timeout", async () => {
    await withCaptureDiagnostics(async () => {
      const { child, controller, stdout, stderr } = createHelperFixture({ requestTimeoutMs: 50 });
      const request = controller.request("capture", { pid: 76543 });
      await nextImmediate();
      stderr.write("RUDDER_WINDOWS_CAPTURE_PHASE id=1 phase=handler_enter\r\n");
      stderr.write("RUDDER_WINDOWS_CAPTURE_PHASE id=1 phase=process_enumeration_start\r\n");
      stderr.write(`${"x".repeat(9_000)}PRIVATE_COMMAND_AND_PAYLOAD`);

      const error = await request.then(() => null, (reason) => reason);
      expect(error.message).toContain("capturePhase=process_enumeration_start");
      expect(error.message).not.toContain("PRIVATE_COMMAND_AND_PAYLOAD");
      expect(error.message).toMatch(/stderr=redacted:8192B:sha256=[a-f0-9]{12}/);

      child.exitCode = 0;
      child.emit("exit", 0, null);
      stdout.end();
      stderr.end();
    });
  });

  it("uses the same full-precision FILETIME token for capture and snapshots", () => {
    expect(windowsProcessCreationCommand(42)).toContain("ToFileTimeUtc().ToString()");
    expect(windowsProcessTreeSnapshotCommand(42)).toContain("ToFileTimeUtc().ToString()");
    expect(windowsProcessTreeSnapshotCommand(42)).not.toContain("fffZ");
    expect(parseWindowsProcessTable(JSON.stringify([
      { ProcessId: 42, ParentProcessId: 1, CreationTime: "134309052500356063" },
    ]))).toEqual([
      { pid: 42, parentPid: 1, createdAt: "134309052500356063" },
    ]);
  });

  it("builds a retained-handle termination helper without taskkill", () => {
    const command = windowsTerminateInstancesCommand([
      { pid: 42, parentPid: 1, createdAt: "134309052500356063" },
    ]);
    expect(command).toContain("SafeHandle");
    expect(command).toContain("GetProcessTimes");
    expect(command).toContain("TerminateProcess");
    expect(command).not.toContain("taskkill");
  });

  it("waits for identity capture before cleanup can receive termination authority", async () => {
    let resolveCapture;
    const capture = new Promise((resolve) => { resolveCapture = resolve; });
    const child = { pid: 42, exitCode: null, signalCode: null };
    const identityPromise = captureManagedWindowsProcessIdentity(child, () => capture);
    const cleanup = vi.fn();
    const cleanupPromise = identityPromise.then(cleanup);

    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    resolveCapture("134309052500356063");
    await cleanupPromise;
    expect(cleanup).toHaveBeenCalledWith({ pid: 42, createdAt: "134309052500356063" });
  });

  it("rejects identity captured after the original child exits", async () => {
    const child = { pid: 42, exitCode: null, signalCode: null };
    await expect(captureManagedWindowsProcessIdentity(child, async () => {
      child.exitCode = 0;
      return "134309052500356063";
    })).rejects.toThrow("exited before its identity was captured");
  });

  it("accepts gone or replacement instances but rejects a retained-handle failure", async () => {
    const processes = [
      { pid: 42, parentPid: 1, createdAt: "134309052500356063" },
      { pid: 43, parentPid: 42, createdAt: "134309052500356064" },
    ];
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify([
        { pid: 42, status: "gone" },
        { pid: 43, status: "replacement" },
      ]),
    }));
    await expect(terminateWindowsProcessInstances(processes, {
      execFileAsync: execute,
    })).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();

    await expect(terminateWindowsProcessInstances(processes, {
      execFileAsync: async () => ({
        stdout: JSON.stringify([
          { pid: 42, status: "terminated" },
          { pid: 43, status: "failed" },
        ]),
      }),
    })).rejects.toThrow("process-handle termination failed");
  });
});
