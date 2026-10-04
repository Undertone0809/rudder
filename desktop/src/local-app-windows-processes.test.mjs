import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  captureManagedWindowsProcessIdentity,
  createWindowsProcessController,
  failClosedWindowsProcessTreeCleanup,
  parseWindowsProcessTable,
  terminateWindowsChildProcessHandle,
  terminateWindowsProcessInstances,
  windowsProcessCreationCommand,
  windowsProcessTreeSnapshotCommand,
  windowsTerminateInstancesCommand,
} from "./local-app-windows-processes.mjs";

function createHelperFixture(options = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes = [];
  const phases = [];
  let spawnArguments;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      callback();
    },
  });
  stdin.unref = () => {};
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    stdin,
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
    requestTimeoutMs: options.requestTimeoutMs ?? 10,
    observePhase: (event) => phases.push(event),
  });
  stdout.write('{"id":0,"ok":true}\n');
  return { child, controller, stdout, stderr, writes, phases, getSpawnArguments: () => spawnArguments };
}

async function nextImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
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
    expect(error.message).toContain("helperStop=signal-accepted");
    expect(error.message).toContain("helperExit=unverified");
    expect(error.message).toMatch(/stderr=redacted:8192B:sha256=[a-f0-9]{12}/);
    expect(error.message).not.toContain("PRIVATE_COMMAND_AND_PAYLOAD");
    expect(error.message).not.toContain("76543");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.exitCode = 0;
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
  });

  it("records sanitized monotonic phases across helper write, read, and capture stages", async () => {
    const { child, controller, stderr, stdout, writes, phases, getSpawnArguments } = createHelperFixture();
    const request = controller.request("capture", { pid: 76543, token: "PRIVATE_REQUEST_SENTINEL" });
    await nextImmediate();

    expect(writes[0]).toBe('{"id":1,"type":"capture","pid":76543,"token":"PRIVATE_REQUEST_SENTINEL"}\n');
    const helperScript = getSpawnArguments()[1][3];
    expect(helperScript).toContain('Write-RudderHelperPhase $requestId "get_process_start"');
    expect(helperScript).toContain('Write-RudderHelperPhase $requestId "get_times_start"');
    expect(helperScript).toContain('Write-RudderHelperPhase $requestId "response_flush_start"');
    expect(helperScript).toContain('Write-RudderHelperPhase 0 "request_read_wait"');

    stderr.write([
      "RUDDER_WINPROC|0|request_read_wait|90",
      "RUDDER_WINPROC|0|request_line_read|100",
      "RUDDER_WINPROC|0|request_parse_start|110",
      "RUDDER_WINPROC|1|request_parse_done|120",
      "RUDDER_WINPROC|1|get_process_start|130",
      "RUDDER_WINPROC|1|get_process_done|135",
      "RUDDER_WINPROC|1|get_times_start|140",
    ].join("\n") + "\n");
    const error = await request.then(() => null, (reason) => reason);

    expect(error.message).toContain("1:node:request_write_start@");
    expect(error.message).toContain("1:node:request_write_callback_ok@");
    expect(error.message).toContain("0:powershell:request_read_wait@90");
    expect(error.message).toContain("1:powershell:get_process_start@130");
    expect(error.message).toContain("1:powershell:get_times_start@140");
    expect(error.message).toContain("request_timeout");
    expect(error.message).toContain("helperStop=signal-accepted");
    expect(error.message).not.toContain("76543");
    expect(error.message).not.toContain("PRIVATE_REQUEST_SENTINEL");
    expect(phases.map((event) => event.phase)).toContain("helper_stop_signal_accepted");
    for (const source of ["node", "powershell"]) {
      const clocks = phases.filter((event) => event.source === source).map((event) => BigInt(event.clock));
      expect(clocks.every((clock, index) => index === 0 || clock >= clocks[index - 1])).toBe(true);
    }

    child.exitCode = 0;
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
  });

  it("distinguishes JSON conversion from request ID binding in timeout traces", async () => {
    const { child, controller, stderr, stdout, getSpawnArguments } = createHelperFixture();
    const request = controller.request("capture", { pid: 76543 });
    await nextImmediate();

    const helperScript = getSpawnArguments()[1][3];
    expect(helperScript).toContain("$request = ConvertFrom-Json -InputObject $line");
    const parseStart = helperScript.indexOf('Write-RudderHelperPhase 0 "request_parse_start"');
    const jsonParsed = helperScript.indexOf('Write-RudderHelperPhase 0 "request_json_parse_done"');
    const requestIdAssignment = helperScript.indexOf("$requestId = [int]$request.id");
    const requestIdBound = helperScript.indexOf('Write-RudderHelperPhase $requestId "request_id_bound"');
    expect(parseStart).toBeGreaterThanOrEqual(0);
    expect(jsonParsed).toBeGreaterThan(parseStart);
    expect(requestIdAssignment).toBeGreaterThan(jsonParsed);
    expect(requestIdBound).toBeGreaterThan(requestIdAssignment);

    stderr.write([
      "RUDDER_WINPROC|0|request_parse_start|110",
      "RUDDER_WINPROC|0|request_json_parse_done|120",
    ].join("\n") + "\n");
    const error = await request.then(() => null, (reason) => reason);

    expect(error.message).toContain("0:powershell:request_json_parse_done@120");
    expect(error.message).not.toContain("request_id_bound@");
    expect(error.message).not.toContain("76543");

    child.exitCode = 0;
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
  });

  it("records response JSON parse and request correlation phases", async () => {
    const { child, controller, stdout, stderr, phases } = createHelperFixture();
    const request = controller.request("capture", { pid: 76543 });
    await nextImmediate();
    stdout.write("not-json\n");
    stderr.write("RUDDER_WINPROC|1|response_flush_done|140\n");
    stdout.write('{"id":1,"ok":true,"result":{"pid":76543,"createdAt":"134309052500356063"}}\n');

    await expect(request).resolves.toEqual({ pid: 76543, createdAt: "134309052500356063" });
    expect(phases.map((event) => event.phase)).toContain("stdout_json_parse_invalid");
    expect(phases.map((event) => event.phase)).toContain("stdout_response_matched_ok");
    expect(phases).toContainEqual(expect.objectContaining({
      source: "powershell",
      id: 1,
      phase: "response_flush_done",
      clock: "140",
    }));
    expect(child.kill).not.toHaveBeenCalled();

    child.exitCode = 0;
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
  });

  it("uses only the owned child handle and leaves process-tree cleanup explicitly unverified", async () => {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: 76543,
      exitCode: null,
      signalCode: null,
      kill: vi.fn((signal) => {
        queueMicrotask(() => {
          child.signalCode = signal;
          child.emit("exit", null, signal);
        });
        return true;
      }),
    });
    const identityError = new Error("identity capture failed");

    await expect(failClosedWindowsProcessTreeCleanup(child, identityError, { timeoutMs: 100 }))
      .rejects.toMatchObject({
        message: "Windows Local App process tree cleanup remains unverified (rootPid=76543; rootCreationTime=unavailable; directChild=exit-after-signal; descendants=unverified)",
        cause: identityError,
      });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("waits for exit after signaling its spawned ChildProcess handle", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await once(child, "spawn");
      await expect(terminateWindowsChildProcessHandle(child, { timeoutMs: 2_000 }))
        .resolves.toBe("exit-after-signal");
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        let timeout;
        const exited = new Promise((resolve) => {
          const onExit = () => {
            clearTimeout(timeout);
            resolve();
          };
          child.once("exit", onExit);
          timeout = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve();
          }, 2_000);
        });
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("does not claim cleanup when the owned child handle cannot prove exit", async () => {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: 76543,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });

    await expect(failClosedWindowsProcessTreeCleanup(child, new Error("identity unavailable"), { timeoutMs: 10 }))
      .rejects.toMatchObject({
        message: "Windows Local App process tree cleanup remains unverified (rootPid=76543; rootCreationTime=unavailable; directChild=unverified; descendants=unverified)",
        cause: expect.any(AggregateError),
      });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(terminateWindowsChildProcessHandle({ pid: 1 }, { timeoutMs: 10 }))
      .rejects.toThrow("child process handle is unavailable");
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
