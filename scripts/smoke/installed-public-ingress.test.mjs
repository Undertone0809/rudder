import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createWorkflowDeadline } from "./installed-public-ingress-deadline.mjs";
import { persistOwnedProcessHandoff, detachAfterRecordedHandoff, parseDarwinProcessWitness } from "./installed-public-ingress-handoff.mjs";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SMOKE_NATIVE_TARGETS, nativeBinaryName } from "./installed-member-directory.mjs";
import {
  assertActivityLoggedFrame,
  assertCreatedIssueResponse,
  assertReconnectActivityAfter,
  assertSupervisedRustChildExit,
  assertWebSocketRejection,
  buildCliEnvironment,
  buildInstalledCliInvocation,
  buildServerEnvironment,
  canRemoveSmokeProfile,
  extractTarEntry,
  fetchJson,
  finishWorkflowWork,
  isExpectedIssueCreatedFrame,
  packageArchiveDigest,
  parseArgs,
  parsePackageTarball,
  requestOwnedTermination,
  recordOwnedSupervisorStart,
  resolveReceiptRelativeEntry,
  shouldRetainSmokeProfile,
  SmokePrerequisiteError,
  SmokeQuestionError,
  stopAndAssertRustListenerExited,
  startServer,
  validateInstallReceipt,
  waitForIssueCreatedFrame,
  waitForExit,
  waitForCliClose,
} from "./installed-public-ingress.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

it("the owning runner exits QUESTION while the exact held child and file logging survive", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ingress-parent-exit-fixture."));
  const entry = path.join(directory, "child.mjs");
  const runnerEntry = path.join(directory, "runner.mjs");
  const runnerModule = new URL("./installed-public-ingress.mjs", import.meta.url).href;
  const handoffModule = new URL("./installed-public-ingress-handoff.mjs", import.meta.url).href;
  await writeFile(entry, 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => console.log("owned-log"), 20);', { mode: 0o600 });
  await writeFile(runnerEntry, `
    import { startServer, stopAndAssertRustListenerExited } from ${JSON.stringify(runnerModule)};
    import { persistOwnedProcessHandoff, detachAfterRecordedHandoff } from ${JSON.stringify(handoffModule)};
    const runtime = startServer(${JSON.stringify(entry)}, ${JSON.stringify(directory)}, process.env, "fixture-runner");
    console.log(JSON.stringify({ ownedPid: runtime.child.pid }));
    const readyBy = Date.now() + 2000;
    while (!runtime.logs.stdout.includes("ready") && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 20));
    try { await stopAndAssertRustListenerExited(runtime, [], 30); } catch {}
    runtime.stopObservingLogs();
    const handoff = await persistOwnedProcessHandoff({
      directory: ${JSON.stringify(directory)}, child: runtime.child, ownerId: runtime.ownerId, kind: "server",
      sourceSha: ${JSON.stringify(sourceSha)}, supportSha256: ${JSON.stringify(digest("fixture"))}, reason: "shutdown_unverified"
    });
    await detachAfterRecordedHandoff(runtime.child, handoff);
    console.log(JSON.stringify({ handoff, logPath: runtime.logPaths.stdout }));
    process.exitCode = 2;
  `, { mode: 0o600 });
  const runner = spawn(process.execPath, [runnerEntry], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  runner.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  runner.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  let heldPid;
  let record;
  const observe = pid => parseDarwinProcessWitness(execFileSync("/bin/ps",
    ["-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "ppid=", "-o", "comm="],
    { encoding: "utf8", timeout: 1000 }));
  try {
    const result = await waitForExit(runner, 4000);
    assert.equal(result.code, 2, errors);
    const terminal = output.trim().split("\n").map(line => JSON.parse(line)).find(row => row.handoff);
    assert.ok(terminal?.handoff, errors);
    record = terminal.handoff.record;
    heldPid = record.pid;
    assert.equal(record.originalParentPid, runner.pid);
    assert.equal(record.state, "HELD_UNRESOLVED");
    assert.equal(record.releaseAllowed, false);
    const live = observe(heldPid);
    assert.equal(live.startedAt, record.startBinding.osStartedAt);
    const before = (await stat(terminal.logPath)).size;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok((await stat(terminal.logPath)).size > before);
  } finally {
    heldPid ??= Number(output.match(/"ownedPid":(\d+)/u)?.[1]);
    if (heldPid > 0) {
      const witness = observe(heldPid);
      assert.equal(path.basename(witness.comm), path.basename(process.execPath));
      if (record) assert.equal(witness.startedAt, record.startBinding.osStartedAt);
      else assert.equal(witness.parentPid, runner.pid);
      process.kill(heldPid, "SIGKILL"); // Exact synthetic, no-PG fixture, identity rechecked.
      const goneBy = Date.now() + 2000;
      while (Date.now() < goneBy) {
        try { process.kill(heldPid, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.throws(() => process.kill(heldPid, 0), { code: "ESRCH" });
    }
    if (runner.exitCode === null && runner.signalCode === null) {
      runner.kill("SIGKILL");
      await waitForExit(runner, 2000);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

it("persists supervisor identity before failed readiness and keeps it after verified child close", {
  skip: process.platform !== "darwin",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ingress-start-identity."));
  const entry = path.join(directory, "fixture.mjs");
  await writeFile(entry, 'setInterval(() => {}, 1000);', { mode: 0o600 });
  const runtime = startServer(entry, directory, process.env, "startup-failure-owner");
  try {
    await once(runtime.child, "spawn");
    const receipt = await recordOwnedSupervisorStart(runtime, directory);
    assert.equal(receipt.record.pid, runtime.child.pid);
    assert.equal(receipt.record.originalParentPid, process.pid);
    assert.equal(receipt.record.state, "OWNED_RUNNING");
    assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
    await assert.rejects(stopAndAssertRustListenerExited(runtime, [], 2000), /Rust startup identity was never observed/u);
    assert.ok(runtime.child.exitCode !== null || runtime.child.signalCode !== null);
    assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
  } finally {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill("SIGTERM");
      await waitForExit(runtime.child, 2000);
    }
    runtime.stopObservingLogs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancellation during final WebSocket close cannot transition to PASS", async () => {
  const signals = new EventEmitter();
  const workflow = createWorkflowDeadline({ totalTimeoutMs: 1000, cleanupReserveMs: 500, signals });
  const socket = new EventEmitter();
  socket.readyState = 1; socket.CLOSED = 3;
  socket.close = () => {
    signals.emit("SIGTERM");
    queueMicrotask(() => socket.emit("close"));
  };
  socket.terminate = () => socket.emit("close");
  let pass = false;
  try {
    await assert.rejects(async () => { await finishWorkflowWork(workflow, socket); pass = true; }, /SIGTERM/u);
    assert.equal(pass, false);
  } finally { workflow.dispose(); }
});

it("an unresponsive owned supervisor gets a durable held handoff without pipe orphaning", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ingress-handoff-fixture."));
  const entry = path.join(directory, "fixture.mjs");
  await writeFile(entry, 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => console.log("owned-log"), 20);', { mode: 0o600 });
  const runtime = startServer(entry, directory, process.env, "test-held-server");
  try {
    const readyBy = Date.now() + 2000;
    while (!runtime.logs.stdout.includes("ready") && Date.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(runtime.logs.stdout, /ready/u);
    await assert.rejects(stopAndAssertRustListenerExited(runtime, [], 30), /did not exit/u);
    runtime.stopObservingLogs();
    const receipt = await persistOwnedProcessHandoff({
      directory, child: runtime.child, ownerId: runtime.ownerId, kind: "server",
      sourceSha, supportSha256: digest("fixture"), reason: "shutdown_unverified",
    });
    await detachAfterRecordedHandoff(runtime.child, receipt);
    assert.equal(runtime.child.stdout, null);
    assert.equal(runtime.child.stderr, null);
    assert.equal(canRemoveSmokeProfile({ runtime, serverStarted: true, shutdownVerified: false }), false);
    const before = (await stat(runtime.logPaths.stdout)).size;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok((await stat(runtime.logPaths.stdout)).size > before, "recorded handoff must preserve child logging");
  } finally {
    runtime.stopObservingLogs();
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill("SIGKILL"); // Only this synthetic no-PG fixture.
      await waitForExit(runtime.child, 2000);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

it("a work deadline enters owned teardown with a retained-profile QUESTION on missing Rust identity", async () => {
  const workflow = createWorkflowDeadline({ totalTimeoutMs: 200, cleanupReserveMs: 150, signals: null });
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  const signals = [];
  child.kill = (signal) => { signals.push(signal); queueMicrotask(() => child.emit("close", null, signal)); return true; };
  const runtime = { owner: "installed-public-ingress-smoke", ownerId: "deadline", child,
    logs: { stdout: "", stderr: "" }, termRequested: false, stopPromise: null };
  try {
    await new Promise((resolve) => workflow.signal.addEventListener("abort", resolve, { once: true }));
    workflow.beginCleanup();
    await assert.rejects(stopAndAssertRustListenerExited(runtime, [], workflow.stepTimeout(100)), SmokeQuestionError);
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(shouldRetainSmokeProfile({ keepTemp: false, runtime, serverStarted: true, shutdownVerified: false }), true);
  } finally { workflow.dispose(); }
});

it("a real owned CLI read subprocess ignoring TERM is closed and reaped after cancellation", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
    { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(2000) });
    await assert.rejects(waitForCliClose(child, 25), /CLI timed out/u);
    assert.equal(child.signalCode, "SIGKILL");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 2000);
    }
  }
});

it("supplies the disposable credential only through the isolated CLI environment", () => {
  const key = "pcp_" + "a".repeat(48);
  const invocation = buildInstalledCliInvocation("/installed/cli.js", "/tmp/owned", "http://127.0.0.1:9999", "org", key, "member");
  assert.equal(invocation.env.RUDDER_API_KEY, key);
  assert.equal(invocation.env.RUDDER_HOME, "/tmp/owned/cli-profile");
  assert.ok(!invocation.args.includes("--api-key"));
  assert.ok(!invocation.args.some((arg) => arg.includes(key)));
});

it("bounds HTTP body consumption when headers arrive but the response stalls", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(fetchJson(`http://127.0.0.1:${server.address().port}`, {}, { timeoutMs: 100 }), /abort|timeout/iu);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it("overall cancellation aborts an in-flight HTTP request", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  try {
    const response = fetchJson(`http://127.0.0.1:${server.address().port}`, {}, { signal: controller.signal, timeoutMs: 5000 });
    controller.abort(new Error("workflow deadline"));
    await assert.rejects(response, /workflow deadline/u);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it("CLI cancellation awaits owned close after TERM rather than abandoning the process", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setTimeout(() => child.emit("close", null, signal), 10);
    return true;
  };
  const controller = new AbortController();
  const completion = waitForCliClose(child, 5000, controller.signal);
  controller.abort(new Error("workflow deadline"));
  await assert.rejects(completion, /workflow deadline/u);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(await waitForExit(child, 100), { code: null, signal: null });
});

it("a CLI ignoring TERM is escalated only on that exact owned process and awaited", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  await assert.rejects(waitForCliClose(child, 10), /CLI timed out/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

it("cancelled event waits detach listeners before teardown", async () => {
  const socket = new EventEmitter();
  const controller = new AbortController();
  const waiter = waitForIssueCreatedFrame(socket, { orgId: "org", title: "x" }, 5000, controller.signal);
  controller.abort(new Error("workflow deadline"));
  await assert.rejects(waiter.promise, /workflow deadline/u);
  for (const event of ["message", "close", "error"]) assert.equal(socket.listenerCount(event), 0);
});

it("expired close waits detach their observation listener", async () => {
  const child = new EventEmitter();
  await assert.rejects(waitForExit(child, 5), /did not exit/u);
  assert.equal(child.listenerCount("close"), 0);
});

it("waits for pipe close even when exitCode was already set", async () => {
  const child = new EventEmitter();
  child.exitCode = 1;
  child.signalCode = null;
  let settled = false;
  const completion = waitForExit(child, 1000).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit("close", 1, null);
  assert.deepEqual(await completion, { code: 1, signal: null });
  assert.deepEqual(await waitForExit(child, 1000), { code: 1, signal: null });
});

it("missing Rust startup identity still stops only the owned supervisor and remains QUESTION", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit("close", null, signal);
    });
    return true;
  };
  const runtime = {
    owner: "installed-public-ingress-smoke", ownerId: "missing-rust",
    child, logs: { stdout: "", stderr: "" }, termRequested: false, stopPromise: null,
  };
  await assert.rejects(stopAndAssertRustListenerExited(runtime, [], 1000), SmokeQuestionError);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(canRemoveSmokeProfile({ runtime, serverStarted: true, shutdownVerified: false }), false);
});
const sourceSha = "755c273fe35fe28c36c37d598687d26dd09648d6";
const packageNames = [
  "@rudderhq/agent-runtime-claude-local",
  "@rudderhq/agent-runtime-codex-local",
  "@rudderhq/agent-runtime-cursor-local",
  "@rudderhq/agent-runtime-hermes-gateway",
  "@rudderhq/agent-runtime-openclaw-gateway",
  "@rudderhq/agent-runtime-opencode-local",
  "@rudderhq/agent-runtime-pi-local",
  "@rudderhq/agent-runtime-utils",
  "@rudderhq/cli",
  "@rudderhq/db",
  "@rudderhq/identity-core",
  "@rudderhq/run-intelligence-core",
  "@rudderhq/server",
  "@rudderhq/shared",
];

function migrationPreflightName(target) {
  return target.endsWith("-pc-windows-msvc") ? "migration-preflight.exe" : "migration-preflight";
}

function makeReceiptInput(overrides = {}) {
  const installRoot = "/tmp/rudder-installed-prefix";
  const targets = Object.fromEntries(SMOKE_NATIVE_TARGETS.map((target) => {
    const serverFoundationName = nativeBinaryName(target);
    const migrationName = migrationPreflightName(target);
    return [target, {
      serverFoundation: {
        entry: `node_modules/@rudderhq/server/resources/native/${target}/${serverFoundationName}`,
        sha256: digest(`${target} foundation`),
      },
      migrationPreflight: {
        entry: `node_modules/@rudderhq/server/resources/native/${target}/${migrationName}`,
        sha256: digest(`${target} migration`),
      },
    }];
  }));
  const packages = packageNames.map((name) => ({
    name,
    version: "0.7.24",
    tarballSha256: digest(`${name} tarball`),
    installedContentSha256: digest(`${name} installed content`),
    checkedEntries: name === "@rudderhq/cli" ? 8 : name === "@rudderhq/server" ? 1941 : 1,
  }));
  const receipt = {
    artifactStatus: "installed_private_candidate_preparation_only_not_workflow_PASS",
    scope: "all archived package entries byte/type/link equality; dependency graph/runtime acceptance separate",
    source: sourceSha,
    productTree: "a9c2944999151b1fa9b80ac17bd75f96b7574fa3",
    prefix: installRoot,
    provenance: "/tmp/native-provenance.json",
    checkedPackages: 14,
    packages,
    declaredLifecycleModeRestoration: [
      nativeBinaryName(SMOKE_NATIVE_TARGETS[0]),
      migrationPreflightName(SMOKE_NATIVE_TARGETS[0]),
    ].map((name) => ({
      package: "@rudderhq/server",
      path: `resources/native/${SMOKE_NATIVE_TARGETS[0]}/${name}`,
      tarballExecutableBits: 0,
      installedExecutableBits: 0o111,
    })),
    ...overrides.receipt,
  };
  const provenance = {
    source: sourceSha,
    ci: 37186766971,
    platformChecks: 6,
    binaries: SMOKE_NATIVE_TARGETS.flatMap((target) => ([
      {
        target,
        name: target.endsWith("-pc-windows-msvc") ? "rudder-server-foundation.exe" : "rudder-server-foundation",
        sha256: targets[target].serverFoundation.sha256,
      },
      {
        target,
        name: migrationPreflightName(target),
        sha256: targets[target].migrationPreflight.sha256,
      },
    ])),
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const provenanceBytes = Buffer.from(JSON.stringify(provenance));
  const components = {
    cli: { entry: "node_modules/@rudderhq/cli/dist/index.js", sha256: digest("cli entry") },
    server: { entry: "node_modules/@rudderhq/server/dist/index.js", sha256: digest("server entry") },
    native: { targets },
  };
  return {
    receiptBytes,
    expectedReceiptSha256: digest(receiptBytes),
    provenanceBytes,
    expectedProvenanceSha256: digest(provenanceBytes),
    expectedSourceSha: sourceSha,
    installRoot,
    hostTarget: SMOKE_NATIVE_TARGETS[0],
    components,
    installedPackages: {
      "@rudderhq/cli": { name: "@rudderhq/cli", version: "0.7.24" },
      "@rudderhq/server": { name: "@rudderhq/server", version: "0.7.24" },
    },
    packageContentDigests: Object.fromEntries(packages.map((entry) => [entry.name, entry.installedContentSha256])),
    ...overrides.input,
  };
}

describe("installed public ingress smoke guards", () => {
  it("fails closed when installed proof arguments are absent", () => {
    assert.throws(() => parseArgs([]), SmokePrerequisiteError);
    assert.throws(
      () => parseArgs(["--install-root", "/tmp/prefix"]),
      /--receipt, --receipt-sha256, --provenance-sha256, --source-sha/u,
    );
  });

  it("keeps caller HOME and USERPROFILE while isolating Rudder profiles and requiring public ingress", () => {
    const baseEnv = {
      HOME: "/Users/identity",
      USERPROFILE: "/Users/identity",
      PATH: "/usr/bin",
      RUDDER_HOME: "/Users/identity/.rudder",
      RUDDER_RUST_PUBLIC_INGRESS_MODE: "off",
      RUDDER_SERVER_FOUNDATION_PATH: "/checkout/native/target/debug/rudder-server-foundation",
      RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: "/checkout/native/target/debug/migration-preflight",
    };
    const env = buildServerEnvironment(baseEnv, {
      profile: "/tmp/rudder-profile",
      publicPort: 32_001,
      databasePort: 54_321,
      instanceId: "installed-public-ingress-test",
      jwtSecret: "ephemeral-test-secret",
      deploymentMode: "authenticated",
    });
    const cliEnv = buildCliEnvironment(baseEnv, "/tmp/rudder-cli-profile");

    assert.equal(env.HOME, baseEnv.HOME);
    assert.equal(env.USERPROFILE, baseEnv.USERPROFILE);
    assert.equal(env.RUDDER_HOME, "/tmp/rudder-profile");
    assert.equal(env.RUDDER_RUST_PUBLIC_INGRESS_MODE, "required");
    assert.equal(cliEnv.RUDDER_HOME, "/tmp/rudder-cli-profile");
    assert.equal(cliEnv.HOME, baseEnv.HOME);
    assert.equal(Object.hasOwn(env, "RUDDER_SERVER_FOUNDATION_PATH"), false);
    assert.equal(Object.hasOwn(cliEnv, "RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH"), false);
  });

  it("binds the candidate-only 14-package receipt, exact prefix, and all 12 native hashes", () => {
    const input = makeReceiptInput();
    const verified = validateInstallReceipt(input);
    assert.equal(verified.receipt.source, sourceSha);
    assert.equal(verified.provenance.ci, 37186766971);

    const wrongReceiptHash = { ...input, expectedReceiptSha256: "0".repeat(64) };
    assert.throws(() => validateInstallReceipt(wrongReceiptHash), /receipt bytes do not match/u);
    const wrongProvenanceHash = { ...input, expectedProvenanceSha256: "0".repeat(64) };
    assert.throws(() => validateInstallReceipt(wrongProvenanceHash), /provenance bytes do not match/u);

    const wrongPrefix = { ...input, installRoot: "/tmp/other-prefix" };
    assert.throws(() => validateInstallReceipt(wrongPrefix), /install prefix/u);
    const wrongCandidate = makeReceiptInput({ receipt: { source: "0".repeat(40) } });
    assert.throws(() => validateInstallReceipt(wrongCandidate), /source SHA/u);

    const wrongNativeHash = makeReceiptInput();
    wrongNativeHash.components.native.targets[SMOKE_NATIVE_TARGETS[0]].serverFoundation.sha256 = "0".repeat(64);
    assert.throws(() => validateInstallReceipt(wrongNativeHash), /hash-bound native provenance/u);

    const wrongArchiveDigest = makeReceiptInput();
    wrongArchiveDigest.packageContentDigests["@rudderhq/server"] = "0".repeat(64);
    assert.throws(() => validateInstallReceipt(wrongArchiveDigest), /archived entry digest/u);
    assert.throws(() => resolveReceiptRelativeEntry(input.installRoot, "../checkout/native"), /escaped installed prefix/u);
  });

  it("derives archive digests from sorted archived files and preserves tarball-relative entries", () => {
    const fileBytes = Buffer.from("installed CLI archive entry\n");
    const header = Buffer.alloc(512);
    header.write("package/dist/index.js", 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${fileBytes.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header[156] = 48;
    header.write("ustar\0", 257, "ascii");
    const padded = Buffer.alloc(Math.ceil(fileBytes.length / 512) * 512);
    fileBytes.copy(padded);
    const tarball = gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
    const entries = parsePackageTarball(tarball);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, "dist/index.js");
    assert.equal(entries[0].mode, 0, "the archived mode is 0644 before the declared npm lifecycle restoration");
    assert.equal(extractTarEntry(tarball, "dist/index.js").toString(), fileBytes.toString());
    const hostRestoration = new Map([["dist/index.js", 0o111]]);
    assert.equal(packageArchiveDigest(entries, hostRestoration), digest(JSON.stringify([[
      "dist/index.js", digest(fileBytes), 0o111,
    ]])));
    assert.notEqual(packageArchiveDigest(entries), packageArchiveDigest(entries, hostRestoration));

    const ordered = [
      { path: "a.js", type: "file", mode: 0, bytes: Buffer.from("lower-root") },
      { path: "a/inside.js", type: "file", mode: 0, bytes: Buffer.from("nested") },
      { path: "A.js", type: "file", mode: 0, bytes: Buffer.from("upper") },
      { path: "link", type: "link", target: "a.js" },
    ];
    const expectedRows = [
      ["A.js", digest(Buffer.from("upper")), 0],
      ["a/inside.js", digest(Buffer.from("nested")), 0],
      ["a.js", digest(Buffer.from("lower-root")), 0],
      ["link", "link", "a.js"],
    ];
    assert.equal(packageArchiveDigest(ordered), digest(JSON.stringify(expectedRows)));
  });

  it("distinguishes the public Actix denial from private Node auth", () => {
    assertWebSocketRejection({ upgraded: false, statusCode: 403, body: "upstream_websocket_rejected" }, "upstream_websocket_rejected");
    assertWebSocketRejection({ upgraded: false, statusCode: 403, body: "forbidden" }, "forbidden");
    assert.throws(
      () => assertWebSocketRejection({ upgraded: false, statusCode: 403, body: "forbidden" }, "upstream_websocket_rejected"),
      /unexpected auth boundary/u,
    );
  });

  it("pre-arms the org/title waiter and retains a matching frame emitted before the POST response", async () => {
    const orgId = "org-one";
    const title = "unique smoke issue one";
    const event = {
      id: 7,
      orgId,
      type: "activity.logged",
      payload: {
        action: "issue.created",
        entityType: "issue",
        entityId: "11111111-1111-4111-8111-111111111111",
        details: { title },
      },
    };
    const socket = new EventEmitter();
    const waiter = waitForIssueCreatedFrame(socket, { orgId, title }, 1_000);
    socket.emit("message", Buffer.from(JSON.stringify({ ...event, payload: { ...event.payload, details: { title: "unrelated" } } })));
    assert.equal(isExpectedIssueCreatedFrame(event, { orgId, title }), true);
    socket.emit("message", Buffer.from(JSON.stringify(event)));

    const issue = assertCreatedIssueResponse({ id: event.payload.entityId, title });
    const captured = await waiter.promise;
    assertActivityLoggedFrame(captured, { orgId, issueId: issue.id });
    assert.equal(isExpectedIssueCreatedFrame(event, { orgId, title: "different title" }), false);
    waiter.cancel();
    assert.throws(() => assertCreatedIssueResponse({ issue }), /created Issue id/u);
  });

  it("checks same-process reconnect ordering without assuming ordering across restart", () => {
    const first = { id: 10, payload: { entityId: "issue-one" } };
    const second = { id: 11, payload: { entityId: "issue-two" } };
    assertReconnectActivityAfter(first, second);
    assert.throws(() => assertReconnectActivityAfter(second, first), /later live-event sequence id/u);
  });

  it("requires the supervised child close receipt before deleting its profile", () => {
    const logs = { stdout: "[rudder-rust-bridge] close completed pid=42 reason=shutdown\n", stderr: "" };
    assertSupervisedRustChildExit(logs, "42");
    assert.throws(() => assertSupervisedRustChildExit(logs, "43"), /owned Rust child/u);
    assert.equal(canRemoveSmokeProfile({ runtime: null, serverStarted: false, shutdownVerified: false }), true);
    assert.equal(canRemoveSmokeProfile({ runtime: null, serverStarted: true, shutdownVerified: true }), true);
    assert.equal(canRemoveSmokeProfile({ runtime: {}, serverStarted: true, shutdownVerified: false }), false);
    assert.equal(canRemoveSmokeProfile({ runtime: null, serverStarted: true, shutdownVerified: false }), false);
    assert.equal(shouldRetainSmokeProfile({ keepTemp: true, runtime: null, serverStarted: true, shutdownVerified: true }), true);
    assert.equal(shouldRetainSmokeProfile({ keepTemp: false, runtime: {}, serverStarted: true, shutdownVerified: false }), true);
    assert.equal(shouldRetainSmokeProfile({ keepTemp: false, runtime: null, serverStarted: true, shutdownVerified: true }), false);
  });

  it("signals only its named ChildProcess, once, using TERM", () => {
    const signals = [];
    const runtime = {
      owner: "installed-public-ingress-smoke",
      ownerId: "run-one",
      child: { kill: (signal) => { signals.push(signal); return true; } },
      termRequested: false,
    };
    assert.equal(requestOwnedTermination(runtime, "run-one"), true);
    assert.equal(requestOwnedTermination(runtime, "run-one"), false);
    assert.deepEqual(signals, ["SIGTERM"]);

    const foreign = { ...runtime, ownerId: "other-run", termRequested: false };
    assert.throws(() => requestOwnedTermination(foreign, "run-one"), /different smoke run/u);
    assert.deepEqual(signals, ["SIGTERM"]);
  });
});
