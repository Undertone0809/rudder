import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createWindowsProcessController } from "../../desktop/src/local-app-windows-processes.mjs";

// These are outer bounds, not overrides of the controller's 60s budgets.
export const CAPTURE_DEADLINE_MS = 185_000;
export const TREE_DEADLINE_MS = 310_000;
export const IMPORT_DEADLINE_MS = 65_000;
export const STARTUP_STALL_DEADLINE_MS = 70_000;
export const CAMPAIGN_DEADLINE_MS = 17 * 60_000;
const EXIT_DEADLINE_MS = 5_000;
const FIXTURE = fileURLToPath(new URL("./windows-process-helper-fixture.mjs", import.meta.url));
const MODULE = new URL("../../desktop/src/local-app-windows-processes.mjs", import.meta.url);
const MANIFESTS = {
  utility: "'Microsoft.PowerShell.Utility.psd1'",
  management: "'Microsoft.PowerShell.Management.psd1'",
};
const READY = "[Console]::Out.WriteLine('{\"id\":0,\"ok\":true}')";
const ENV_KEYS = ["ELECTRON_RUN_AS_NODE", "SystemRoot", "WINDIR", "TEMP", "TMP"];
const PHASES = new Set([
  "startup_timeout", "ready_frame_ignored_after_timeout", "startup_helper_exit_verified", "startup_helper_exit_unverified",
  "startup_utility_import_start", "startup_utility_import_done", "startup_management_import_start",
  "startup_management_import_done", "startup_import_failed", "ready_flush_done", "request_read_wait",
  "request_line_read", "request_parse_start", "request_json_parse_done", "request_id_bound",
  "request_parse_done", "get_process_start", "get_process_done", "get_times_start", "get_times_done",
  "snapshot_query_start", "snapshot_query_done", "snapshot_process_failed", "terminate_process_lookup_failed",
  "request_failed", "response_serialize_start", "response_flush_start", "response_flush_done",
  "ready_frame_parsed", "stdout_response_matched_ok", "stdout_response_matched_error", "stdout_response_unmatched",
  "stdout_json_parse_invalid", "request_write_start", "request_write_callback_error", "request_write_callback_ok",
  "request_write_accepted", "request_write_backpressured", "request_write_threw", "request_stdin_error",
  "request_timeout", "helper_stop_signal_accepted", "helper_stop_signal_refused", "helper_stop_signal_failed",
]);

function check(value, code = "assertion_failed") {
  if (!value) { const error = new Error(code); error.acceptanceCode = code; throw error; }
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const milliseconds = (start) => Number(process.hrtime.bigint() - start) / 1e6;

export function minimalWatchdogEnvironment(source = process.env) {
  const systemRoot = source.SystemRoot ?? "C:\\Windows";
  const temp = source.TEMP ?? source.TMP ?? path.win32.join(systemRoot, "Temp");
  return { ELECTRON_RUN_AS_NODE: "1", SystemRoot: systemRoot, WINDIR: source.WINDIR ?? systemRoot,
    TEMP: temp, TMP: source.TMP ?? temp };
}

export function runnerIdentity(source = process.env) {
  return {
    imageId: /^win\d{2,4}(?:-vs\d{4})?$/.test(source.ImageOS ?? "") ? source.ImageOS : null,
    imageVersion: /^\d{1,8}(?:\.\d{1,8}){1,3}$/.test(source.ImageVersion ?? "") ? source.ImageVersion : null,
    os: ["Windows", "Linux", "macOS"].includes(source.RUNNER_OS) ? source.RUNNER_OS : null,
    arch: ["X86", "X64", "ARM", "ARM64"].includes(source.RUNNER_ARCH) ? source.RUNNER_ARCH : null,
  };
}

export function acceptancePlan() {
  return [
    { name: "candidate-1", kind: "captures", deadlineMs: CAPTURE_DEADLINE_MS },
    { name: "candidate-2", kind: "captures", deadlineMs: CAPTURE_DEADLINE_MS },
    { name: "owned-tree", kind: "tree", deadlineMs: TREE_DEADLINE_MS },
    { name: "missing-utility-import", kind: "missing-import", module: "utility", deadlineMs: IMPORT_DEADLINE_MS },
    { name: "missing-management-import", kind: "missing-import", module: "management", deadlineMs: IMPORT_DEADLINE_MS },
    { name: "startup-stall", kind: "startup-stall", deadlineMs: STARTUP_STALL_DEADLINE_MS },
  ];
}

export function helperScript(script, kind, module = "utility") {
  check(typeof script === "string" && Object.values(MANIFESTS).every((manifest) => script.split(manifest).length === 2), "source_drift");
  check(Object.hasOwn(MANIFESTS, module), "source_drift");
  if (kind === "missing-import") return script.replace(MANIFESTS[module], "'RudderAcceptanceMissing.psd1'");
  if (kind === "startup-stall") {
    check(script.split(READY).length === 2, "source_drift");
    return script.replace(READY, `[Threading.Thread]::Sleep(90000)\n${READY}`);
  }
  return script;
}

// Never copy errors, payloads, paths, environment values, or raw process output
// into the report. Both error categories and phase names are closed allowlists.
export function failureKind(error) {
  const known = new Set(["source_drift", "assertion_failed", "case_deadline", "campaign_deadline",
    "identity_mismatch", "fixture_protocol_failed", "exit_unverified", "metadata_invalid"]);
  if (known.has(error?.acceptanceCode)) return error.acceptanceCode;
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.startsWith("Windows process helper request timed out")) return "request_timeout";
  if (message.startsWith("Windows process helper did not start in time")) return "startup_timeout";
  if (message.startsWith("Windows process helper exited")) return "helper_exited";
  return "operation_failed";
}

export function sanitizedPhase(event, elapsedMs) {
  if (!["node", "powershell"].includes(event?.source) || !PHASES.has(event?.phase)
    || !/^\d{1,30}$/.test(event?.clock ?? "") || !Number.isSafeInteger(event?.id)
    || event.id < 0 || event.id > 16 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return { source: event.source, id: event.id, phase: event.phase, clock: event.clock, elapsedMs };
}

export async function bounded(operation, timeoutMs, code = "case_deadline") {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error(code); error.acceptanceCode = code; reject(error); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function observeOwnedChild(child) {
  const owner = { child, exitObserved: false, exitCode: null, signalObserved: false, spawnFailed: false };
  owner.closed = new Promise((resolve) => { child.once("close", resolve); });
  owner.exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      owner.exitObserved = true;
      owner.exitCode = Number.isInteger(code) ? code : null;
      owner.signalObserved = typeof signal === "string";
      resolve();
    });
  });
  child.on("error", () => { if (!Number.isInteger(child.pid)) owner.spawnFailed = true; });
  return owner;
}

export async function settleOwnedHelper(owner, { graceful = true, timeoutMs = EXIT_DEADLINE_MS } = {}) {
  if (!owner) return { status: "not_spawned", exitObserved: false };
  let status = "exited";
  if (!owner.exitObserved && graceful) {
    try {
      owner.child.stdin.end();
      await bounded(owner.exited, timeoutMs, "exit_unverified");
      status = "exit_after_eof";
    } catch { /* Still own the handle; try one bounded forced cleanup. */ }
  }
  if (!owner.exitObserved) {
    try {
      owner.child.kill("SIGKILL");
      await bounded(owner.exited, timeoutMs, "exit_unverified");
      status = "exit_after_signal";
    } catch { status = owner.spawnFailed ? "not_spawned" : "unverified"; }
  }
  return { status, exitObserved: owner.exitObserved, exitCode: owner.exitCode, signalObserved: owner.signalObserved };
}

export function startFixture({ spawnProcess = spawn, environment = minimalWatchdogEnvironment() } = {}) {
  const child = spawnProcess(process.execPath, [FIXTURE, "root"], {
    env: environment, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const fixture = observeOwnedChild(child);
  fixture.descendantExitObserved = false;
  fixture.ready = new Promise((resolve) => {
    child.on("message", (message) => {
      if (message?.type === "ready" && message.rootPid === child.pid
        && Number.isSafeInteger(message.descendantPid) && message.descendantPid > 0
        && message.descendantPid !== child.pid) resolve(message);
    });
  });
  fixture.descendantExited = new Promise((resolve) => {
    child.on("message", (message) => {
      if ((message?.type === "descendant-exit" && message.exitObserved === true)
        || (message?.type === "cleanup" && message.descendantExitObserved === true)) {
        fixture.descendantExitObserved = true;
        resolve();
      }
    });
  });
  return fixture;
}

export async function cleanupFixture(fixture, timeoutMs = 6_000) {
  if (!fixture) return { rootExitObserved: false, descendantExitObserved: false, status: "not_spawned" };
  if (!fixture.exitObserved) {
    try { fixture.child.send({ type: "cleanup" }, () => {}); } catch { /* Bounded fallback below. */ }
    try { await bounded(fixture.exited, timeoutMs, "exit_unverified"); } catch { /* The retained root handle is the last resort. */ }
  }
  if (!fixture.exitObserved) await settleOwnedHelper(fixture, { graceful: false, timeoutMs: 2_000 });
  const verified = fixture.exitObserved && fixture.descendantExitObserved;
  return { status: verified ? "verified" : "unverified", rootExitObserved: fixture.exitObserved,
    descendantExitObserved: fixture.descendantExitObserved };
}

export function describeOwnedSnapshot(rows, rootIdentity, ready, fixture) {
  const entries = Array.isArray(rows) ? rows : [];
  const roots = entries.filter((row) => row?.ProcessId === ready.rootPid);
  const descendants = entries.filter((row) => row?.ProcessId === ready.descendantPid);
  const ids = entries.map((row) => row?.ProcessId);
  return {
    isArray: Array.isArray(rows), rowCount: Array.isArray(rows) ? rows.length : null,
    extraRowCount: entries.length - roots.length - descendants.length,
    rootMatchCount: roots.length, descendantMatchCount: descendants.length,
    duplicateProcessIds: new Set(ids).size !== ids.length,
    rootPidMatched: rootIdentity.pid === ready.rootPid,
    rootCreationTimeMatched: roots.length === 1 && roots[0].CreationTime === rootIdentity.createdAt,
    directParentMatched: descendants.length === 1 && descendants[0].ParentProcessId === ready.rootPid,
    descendantCreationTimeValid: descendants.length === 1
      && typeof descendants[0].CreationTime === "string" && /^\d+$/.test(descendants[0].CreationTime),
    heldRootLive: fixture.exitObserved === false,
    heldDescendantLive: fixture.descendantExitObserved === false,
  };
}

export function ownedSnapshot(rows, rootIdentity, ready, fixture) {
  const proof = describeOwnedSnapshot(rows, rootIdentity, ready, fixture);
  check(proof.isArray && proof.rootMatchCount === 1 && proof.descendantMatchCount === 1
    && !proof.duplicateProcessIds && proof.rootPidMatched && proof.rootCreationTimeMatched
    && proof.directParentMatched && proof.descendantCreationTimeValid
    && proof.heldRootLive && proof.heldDescendantLive, "identity_mismatch");
  const descendant = rows.find((row) => row?.ProcessId === ready.descendantPid);
  // Extra snapshot rows are unclaimed. Only identities proven by our retained
  // fixture handles are eligible for this acceptance campaign's termination.
  return { root: rootIdentity, descendant: { pid: ready.descendantPid, createdAt: descendant.CreationTime } };
}

function terminatedExact(result, identity) {
  const rows = Array.isArray(result) ? result : [result];
  check(rows.length === 1 && rows[0]?.pid === identity.pid && rows[0]?.status === "terminated", "identity_mismatch");
}

export function missingImportSatisfied(result) {
  return result.pendingCaptureRejected === true && result.captureFailure === "helper_exited"
    && result.requestWrites === 0 && result.readyObserved === false
    && result.events.some((event) => event.phase === "startup_import_failed")
    && result.naturalExitObserved === true && result.naturalExitCode === 1;
}

export function startupStallSatisfied(result) {
  return result.pendingCaptureRejected === true && result.captureFailure === "startup_timeout"
    && result.requestWrites === 0 && result.readyObserved === false
    && result.events.some((event) => event.phase === "startup_timeout")
    && result.events.some((event) => event.phase === "startup_helper_exit_verified")
    && !result.events.some((event) => event.phase === "startup_helper_exit_unverified")
    && result.timeoutHelperExitObserved === true && result.controllerKillCallsBeforeCleanup === 1
    && result.controllerKillRequestedSigkill === true && result.startupExitDiagnostic === "exit-after-signal"
    && result.failureObservedAtMs >= 59_000 && result.failureObservedAtMs <= 65_000;
}

export function startupImportsSatisfied(events) {
  const phases = events.filter((event) => event.source === "powershell").map((event) => event.phase);
  const expected = ["startup_utility_import_start", "startup_utility_import_done",
    "startup_management_import_start", "startup_management_import_done", "ready_flush_done"];
  const positions = expected.map((phase) => phases.indexOf(phase));
  return !phases.includes("startup_import_failed")
    && positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]));
}

export function lifecycleSatisfied(result) {
  return result.snapshotRootMatched === true && result.snapshotDescendantMatched === true
    && result.descendantTerminationMatched === true && result.rootTerminationMatched === true
    && result.rootExactIdentityGone === true && result.descendantExactIdentityGone === true;
}

export async function runCase(probe, { environment = minimalWatchdogEnvironment(),
  spawnProcess = spawn, createController = createWindowsProcessController } = {}) {
  const started = process.hrtime.bigint();
  const result = { name: probe.name, kind: probe.kind, ...(probe.module ? { missingModule: probe.module } : {}), events: [], captures: [], requestWrites: 0, helperSignalCalls: 0, readyObserved: false };
  let owner;
  let fixture;
  let deadlineReached = false;
  // Do not continue issuing requests after the outer deadline wins its race.
  const active = () => check(!deadlineReached, "case_deadline");
  const operation = async () => {
    // Await fixture readiness before creating the controller: its internal ready
    // promise must be consumed immediately even when startup fails.
    let ready;
    if (probe.kind === "tree") {
      fixture = startFixture({ spawnProcess, environment });
      ready = await bounded(fixture.ready, 10_000, "fixture_protocol_failed");
      active();
    }
    const controller = createController({
      systemRoot: environment.SystemRoot,
      // Intentionally no requestTimeoutMs: this exercises the unchanged budgets.
      observePhase(event) {
        const clean = sanitizedPhase(event, milliseconds(started));
        if (clean && result.events.length < 256) result.events.push(clean);
        if (["ready_frame_parsed", "ready_flush_done"].includes(clean?.phase)) result.readyObserved = true;
      },
      spawnProcess(executable, args, options) {
        check(args.length === 4 && args[0] === "-NoProfile" && args[1] === "-NonInteractive" && args[2] === "-Command", "source_drift");
        const script = helperScript(args[3], probe.kind, probe.module);
        result.candidateScriptSha256 = sha256(args[3]);
        result.executedScriptSha256 = sha256(script);
        owner = observeOwnedChild(spawnProcess(executable, [...args.slice(0, 3), script], { ...options, env: environment }));
        const kill = owner.child.kill.bind(owner.child);
        owner.child.kill = (signal) => {
          result.helperSignalCalls += 1;
          result.controllerKillRequestedSigkill = signal === "SIGKILL";
          return kill(signal);
        };
        const write = owner.child.stdin.write.bind(owner.child.stdin);
        owner.child.stdin.write = (...writeArgs) => { result.requestWrites += 1; return write(...writeArgs); };
        return owner.child;
      },
    });
    if (["missing-import", "startup-stall"].includes(probe.kind)) {
      try { await controller.request("capture", { pid: process.pid }); }
      catch (error) {
        result.pendingCaptureRejected = true;
        result.captureFailure = failureKind(error);
        if (probe.kind === "startup-stall") {
          const status = /\(helperExit=(exit-after-signal|already-exited|unverified),/.exec(error?.message ?? "");
          result.startupExitDiagnostic = status?.[1] ?? null;
        }
      }
      result.failureObservedAtMs = milliseconds(started);
      active();
      await bounded(owner.exited, EXIT_DEADLINE_MS, "exit_unverified");
      await bounded(owner.closed, EXIT_DEADLINE_MS, "exit_unverified");
      if (probe.kind === "startup-stall") {
        result.timeoutHelperExitObserved = owner.exitObserved;
        result.controllerKillCallsBeforeCleanup = result.helperSignalCalls;
        check(startupStallSatisfied(result));
        return;
      }
      result.naturalExitObserved = owner.exitObserved;
      result.naturalExitCode = owner.exitCode;
      check(missingImportSatisfied(result));
      result.priorUtilityImportCompleted = result.events.some((event) => event.phase === "startup_utility_import_done");
      check(result.priorUtilityImportCompleted === (probe.module === "management"));
      return;
    }
    if (probe.kind === "captures") {
      let firstIdentity;
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        active();
        check(!owner.child.stdin.writableEnded && !owner.child.stdin.destroyed && !owner.exitObserved);
        const requestStarted = process.hrtime.bigint();
        const capture = await controller.request("capture", { pid: process.pid });
        active();
        check(capture?.pid === process.pid && typeof capture?.createdAt === "string" && /^\d+$/.test(capture.createdAt), "identity_mismatch");
        if (firstIdentity !== undefined) check(capture.createdAt === firstIdentity, "identity_mismatch");
        firstIdentity = capture.createdAt;
        check(!owner.child.stdin.writableEnded && !owner.child.stdin.destroyed && !owner.exitObserved);
        result.captures.push({ ordinal, elapsedMs: milliseconds(requestStarted), identityMatched: true, stdinOpen: true });
        if (ordinal === 1) result.startupToFirstResponseMs = milliseconds(started);
      }
      return;
    }
    check(probe.kind === "tree");
    const rootIdentity = await controller.request("capture", { pid: ready.rootPid });
    active();
    check(rootIdentity?.pid === ready.rootPid && typeof rootIdentity?.createdAt === "string"
      && /^\d+$/.test(rootIdentity.createdAt), "identity_mismatch");
    const rows = await controller.request("snapshot", { pid: ready.rootPid });
    active();
    result.snapshotObservation = describeOwnedSnapshot(rows, rootIdentity, ready, fixture);
    const identities = ownedSnapshot(rows, rootIdentity, ready, fixture);
    result.snapshotRootMatched = true;
    result.snapshotDescendantMatched = true;
    // Stop the descendant first and observe its held ChildProcess exit while
    // the root is still alive to attest it. Then stop and observe the root.
    terminatedExact(await controller.request("terminate", { processes: [identities.descendant] }), identities.descendant);
    active();
    result.descendantTerminationMatched = true;
    await bounded(fixture.descendantExited, EXIT_DEADLINE_MS, "exit_unverified");
    result.descendantExactIdentityGone = fixture.descendantExitObserved;
    active();
    terminatedExact(await controller.request("terminate", { processes: [identities.root] }), identities.root);
    active();
    result.rootTerminationMatched = true;
    await bounded(fixture.exited, EXIT_DEADLINE_MS, "exit_unverified");
    result.rootExactIdentityGone = fixture.exitObserved;
    check(lifecycleSatisfied(result));
  };
  try {
    await bounded(operation(), probe.deadlineMs);
    result.outcome = "passed";
  } catch (error) {
    deadlineReached = true;
    result.outcome = "failed";
    result.failure = failureKind(error);
  } finally {
    result.fixtureCleanup = await cleanupFixture(fixture);
    result.helperCleanup = await settleOwnedHelper(owner);
    if (owner?.exitObserved) {
      try { await bounded(owner.closed, EXIT_DEADLINE_MS, "exit_unverified"); }
      catch { result.outcome = "failed"; result.failure ??= "exit_unverified"; }
    }
    if (!["missing-import", "startup-stall"].includes(probe.kind)) {
      result.startupImportsBeforeReady = startupImportsSatisfied(result.events);
      if (!result.startupImportsBeforeReady) { result.outcome = "failed"; result.failure ??= "assertion_failed"; }
    }
    result.elapsedMs = milliseconds(started);
    if (!result.helperCleanup.exitObserved || (fixture && result.fixtureCleanup.status !== "verified")) {
      result.outcome = "failed";
      result.failure ??= "exit_unverified";
    }
  }
  return result;
}

export async function runCampaign({ run = runCase, environment = minimalWatchdogEnvironment(), onResult = async () => {} } = {}) {
  const started = process.hrtime.bigint();
  const results = [];
  for (const probe of acceptancePlan()) {
    const remaining = CAMPAIGN_DEADLINE_MS - milliseconds(started);
    if (remaining <= 0) return { results, passed: false, deadlineReached: true };
    const result = await run({ ...probe, deadlineMs: Math.min(probe.deadlineMs, remaining) }, { environment });
    results.push(result);
    await onResult(results);
    // A failure is terminal evidence. Never retry it or replace it with a pass.
    if (result.outcome !== "passed") break;
  }
  return { results, passed: results.length === acceptancePlan().length && results.every((result) => result.outcome === "passed"),
    deadlineReached: milliseconds(started) >= CAMPAIGN_DEADLINE_MS };
}

async function powershellVersion(environment) {
  // Run only AFTER the candidate campaign, never warm PowerShell first.
  const executable = path.win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const owner = observeOwnedChild(spawn(executable, ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::Out.WriteLine($PSVersionTable.PSVersion.ToString())"],
  { env: environment, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }));
  let output = "";
  const result = { numericVersion: null };
  owner.child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-128); });
  owner.child.stdin.end();
  try {
    await bounded(owner.closed, 15_000, "metadata_invalid");
    check(owner.exitObserved && owner.exitCode === 0 && /^\d+(?:\.\d+){1,3}$/.test(output.trim()), "metadata_invalid");
    result.numericVersion = output.trim();
  } catch (error) { result.failure = failureKind(error); }
  finally {
    result.cleanup = await settleOwnedHelper(owner, { graceful: false });
    if (!result.cleanup.exitObserved) result.failure = "exit_unverified";
  }
  return result;
}

async function main() {
  const outputFlag = process.argv.indexOf("--output");
  const output = outputFlag < 0 ? "windows-process-helper-acceptance.json" : process.argv[outputFlag + 1];
  check(typeof output === "string" && output.length > 0);
  const environment = minimalWatchdogEnvironment();
  const report = {
    schemaVersion: 1, scope: "windows_helper_boundary", packagedLocalAppAcceptance: false,
    platform: process.platform, arch: process.arch,
    nodeVersion: /^\d+\.\d+\.\d+$/.test(process.versions.node) ? process.versions.node : null,
    runner: runnerIdentity(),
    sourceSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null,
    sourceModuleSha256: sha256(await readFile(MODULE)),
    harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    fixtureSha256: sha256(await readFile(FIXTURE)),
    environmentKeys: ENV_KEYS,
    environmentExactKeys: Object.keys(environment).sort().join(",") === [...ENV_KEYS].sort().join(","),
    controllerStartupBudgetMs: 60_000, controllerRequestBudgetMs: 60_000,
    campaignDeadlineMs: CAMPAIGN_DEADLINE_MS,
    limitations: ["Fresh jobs are independent; repeats within a job may share OS caches.",
      "This controlled helper boundary is not packaged Local App acceptance.",
      "The historical greater-than-60-second timeout was not reproduced by this acceptance alone."],
    results: [], passed: false,
  };
  const save = async () => {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  };
  if (process.platform !== "win32") {
    report.blocker = "windows_required";
    await save();
    process.exitCode = 1;
    return;
  }
  Object.assign(report, await runCampaign({ environment, onResult: async (results) => { report.results = results; await save(); } }));
  report.powershell = await powershellVersion(environment);
  if (report.powershell.failure) report.passed = false;
  await save();
  console.log(JSON.stringify({ scope: report.scope, passed: report.passed,
    cases: report.results.map(({ name, outcome }) => ({ name, outcome })) }));
  if (!report.passed || report.deadlineReached) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Windows helper acceptance failed; raw output omitted"); process.exitCode = 1; });
}
