import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { createWindowsProcessController } from "../../desktop/src/local-app-windows-processes.mjs";
import {
  CAMPAIGN_DEADLINE_MS,
  CASE_DEADLINE_MS,
  eofFollowupNeeded,
  failureKind,
  initialProbePlan,
  instrumentHelper,
  minimalWatchdogEnvironment,
  parseMetadata,
  runCampaign,
  runProbe,
  runnerIdentity,
  settleOwnedHelper,
  stalledAtConversion,
} from "./windows-process-helper.mjs";

const SCRIPT = `[Console]::Out.WriteLine('{"id":0,"ok":true}')\n$request = ConvertFrom-Json -InputObject $line`;

function helperFixture({ answer = true, killAccepted = true, answerOnEof = false } = {}) {
  const writes = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4321, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref() {},
    kill(signal) {
      child.signals.push(signal);
      if (killAccepted) queueMicrotask(() => child.exit(1, signal));
      return killAccepted;
    },
    signals: [],
    exit(code, signal = null) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
      child.stdout.end();
      child.stderr.end();
    },
  });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk));
      writes.push(request);
      if (answerOnEof) child.stderr.write("RUDDER_WINPROC|0|request_parse_start|100\n");
      if (answer) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ok: true,
        result: { pid: request.pid, createdAt: "134309052500356063" } })}\n`));
      callback();
    },
    final(callback) {
      if (answerOnEof && writes[0]) {
        child.stderr.write("RUDDER_WINPROC|0|request_json_parse_done|200\n");
        child.stdout.write(`${JSON.stringify({ id: writes[0].id, ok: true,
          result: { pid: writes[0].pid, createdAt: "134309052500356063" } })}\n`);
      }
      queueMicrotask(() => child.exit(0));
      callback();
    },
  });
  let argumentsSeen;
  const spawnProcess = (...args) => {
    argumentsSeen = args;
    queueMicrotask(() => child.stdout.write('{"id":0,"ok":true}\n'));
    return child;
  };
  return { child, writes, spawnProcess, args: () => argumentsSeen };
}

test("minimal environment preserves the watchdog allowlist and excludes caller secrets/search paths", () => {
  const env = minimalWatchdogEnvironment({ SystemRoot: "D:\\Windows", WINDIR: "D:\\Windows", TMP: "D:\\Temp",
    PATH: "UNTRUSTED", PSModulePath: "UNTRUSTED", USERPROFILE: "PRIVATE", LOCALAPPDATA: "PRIVATE", TOKEN: "SECRET" });
  assert.deepEqual(env, { ELECTRON_RUN_AS_NODE: "1", SystemRoot: "D:\\Windows", WINDIR: "D:\\Windows",
    TEMP: "D:\\Temp", TMP: "D:\\Temp" });
  assert.equal(minimalWatchdogEnvironment({}).TEMP, "C:\\Windows\\Temp");
  assert.equal(minimalWatchdogEnvironment({ TEMP: "one", TMP: "two" }).TMP, "two");
});

test("plan is bounded and starts with two unchanged streaming requests", () => {
  assert.deepEqual(initialProbePlan().map((probe) => probe.name), ["baseline", "resolution", "trusted-initialization", "trusted-utility-management"]);
  assert.equal(initialProbePlan()[0].requests, 2);
  assert.equal(initialProbePlan()[0].instrumentation, "none");
  assert.ok(CASE_DEADLINE_MS >= 3 * 60_000);
  assert.ok(CAMPAIGN_DEADLINE_MS < 20 * 60_000);
  assert.equal(instrumentHelper(SCRIPT, "none"), SCRIPT);
});

test("runner evidence accepts only bounded image/version/platform identities", () => {
  assert.deepEqual(runnerIdentity({ ImageOS: "win25-vs2026", ImageVersion: "20260925.250.1",
    RUNNER_OS: "Windows", RUNNER_ARCH: "X64", TOKEN: "PRIVATE" }), {
    imageId: "win25-vs2026", imageVersion: "20260925.250.1", os: "Windows", arch: "X64",
  });
  assert.deepEqual(runnerIdentity({ ImageOS: "C:\\PRIVATE", ImageVersion: "PRIVATE",
    RUNNER_OS: "PRIVATE", RUNNER_ARCH: "PRIVATE" }), { imageId: null, imageVersion: null, os: null, arch: null });
});

test("instrumentation splits command discovery/invocation and imports only PSHOME Utility", () => {
  const resolution = instrumentHelper(SCRIPT, "resolution");
  assert.ok(resolution.indexOf("diag_discovery_start") < resolution.indexOf("GetCommand("));
  assert.ok(resolution.indexOf("GetCommand(") < resolution.indexOf("diag_discovery_done"));
  assert.ok(resolution.includes("$request = & $rudderJsonCommand -InputObject $line"));
  assert.ok(resolution.indexOf("Unexpected diagnostic converter identity") < resolution.indexOf("$request = &"));
  const trusted = instrumentHelper(SCRIPT, "trusted");
  assert.ok(trusted.includes("[IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility'"));
  assert.ok(trusted.includes("System.Web.Extensions, Version=4.0.0.0"));
  assert.ok(trusted.indexOf("diag_serializer_init_done") < trusted.indexOf("[Console]::Out.WriteLine"));
  assert.ok(!trusted.includes("ExecutionPolicy"));
  assert.ok(!trusted.includes("SetEnvironmentVariable"));
  assert.throws(() => instrumentHelper("changed", "resolution"), /source drift/);
  assert.throws(() => instrumentHelper(`${SCRIPT}\n${SCRIPT}`, "trusted"), /source drift/);
  assert.throws(() => instrumentHelper(SCRIPT, "unknown"));
});

test("metadata and failure output use an allowlist, never raw stderr or environment values", () => {
  assert.deepEqual(parseMetadata("RUDDER_DIAG|powershell_version|5.1.26100.1"), ["powershell_version", "5.1.26100.1"]);
  assert.deepEqual(parseMetadata("RUDDER_DIAG|env_LOCALAPPDATA|False"), ["env_LOCALAPPDATA", false]);
  assert.deepEqual(parseMetadata("RUDDER_DIAG|expected_converter_type|True"), ["expected_converter_type", true]);
  assert.deepEqual(parseMetadata("RUDDER_DIAG|expected_management_module|True"), ["expected_management_module", true]);
  assert.deepEqual(parseMetadata("RUDDER_DIAG|expected_management_module|False"), ["expected_management_module", false]);
  for (const line of ["TOKEN=PRIVATE", "RUDDER_DIAG|TOKEN|PRIVATE", "RUDDER_DIAG|env_LOCALAPPDATA|PRIVATE",
    "RUDDER_DIAG|powershell_version|PRIVATE", "RUDDER_DIAG|converter_assembly_version|C:\\private"]) {
    assert.equal(parseMetadata(line), null);
  }
  assert.equal(failureKind(new Error("Windows process helper exited (1): PRIVATE")), "helper_exited");
  assert.equal(failureKind(new Error("Windows process helper request timed out PRIVATE")), "request_timeout");
  assert.equal(failureKind(new Error("PRIVATE")), "operation_failed");
});

test("fourth comparison only adds trusted Management preload before readiness, leaving Get-Process unchanged", () => {
  const script = `${SCRIPT}\n$candidate = Get-Process -Id ([int]$request.pid) -ErrorAction Stop`;
  const result = instrumentHelper(script, "trusted-management");
  const ready = result.indexOf("[Console]::Out.WriteLine");
  assert.ok(result.includes("[IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')"));
  assert.ok(result.indexOf("diag_utility_import_done") < result.indexOf("diag_management_import_start"));
  assert.ok(result.indexOf("diag_management_import_start") < result.indexOf("Import-Module -Name $rudderManagementPath"));
  assert.ok(result.indexOf("Import-Module -Name $rudderManagementPath") < result.indexOf("diag_management_import_done"));
  assert.ok(result.indexOf("diag_management_import_done") < ready);
  assert.ok(result.indexOf("Unexpected diagnostic Management module identity") < ready);
  assert.ok(result.includes("$candidate = Get-Process -Id ([int]$request.pid) -ErrorAction Stop"));
  assert.ok(!result.includes("GetCommand('Get-Process'"));
  const blockStart = result.lastIndexOf('\nWrite-RudderHelperPhase 0 "diag_management_import_start"', ready);
  const blockEnd = result.indexOf("\n\n[Console]::Out.WriteLine", blockStart);
  assert.equal(result.slice(0, blockStart) + result.slice(blockEnd + 1), instrumentHelper(script, "trusted"));
  assert.ok(!result.includes("ExecutionPolicy"));
  assert.deepEqual(initialProbePlan()[3], { name: "trusted-utility-management", instrumentation: "trusted-management", requests: 2 });
});

test("production controller seam sends only two captures of the harness PID and closes its own handle", async () => {
  const fixture = helperFixture();
  const result = await runProbe(initialProbePlan()[0], { spawnProcess: fixture.spawnProcess });
  assert.equal(result.outcome, "capture_completed");
  assert.equal(result.requests.length, 2);
  assert.deepEqual(fixture.writes, [1, 2].map((id) => ({ id, type: "capture", pid: process.pid })));
  assert.equal(fixture.args()[1][2], "-Command");
  assert.ok(fixture.args()[1][3].includes("$request = ConvertFrom-Json -InputObject $line"));
  assert.deepEqual(Object.keys(fixture.args()[2].env).sort(), ["ELECTRON_RUN_AS_NODE", "SystemRoot", "TEMP", "TMP", "WINDIR"].sort());
  assert.equal(result.cleanup.status, "exit_after_eof");
  assert.deepEqual(fixture.child.signals, []);
  assert.equal(JSON.stringify(result).includes('"pid"'), false);
  assert.equal(JSON.stringify(result).includes("134309052500356063"), false);
});

test("abort cleans up the spawned child by handle and does not change controller requestTimeoutMs", async () => {
  const fixture = helperFixture({ answer: false });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10);
  let controllerOptions;
  const result = await runProbe(initialProbePlan()[0], { spawnProcess: fixture.spawnProcess, signal: abort.signal,
    createController: (options) => { controllerOptions = options; return createWindowsProcessController(options); } });
  clearTimeout(timer);
  assert.equal(result.failure, "diagnostic_deadline");
  assert.equal(result.cleanup.status, "exit_after_signal");
  assert.deepEqual(fixture.child.signals, ["SIGKILL"]);
  assert.deepEqual(Object.keys(controllerOptions).sort(), ["observePhase", "spawnProcess"]);
});

test("controlled EOF is recorded after parse starts and preserves capture response validation", async () => {
  const fixture = helperFixture({ answer: false, answerOnEof: true });
  const result = await runProbe({ name: "eof-test", instrumentation: "none", requests: 1, eofDelayMs: 5 },
    { spawnProcess: fixture.spawnProcess });
  assert.equal(result.outcome, "capture_completed");
  assert.equal(result.eofWrite, "submitted");
  assert.equal(eofFollowupNeeded(result), true);
  assert.ok(result.eofAtMs >= result.events.find((event) => event.phase === "request_parse_start").elapsedMs);
  assert.ok(["exited", "exit_after_eof"].includes(result.cleanup.status));
  assert.deepEqual(fixture.writes, [{ id: 1, type: "capture", pid: process.pid }]);
});

test("raw helper errors and unrecognized metadata never reach the report", async () => {
  const fixture = helperFixture({ answer: false });
  const result = await runProbe(initialProbePlan()[0], { spawnProcess: (...args) => {
    const child = fixture.spawnProcess(...args);
    setImmediate(() => {
      child.stderr.write("PRIVATE_ERROR_WITH_REQUEST_PID_AND_ENV\nRUDDER_DIAG|env_USERPROFILE|PRIVATE\n");
      child.stderr.write("RUDDER_DIAG|powershell_version|5.1.26100.1\n");
      child.exit(1);
    });
    return child;
  } });
  assert.equal(result.failure, "helper_exited");
  assert.equal(result.cleanup.status, "exited");
  assert.equal(result.metadata.powershell_version, "5.1.26100.1");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("fast parse failure with an unmatched id0 error is not a conversion stall when the request times out", async () => {
  const fixture = helperFixture({ answer: false });
  const result = await runProbe(initialProbePlan()[0], {
    // Only this mock transport uses a short deadline; runProbe never overrides production timeouts.
    createController: (options) => createWindowsProcessController({ ...options, requestTimeoutMs: 20 }),
    spawnProcess: (...args) => {
      const child = fixture.spawnProcess(...args);
      setImmediate(() => {
        child.stderr.write([
          "RUDDER_WINPROC|0|request_parse_start|100",
          "RUDDER_WINPROC|0|request_failed|110",
          "RUDDER_WINPROC|0|response_serialize_start|120",
          "RUDDER_WINPROC|0|response_flush_done|130",
          "RUDDER_WINPROC|0|request_read_wait|140",
        ].join("\n") + "\n");
        child.stdout.write('{"id":0,"ok":false,"error":"PRIVATE_DIAGNOSTIC_FAILURE"}\n');
      });
      return child;
    },
  });
  assert.equal(result.failure, "request_timeout");
  assert.ok(result.events.some((event) => event.phase === "stdout_response_unmatched"));
  assert.equal(stalledAtConversion(result), false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(result.cleanup.status, "exited");
});

test("owned helper cleanup does not turn an accepted signal into exit proof", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 76543, exitCode: null, signalCode: null,
    kill: () => true });
  assert.deepEqual(await settleOwnedHelper(child, { timeoutMs: 5 }), { status: "unverified" });
  child.kill = () => false;
  assert.deepEqual(await settleOwnedHelper(child, { timeoutMs: 5 }), { status: "unverified" });
  assert.deepEqual(await settleOwnedHelper(null), { status: "not_spawned" });
});

test("owned helper cleanup observes a real process exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    assert.deepEqual(await settleOwnedHelper(child), { status: "exit_after_signal" });
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

test("EOF interventions are conditional; apparent sensitivity gets one different-delay comparison", async () => {
  const observed = [];
  const first = { failure: "request_timeout", events: [{ phase: "request_parse_start", elapsedMs: 1 }], cleanup: { status: "exited" } };
  assert.equal(stalledAtConversion(first), true);
  assert.equal(stalledAtConversion({ ...first, failure: "startup_timeout" }), false);
  const campaign = await runCampaign({ run: async (probe) => {
    observed.push(probe);
    if (probe.name === "baseline") return { ...first, name: probe.name };
    if (probe.name === "eof-15s") return { name: probe.name, eofAtMs: 15000,
      events: [{ phase: "request_json_parse_done", elapsedMs: 15020 }], cleanup: { status: "exited" } };
    return { name: probe.name, events: [], cleanup: { status: "exited" } };
  } });
  assert.equal(campaign.results.length, 6);
  assert.deepEqual(observed.slice(-2).map((probe) => probe.eofDelayMs), [15000, 30000]);
  assert.equal(eofFollowupNeeded({ eofAtMs: 100, events: [{ phase: "request_json_parse_done", elapsedMs: 3000 }] }), false);
  assert.equal(eofFollowupNeeded({ events: [] }), false);
});

test("conversion-stall classification follows the latest unmatched parse, including request two", () => {
  const firstSuccess = [{ phase: "request_parse_start" }, { phase: "request_json_parse_done" }];
  assert.equal(stalledAtConversion({ failure: "request_timeout", events: firstSuccess }), false);
  assert.equal(stalledAtConversion({ failure: "request_timeout", events: [
    ...firstSuccess, { phase: "request_parse_start" }, { phase: "diag_discovery_start" },
  ] }), true);
  assert.equal(stalledAtConversion({ failure: "request_timeout", events: [
    ...firstSuccess, { phase: "request_parse_start" }, { phase: "request_json_parse_done" },
  ] }), false);
  for (const phase of ["request_failed", "response_serialize_start", "response_flush_start", "response_flush_done",
    "stdout_response_unmatched", "stdout_response_matched_error", "request_read_wait"]) {
    assert.equal(stalledAtConversion({ failure: "request_timeout", events: [
      ...firstSuccess, { phase: "request_parse_start" }, { phase },
    ] }), false, phase);
  }
});

test("campaign stops on unverified cleanup or deadline, and never retries a healthy baseline", async () => {
  for (const status of ["unverified", "exited"]) {
    let calls = 0;
    const { results } = await runCampaign({ run: async () => { calls += 1; return { events: [], cleanup: { status } }; } });
    assert.equal(calls, status === "unverified" ? 1 : 4);
    assert.equal(results.length, calls);
  }
  const abort = new AbortController();
  abort.abort();
  const campaign = await runCampaign({ signal: abort.signal, run: () => assert.fail("must not spawn") });
  assert.equal(campaign.deadlineReached, true);
  assert.equal(campaign.results.length, 0);
});
