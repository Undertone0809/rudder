import { describe, expect, it, vi } from "vitest";

import {
  isAbsoluteLocalAppPath,
  isValidLocalAppWatchdogConfig,
  localAppUsesDetachedProcessGroup,
  terminateLocalAppOwner,
} from "./local-app-process-platform-shared.mjs";
import {
  createLocalAppProcessPlatform,
  descendantProcessIds,
  parseLinuxTcpListenerInodes,
  parseWindowsLoopbackListenerPids,
  parseWindowsProcessTable,
} from "./local-app-process-platform.js";

describe("Local App process platform abstraction", () => {
  it("uses portable absolute-path and detached-process rules", () => {
    expect(isAbsoluteLocalAppPath("/opt/rudder/app", "linux")).toBe(true);
    expect(isAbsoluteLocalAppPath("C:\\Rudder\\app.exe", "win32")).toBe(true);
    expect(isAbsoluteLocalAppPath("/opt/rudder/app", "win32")).toBe(false);
    expect(localAppUsesDetachedProcessGroup("darwin")).toBe(true);
    expect(localAppUsesDetachedProcessGroup("linux")).toBe(true);
    expect(localAppUsesDetachedProcessGroup("win32")).toBe(false);
  });

  it("validates watchdog configuration using the selected platform path grammar", () => {
    expect(isValidLocalAppWatchdogConfig({
      type: "start",
      executable: "C:\\Rudder\\node.exe",
      argv: ["server.mjs"],
      cwd: "C:\\Users\\me\\app",
      env: { PORT: "43123" },
    }, "win32")).toBe(true);
    expect(isValidLocalAppWatchdogConfig({
      type: "start",
      executable: "../node",
      argv: [],
      cwd: "/tmp/app",
      env: {},
    }, "linux")).toBe(false);
  });

  it("terminates a POSIX process group and escalates only when still alive", async () => {
    let alive = true;
    const signals: Array<number | string> = [];
    await terminateLocalAppOwner(42, {
      platform: "linux",
      isAlive: () => alive,
      killProcess: (_pid: number, signal: number | string) => {
        signals.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
      delay: async () => undefined,
      termTimeoutMs: 1,
      pollMs: 1,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("terminates exact Windows process instances and proves the owner dead", async () => {
    const alive = new Set([42, 43]);
    const processTable = [
      { pid: 42, parentPid: 1, createdAt: "root-v1" },
      { pid: 43, parentPid: 42, createdAt: "child-v1" },
    ];
    const calls: Array<Array<{ pid: number; parentPid: number; createdAt: string }>> = [];
    await terminateLocalAppOwner(42, {
      platform: "win32",
      expectedOwnerCreatedAt: "root-v1",
      snapshotWindowsProcesses: async () => processTable.filter(({ pid }) => alive.has(pid)),
      terminateWindowsProcessInstances: async (processes) => {
        calls.push(processes);
        for (const { pid } of processes) alive.delete(pid);
      },
      delay: async () => undefined,
      termTimeoutMs: 1,
      pollMs: 1,
    });
    expect(calls).toEqual([processTable]);
  });

  it("does not mistake a missing Windows root PID for proof that its child tree is dead", async () => {
    let snapshots = 0;
    await expect(terminateLocalAppOwner(42, {
      platform: "win32",
      expectedOwnerCreatedAt: "root-v1",
      snapshotWindowsProcesses: async () => {
        snapshots += 1;
        return snapshots === 1
          ? [
              { pid: 42, parentPid: 1, createdAt: "root-v1" },
              { pid: 43, parentPid: 42, createdAt: "child-v1" },
            ]
          : [{ pid: 43, parentPid: 42, createdAt: "child-v1" }];
      },
      terminateWindowsProcessInstances: async () => { throw new Error("root already exited"); },
      delay: async () => undefined,
      termTimeoutMs: 1,
      pollMs: 1,
    })).rejects.toThrow("could not be proven dead");
  });

  it("terminates listener-verified Windows instances after an intermediate root exits", async () => {
    const verifiedProcesses = [
      { pid: 42, parentPid: 1, createdAt: "root-v1" },
      { pid: 43, parentPid: 42, createdAt: "child-v1" },
    ];
    const terminateWindowsProcessInstances = vi.fn();
    await terminateLocalAppOwner(42, {
      platform: "win32",
      expectedOwnerCreatedAt: "root-v1",
      expectedWindowsProcesses: verifiedProcesses,
      snapshotWindowsProcesses: async () => [],
      terminateWindowsProcessInstances,
      delay: async () => undefined,
      termTimeoutMs: 1,
      pollMs: 1,
    });
    expect(terminateWindowsProcessInstances).toHaveBeenCalledWith(verifiedProcesses);
  });

  it("refuses to terminate a reused Windows root PID", async () => {
    const terminateWindowsProcessInstances = vi.fn();
    await expect(terminateLocalAppOwner(42, {
      platform: "win32",
      expectedOwnerCreatedAt: "root-v1",
      snapshotWindowsProcesses: async () => [
        { pid: 42, parentPid: 1, createdAt: "root-v2" },
      ],
      terminateWindowsProcessInstances,
    })).rejects.toThrow("could not be proven dead");
    expect(terminateWindowsProcessInstances).not.toHaveBeenCalled();
  });

  it("does not terminate a replacement that reuses a captured descendant PID", async () => {
    let processTable = [
      { pid: 42, parentPid: 1, createdAt: "root-v1" },
      { pid: 43, parentPid: 42, createdAt: "child-v1" },
    ];
    const terminateWindowsProcessInstances = vi.fn(async () => {
      processTable = [{ pid: 43, parentPid: 1, createdAt: "child-v2" }];
    });
    await terminateLocalAppOwner(42, {
      platform: "win32",
      expectedOwnerCreatedAt: "root-v1",
      snapshotWindowsProcesses: async () => processTable,
      terminateWindowsProcessInstances,
      delay: async () => undefined,
      termTimeoutMs: 1,
      pollMs: 1,
    });
    expect(terminateWindowsProcessInstances).toHaveBeenCalledOnce();
    expect(terminateWindowsProcessInstances).toHaveBeenCalledWith([
      { pid: 42, parentPid: 1, createdAt: "root-v1" },
      { pid: 43, parentPid: 42, createdAt: "child-v1" },
    ]);
  });

  it("parses Windows process descendants and requires an exact loopback listener", () => {
    const table = parseWindowsProcessTable(JSON.stringify([
      { ProcessId: 0, ParentProcessId: 0 },
      { ProcessId: 42, ParentProcessId: 1, CreationTime: "root-v1" },
      { ProcessId: 43, ParentProcessId: 42, CreationTime: "child-v1" },
      { ProcessId: 99, ParentProcessId: 1, CreationTime: "other-v1" },
    ]));
    expect(table).toEqual([
      { pid: 42, parentPid: 1, createdAt: "root-v1" },
      { pid: 43, parentPid: 42, createdAt: "child-v1" },
      { pid: 99, parentPid: 1, createdAt: "other-v1" },
    ]);
    expect([...descendantProcessIds(42, table!)]).toEqual([42, 43]);
    expect(parseWindowsLoopbackListenerPids(
      "TCP    127.0.0.1:43123    0.0.0.0:0    LISTENING    43",
      43_123,
    )).toEqual([43]);
    expect(parseWindowsLoopbackListenerPids(
      "TCP    0.0.0.0:43123    0.0.0.0:0    LISTENING    43",
      43_123,
    )).toBeNull();
    expect(parseWindowsProcessTable(JSON.stringify([
      { ProcessId: 0, ParentProcessId: 1, CreationTime: "invalid" },
    ]))).toBeNull();
  });

  it("verifies a Windows listener belongs to the managed root process tree", async () => {
    const execute = vi.fn(async (executable: string) => ({
      stdout: executable.endsWith("powershell.exe")
        ? JSON.stringify([
            { ProcessId: 42, ParentProcessId: 1, CreationTime: "root-v1" },
            { ProcessId: 43, ParentProcessId: 42, CreationTime: "child-v1" },
          ])
        : "TCP    127.0.0.1:43123    0.0.0.0:0    LISTENING    43",
    }));
    const platform = createLocalAppProcessPlatform({
      platform: "win32",
      execFileAsync: execute,
    });
    await expect(platform.verifyListenerOwnership({
      port: 43_123,
      pid: 42,
      pgid: 42,
      timeoutMs: 1_234,
    }))
      .resolves.toBe(true);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/powershell\.exe$/),
      expect.arrayContaining([
        expect.stringContaining("Creating Process ID"),
      ]),
      expect.objectContaining({ maxBuffer: 2 * 1024 * 1024 }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/netstat\.exe$/),
      expect.any(Array),
      expect.objectContaining({ maxBuffer: 2 * 1024 * 1024 }),
    );
    for (const call of execute.mock.calls) {
      expect(call[2].timeout).toBeGreaterThan(0);
      expect(call[2].timeout).toBeLessThanOrEqual(1_234);
    }
  });

  it("passes only the root instance verified at startup to parent-side termination", async () => {
    const execute = vi.fn(async (executable: string) => ({
      stdout: executable.endsWith("powershell.exe")
        ? JSON.stringify([
            { ProcessId: 42, ParentProcessId: 1, CreationTime: "root-v1" },
            { ProcessId: 43, ParentProcessId: 42, CreationTime: "child-v1" },
          ])
        : "TCP    127.0.0.1:43123    0.0.0.0:0    LISTENING    43",
    }));
    const terminateWindowsProcessInstances = vi.fn();
    const platform = createLocalAppProcessPlatform({
      platform: "win32",
      execFileAsync: async (executable, args, options) => {
        return execute(executable, args, options);
      },
      snapshotWindowsProcesses: async () => [
        { pid: 42, parentPid: 1, createdAt: "root-v2" },
      ],
      terminateWindowsProcessInstances,
    });
    await expect(platform.verifyListenerOwnership({
      port: 43_123,
      pid: 42,
      pgid: 42,
      timeoutMs: 30_000,
    })).resolves.toBe(true);
    await expect(platform.terminate(42)).resolves.toBeUndefined();
    expect(terminateWindowsProcessInstances).toHaveBeenCalledWith([
      { pid: 42, parentPid: 1, createdAt: "root-v1" },
      { pid: 43, parentPid: 42, createdAt: "child-v1" },
    ]);
  });

  it.each([
    {
      name: "process inspection timeout",
      execute: async () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      },
      reason: "process inspection timed out",
    },
    {
      name: "missing managed root",
      execute: async () => ({
        stdout: JSON.stringify([{ ProcessId: 99, ParentProcessId: 1, CreationTime: "other-v1" }]),
      }),
      reason: "managed root was absent from process snapshot",
    },
    {
      name: "missing exact listener",
      execute: async (executable: string) => ({
        stdout: executable.endsWith("powershell.exe")
          ? JSON.stringify([{ ProcessId: 42, ParentProcessId: 1, CreationTime: "root-v1" }])
          : "",
      }),
      reason: "exact loopback listener was absent",
    },
    {
      name: "listener outside managed tree",
      execute: async (executable: string) => ({
        stdout: executable.endsWith("powershell.exe")
          ? JSON.stringify([
              { ProcessId: 42, ParentProcessId: 1, CreationTime: "root-v1" },
              { ProcessId: 99, ParentProcessId: 1, CreationTime: "other-v1" },
            ])
          : "TCP    127.0.0.1:43123    0.0.0.0:0    LISTENING    99",
      }),
      reason: "listener was outside the managed process tree",
    },
  ])("fails closed with sanitized diagnostics for $name", async ({ execute, reason }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const platform = createLocalAppProcessPlatform({
        platform: "win32",
        execFileAsync: execute,
      });
      await expect(platform.verifyListenerOwnership({
        port: 43_123,
        pid: 42,
        pgid: 42,
        timeoutMs: 30_000,
      })).resolves.toBe(false);
      await expect(platform.verifyListenerOwnership({
        port: 43_123,
        pid: 42,
        pgid: 42,
        timeoutMs: 30_000,
      })).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        `[local-app-ownership] Windows listener ownership rejected: ${reason}`,
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a Windows listener snapshot that completes after its shared deadline", async () => {
    const execute = vi.fn(async (executable: string) => ({
      stdout: executable.endsWith("powershell.exe")
        ? JSON.stringify([
            { ProcessId: 42, ParentProcessId: 1, CreationTime: "root-v1" },
            { ProcessId: 43, ParentProcessId: 42, CreationTime: "child-v1" },
          ])
        : "TCP    127.0.0.1:43123    0.0.0.0:0    LISTENING    43",
    }));
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_234);
    try {
      const platform = createLocalAppProcessPlatform({
        platform: "win32",
        execFileAsync: execute,
      });
      await expect(platform.verifyListenerOwnership({
        port: 43_123,
        pid: 42,
        pgid: 42,
        timeoutMs: 1_234,
      })).resolves.toBe(false);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("parses only IPv4 loopback listeners from Linux procfs", () => {
    const header = "sl local_address rem_address st tx_queue tr tm retrnsmt uid timeout inode";
    expect(parseLinuxTcpListenerInodes([
      header,
      "0: 0100007F:A873 00000000:0000 0A 0:0 00:0 0 1000 0 7654321",
    ].join("\n"), 43_123)).toEqual(["7654321"]);
    expect(parseLinuxTcpListenerInodes([
      header,
      "0: 00000000:A873 00000000:0000 0A 0:0 00:0 0 1000 0 7654321",
    ].join("\n"), 43_123)).toBeNull();
  });
});
