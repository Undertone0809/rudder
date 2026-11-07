import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  attestExternalDesktopUpdateHelper,
  desktopUpdateRuntimeReceiptsMatch,
  DESKTOP_UPDATE_HELPER_PROTOCOL,
  DESKTOP_UPDATE_HELPER_TERMINATION_GRACE_MS,
  ensureExternalDesktopUpdateHelper,
  handoffDesktopUpdateToExternalHelper,
  isDesktopUpdateRequestFresh,
  quarantineDesktopUpdateRequest,
  readDesktopUpdateHelperRequest,
  readDesktopUpdateJournal,
  recoverDesktopUpdateWithExternalHelper,
  requestMatchesAutomaticCandidate,
  resolveDesktopUpdateRuntimeReceipt,
  resolveDesktopUpdateTransactionPaths,
  resolveExternalDesktopUpdateHelperPath,
  type DesktopUpdateHelperRequest,
} from "./desktop-update-helper.js";

describe("external Desktop update helper attestation", () => {
  it("rejects missing, symlinked, and bundle-local helpers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-attest-"));
    const resources = path.join(root, "Resources");
    const helper = path.join(resources, "native", "rudder-update-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, `#!/bin/sh\necho '${DESKTOP_UPDATE_HELPER_PROTOCOL}'\n`);
    fs.chmodSync(helper, 0o755);
    expect(resolveExternalDesktopUpdateHelperPath({ userDataPath: root, resourcesPath: resources, platform: "darwin" })).toBeNull();
    const external = path.join(root, "update-helper", "rudder-update-helper");
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.symlinkSync(helper, external);
    expect(resolveExternalDesktopUpdateHelperPath({ userDataPath: root, resourcesPath: resources, platform: "darwin" })).toBeNull();
  });

  it("attests an installed helper only after protocol and executable checks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-attest-"));
    const installKey = createInstallKey(root, path.join(root, "Resources"));
    const helper = path.join(root, "update-helper", installKey, "rudder-update-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' '${DESKTOP_UPDATE_HELPER_PROTOCOL}'\n`);
    fs.chmodSync(helper, 0o755);
    expect(attestExternalDesktopUpdateHelper({ userDataPath: root, resourcesPath: path.join(root, "Resources"), platform: "darwin" })).toMatchObject({ path: helper });
  });

  it("copies a packaged helper outside the replaceable App bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-install-"));
    const resources = path.join(root, "Resources");
    const bundled = path.join(resources, "native", "aarch64-apple-darwin", "rudder-update-helper");
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, `#!/bin/sh\nprintf '%s\\n' '${DESKTOP_UPDATE_HELPER_PROTOCOL}'\n`);
    fs.chmodSync(bundled, 0o755);
    const result = ensureExternalDesktopUpdateHelper({ userDataPath: root, resourcesPath: resources, platform: "darwin" });
    expect(result?.path).toMatch(new RegExp(`${path.join(root, "update-helper")}.*rudder-update-helper$`));
    expect(fs.lstatSync(result!.path).isSymbolicLink()).toBe(false);
    expect(result!.path.startsWith(resources)).toBe(false);
  });

  it("builds durable transaction paths and writes one JSON request to the native helper", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-request-"));
    const transactionId = "desktop-update-123456";
    const paths = resolveDesktopUpdateTransactionPaths({
      userDataPath: root,
      transactionId,
      resourcesPath: path.join(root, "Rudder.app", "Contents", "Resources"),
    });
    expect(paths.installPath).toBe(path.join(root, "Rudder.app"));
    expect(paths.lkgPath).toContain("update-helper/lkg/Rudder.app");
    expect(paths.journalPath).toContain(`${transactionId}.journal.json`);
    const child = { unref: vi.fn() } as never;
    const spawnProcess = vi.fn(() => child);
    handoffDesktopUpdateToExternalHelper({
      helperPath: "/tmp/rudder-update-helper",
      spawnProcess,
      request: {
        operation: "apply",
        ownerToken: "owner-token-123456",
        transactionId,
        ...paths,
        statePath: path.join(root, "desktop-auto-update.json"),
        stagedPath: path.join(root, "staged.zip"),
        targetVersion: "0.3.4",
        candidateSha256: "a".repeat(64),
        admission: { closed: true, activeRuns: 0, drainToken: "drain-token-123456" },
        checkpoint: { instanceId: "default", databaseRevision: "db-rev-1", migrationCompatible: true },
        helper: { path: "/tmp/rudder-update-helper", ownerUid: 501, mode: 0o755, sha256: "b".repeat(64) },
        probation: {
          executable: path.join(paths.installPath, "Contents/MacOS/Rudder"),
          args: [],
          timeoutMs: 10_000,
          runtime: createRuntimeReceipt(root),
        },
      },
    });
    expect(spawnProcess).toHaveBeenCalledWith("/tmp/rudder-update-helper", ["--request", expect.stringContaining(`${transactionId}.journal.json.request.json`)], expect.objectContaining({ detached: true, stdio: ["ignore", "ignore", "ignore"] }));
    const requestPath = spawnProcess.mock.calls[0][1][1] as string;
    expect(JSON.parse(fs.readFileSync(requestPath, "utf8"))).toMatchObject({
      operation: "apply",
      transactionId,
      admission: { closed: true, activeRuns: 0 },
      probation: { runtime: createRuntimeReceipt(root) },
    });
    expect(readDesktopUpdateHelperRequest(requestPath)?.probation.runtime).toEqual(createRuntimeReceipt(root));
  });

  it("rejects a claimed request bound to a different helper generation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-binding-"));
    const transactionId = "desktop-update-binding";
    const paths = resolveDesktopUpdateTransactionPaths({ userDataPath: root, transactionId });
    const helper = { path: "/tmp/rudder-update-helper", ownerUid: 501, mode: 0o755, sha256: "b".repeat(64) };
    const candidate = {
      updateId: transactionId,
      version: "0.3.4",
      instanceId: "default",
      stagedArtifactPath: path.join(root, "staged.zip"),
      stagedArtifactDigest: "a".repeat(64),
    };
    const runtimeReceipt = createRuntimeReceipt(root);
    const request = {
      operation: "apply" as const,
      ownerToken: "owner-token-123456",
      transactionId,
      ...paths,
      statePath: path.join(root, "desktop-auto-update.json"),
      stagedPath: candidate.stagedArtifactPath,
      targetVersion: candidate.version,
      candidateSha256: candidate.stagedArtifactDigest,
      admission: { closed: true, activeRuns: 0, drainToken: "drain-token-123456" },
      checkpoint: { instanceId: "default", databaseRevision: "db-rev-1", migrationCompatible: true },
      helper,
      probation: {
        executable: path.join(paths.installPath, "Contents/MacOS/Rudder"),
        args: [],
        timeoutMs: 10_000,
        runtime: runtimeReceipt,
      },
    };

    expect(requestMatchesAutomaticCandidate({ request, candidate, statePath: request.statePath, paths, helper, runtimeReceipt })).toBe(true);
    expect(requestMatchesAutomaticCandidate({
      request,
      candidate,
      statePath: request.statePath,
      paths,
      helper: { ...helper, sha256: "c".repeat(64) },
      runtimeReceipt,
    })).toBe(false);
    expect(requestMatchesAutomaticCandidate({
      request: { ...request, probation: { ...request.probation, runtime: { ...runtimeReceipt, apiPort: 3201 } } },
      candidate,
      statePath: request.statePath,
      paths,
      helper,
      runtimeReceipt,
    })).toBe(false);
    expect(requestMatchesAutomaticCandidate({
      request: { ...request, probation: { ...request.probation, runtime: undefined as never } },
      candidate,
      statePath: request.statePath,
      paths,
      helper,
      runtimeReceipt,
    })).toBe(false);
  });

  it("fails closed for unreadable journals and parses a delayed nonzero recovery result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-journal-"));
    const transactionId = "desktop-update-abcdef";
    const paths = resolveDesktopUpdateTransactionPaths({ userDataPath: root, transactionId });
    fs.mkdirSync(path.dirname(paths.journalPath), { recursive: true });
    fs.writeFileSync(paths.journalPath, "{not-json", "utf8");
    expect(readDesktopUpdateJournal(root, transactionId)).toMatchObject({
      stage: "invalid",
      recoveryRequired: true,
      recoveryCode: "journal_unreadable",
    });
    const runtimeReceipt = createRuntimeReceipt(root);
    fs.writeFileSync(paths.journalPath, JSON.stringify({
      transactionId,
      stage: "probation_passed",
      recoveryRequired: true,
      probationRuntime: { ...runtimeReceipt, apiPid: 1234, postgresPid: 5678, postmasterPid: 4242 },
    }), "utf8");
    const journal = readDesktopUpdateJournal(root, transactionId);
    expect(journal).toMatchObject({
      probationRuntime: { ...runtimeReceipt, apiPid: 1234, postgresPid: 5678, postmasterPid: 4242 },
    });
    expect(desktopUpdateRuntimeReceiptsMatch(journal?.probationRuntime, runtimeReceipt)).toBe(true);
    const child = createRecoveryChild();
    const spawnProcess = vi.fn(() => child);
    let settled = false;
    const resultPromise = recoverDesktopUpdateWithExternalHelper({
      helperPath: "/tmp/rudder-update-helper",
      request: createRecoveryRequest(root, transactionId, 1000),
      spawnProcess: spawnProcess as never,
    });
    void resultPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.stdout.emit("data", Buffer.from('{"phase":"recovering"}\n'));
    child.stdout.emit("data", Buffer.from("helper diagnostic without JSON\n"));
    child.stdout.emit("data", Buffer.from('{"ok":true,"stage":"rolled_back","recoveryRequired":false}\n'));
    child.emit("close", 3);

    await expect(resultPromise).resolves.toMatchObject({ ok: true, stage: "rolled_back", recoveryRequired: false });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/tmp/rudder-update-helper",
      ["--request", expect.stringContaining(`${transactionId}.journal.json.request.json`)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(fs.existsSync(`${paths.journalPath}.request.json`)).toBe(false);
  });

  it("fails closed on helper errors and cleans the recovery request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-error-"));
    const request = createRecoveryRequest(root, "desktop-update-error", 1000);
    const child = createRecoveryChild();
    const resultPromise = recoverDesktopUpdateWithExternalHelper({
      helperPath: "/tmp/rudder-update-helper",
      request,
      spawnProcess: vi.fn(() => child) as never,
    });

    child.emit("error", new Error("helper launch failed"));
    await Promise.resolve();
    expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
    child.emit("close", 2, null);

    await expect(resultPromise).resolves.toMatchObject({ ok: false, error: "helper launch failed" });
    expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(false);
  });

  it("waits for confirmed close after SIGTERM before cleaning the request", async () => {
    vi.useFakeTimers();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-delayed-close-"));
      const request = createRecoveryRequest(root, "desktop-update-delayed", 1000);
      const child = createRecoveryChild();
      const signals: NodeJS.Signals[] = [];
      child.kill.mockImplementation((signal: NodeJS.Signals) => {
        signals.push(signal);
        setTimeout(() => child.emit("close", null, "SIGTERM"), 1000);
        return true;
      });
      const resultPromise = recoverDesktopUpdateWithExternalHelper({
        helperPath: "/tmp/rudder-update-helper",
        request,
        spawnProcess: vi.fn(() => child) as never,
      });
      const recoveryTimeoutMs = (2 * request.probation.timeoutMs) + 15_000;

      await vi.advanceTimersByTimeAsync(recoveryTimeoutMs);
      expect(signals).toEqual(["SIGTERM"]);
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toMatchObject({ ok: false, error: "automatic_update_recovery_timeout" });
      expect(signals).toEqual(["SIGTERM"]);
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates ignored SIGTERM to SIGKILL and preserves the request without confirmed close", async () => {
    vi.useFakeTimers();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-forced-stop-"));
      const request = createRecoveryRequest(root, "desktop-update-forced", 1000);
      const child = createRecoveryChild();
      const signals: NodeJS.Signals[] = [];
      child.kill.mockImplementation((signal: NodeJS.Signals) => {
        signals.push(signal);
        return true;
      });
      const resultPromise = recoverDesktopUpdateWithExternalHelper({
        helperPath: "/tmp/rudder-update-helper",
        request,
        spawnProcess: vi.fn(() => child) as never,
      });
      const recoveryTimeoutMs = (2 * request.probation.timeoutMs) + 15_000;

      await vi.advanceTimersByTimeAsync(recoveryTimeoutMs);
      expect(signals).toEqual(["SIGTERM"]);
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
      await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_HELPER_TERMINATION_GRACE_MS);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
      await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_HELPER_TERMINATION_GRACE_MS);

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        recoveryRequired: true,
        recoveryCode: "automatic_update_recovery_process_exit_unconfirmed",
      });
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);

      child.emit("error", new Error("late kill error"));
      child.emit("close", null, "SIGKILL");
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the request until a delayed SIGKILL close is confirmed", async () => {
    vi.useFakeTimers();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-delayed-kill-"));
      const request = createRecoveryRequest(root, "desktop-update-kill", 1000);
      const child = createRecoveryChild();
      const signals: NodeJS.Signals[] = [];
      child.kill.mockImplementation((signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGKILL") setTimeout(() => child.emit("close", null, "SIGKILL"), 1000);
        return true;
      });
      const resultPromise = recoverDesktopUpdateWithExternalHelper({
        helperPath: "/tmp/rudder-update-helper",
        request,
        spawnProcess: vi.fn(() => child) as never,
      });
      const recoveryTimeoutMs = (2 * request.probation.timeoutMs) + 15_000;

      await vi.advanceTimersByTimeAsync(recoveryTimeoutMs);
      await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_HELPER_TERMINATION_GRACE_MS);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toMatchObject({ ok: false, error: "automatic_update_recovery_timeout" });
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects empty, invalid, and oversized recovery output", async () => {
    const cases = [
      { output: "", error: "automatic_update_recovery_no_result" },
      { output: "not-json\n", error: "automatic_update_recovery_invalid_result" },
      { output: "x".repeat(1024 * 1024 + 1), error: "automatic_update_recovery_output_too_large" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-output-"));
      const request = createRecoveryRequest(root, `desktop-update-output-${index}`, 1000);
      const child = createRecoveryChild();
      const resultPromise = recoverDesktopUpdateWithExternalHelper({
        helperPath: "/tmp/rudder-update-helper",
        request,
        spawnProcess: vi.fn(() => child) as never,
      });

      if (testCase.output) child.stdout.emit("data", testCase.output);
      child.emit("close", 0);

      await expect(resultPromise).resolves.toMatchObject({ ok: false, error: testCase.error });
      expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(false);
    }
  });

  it("fails closed when the helper is terminated by a signal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-signal-"));
    const request = createRecoveryRequest(root, "desktop-update-signal", 1000);
    const child = createRecoveryChild();
    const resultPromise = recoverDesktopUpdateWithExternalHelper({
      helperPath: "/tmp/rudder-update-helper",
      request,
      spawnProcess: vi.fn(() => child) as never,
    });

    child.stdout.emit("data", '{"ok":true,"stage":"rolled_back"}\n');
    child.emit("close", null, "SIGTERM");

    await expect(resultPromise).resolves.toMatchObject({ ok: false, error: "automatic_update_recovery_terminated_by_signal" });
    expect(fs.existsSync(`${request.journalPath}.request.json`)).toBe(false);
  });

  it("bounds orphaned claimed requests and quarantines stale request files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-stale-"));
    const requestPath = path.join(root, "transaction.journal.json.request.json");
    fs.writeFileSync(requestPath, "{}\n", { mode: 0o600 });
    const freshNow = fs.statSync(requestPath).mtimeMs + 1_000;
    expect(isDesktopUpdateRequestFresh(requestPath, freshNow)).toBe(true);
    const staleNow = fs.statSync(requestPath).mtimeMs + (5 * 60 * 1_000) + 1;
    expect(isDesktopUpdateRequestFresh(requestPath, staleNow)).toBe(false);
    const quarantined = quarantineDesktopUpdateRequest(requestPath);
    expect(quarantined).toMatch(/\.stale-/u);
    expect(fs.existsSync(requestPath)).toBe(false);
    expect(fs.existsSync(quarantined!)).toBe(true);
  });
});

function createInstallKey(userDataPath: string, resourcesPath: string): string {
  void userDataPath;
  return createHash("sha256")
    .update(path.resolve(resourcesPath, "..", ".."))
    .digest("hex")
    .slice(0, 16);
}

function createRuntimeReceipt(root: string) {
  return resolveDesktopUpdateRuntimeReceipt({
    instanceRoot: path.join(root, "rudder-home", "instances", "default"),
    instanceId: "default",
    apiPort: 3200,
    postgresPort: 54339,
  });
}

function createRecoveryRequest(
  root: string,
  transactionId: string,
  timeoutMs: number,
): DesktopUpdateHelperRequest {
  const paths = resolveDesktopUpdateTransactionPaths({ userDataPath: root, transactionId });
  return {
    operation: "recover",
    ownerToken: "owner-token-123456",
    transactionId,
    ...paths,
    stagedPath: path.join(root, "staged.zip"),
    targetVersion: "0.3.4",
    candidateSha256: "a".repeat(64),
    admission: { closed: true, activeRuns: 0, drainToken: "drain-token-123456" },
    checkpoint: { instanceId: "default", databaseRevision: "db-rev-1", migrationCompatible: true },
    helper: { path: "/tmp/rudder-update-helper", ownerUid: 501, mode: 0o755, sha256: "b".repeat(64) },
    probation: {
      executable: path.join(paths.installPath, "Contents/MacOS/Rudder"),
      args: ["--rudder-update-probation"],
      timeoutMs,
      runtime: createRuntimeReceipt(root),
    },
  };
}

function createRecoveryChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}
