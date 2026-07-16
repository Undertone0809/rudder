import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRollbackNoticeCopy,
  findPendingDesktopUpdateRecoveryTransactionPath,
  markDesktopUpdateCandidateFailed,
  markDesktopUpdateCandidateReady,
  markRollbackNoticeShown,
  readDesktopUpdateTransaction,
  readPendingRollbackIncident,
  readQuarantinedDesktopVersions,
  resolveCandidateUpdateTransactionPath,
  resolveRollbackIncidentPath,
  waitForDesktopUpdateCommit,
  type DesktopUpdateTransaction,
} from "./desktop-update-recovery.js";

const roots: string[] = [];

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-desktop-update."));
  roots.push(root);
  fs.mkdirSync(path.join(root, "desktop-updates", "transactions"), { recursive: true });
  return root;
}

function createTransaction(root: string, patch: Partial<DesktopUpdateTransaction> = {}) {
  const transaction: DesktopUpdateTransaction = {
    version: 1,
    updateId: "update-1",
    origin: "upgrade",
    phase: "candidate_installed",
    fromVersion: "0.4.6",
    targetVersion: "0.4.7",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    install: { appPath: "/Applications/Rudder.app", metadataPath: "/Applications/.rudder-desktop-install.json" },
    database: { mode: "embedded-postgres", dataDir: "/tmp/db", checkpointPath: "/tmp/checkpoint" },
    ...patch,
  };
  const transactionPath = path.join(root, "desktop-updates", "transactions", `${transaction.updateId}.json`);
  fs.writeFileSync(transactionPath, JSON.stringify(transaction));
  return { transaction, transactionPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("desktop update recovery", () => {
  it("accepts only Rudder-owned transaction paths", () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root);
    const env = { RUDDER_HOME: root };

    expect(resolveCandidateUpdateTransactionPath([`--rudder-update-transaction=${transactionPath}`], env))
      .toBe(transactionPath);
    expect(resolveRollbackIncidentPath([`--rudder-update-recovery=${transactionPath}`], env))
      .toBe(transactionPath);
    expect(resolveCandidateUpdateTransactionPath(["--rudder-update-transaction=/tmp/foreign.json"], env))
      .toBeNull();
  });

  it("marks readiness only for exact app and runtime versions", () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root);

    expect(() => markDesktopUpdateCandidateReady({
      transactionPath,
      appVersion: "0.4.7",
      runtimeVersion: "0.4.6",
    })).toThrow("version mismatch");

    expect(markDesktopUpdateCandidateReady({
      transactionPath,
      appVersion: "0.4.7",
      runtimeVersion: "0.4.7",
    })).toMatchObject({ phase: "candidate_ready" });
  });

  it("does not mark readiness before candidate installation is durable", () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root, { phase: "backup_ready" });

    expect(markDesktopUpdateCandidateReady({
      transactionPath,
      appVersion: "0.4.7",
      runtimeVersion: "0.4.7",
    })).toMatchObject({ phase: "backup_ready" });
    expect(readDesktopUpdateTransaction(transactionPath)?.phase).toBe("backup_ready");
  });

  it("persists a bounded startup failure for the supervising helper", () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root);
    markDesktopUpdateCandidateFailed(transactionPath, {
      id: "failure-1",
      occurredAt: "2026-07-16T00:00:05.000Z",
      stage: "database",
      attempt: 1,
      category: "database",
      summary: "The local database did not start cleanly.",
    });

    expect(readDesktopUpdateTransaction(transactionPath)?.failure).toMatchObject({
      id: "failure-1",
      stage: "database",
    });
  });

  it("records a probation renderer failure without racing the committed journal", () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root, { phase: "candidate_ready" });
    markDesktopUpdateCandidateFailed(transactionPath, {
      id: "renderer-failure",
      occurredAt: "2026-07-16T00:00:05.000Z",
      stage: "renderer",
      attempt: 1,
      category: "runtime",
      summary: "The candidate renderer exited before commit.",
    });

    expect(readDesktopUpdateTransaction(transactionPath)?.failure?.id).toBe("renderer-failure");
    expect(JSON.parse(fs.readFileSync(transactionPath, "utf8"))).not.toHaveProperty("failure");
    expect(JSON.parse(fs.readFileSync(`${transactionPath}.failure.json`, "utf8"))).toMatchObject({
      id: "renderer-failure",
      stage: "renderer",
    });
  });

  it("does not reject the candidate window when the commit decision owns the lock", () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root, { phase: "candidate_ready" });
    fs.writeFileSync(`${transactionPath}.decision.lock`, "commit in progress\n");

    expect(markDesktopUpdateCandidateFailed(transactionPath, {
      id: "renderer-failure",
      occurredAt: "2026-07-16T00:00:05.000Z",
      stage: "renderer",
      attempt: 1,
      category: "runtime",
      summary: "The candidate renderer exited while commit owned the decision.",
    })).toBe(false);
    expect(fs.existsSync(`${transactionPath}.failure.json`)).toBe(false);
  });

  it("waits for the helper commit before exposing the candidate", async () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root, { phase: "candidate_ready" });
    setTimeout(() => {
      const current = readDesktopUpdateTransaction(transactionPath)!;
      fs.writeFileSync(transactionPath, JSON.stringify({
        ...current,
        phase: "committed",
        committedAt: new Date().toISOString(),
      }));
    }, 10);

    await expect(waitForDesktopUpdateCommit(transactionPath, { timeoutMs: 500, pollIntervalMs: 5 }))
      .resolves.toMatchObject({ phase: "committed" });
    expect(readDesktopUpdateTransaction(transactionPath)?.phase).toBe("committed");
    expect(fs.existsSync(`${transactionPath}.heartbeat`)).toBe(false);
  });

  it("rejects a committed journal when a pre-decision failure sidecar exists", async () => {
    const root = createRoot();
    const { transactionPath } = createTransaction(root, { phase: "committed" });
    fs.writeFileSync(`${transactionPath}.failure.json`, JSON.stringify({
      id: "failure-before-commit",
      occurredAt: "2026-07-16T00:00:05.000Z",
      stage: "renderer",
      attempt: 1,
      category: "runtime",
      summary: "The candidate renderer failed before commit.",
    }));

    await expect(waitForDesktopUpdateCommit(transactionPath, { timeoutMs: 50, pollIntervalMs: 5 }))
      .rejects.toThrow("rejected the candidate");
  });

  it("finds the newest rollback transaction that still needs resume", () => {
    const root = createRoot();
    const backupAppPath = path.join(root, "recovery", "Rudder-last-known-good.app");
    const checkpointPath = path.join(root, "recovery", "db-checkpoint");
    fs.mkdirSync(backupAppPath, { recursive: true });
    fs.mkdirSync(checkpointPath, { recursive: true });
    fs.writeFileSync(path.join(checkpointPath, "PG_VERSION"), "18\n");
    createTransaction(root, {
      updateId: "older-pending",
      phase: "rollback_pending",
      updatedAt: "2026-07-16T00:00:01.000Z",
    });
    createTransaction(root, {
      updateId: "newer-failed",
      phase: "rollback_failed",
      updatedAt: "2026-07-16T00:00:02.000Z",
    });
    const interruptedCandidate = createTransaction(root, {
      updateId: "interrupted-candidate",
      phase: "candidate_ready",
      updatedAt: "2026-07-16T00:00:04.000Z",
      install: {
        appPath: "/Applications/Rudder.app",
        backupAppPath,
        metadataPath: "/Applications/.rudder-desktop-install.json",
      },
      database: {
        mode: "embedded-postgres",
        dataDir: "/tmp/rudder-db",
        checkpointPath,
      },
    });
    createTransaction(root, {
      updateId: "already-committed",
      phase: "committed",
      updatedAt: "2026-07-16T00:00:05.000Z",
    });

    expect(findPendingDesktopUpdateRecoveryTransactionPath({ RUDDER_HOME: root }))
      .toBe(interruptedCandidate.transactionPath);
  });

  it("resumes a prepared journal as a safe cancellation when the old app is still present", () => {
    const root = createRoot();
    const appPath = path.join(root, "Applications", "Rudder.app");
    const checkpointPath = path.join(root, "recovery", "db-checkpoint");
    fs.mkdirSync(appPath, { recursive: true });
    fs.mkdirSync(checkpointPath, { recursive: true });
    fs.writeFileSync(path.join(checkpointPath, "PG_VERSION"), "18\n");
    const prepared = createTransaction(root, {
      phase: "prepared",
      install: {
        appPath,
        backupAppPath: path.join(root, "recovery", "missing-backup.app"),
        metadataPath: path.join(root, "Applications", ".rudder-desktop-install.json"),
      },
      database: {
        mode: "embedded-postgres",
        dataDir: path.join(root, "db"),
        checkpointPath,
      },
    });

    expect(findPendingDesktopUpdateRecoveryTransactionPath({ RUDDER_HOME: root }))
      .toBe(prepared.transactionPath);
  });

  it("resumes a prepared journal as rollback only after the physical backup exists", () => {
    const root = createRoot();
    const backupAppPath = path.join(root, "recovery", "Rudder-last-known-good.app");
    const checkpointPath = path.join(root, "recovery", "db-checkpoint");
    fs.mkdirSync(backupAppPath, { recursive: true });
    fs.mkdirSync(checkpointPath, { recursive: true });
    fs.writeFileSync(path.join(checkpointPath, "PG_VERSION"), "18\n");
    const prepared = createTransaction(root, {
      phase: "prepared",
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

    expect(findPendingDesktopUpdateRecoveryTransactionPath({ RUDDER_HOME: root }))
      .toBe(prepared.transactionPath);
  });

  it("fails closed when a pending rollback has no complete physical snapshots", () => {
    const root = createRoot();
    createTransaction(root, {
      phase: "candidate_ready",
      install: {
        appPath: path.join(root, "Applications", "Rudder.app"),
        backupAppPath: path.join(root, "recovery", "missing-backup.app"),
        metadataPath: path.join(root, "Applications", ".rudder-desktop-install.json"),
      },
      database: {
        mode: "embedded-postgres",
        dataDir: path.join(root, "db"),
        checkpointPath: path.join(root, "recovery", "missing-checkpoint"),
      },
    });

    expect(findPendingDesktopUpdateRecoveryTransactionPath({ RUDDER_HOME: root })).toBeNull();
  });

  it("does not resume a fresh install that has no last-known-good artifacts", () => {
    const root = createRoot();
    createTransaction(root, {
      origin: "fresh_install",
      phase: "candidate_ready",
      install: {
        appPath: "/Applications/Rudder.app",
        metadataPath: "/Applications/.rudder-desktop-install.json",
      },
      database: { mode: "none" },
    });

    expect(findPendingDesktopUpdateRecoveryTransactionPath({ RUDDER_HOME: root })).toBeNull();
  });

  it("shows a rolled-back incident once with the approved recovery copy", () => {
    const root = createRoot();
    const { transaction, transactionPath } = createTransaction(root, {
      phase: "rolled_back",
      failure: {
        id: "failure-1",
        occurredAt: "2026-07-16T00:00:05.000Z",
        stage: "database",
        attempt: 1,
        category: "database",
        summary: "The local database did not start cleanly.",
      },
    });

    const incident = readPendingRollbackIncident(transactionPath);
    expect(createRollbackNoticeCopy(incident!)).toEqual({
      message: "Rudder 已恢复到 v0.4.6",
      detail:
        "v0.4.7 未能正常启动，因此 Rudder 已重新打开上一个可用版本。你的数据已保留，并且 v0.4.7 的更新已暂停。"
        + "您可以继续使用当前版本，等到后续修复该问题的新版本推出后再更新。",
    });
    markRollbackNoticeShown(transactionPath, transaction);
    expect(readPendingRollbackIncident(transactionPath)).toBeNull();
  });

  it("reads the failed-version quarantine", () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, "desktop-updates", "quarantine.json"), JSON.stringify({
      version: 1,
      entries: [{ targetVersion: "0.4.7", failedAt: "2026-07-16T00:00:05.000Z" }],
    }));

    expect(readQuarantinedDesktopVersions({ RUDDER_HOME: root })).toEqual(new Set(["0.4.7"]));
  });
});
