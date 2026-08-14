import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  attestExternalDesktopUpdateHelper,
  ensureExternalDesktopUpdateHelper,
  handoffDesktopUpdateToExternalHelper,
  isDesktopUpdateRequestFresh,
  quarantineDesktopUpdateRequest,
  readDesktopUpdateJournal,
  recoverDesktopUpdateWithExternalHelper,
  requestMatchesAutomaticCandidate,
  resolveDesktopUpdateTransactionPaths,
  resolveExternalDesktopUpdateHelperPath,
  DESKTOP_UPDATE_HELPER_PROTOCOL,
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
        stagedPath: path.join(root, "staged.zip"),
        targetVersion: "0.3.4",
        candidateSha256: "a".repeat(64),
        admission: { closed: true, activeRuns: 0, drainToken: "drain-token-123456" },
        checkpoint: { instanceId: "default", databaseRevision: "db-rev-1", migrationCompatible: true },
        helper: { path: "/tmp/rudder-update-helper", ownerUid: 501, mode: 0o755, sha256: "b".repeat(64) },
        probation: { executable: path.join(paths.installPath, "Contents/MacOS/Rudder"), args: [], timeoutMs: 10_000 },
      },
    });
    expect(spawnProcess).toHaveBeenCalledWith("/tmp/rudder-update-helper", ["--request", expect.stringContaining(`${transactionId}.journal.json.request.json`)], expect.objectContaining({ detached: true, stdio: ["ignore", "ignore", "ignore"] }));
    const requestPath = spawnProcess.mock.calls[0][1][1] as string;
    expect(JSON.parse(fs.readFileSync(requestPath, "utf8"))).toMatchObject({ operation: "apply", transactionId, admission: { closed: true, activeRuns: 0 } });
  });

  it("rejects a claimed request bound to a different helper generation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-binding-"));
    const transactionId = "desktop-update-binding";
    const paths = resolveDesktopUpdateTransactionPaths({ userDataPath: root, transactionId });
    const helper = { path: "/tmp/rudder-update-helper", ownerUid: 501, mode: 0o755, sha256: "b".repeat(64) };
    const candidate = {
      updateId: transactionId,
      version: "0.3.4",
      stagedArtifactPath: path.join(root, "staged.zip"),
      stagedArtifactDigest: "a".repeat(64),
    };
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
      probation: { executable: path.join(paths.installPath, "Contents/MacOS/Rudder"), args: [], timeoutMs: 10_000 },
    };

    expect(requestMatchesAutomaticCandidate({ request, candidate, statePath: request.statePath, paths, helper })).toBe(true);
    expect(requestMatchesAutomaticCandidate({
      request,
      candidate,
      statePath: request.statePath,
      paths,
      helper: { ...helper, sha256: "c".repeat(64) },
    })).toBe(false);
  });

  it("fails closed for unreadable journals and parses a recovery result", () => {
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
    const result = recoverDesktopUpdateWithExternalHelper({
      helperPath: "/tmp/rudder-update-helper",
      request: {
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
        probation: { executable: path.join(paths.installPath, "Contents/MacOS/Rudder"), args: ["--rudder-update-probation"], timeoutMs: 1000 },
      },
      spawnProcess: vi.fn(() => ({
        stdout: Buffer.from('{"ok":true,"stage":"rolled_back","recoveryRequired":false}\n'),
        stderr: Buffer.from(""),
        status: 3,
      }) as never),
    });
    expect(result).toMatchObject({ ok: true, stage: "rolled_back", recoveryRequired: false });
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
