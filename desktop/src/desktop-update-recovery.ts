import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DesktopStartupFailureView } from "./desktop-startup-failure.js";
import { resolveSharedRudderHomeDir } from "./runtime-cache.js";

const TRANSACTION_ARG = "--rudder-update-transaction=";
const RECOVERY_ARG = "--rudder-update-recovery=";

export type DesktopUpdateTransaction = {
  version: 1;
  updateId: string;
  origin: "upgrade" | "fresh_install";
  phase:
    | "prepared"
    | "backup_ready"
    | "candidate_installed"
    | "candidate_ready"
    | "committed"
    | "cancelled"
    | "rollback_pending"
    | "rolled_back"
    | "rollback_failed";
  fromVersion?: string;
  targetVersion: string;
  createdAt: string;
  updatedAt: string;
  install: {
    appPath: string;
    backupAppPath?: string;
    metadataPath: string;
    previousMetadata?: unknown;
  };
  database: {
    mode: "embedded-postgres" | "external-postgres" | "none";
    dataDir?: string;
    checkpointPath?: string;
    restoredAt?: string;
  };
  failure?: DesktopStartupFailureView;
  candidateReadyAt?: string;
  committedAt?: string;
  rollback?: {
    attemptedAt: string;
    completedAt?: string;
    error?: string;
  };
  quarantinedTarget?: string;
  noticeShownAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isDesktopUpdateTransaction(value: unknown): value is DesktopUpdateTransaction {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.updateId !== "string" || typeof value.targetVersion !== "string") return false;
  if (value.origin !== "upgrade" && value.origin !== "fresh_install") return false;
  if (typeof value.phase !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return false;
  }
  if (!isRecord(value.install) || typeof value.install.appPath !== "string" || typeof value.install.metadataPath !== "string") {
    return false;
  }
  return isRecord(value.database) && typeof value.database.mode === "string";
}

export function resolveDesktopUpdateRecoveryRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return path.join(resolveSharedRudderHomeDir(env, homeDir), "desktop-updates");
}

function resolveOwnedTransactionPath(
  rawPath: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string | null {
  if (!rawPath?.trim()) return null;
  const candidate = path.resolve(rawPath.trim());
  const transactionsRoot = path.join(resolveDesktopUpdateRecoveryRoot(env, homeDir), "transactions");
  const relative = path.relative(transactionsRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !candidate.endsWith(".json")) return null;
  return candidate;
}

function resolveTransactionArg(
  prefix: string,
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string | null {
  const rawPath = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return resolveOwnedTransactionPath(rawPath, env, homeDir);
}

export function resolveCandidateUpdateTransactionPath(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string | null {
  return resolveTransactionArg(TRANSACTION_ARG, argv, env, homeDir);
}

export function resolveRollbackIncidentPath(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string | null {
  return resolveTransactionArg(RECOVERY_ARG, argv, env, homeDir);
}

function resolveCandidateFailurePath(transactionPath: string): string {
  return `${transactionPath}.failure.json`;
}

function resolveDecisionLockPath(transactionPath: string): string {
  return `${transactionPath}.decision.lock`;
}

export function readDesktopUpdateTransaction(filePath: string | null): DesktopUpdateTransaction | null {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isDesktopUpdateTransaction(parsed)) return null;
    const failurePath = resolveCandidateFailurePath(filePath);
    if (parsed.failure || !fs.existsSync(failurePath)) return parsed;
    const failure = JSON.parse(fs.readFileSync(failurePath, "utf8")) as unknown;
    if (
      isRecord(failure)
      && typeof failure.id === "string"
      && typeof failure.occurredAt === "string"
      && typeof failure.stage === "string"
      && typeof failure.attempt === "number"
      && typeof failure.category === "string"
      && typeof failure.summary === "string"
    ) {
      return { ...parsed, failure: failure as DesktopStartupFailureView };
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeDesktopUpdateTransaction(filePath: string, transaction: DesktopUpdateTransaction): void {
  const next = { ...transaction, updatedAt: new Date().toISOString() };
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function resolveCandidateHeartbeatPath(transactionPath: string): string {
  return `${transactionPath}.heartbeat`;
}

function writeCandidateHeartbeat(transactionPath: string): void {
  const heartbeatPath = resolveCandidateHeartbeatPath(transactionPath);
  const tempPath = `${heartbeatPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, heartbeatPath);
}

function removeCandidateHeartbeat(transactionPath: string): void {
  fs.rmSync(resolveCandidateHeartbeatPath(transactionPath), { force: true });
}

function writeCandidateFailure(transactionPath: string, failure: DesktopStartupFailureView): void {
  const failurePath = resolveCandidateFailurePath(transactionPath);
  const tempPath = `${failurePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, failurePath);
}

export function markDesktopUpdateCandidateReady(input: {
  transactionPath: string | null;
  appVersion: string;
  runtimeVersion: string;
  enforceAppVersion?: boolean;
}): DesktopUpdateTransaction | null {
  const transaction = readDesktopUpdateTransaction(input.transactionPath);
  if (!transaction || !input.transactionPath) return null;
  if (transaction.phase !== "candidate_installed") return transaction;
  if (
    transaction.targetVersion !== input.runtimeVersion
    || (input.enforceAppVersion !== false && transaction.targetVersion !== input.appVersion)
  ) {
    throw new Error(
      `Update candidate version mismatch: expected ${transaction.targetVersion}, app ${input.appVersion}, runtime ${input.runtimeVersion}.`,
    );
  }
  const next: DesktopUpdateTransaction = {
    ...transaction,
    phase: "candidate_ready",
    candidateReadyAt: new Date().toISOString(),
  };
  writeDesktopUpdateTransaction(input.transactionPath, next);
  return next;
}

export function markDesktopUpdateCandidateFailed(
  transactionPath: string | null,
  failure: DesktopStartupFailureView,
): boolean {
  if (!transactionPath) return false;
  let lockFd: number;
  try {
    lockFd = fs.openSync(resolveDecisionLockPath(transactionPath), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    const transaction = readDesktopUpdateTransaction(transactionPath);
    if (!transaction) return false;
    if (transaction.failure) return true;
    if (!["candidate_installed", "candidate_ready"].includes(transaction.phase)) return false;
    writeCandidateFailure(transactionPath, failure);
    return true;
  } finally {
    fs.closeSync(lockFd);
    fs.rmSync(resolveDecisionLockPath(transactionPath), { force: true });
  }
}

export async function waitForDesktopUpdateCommit(
  transactionPath: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<DesktopUpdateTransaction> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const transaction = readDesktopUpdateTransaction(transactionPath);
    if (
      transaction?.failure
      || transaction?.phase === "rollback_pending"
      || transaction?.phase === "rolled_back"
      || transaction?.phase === "rollback_failed"
    ) {
      removeCandidateHeartbeat(transactionPath);
      throw new Error("The update helper rejected the candidate and started recovery.");
    }
    if (transaction?.phase === "committed") {
      removeCandidateHeartbeat(transactionPath);
      return transaction;
    }
    if (transaction?.phase === "candidate_ready") {
      writeCandidateHeartbeat(transactionPath);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error("The update helper did not commit the candidate before the readiness timeout.");
}

export function readPendingRollbackIncident(
  transactionPath: string | null,
): DesktopUpdateTransaction | null {
  const transaction = readDesktopUpdateTransaction(transactionPath);
  if (!transaction || transaction.phase !== "rolled_back" || transaction.noticeShownAt) return null;
  return transaction;
}

export function findPendingDesktopUpdateRecoveryTransactionPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string | null {
  const transactionsRoot = path.join(resolveDesktopUpdateRecoveryRoot(env, homeDir), "transactions");
  try {
    const candidates = fs.readdirSync(transactionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".failure.json"))
      .flatMap((entry) => {
        const transactionPath = path.join(transactionsRoot, entry.name);
        const transaction = readDesktopUpdateTransaction(transactionPath);
        const backupPath = transaction?.install.backupAppPath;
        const checkpointPath = transaction?.database.checkpointPath;
        const hasCheckpoint = Boolean(
          checkpointPath && fs.existsSync(path.join(checkpointPath, "PG_VERSION")),
        );
        const hasRecoveryArtifacts = Boolean(backupPath && fs.existsSync(backupPath) && hasCheckpoint);
        const canCancelBeforeBackup = Boolean(
          transaction?.phase === "prepared"
          && transaction.install.appPath
          && fs.existsSync(transaction.install.appPath)
          && hasCheckpoint,
        );
        const canRecoverPrepared = Boolean(
          transaction?.phase === "prepared"
          && !fs.existsSync(transaction.install.appPath)
          && hasRecoveryArtifacts,
        );
        return transaction
          && (
            canCancelBeforeBackup
            || canRecoverPrepared
            || (transaction.phase !== "prepared" && hasRecoveryArtifacts)
          )
          && [
            "prepared",
            "backup_ready",
            "candidate_installed",
            "candidate_ready",
            "rollback_pending",
            "rollback_failed",
          ].includes(transaction.phase)
          ? [{ transactionPath, updatedAt: Date.parse(transaction.updatedAt) || 0 }]
          : [];
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return candidates[0]?.transactionPath ?? null;
  } catch {
    return null;
  }
}

export function markRollbackNoticeShown(transactionPath: string, transaction: DesktopUpdateTransaction): void {
  writeDesktopUpdateTransaction(transactionPath, {
    ...transaction,
    noticeShownAt: new Date().toISOString(),
  });
}

export function readQuarantinedDesktopVersions(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): Set<string> {
  const quarantinePath = path.join(resolveDesktopUpdateRecoveryRoot(env, homeDir), "quarantine.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(quarantinePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) return new Set();
    return new Set(parsed.entries.flatMap((entry) => (
      isRecord(entry) && typeof entry.targetVersion === "string" ? [entry.targetVersion] : []
    )));
  } catch {
    return new Set();
  }
}

function displayVersion(version: string | null | undefined): string {
  if (!version) return "unknown";
  return version.startsWith("v") ? version : `v${version}`;
}

export function createRollbackNoticeCopy(transaction: DesktopUpdateTransaction): {
  message: string;
  detail: string;
} {
  const restoredVersion = displayVersion(transaction.fromVersion);
  const failedVersion = displayVersion(transaction.targetVersion);
  return {
    message: `Rudder 已恢复到 ${restoredVersion}`,
    detail:
      `${failedVersion} 未能正常启动，因此 Rudder 已重新打开上一个可用版本。`
      + `你的数据已保留，并且 ${failedVersion} 的更新已暂停。`
      + "您可以继续使用当前版本，等到后续修复该问题的新版本推出后再更新。",
  };
}
