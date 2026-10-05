import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createWindowsProcessController } from "../../desktop/src/local-app-windows-processes.mjs";

import {
  CAMPAIGN_DEADLINE_MS,
  CAPTURE_DEADLINE_MS,
  IMPORT_DEADLINE_MS, STARTUP_STALL_DEADLINE_MS,
  TREE_DEADLINE_MS,
  acceptancePlan, bounded, cleanupFixture, describeOwnedSnapshot, failureKind, helperScript, lifecycleSatisfied,
  minimalWatchdogEnvironment, missingImportSatisfied, observeOwnedChild, ownedSnapshot,
  runCampaign, runCase, runnerIdentity, sanitizedPhase, settleOwnedHelper, startFixture,
  startupImportsSatisfied, startupStallSatisfied,
} from "./windows-process-helper.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  child.kill = () => true;
  return child;
}

const startEvents = ["startup_utility_import_start", "startup_utility_import_done",
  "startup_management_import_start", "startup_management_import_done", "ready_flush_done"]
  .map((phase) => ({ source: "powershell", id: 0, phase, clock: "1" }));

// The fake only replaces the OS boundary; runCase still uses the checked-in
// controller and its real pending-ready, request-write, and rejection behavior.
function helperSpawn({ missing = false, module = "utility", wrongIdentity = false } = {}) {
  return (executable, args, options) => {
    assert.match(executable, /powershell\.exe$/);
    assert.deepEqual(Object.keys(options.env).sort(), ["ELECTRON_RUN_AS_NODE", "SystemRoot", "TEMP", "TMP", "WINDIR"]);
    const child = fakeChild();
    const exit = (code) => {
      child.exitCode = code;
      child.emit("exit", code, null);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code, null);
    };
    child.kill = () => { exit(1); return true; };
    child.stdin.on("finish", () => { if (child.exitCode === null) exit(0); });
    child.stdin.on("data", (line) => {
      const request = JSON.parse(line);
      child.stdout.write(`${JSON.stringify({ id: request.id, ok: true,
        result: { pid: wrongIdentity ? 1 : request.pid, createdAt: "1234567890" } })}\n`);
    });
    queueMicrotask(() => {
      if (missing) {
        assert.match(args[3], /RudderAcceptanceMissing\.psd1/);
        if (module === "management") {
          child.stderr.write("RUDDER_WINPROC|0|startup_utility_import_start|1\n");
          child.stderr.write("RUDDER_WINPROC|0|startup_utility_import_done|1\n");
        }
        child.stderr.write("RUDDER_WINPROC|0|startup_import_failed|1\n");
        exit(1);
      } else {
        assert.doesNotMatch(args[3], /RudderAcceptanceMissing/);
        for (const event of startEvents) child.stderr.write(`RUDDER_WINPROC|0|${event.phase}|1\n`);
        child.stdout.write('{"id":0,"ok":true}\n');
      }
    });
    return child;
  };
}

test("fixed candidate-first plan: two fresh helpers, owned tree, then missing import; no retry", async () => {
  const plan = acceptancePlan();
  assert.deepEqual(plan.map((row) => row.kind), ["captures", "captures", "tree", "missing-import", "missing-import", "startup-stall"]);
  assert.equal(CAPTURE_DEADLINE_MS, 185_000);
  assert.equal(TREE_DEADLINE_MS, 310_000);
  assert.equal(IMPORT_DEADLINE_MS, 65_000);
  assert.equal(STARTUP_STALL_DEADLINE_MS, 70_000);
  assert.equal(CAMPAIGN_DEADLINE_MS, 1_020_000);
  const seen = [];
  const campaign = await runCampaign({ run: async (probe) => {
    seen.push(probe.name);
    return { name: probe.name, outcome: probe.name === "candidate-2" ? "failed" : "passed" };
  } });
  assert.deepEqual(seen, ["candidate-1", "candidate-2"]);
  assert.equal(campaign.passed, false);
});

test("watchdog environment is exactly five keys, without ambient module/profile/secret values", () => {
  const env = minimalWatchdogEnvironment({ ELECTRON_RUN_AS_NODE: "0", SystemRoot: "Z:\\Windows",
    TEMP: "Z:\\Temp", PSModulePath: "forbidden", PATH: "forbidden", USERPROFILE: "forbidden", SECRET: "forbidden" });
  assert.deepEqual(env, { ELECTRON_RUN_AS_NODE: "1", SystemRoot: "Z:\\Windows", WINDIR: "Z:\\Windows",
    TEMP: "Z:\\Temp", TMP: "Z:\\Temp" });
  assert.equal(JSON.stringify(env).includes("forbidden"), false);
});

test("variant replaces only one exact trusted filename and never mutates the source", async () => {
  const source = await readFile(new URL("../../desktop/src/local-app-windows-processes.mjs", import.meta.url), "utf8");
  assert.equal(helperScript(source, "captures"), source);
  const changed = helperScript(source, "missing-import");
  assert.equal(changed.replace("'RudderAcceptanceMissing.psd1'", "'Microsoft.PowerShell.Utility.psd1'"), source);
  assert.throws(() => helperScript("no manifest", "missing-import"), /source_drift/);
  assert.throws(() => helperScript(source + "'Microsoft.PowerShell.Utility.psd1'", "missing-import"), /source_drift/);
  const management = helperScript(source, "missing-import", "management");
  assert.equal(management.replace("'RudderAcceptanceMissing.psd1'", "'Microsoft.PowerShell.Management.psd1'"), source);
  // The stall changes only the command copy, preserving both imports and Ready.
  const stalled = helperScript(source, "startup-stall");
  assert.equal(stalled.replace("[Threading.Thread]::Sleep(90000)\n", ""), source);
  assert.equal(await readFile(new URL("../../desktop/src/local-app-windows-processes.mjs", import.meta.url), "utf8"), source);
});

test("strict sanitized runner metadata, events, and failures drop arbitrary strings", () => {
  assert.deepEqual(runnerIdentity({ ImageOS: "win25-vs2026", ImageVersion: "20261001.1.0", RUNNER_OS: "Windows", RUNNER_ARCH: "X64" }),
    { imageId: "win25-vs2026", imageVersion: "20261001.1.0", os: "Windows", arch: "X64" });
  assert.deepEqual(runnerIdentity({ ImageOS: "secret", ImageVersion: "C:\\private", RUNNER_OS: "secret", RUNNER_ARCH: "secret" }),
    { imageId: null, imageVersion: null, os: null, arch: null });
  assert.equal(failureKind(new Error("secret password and raw stderr")), "operation_failed");
  assert.equal(failureKind(new Error("Windows process helper exited (1): secret")), "helper_exited");
  assert.equal(failureKind({ acceptanceCode: "secret" }), "operation_failed");
  assert.equal(sanitizedPhase({ source: "node", phase: "private_secret", clock: "1", id: 0 }, 1), null);
  assert.equal(sanitizedPhase({ ...startEvents[0], clock: "secret" }, 1), null);
  assert.equal(sanitizedPhase({ ...startEvents[0], id: -1 }, 1), null);
  assert.deepEqual(sanitizedPhase({ ...startEvents[0], extra: "secret" }, 2), { ...startEvents[0], elapsedMs: 2 });
});

test("accepted kill signal and signalCode without observed exit cannot prove cleanup", async () => {
  const child = fakeChild();
  child.signalCode = "SIGKILL";
  const owner = observeOwnedChild(child);
  const cleanup = await settleOwnedHelper(owner, { graceful: false, timeoutMs: 10 });
  assert.equal(cleanup.status, "unverified");
  assert.equal(cleanup.exitObserved, false);
});

test("held helper cleanup observes actual EOF exit or fallback exit", async () => {
  const child = fakeChild();
  const owner = observeOwnedChild(child);
  child.stdin.on("finish", () => child.emit("exit", 0, null));
  const cleanup = await settleOwnedHelper(owner, { timeoutMs: 100 });
  assert.equal(cleanup.status, "exit_after_eof");
  assert.equal(cleanup.exitObserved, true);
  assert.equal(cleanup.exitCode, 0);
  const forced = fakeChild();
  const forcedOwner = observeOwnedChild(forced);
  forced.kill = () => { forced.emit("exit", null, "SIGKILL"); return true; };
  assert.equal((await settleOwnedHelper(forcedOwner, { graceful: false, timeoutMs: 100 })).exitObserved, true);
});

test("controller captures twice with open stdin, valid identities, and verified helper exit", async () => {
  const result = await runCase(acceptancePlan()[0], { spawnProcess: helperSpawn() });
  assert.equal(result.outcome, "passed");
  assert.equal(result.captures.length, 2);
  assert.equal(result.requestWrites, 2);
  assert.ok(result.captures.every((capture) => capture.stdinOpen && capture.identityMatched));
  assert.ok(result.startupToFirstResponseMs >= result.captures[0].elapsedMs);
  assert.equal(result.candidateScriptSha256, result.executedScriptSha256);
  assert.equal(result.startupImportsBeforeReady, true);
  assert.equal(result.helperCleanup.exitObserved, true);
});

test("missing-import real controller rejects its pending capture without any write or ready", async () => {
  const result = await runCase(acceptancePlan()[3], { spawnProcess: helperSpawn({ missing: true }) });
  assert.equal(result.outcome, "passed");
  assert.equal(missingImportSatisfied(result), true);
  assert.equal(result.requestWrites, 0);
  assert.equal(result.readyObserved, false);
  assert.equal(result.naturalExitObserved, true);
  assert.equal(result.naturalExitCode, 1);
  assert.notEqual(result.candidateScriptSha256, result.executedScriptSha256);
  for (const change of [{ readyObserved: true }, { requestWrites: 1 }, { pendingCaptureRejected: false },
    { naturalExitObserved: false }, { naturalExitCode: 0 }, { events: [] }]) {
    assert.equal(missingImportSatisfied({ ...result, ...change }), false);
  }
});

test("missing Management import fails closed after successful Utility import", async () => {
  const result = await runCase(acceptancePlan()[4], { spawnProcess: helperSpawn({ missing: true, module: "management" }) });
  assert.equal(result.outcome, "passed");
  assert.equal(result.missingModule, "management");
  assert.equal(result.priorUtilityImportCompleted, true);
  assert.equal(missingImportSatisfied(result), true);
});

test("capture identity failure stays failed and cleans up the owned helper", async () => {
  const result = await runCase(acceptancePlan()[0], { spawnProcess: helperSpawn({ wrongIdentity: true }) });
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure, "identity_mismatch");
  assert.equal(result.helperCleanup.exitObserved, true);
});

test("startup acceptance requires both imports in order before ready and rejects import failure", () => {
  assert.equal(startupImportsSatisfied(startEvents), true);
  assert.equal(startupImportsSatisfied(startEvents.slice(1)), false);
  assert.equal(startupImportsSatisfied([...startEvents].reverse()), false);
  assert.equal(startupImportsSatisfied([...startEvents, { source: "powershell", phase: "startup_import_failed" }]), false);
});

test("snapshot authority is limited to our still-held root and one direct descendant", () => {
  const identity = { pid: 101, createdAt: "123" };
  const ready = { rootPid: 101, descendantPid: 102 };
  const fixture = { exitObserved: false, descendantExitObserved: false };
  const rows = [{ ProcessId: 101, ParentProcessId: 1, CreationTime: "123" },
    { ProcessId: 102, ParentProcessId: 101, CreationTime: "456" }];
  assert.deepEqual(ownedSnapshot(rows, identity, ready, fixture), { root: identity, descendant: { pid: 102, createdAt: "456" } });
  const extraRows = [...rows, { ProcessId: 103, ParentProcessId: 101, CreationTime: "789" },
    { ProcessId: 104, ParentProcessId: 102, CreationTime: "987" }];
  assert.deepEqual(ownedSnapshot(extraRows, identity, ready, fixture), ownedSnapshot(rows, identity, ready, fixture));
  assert.deepEqual(describeOwnedSnapshot(extraRows, identity, ready, fixture), {
    isArray: true, rowCount: 4, extraRowCount: 2, rootMatchCount: 1, descendantMatchCount: 1,
    duplicateProcessIds: false, rootPidMatched: true, rootCreationTimeMatched: true,
    directParentMatched: true, descendantCreationTimeValid: true, heldRootLive: true, heldDescendantLive: true,
  });
  assert.throws(() => ownedSnapshot(null, identity, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot([rows[0]], identity, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot([rows[1]], identity, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot([...rows, rows[0]], identity, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot([...rows, rows[1]], identity, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot([...extraRows, extraRows[2]], identity, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot(rows, { ...identity, pid: 999 }, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot(rows, { ...identity, createdAt: "999" }, ready, fixture), /identity_mismatch/);
  assert.throws(() => ownedSnapshot(rows, identity, ready, { ...fixture, exitObserved: true }), /identity_mismatch/);
  assert.throws(() => ownedSnapshot(rows, identity, ready, { ...fixture, descendantExitObserved: true }), /identity_mismatch/);
  assert.throws(() => ownedSnapshot([rows[0], { ...rows[1], ParentProcessId: 999 }], identity, ready, fixture), /identity_mismatch/);
  for (const CreationTime of [null, 456, "", "not-a-token"]) {
    assert.throws(() => ownedSnapshot([rows[0], { ...rows[1], CreationTime }], identity, ready, fixture), /identity_mismatch/);
  }
});

test("lifecycle acceptance cannot pass on termination submission without both exact exits", () => {
  const complete = { snapshotRootMatched: true, snapshotDescendantMatched: true, descendantTerminationMatched: true,
    rootTerminationMatched: true, rootExactIdentityGone: true, descendantExactIdentityGone: true };
  assert.equal(lifecycleSatisfied(complete), true);
  for (const key of Object.keys(complete)) assert.equal(lifecycleSatisfied({ ...complete, [key]: false }), false);
});

test("real controlled Node fixture retains and gracefully cleans both owned handles without PowerShell", { timeout: 12_000 }, async () => {
  const fixture = startFixture();
  try {
    const ready = await bounded(fixture.ready, 5_000);
    assert.equal(ready.rootPid, fixture.child.pid);
    assert.ok(ready.descendantPid > 0);
  } finally {
    const cleanup = await cleanupFixture(fixture);
    assert.equal(cleanup.status, "verified");
    assert.equal(cleanup.rootExitObserved, true);
    assert.equal(cleanup.descendantExitObserved, true);
  }
});

test("fixture cleanup never claims descendant exit solely because its root exited", async () => {
  const child = fakeChild();
  const fixture = observeOwnedChild(child);
  fixture.descendantExitObserved = false;
  child.emit("exit", 1, null);
  assert.deepEqual(await cleanupFixture(fixture, 10),
    { status: "unverified", rootExitObserved: true, descendantExitObserved: false });
});

test("read-only workflow runs actual candidate first in two independent cmd jobs with bounded retention", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/windows-process-helper-acceptance.yml", import.meta.url), "utf8");
  assert.match(workflow, /runner: \[fresh-a, fresh-b\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /shell: cmd/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /retention-days: 3/);
  assert.ok(workflow.indexOf("run: node scripts/acceptance/windows-process-helper.mjs") < workflow.indexOf("run: node --test"));
  assert.doesNotMatch(workflow, /pnpm|cargo|shell: (?:pwsh|powershell)|continue-on-error: true|contents: write/);
});


test("full controller lifecycle snapshots and terminates only two proven fixture identities in order", async () => {
  const fixture = fakeChild();
  fixture.pid = 501;
  fixture.send = (message, callback) => {
    if (message.type === "cleanup") {
      fixture.emit("message", { type: "descendant-exit", exitObserved: true });
      fixture.emit("exit", 0, null);
    }
    callback?.();
  };
  const requests = [];
  const spawnProcess = (executable, args, options) => {
    if (executable === process.execPath) {
      assert.equal(args[1], "root");
      queueMicrotask(() => fixture.emit("message", { type: "ready", rootPid: 501, descendantPid: 502 }));
      return fixture;
    }
    const child = fakeChild();
    child.stdin.on("finish", () => { child.emit("exit", 0, null); child.emit("close", 0, null); });
    child.stdin.on("data", (line) => {
      const request = JSON.parse(line);
      requests.push(request);
      let result;
      if (request.type === "capture") result = { pid: 501, createdAt: "111" };
      if (request.type === "snapshot") result = [
        { ProcessId: 501, ParentProcessId: 1, CreationTime: "111" },
        { ProcessId: 502, ParentProcessId: 501, CreationTime: "222" },
        { ProcessId: 503, ParentProcessId: 501, CreationTime: "333" },
        { ProcessId: 504, ParentProcessId: 502, CreationTime: "444" },
      ];
      if (request.type === "terminate") {
        const expected = requests.length === 3 ? { pid: 502, createdAt: "222" } : { pid: 501, createdAt: "111" };
        assert.deepEqual(request.processes, [expected]);
        result = [{ pid: expected.pid, status: "terminated" }];
        if (expected.pid === 502) fixture.emit("message", { type: "descendant-exit", exitObserved: true });
        else fixture.emit("exit", 1, null);
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
    queueMicrotask(() => {
      for (const event of startEvents) child.stderr.write(`RUDDER_WINPROC|0|${event.phase}|1\n`);
      child.stdout.write('{"id":0,"ok":true}\n');
    });
    return child;
  };
  const result = await runCase(acceptancePlan()[2], { spawnProcess });
  assert.equal(result.outcome, "passed");
  assert.deepEqual(requests.map((request) => request.type), ["capture", "snapshot", "terminate", "terminate"]);
  assert.equal(lifecycleSatisfied(result), true);
  assert.equal(result.fixtureCleanup.status, "verified");
  assert.equal(result.helperCleanup.exitObserved, true);
  assert.equal(result.snapshotObservation.rowCount, 4);
  assert.equal(result.snapshotObservation.extraRowCount, 2);
  // Reports contain boolean proofs, never the fixture's raw PID/creation tokens.
  assert.doesNotMatch(JSON.stringify(result), /"pid"|"createdAt"|"processes"/);
});


test("startup-stall verdict requires verified exit and original 60s budget observation", () => {
  const complete = { pendingCaptureRejected: true, captureFailure: "startup_timeout", requestWrites: 0,
    readyObserved: false, timeoutHelperExitObserved: true, failureObservedAtMs: 60_020,
    controllerKillCallsBeforeCleanup: 1, controllerKillRequestedSigkill: true, startupExitDiagnostic: "exit-after-signal",
    events: [{ phase: "startup_timeout" }, { phase: "startup_helper_exit_verified" }] };
  assert.equal(startupStallSatisfied(complete), true);
  for (const change of [{ readyObserved: true }, { requestWrites: 1 }, { timeoutHelperExitObserved: false },
    { controllerKillCallsBeforeCleanup: 0 }, { startupExitDiagnostic: "unverified" },
    { failureObservedAtMs: 2000 }, { failureObservedAtMs: 66_000 }, { events: [{ phase: "startup_timeout" }] }]) {
    assert.equal(startupStallSatisfied({ ...complete, ...change }), false);
  }
  assert.equal(failureKind(new Error("Windows process helper did not start in time (helperExit=verified)")), "startup_timeout");
});


test("actual controller startup timer cleans the owned helper at its unchanged 60s deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  let writes = 0;
  let kills = 0;
  const events = [];
  child.stdin.on("data", () => { writes += 1; });
  child.kill = () => { kills += 1; child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); return true; };
  const owner = observeOwnedChild(child);
  const controller = createWindowsProcessController({
    spawnProcess(executable, args) {
      assert.match(helperScript(args[3], "startup-stall"), /\[Threading\.Thread\]::Sleep\(90000\)/);
      return child;
    },
    observePhase: (event) => events.push(event),
  });
  const pending = controller.request("capture", { pid: process.pid });
  const rejected = assert.rejects(pending, (error) => failureKind(error) === "startup_timeout"
    && error.message.includes("helperExit=exit-after-signal"));
  t.mock.timers.tick(59_999);
  assert.equal(kills, 0);
  assert.equal(writes, 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(kills, 1);
  assert.equal(writes, 0);
  assert.equal(owner.exitObserved, true);
  assert.ok(events.some((event) => event.phase === "startup_timeout"));
  assert.ok(events.some((event) => event.phase === "startup_helper_exit_verified"));
});


test("fixture descendant explicitly preserves only the five watchdog environment keys", async () => {
  const source = await readFile(new URL("./windows-process-helper-fixture.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /env: process\.env|\.\.\.process\.env/);
  const block = /env: \{([\s\S]*?)\n    \}/.exec(source)?.[1];
  assert.ok(block);
  const keys = [...block.matchAll(/^\s*([a-zA-Z_]+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(keys, ["ELECTRON_RUN_AS_NODE", "SystemRoot", "TEMP", "TMP", "WINDIR"]);
});
