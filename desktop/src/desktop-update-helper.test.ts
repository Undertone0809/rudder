import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  attestExternalDesktopUpdateHelper,
  ensureExternalDesktopUpdateHelper,
  handoffDesktopUpdateToExternalHelper,
  resolveDesktopUpdateTransactionPaths,
  resolveExternalDesktopUpdateHelperPath,
} from "./desktop-update-helper.js";

describe("external Desktop update helper attestation", () => {
  it("rejects missing, symlinked, and bundle-local helpers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-attest-"));
    const resources = path.join(root, "Resources");
    const helper = path.join(resources, "native", "rudder-update-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\necho rudder-update-helper 0.7.5 protocol=1\n");
    fs.chmodSync(helper, 0o755);
    expect(resolveExternalDesktopUpdateHelperPath({ userDataPath: root, resourcesPath: resources, platform: "darwin" })).toBeNull();
    const external = path.join(root, "update-helper", "rudder-update-helper");
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.symlinkSync(helper, external);
    expect(resolveExternalDesktopUpdateHelperPath({ userDataPath: root, resourcesPath: resources, platform: "darwin" })).toBeNull();
  });

  it("attests an installed helper only after protocol and executable checks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-attest-"));
    const helper = path.join(root, "update-helper", "rudder-update-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\nprintf '%s\\n' 'rudder-update-helper 0.7.5 protocol=1'\n");
    fs.chmodSync(helper, 0o755);
    expect(attestExternalDesktopUpdateHelper({ userDataPath: root, resourcesPath: path.join(root, "Resources"), platform: "darwin" })).toMatchObject({ path: helper });
  });

  it("copies a packaged helper outside the replaceable App bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-helper-install-"));
    const resources = path.join(root, "Resources");
    const bundled = path.join(resources, "native", "aarch64-apple-darwin", "rudder-update-helper");
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, "#!/bin/sh\nprintf '%s\\n' 'rudder-update-helper 0.7.5 protocol=1'\n");
    fs.chmodSync(bundled, 0o755);
    const result = ensureExternalDesktopUpdateHelper({ userDataPath: root, resourcesPath: resources, platform: "darwin" });
    expect(result?.path).toBe(path.join(root, "update-helper", "rudder-update-helper"));
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
    const stdin = { write: vi.fn((_payload: string, callback?: () => void) => callback?.()), end: vi.fn() };
    const child = { stdin, unref: vi.fn() } as never;
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
      },
    });
    expect(spawnProcess).toHaveBeenCalledWith("/tmp/rudder-update-helper", ["--stdin"], expect.objectContaining({ detached: true }));
    expect(JSON.parse(stdin.write.mock.calls[0][0])).toMatchObject({ operation: "apply", transactionId, admission: { closed: true, activeRuns: 0 } });
    expect(stdin.end).toHaveBeenCalledOnce();
  });
});
