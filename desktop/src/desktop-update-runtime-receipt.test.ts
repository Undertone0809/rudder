import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DesktopAutoUpdateCandidate } from "./desktop-auto-update-state.js";
import {
  resolveDesktopUpdateRuntimeReceipt,
  resolveDesktopUpdateTransactionPaths,
  type DesktopUpdateJournalSnapshot,
} from "./desktop-update-helper.js";
import {
  createAutomaticDesktopUpdateRuntimeContext,
  createBoundDesktopUpdateRecoveryRequest,
  resolveDesktopUpdateRuntimeReceiptForProfile,
} from "./desktop-update-runtime-receipt.js";

describe("Desktop update runtime receipts", () => {
  it("resolves the automatic runtime identity, scope, and owned ports together", () => {
    const instanceRoot = path.resolve("/tmp/rudder-runtime-receipt-instance");
    const context = createAutomaticDesktopUpdateRuntimeContext({
      context: {
        getBootState: () => ({
          runtime: { localEnv: "prod_local", instanceId: "default" },
          paths: { instanceRoot },
        }),
        hasExternalUpdateHelperCapability: () => true,
        hasSignedUpdatePolicyCapability: () => true,
      },
      isPackaged: () => true,
      platform: "darwin",
      env: {},
    });

    expect(context.automaticRuntimeIdentity()).toEqual({ profile: "prod_local", instanceId: "default" });
    expect(context.automaticUpdateScopeAllowed()).toBe(true);
    expect(context.automaticUpdatePrerequisitesAvailable()).toBe(true);
    expect(context.automaticUpdateCapabilityAvailable()).toBe(true);
    expect(context.automaticRuntimeReceipt()).toEqual(resolveDesktopUpdateRuntimeReceiptForProfile({
      name: "prod_local",
      instanceId: "default",
      port: "3200",
      embeddedPostgresPort: "54339",
    }, instanceRoot, {}));
  });

  it("prefers the supplied runtime receipt and denies automatic updates outside the packaged default profile", () => {
    const suppliedReceipt = resolveDesktopUpdateRuntimeReceipt({
      instanceRoot: path.resolve("/tmp/rudder-supplied-runtime-receipt"),
      instanceId: "default",
      apiPort: 3200,
      postgresPort: 54339,
    });
    const context = createAutomaticDesktopUpdateRuntimeContext({
      context: {
        getBootState: () => ({ runtime: { localEnv: "dev", instanceId: "dev" } }),
        getRuntimeReceipt: () => suppliedReceipt,
      },
      isPackaged: () => true,
      platform: "darwin",
      env: {},
    });

    expect(context.automaticRuntimeReceipt()).toEqual(suppliedReceipt);
    expect(context.automaticUpdateScopeAllowed()).toBe(false);
  });

  it("builds recovery requests only when the journal receipt matches the current runtime", () => {
    const fixture = recoveryFixture();
    const request = createBoundDesktopUpdateRecoveryRequest(fixture);

    expect(request).toMatchObject({
      operation: "recover",
      transactionId: fixture.journal.transactionId,
      installPath: fixture.journal.installPath,
      stagedPath: fixture.journal.stagedPath,
      lkgPath: fixture.journal.lkgPath,
      checkpointPath: fixture.journal.checkpointPath,
      statePath: fixture.journal.statePath,
      admission: fixture.journal.admission,
      checkpoint: fixture.journal.checkpoint,
      runtimeReceipt: fixture.runtimeReceipt,
      helper: fixture.journal.helper,
      probation: { args: ["--rudder-update-probation"], timeoutMs: 10_000 },
    });
    expect(createBoundDesktopUpdateRecoveryRequest({
      ...fixture,
      runtimeReceipt: { ...fixture.runtimeReceipt, apiPort: 3201 },
    })).toBeNull();
    expect(createBoundDesktopUpdateRecoveryRequest({
      ...fixture,
      helper: { ...fixture.helper, sha256: "d".repeat(64) },
    })).toBeNull();
    expect(createBoundDesktopUpdateRecoveryRequest({
      ...fixture,
      candidate: { ...fixture.candidate, version: "9.9.9" },
    })).toBeNull();
  });
});

function recoveryFixture() {
  const userDataPath = path.resolve("/tmp/rudder-update-recovery-receipt");
  const transactionId = "receipt-update-1";
  const resourcesPath = path.join(userDataPath, "Rudder.app", "Contents", "Resources");
  const execPath = path.join(userDataPath, "Rudder.app", "Contents", "MacOS", "Rudder");
  const paths = resolveDesktopUpdateTransactionPaths({ userDataPath, transactionId, resourcesPath, execPath });
  const runtimeReceipt = resolveDesktopUpdateRuntimeReceipt({
    instanceRoot: path.join(userDataPath, "instances", "default"),
    instanceId: "default",
    apiPort: 3200,
    postgresPort: 54339,
  });
  const helper = {
    path: path.join(userDataPath, "update-helper", "rudder-update-helper"),
    protocol: "rudder-update-helper 0.1.0 protocol=1",
    ownerUid: 501,
    mode: 0o755,
    sha256: "b".repeat(64),
  };
  const candidate: DesktopAutoUpdateCandidate = {
    channel: "stable",
    version: "1.2.3",
    platform: "darwin",
    arch: process.arch,
    installId: paths.installPath,
    profile: "prod_local",
    instanceId: "default",
    sourceReleaseDigest: "c".repeat(64),
    updateId: transactionId,
    stagedArtifactPath: path.join(userDataPath, "staged.zip"),
    stagedArtifactDigest: "a".repeat(64),
    stagedAt: new Date(0).toISOString(),
    status: "staged",
    generation: 1,
  };
  const journal: DesktopUpdateJournalSnapshot = {
    transactionId,
    ownerToken: "owner-token-123456",
    installPath: paths.installPath,
    stagedPath: candidate.stagedArtifactPath,
    lkgPath: paths.lkgPath,
    checkpointPath: paths.checkpointPath,
    statePath: path.join(userDataPath, "desktop-auto-update.json"),
    targetVersion: candidate.version,
    candidateSha256: candidate.stagedArtifactDigest,
    runtimeReceipt,
    helper: {
      path: helper.path,
      ownerUid: helper.ownerUid,
      mode: helper.mode,
      sha256: helper.sha256,
    },
    admission: { closed: true, activeRuns: 0, drainToken: "drain-token-123456" },
    checkpoint: { instanceId: "default", databaseRevision: "db-revision-1", migrationCompatible: true },
    stage: "previous_moved",
    recoveryRequired: true,
  };

  return {
    journal,
    candidate,
    helper,
    userDataPath,
    resourcesPath,
    execPath,
    runtimeReceipt,
  };
}
