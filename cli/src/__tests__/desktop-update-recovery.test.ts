import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmbeddedPostgresCheckpoint,
  createDesktopUpdateMaintenanceLock,
  hasResumableDesktopUpdateRecoveryTransaction,
  inspectDesktopUpdateRecoveryArtifacts,
  quarantineDesktopUpdateTarget,
  readDesktopUpdateTransaction,
  removeDesktopUpdateMaintenanceLock,
  removeDesktopUpdateRecoveryArtifacts,
  resolveDesktopUpdateCandidateHeartbeatPath,
  resolveDesktopUpdateQuarantinePath,
  resolveDesktopUpdateMaintenanceLockPath,
  resolveDesktopUpdateRuntimeStartLockPath,
  resolveDesktopUpdateTransactionPath,
  restorePathFromSnapshotAtomically,
  restoreEmbeddedPostgresCheckpoint,
  waitForDesktopUpdateCandidate,
  waitForDesktopUpdateCandidateStability,
  writeDesktopUpdateTransaction,
  type DesktopUpdateTransaction,
} from "../desktop-update-recovery.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-desktop-update-recovery."));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function transaction(updateId: string): DesktopUpdateTransaction {
  return {
    version: 1,
    updateId,
    origin: "upgrade",
    phase: "candidate_installed",
    fromVersion: "0.4.6",
    targetVersion: "0.4.7",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    install: {
      appPath: "/Applications/Rudder.app",
      backupAppPath: "/tmp/Rudder.app",
      metadataPath: "/Applications/.rudder-desktop-install.json",
    },
    database: { mode: "embedded-postgres", dataDir: "/tmp/db", checkpointPath: "/tmp/checkpoint" },
  };
}

describe("desktop update recovery transaction", () => {
  it("writes and reads an atomic transaction", async () => {
    const root = await createTempRoot();
    const filePath = resolveDesktopUpdateTransactionPath("update-1", root);
    await writeDesktopUpdateTransaction(filePath, transaction("update-1"));

    await expect(readDesktopUpdateTransaction(filePath)).resolves.toMatchObject({
      updateId: "update-1",
      phase: "candidate_installed",
      fromVersion: "0.4.6",
      targetVersion: "0.4.7",
    });
  });

  it("holds an instance maintenance lock for one update owner", async () => {
    const root = await createTempRoot();
    const lockPath = await createDesktopUpdateMaintenanceLock({
      updateId: "update-owner",
      targetVersion: "0.4.7",
      instanceId: "default",
      homeDir: root,
    });
    expect(lockPath).toBe(resolveDesktopUpdateMaintenanceLockPath("default", root));
    await expect(createDesktopUpdateMaintenanceLock({
      updateId: "competing-update",
      targetVersion: "0.4.8",
      instanceId: "default",
      homeDir: root,
    })).rejects.toThrow("already owns");
    await removeDesktopUpdateMaintenanceLock(lockPath, "competing-update");
    await expect(stat(lockPath)).resolves.toBeTruthy();
    await removeDesktopUpdateMaintenanceLock(lockPath, "update-owner");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves maintenance ownership while a recovery journal is resumable", async () => {
    const root = await createTempRoot();
    const updateId = "preserve-recovery-lock";
    const backupAppPath = path.join(root, "backup", "Rudder.app");
    const checkpointPath = path.join(root, "checkpoint");
    const transactionPath = resolveDesktopUpdateTransactionPath(updateId, root);
    await mkdir(backupAppPath, { recursive: true });
    await mkdir(checkpointPath, { recursive: true });
    await writeFile(path.join(checkpointPath, "PG_VERSION"), "18\n");
    await writeDesktopUpdateTransaction(transactionPath, {
      ...transaction(updateId),
      phase: "backup_ready",
      install: {
        appPath: path.join(root, "Applications", "Rudder.app"),
        backupAppPath,
        metadataPath: path.join(root, "Applications", ".rudder-desktop-install.json"),
      },
      database: {
        mode: "embedded-postgres",
        dataDir: path.join(root, "db"),
        checkpointPath,
      },
    });
    const lockPath = await createDesktopUpdateMaintenanceLock({
      updateId,
      targetVersion: "0.4.7",
      instanceId: "default",
      homeDir: root,
    });

    await expect(hasResumableDesktopUpdateRecoveryTransaction(updateId, root)).resolves.toBe(true);
    await expect(stat(transactionPath)).resolves.toBeTruthy();
    await expect(stat(backupAppPath)).resolves.toBeTruthy();
    await expect(stat(path.join(checkpointPath, "PG_VERSION"))).resolves.toBeTruthy();
    await expect(stat(lockPath)).resolves.toBeTruthy();
  });

  it("waits for the runtime start lock before entering update maintenance", async () => {
    const root = await createTempRoot();
    const runtimeStartLockPath = resolveDesktopUpdateRuntimeStartLockPath("default", root);
    await mkdir(path.dirname(runtimeStartLockPath), { recursive: true });
    await writeFile(runtimeStartLockPath, "runtime starting\n");

    let acquired = false;
    const lockPromise = createDesktopUpdateMaintenanceLock({
      updateId: "coordinated-update",
      targetVersion: "0.4.7",
      instanceId: "default",
      homeDir: root,
      runtimeStartLockTimeoutMs: 1_000,
    }).then((value) => {
      acquired = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(acquired).toBe(false);

    await rm(runtimeStartLockPath);
    await expect(lockPromise).resolves.toBe(resolveDesktopUpdateMaintenanceLockPath("default", root));
  });

  it("observes candidate readiness and explicit candidate failure", async () => {
    const root = await createTempRoot();
    const readyPath = resolveDesktopUpdateTransactionPath("ready", root);
    const ready = transaction("ready");
    await writeDesktopUpdateTransaction(readyPath, ready);
    setTimeout(() => {
      void writeDesktopUpdateTransaction(readyPath, {
        ...ready,
        phase: "candidate_ready",
        candidateReadyAt: new Date().toISOString(),
      });
    }, 10);

    await expect(waitForDesktopUpdateCandidate(readyPath, { timeoutMs: 500, pollIntervalMs: 5 }))
      .resolves.toMatchObject({ status: "ready" });

    const failedPath = resolveDesktopUpdateTransactionPath("failed", root);
    await writeDesktopUpdateTransaction(failedPath, {
      ...transaction("failed"),
      failure: {
        id: "failure-1",
        occurredAt: "2026-07-16T00:00:05.000Z",
        stage: "database",
        attempt: 1,
        category: "database",
        summary: "The local database did not start cleanly.",
      },
    });
    await expect(waitForDesktopUpdateCandidate(failedPath, { timeoutMs: 50, pollIntervalMs: 5 }))
      .resolves.toMatchObject({ status: "failed" });
  });

  it("requires a live candidate heartbeat throughout the stability window", async () => {
    const root = await createTempRoot();
    const transactionPath = resolveDesktopUpdateTransactionPath("stable", root);
    const heartbeatPath = resolveDesktopUpdateCandidateHeartbeatPath(transactionPath);
    await writeDesktopUpdateTransaction(transactionPath, {
      ...transaction("stable"),
      phase: "candidate_ready",
      candidateReadyAt: new Date().toISOString(),
    });
    fs.writeFileSync(heartbeatPath, `${new Date().toISOString()}\n`);
    const heartbeat = setInterval(() => {
      const tempPath = `${heartbeatPath}.tmp`;
      fs.writeFileSync(tempPath, `${new Date().toISOString()}\n`);
      fs.renameSync(tempPath, heartbeatPath);
    }, 5);

    try {
      await expect(waitForDesktopUpdateCandidateStability(transactionPath, {
        stabilityWindowMs: 80,
        pollIntervalMs: 5,
        maxHeartbeatAgeMs: 100,
      })).resolves.toBe(true);
    } finally {
      clearInterval(heartbeat);
    }
  });

  it("rejects a candidate whose process heartbeat expired", async () => {
    const root = await createTempRoot();
    const transactionPath = resolveDesktopUpdateTransactionPath("expired", root);
    const heartbeatPath = resolveDesktopUpdateCandidateHeartbeatPath(transactionPath);
    await writeDesktopUpdateTransaction(transactionPath, {
      ...transaction("expired"),
      phase: "candidate_ready",
      candidateReadyAt: new Date().toISOString(),
    });
    await writeFile(heartbeatPath, "2026-07-16T00:00:00.000Z\n");

    await expect(waitForDesktopUpdateCandidateStability(transactionPath, {
      stabilityWindowMs: 30,
      pollIntervalMs: 5,
      maxHeartbeatAgeMs: 10,
    })).resolves.toBe(false);
  });

  it("removes transaction-owned recovery artifacts using the exact journal path", async () => {
    const root = await createTempRoot();
    const transactionPath = resolveDesktopUpdateTransactionPath("cleanup", root);
    const backupAppPath = path.join(root, "backup", "Rudder.app");
    const checkpointPath = path.join(root, "checkpoint");
    const heartbeatPath = resolveDesktopUpdateCandidateHeartbeatPath(transactionPath);
    await mkdir(backupAppPath, { recursive: true });
    await mkdir(checkpointPath, { recursive: true });
    await mkdir(path.dirname(heartbeatPath), { recursive: true });
    await writeFile(heartbeatPath, `${new Date().toISOString()}\n`);
    const cleanupTransaction: DesktopUpdateTransaction = {
      ...transaction("cleanup"),
      install: {
        ...transaction("cleanup").install,
        backupAppPath,
      },
      database: {
        mode: "embedded-postgres",
        dataDir: path.join(root, "db"),
        checkpointPath,
      },
    };

    await removeDesktopUpdateRecoveryArtifacts(cleanupTransaction, transactionPath);

    await expect(stat(heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(backupAppPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates and restores a stopped embedded PostgreSQL checkpoint", async () => {
    const root = await createTempRoot();
    const dataDir = path.join(root, "db");
    const checkpoint = path.join(root, "checkpoint");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "PG_VERSION"), "18\n");
    await writeFile(path.join(dataDir, "proof.txt"), "before");

    await expect(createEmbeddedPostgresCheckpoint(dataDir, checkpoint)).resolves.toBe(true);
    await writeFile(path.join(dataDir, "proof.txt"), "after");
    await restoreEmbeddedPostgresCheckpoint(dataDir, checkpoint);

    await expect(readFile(path.join(dataDir, "proof.txt"), "utf8")).resolves.toBe("before");
  });

  it("requires physical app and PostgreSQL snapshots before rollback", async () => {
    const root = await createTempRoot();
    const appPath = path.join(root, "Applications", "Rudder.app");
    const backupAppPath = path.join(root, "backup", "Rudder.app");
    const checkpointPath = path.join(root, "checkpoint");
    await mkdir(appPath, { recursive: true });
    await mkdir(backupAppPath, { recursive: true });
    await mkdir(checkpointPath, { recursive: true });
    await writeFile(path.join(checkpointPath, "PG_VERSION"), "18\n");
    const recoveryTransaction: DesktopUpdateTransaction = {
      ...transaction("physical-artifacts"),
      phase: "backup_ready",
      install: {
        appPath,
        backupAppPath,
        metadataPath: path.join(root, "Applications", ".rudder-desktop-install.json"),
      },
      database: {
        mode: "embedded-postgres",
        dataDir: path.join(root, "db"),
        checkpointPath,
      },
    };

    await expect(inspectDesktopUpdateRecoveryArtifacts(recoveryTransaction)).resolves.toEqual({
      appPresent: true,
      backupAppPresent: true,
      checkpointPresent: true,
    });
    await rm(path.join(checkpointPath, "PG_VERSION"));
    await expect(inspectDesktopUpdateRecoveryArtifacts(recoveryTransaction)).resolves.toEqual({
      appPresent: true,
      backupAppPresent: true,
      checkpointPresent: false,
    });
  });

  it("refuses to checkpoint a live embedded PostgreSQL directory", async () => {
    const root = await createTempRoot();
    const dataDir = path.join(root, "live-db");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "PG_VERSION"), "18\n");
    await writeFile(path.join(dataDir, "postmaster.pid"), "12345\n");

    await expect(createEmbeddedPostgresCheckpoint(dataDir, path.join(root, "checkpoint-live")))
      .rejects.toThrow("still live");
  });

  it.each(["staged", "displaced", "swapped"] as const)(
    "resumes an atomic snapshot restore after a %s-step failure",
    async (failedStep) => {
      const root = await createTempRoot();
      const snapshotPath = path.join(root, "snapshot");
      const destinationPath = path.join(root, "destination");
      await mkdir(snapshotPath, { recursive: true });
      await mkdir(destinationPath, { recursive: true });
      await writeFile(path.join(snapshotPath, "proof.txt"), "last-known-good");
      await writeFile(path.join(destinationPath, "proof.txt"), "candidate");

      await expect(restorePathFromSnapshotAtomically({
        snapshotPath,
        destinationPath,
        operationId: `resume-${failedStep}`,
        onStep: (step) => {
          if (step === failedStep) throw new Error(`injected ${failedStep} failure`);
        },
      })).rejects.toThrow(`injected ${failedStep} failure`);

      await restorePathFromSnapshotAtomically({
        snapshotPath,
        destinationPath,
        operationId: `resume-${failedStep}`,
      });

      await expect(readFile(path.join(destinationPath, "proof.txt"), "utf8"))
        .resolves.toBe("last-known-good");
      await expect(readFile(path.join(snapshotPath, "proof.txt"), "utf8"))
        .resolves.toBe("last-known-good");
    },
  );

  it("quarantines each failed target once", async () => {
    const root = await createTempRoot();
    await quarantineDesktopUpdateTarget({ targetVersion: "0.4.7", failureId: "old", homeDir: root });
    await quarantineDesktopUpdateTarget({ targetVersion: "0.4.7", failureId: "new", homeDir: root });

    const quarantine = JSON.parse(await readFile(resolveDesktopUpdateQuarantinePath(root), "utf8"));
    expect(quarantine.entries).toEqual([
      expect.objectContaining({ targetVersion: "0.4.7", failureId: "new" }),
    ]);
  });
});
