import { describe, expect, it, vi } from "vitest";

import {
  captureManagedWindowsProcessIdentity,
  parseWindowsProcessTable,
  terminateWindowsProcessInstances,
  windowsProcessCreationCommand,
  windowsProcessTreeSnapshotCommand,
  windowsTerminateInstancesCommand,
} from "./local-app-windows-processes.mjs";

describe("Windows Local App process-instance authority", () => {
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
