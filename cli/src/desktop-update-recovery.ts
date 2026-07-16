import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveRudderHomeDir } from "./config/home.js";

export const DESKTOP_UPDATE_TRANSACTION_VERSION = 1;
export const DESKTOP_UPDATE_READY_TIMEOUT_MS = 90_000;

export type DesktopUpdateFailureRecord = {
  id: string;
  occurredAt: string;
  stage: string;
  attempt: number;
  category: string;
  summary: string;
};

export type DesktopUpdateTransactionPhase =
  | "prepared"
  | "backup_ready"
  | "candidate_installed"
  | "candidate_ready"
  | "committed"
  | "cancelled"
  | "rollback_pending"
  | "rolled_back"
  | "rollback_failed";

export type DesktopUpdateTransaction = {
  version: 1;
  updateId: string;
  origin: "upgrade" | "fresh_install";
  phase: DesktopUpdateTransactionPhase;
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
  failure?: DesktopUpdateFailureRecord;
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

export type DesktopUpdateQuarantine = {
  version: 1;
  entries: Array<{
    targetVersion: string;
    failedAt: string;
    failureId?: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isDesktopUpdateTransaction(value: unknown): value is DesktopUpdateTransaction {
  if (!isRecord(value) || value.version !== DESKTOP_UPDATE_TRANSACTION_VERSION) return false;
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

export function isResumableDesktopUpdateTransaction(
  transaction: DesktopUpdateTransaction | null,
): transaction is DesktopUpdateTransaction {
  return Boolean(transaction && [
    "prepared",
    "backup_ready",
    "candidate_installed",
    "candidate_ready",
    "rollback_pending",
    "rollback_failed",
  ].includes(transaction.phase));
}

export function resolveDesktopUpdateRecoveryRoot(homeDir = resolveRudderHomeDir()): string {
  return path.resolve(homeDir, "desktop-updates");
}

export function resolveDesktopUpdateTransactionPath(updateId: string, homeDir = resolveRudderHomeDir()): string {
  return path.join(resolveDesktopUpdateRecoveryRoot(homeDir), "transactions", `${updateId}.json`);
}

export async function hasResumableDesktopUpdateRecoveryTransaction(
  updateId: string,
  homeDir = resolveRudderHomeDir(),
): Promise<boolean> {
  return isResumableDesktopUpdateTransaction(
    await readDesktopUpdateTransaction(resolveDesktopUpdateTransactionPath(updateId, homeDir)),
  );
}

export function resolveOwnedDesktopUpdateTransactionPath(
  transactionPath: string,
  homeDir = resolveRudderHomeDir(),
): string | null {
  const candidate = path.resolve(transactionPath);
  const transactionsRoot = path.join(resolveDesktopUpdateRecoveryRoot(homeDir), "transactions");
  const relative = path.relative(transactionsRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !candidate.endsWith(".json")) return null;
  return candidate;
}

export function resolveDesktopUpdateCandidateHeartbeatPath(transactionPath: string): string {
  return `${transactionPath}.heartbeat`;
}

export function resolveDesktopUpdateCandidateFailurePath(transactionPath: string): string {
  return `${transactionPath}.failure.json`;
}

export function resolveDesktopUpdateDecisionLockPath(transactionPath: string): string {
  return `${transactionPath}.decision.lock`;
}

export async function withDesktopUpdateDecisionLock<T>(
  transactionPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = resolveDesktopUpdateDecisionLockPath(transactionPath);
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return await task();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export function resolveDesktopUpdateQuarantinePath(homeDir = resolveRudderHomeDir()): string {
  return path.join(resolveDesktopUpdateRecoveryRoot(homeDir), "quarantine.json");
}

export function resolveDesktopUpdateMaintenanceLockPath(
  instanceId: string,
  homeDir = resolveRudderHomeDir(),
): string {
  return path.join(path.resolve(homeDir, "instances", instanceId), "desktop-update-maintenance.json");
}

export function resolveDesktopUpdateRuntimeStartLockPath(
  instanceId: string,
  homeDir = resolveRudderHomeDir(),
): string {
  return path.join(path.resolve(homeDir, "instances", instanceId), "runtime", "start.lock");
}

export async function createDesktopUpdateMaintenanceLock(input: {
  updateId: string;
  targetVersion: string;
  instanceId: string;
  homeDir?: string;
  runtimeStartLockTimeoutMs?: number;
}): Promise<string> {
  const lockPath = resolveDesktopUpdateMaintenanceLockPath(input.instanceId, input.homeDir);
  const runtimeStartLockPath = resolveDesktopUpdateRuntimeStartLockPath(input.instanceId, input.homeDir);
  const timeoutMs = input.runtimeStartLockTimeoutMs ?? 60_000;
  const startedAt = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    if (await pathExists(runtimeStartLockPath)) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out waiting for the local runtime startup lock before Desktop update maintenance.");
      }
      await delay(50);
      continue;
    }

    let created = false;
    try {
      const handle = await open(lockPath, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify({
          version: 1,
          updateId: input.updateId,
          targetVersion: input.targetVersion,
          createdAt: new Date().toISOString(),
        }, null, 2)}\n`);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(lockPath, "utf8").catch(() => "null")) as unknown;
      if (!isRecord(existing) || existing.updateId !== input.updateId) {
        throw new Error("Another Desktop update recovery transaction already owns this instance.");
      }
    }

    if (!(await pathExists(runtimeStartLockPath))) return lockPath;
    if (created) await removeDesktopUpdateMaintenanceLock(lockPath, input.updateId);
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for the local runtime startup lock before Desktop update maintenance.");
    }
    await delay(50);
  }
}

export async function removeDesktopUpdateMaintenanceLock(
  lockPath: string,
  updateId: string,
): Promise<void> {
  const existing = JSON.parse(await readFile(lockPath, "utf8").catch(() => "null")) as unknown;
  if (isRecord(existing) && existing.updateId === updateId) {
    await rm(lockPath, { force: true });
  }
}

export function resolveDesktopUpdateBackupPath(input: {
  updateId: string;
  installRoot: string;
  appName: string;
  homeDir?: string;
}): string {
  const installId = createHash("sha256").update(path.resolve(input.installRoot)).digest("hex").slice(0, 16);
  return path.join(
    resolveDesktopUpdateRecoveryRoot(input.homeDir),
    "backups",
    installId,
    input.updateId,
    input.appName,
  );
}

export function resolveDesktopUpdateCheckpointPath(input: {
  updateId: string;
  instanceId: string;
  homeDir?: string;
}): string {
  return path.join(
    resolveDesktopUpdateRecoveryRoot(input.homeDir),
    "checkpoints",
    input.instanceId,
    input.updateId,
    "db",
  );
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function readDesktopUpdateTransaction(filePath: string): Promise<DesktopUpdateTransaction | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isDesktopUpdateTransaction(parsed)) return null;
    const failure = JSON.parse(
      await readFile(resolveDesktopUpdateCandidateFailurePath(filePath), "utf8").catch(() => "null"),
    ) as unknown;
    if (
      !parsed.failure
      && isRecord(failure)
      && typeof failure.id === "string"
      && typeof failure.occurredAt === "string"
      && typeof failure.stage === "string"
      && typeof failure.attempt === "number"
      && typeof failure.category === "string"
      && typeof failure.summary === "string"
    ) {
      return { ...parsed, failure: failure as DesktopUpdateFailureRecord };
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeDesktopUpdateTransaction(
  filePath: string,
  transaction: DesktopUpdateTransaction,
): Promise<void> {
  await atomicWriteJson(filePath, transaction);
}

export async function updateDesktopUpdateTransaction(
  filePath: string,
  update: (current: DesktopUpdateTransaction) => DesktopUpdateTransaction,
): Promise<DesktopUpdateTransaction> {
  const current = await readDesktopUpdateTransaction(filePath);
  if (!current) throw new Error(`Desktop update transaction is missing or invalid at ${filePath}.`);
  const next = update(current);
  await writeDesktopUpdateTransaction(filePath, { ...next, updatedAt: new Date().toISOString() });
  return next;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export type DesktopUpdateRecoveryArtifacts = {
  appPresent: boolean;
  backupAppPresent: boolean;
  checkpointPresent: boolean;
};

async function isDirectory(filePath: string | undefined): Promise<boolean> {
  if (!filePath) return false;
  return (await stat(filePath).catch(() => null))?.isDirectory() === true;
}

async function isFile(filePath: string | undefined): Promise<boolean> {
  if (!filePath) return false;
  return (await stat(filePath).catch(() => null))?.isFile() === true;
}

export async function inspectDesktopUpdateRecoveryArtifacts(
  transaction: DesktopUpdateTransaction,
): Promise<DesktopUpdateRecoveryArtifacts> {
  return {
    appPresent: await isDirectory(transaction.install.appPath),
    backupAppPresent: await isDirectory(transaction.install.backupAppPath),
    checkpointPresent: transaction.database.mode === "embedded-postgres"
      && await isFile(
        transaction.database.checkpointPath
          ? path.join(transaction.database.checkpointPath, "PG_VERSION")
          : undefined,
      ),
  };
}

export async function createEmbeddedPostgresCheckpoint(dataDir: string, checkpointPath: string): Promise<boolean> {
  if (!(await pathExists(path.join(dataDir, "PG_VERSION")))) return false;
  if (await pathExists(path.join(dataDir, "postmaster.pid"))) {
    throw new Error("The embedded PostgreSQL data directory is still live; refusing to create an update checkpoint.");
  }
  await rm(checkpointPath, { recursive: true, force: true });
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await cp(dataDir, checkpointPath, { recursive: true, verbatimSymlinks: true });
  return true;
}

export async function restoreEmbeddedPostgresCheckpoint(dataDir: string, checkpointPath: string): Promise<void> {
  if (!(await pathExists(path.join(checkpointPath, "PG_VERSION")))) {
    throw new Error("The pre-update PostgreSQL checkpoint is missing or incomplete.");
  }
  await restorePathFromSnapshotAtomically({
    snapshotPath: checkpointPath,
    destinationPath: dataDir,
    operationId: path.basename(path.dirname(checkpointPath)),
  });
}

export type RestoreSnapshotStep = "staged" | "displaced" | "swapped";

function resolveRestoreSwapPaths(destinationPath: string, operationId: string) {
  const destination = path.resolve(destinationPath);
  const key = createHash("sha256").update(operationId).digest("hex").slice(0, 16);
  const prefix = path.join(path.dirname(destination), `.${path.basename(destination)}.rudder-restore-${key}`);
  return {
    destination,
    staging: `${prefix}.staging`,
    previous: `${prefix}.previous`,
    ready: `${prefix}.ready`,
  };
}

export async function restorePathFromSnapshotAtomically(input: {
  snapshotPath: string;
  destinationPath: string;
  operationId: string;
  onStep?: (step: RestoreSnapshotStep) => Promise<void> | void;
}): Promise<void> {
  const snapshotPath = path.resolve(input.snapshotPath);
  const paths = resolveRestoreSwapPaths(input.destinationPath, input.operationId);
  if (!(await pathExists(snapshotPath))) throw new Error(`Recovery snapshot is missing at ${snapshotPath}.`);
  await mkdir(path.dirname(paths.destination), { recursive: true });

  if (
    await pathExists(paths.destination)
    && await pathExists(paths.previous)
    && !(await pathExists(paths.staging))
    && await pathExists(paths.ready)
  ) {
    await rm(paths.previous, { recursive: true, force: true });
    await rm(paths.ready, { force: true });
    return;
  }

  try {
    if (!(await pathExists(paths.ready))) {
      await rm(paths.staging, { recursive: true, force: true });
      await cp(snapshotPath, paths.staging, { recursive: true, verbatimSymlinks: true });
      await writeFile(paths.ready, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
    }
    await input.onStep?.("staged");

    if (await pathExists(paths.destination)) {
      if (await pathExists(paths.previous)) {
        throw new Error(`Recovery swap already has a displaced destination at ${paths.previous}.`);
      }
      await rename(paths.destination, paths.previous);
    }
    await input.onStep?.("displaced");

    await rename(paths.staging, paths.destination);
    await input.onStep?.("swapped");
    await rm(paths.previous, { recursive: true, force: true });
    await rm(paths.ready, { force: true });
  } catch (error) {
    if (!(await pathExists(paths.destination)) && await pathExists(paths.previous)) {
      try {
        await rename(paths.previous, paths.destination);
        await rm(paths.staging, { recursive: true, force: true });
        await rm(paths.ready, { force: true });
      } catch {
        // Preserve swap artifacts so the same transaction can resume.
      }
    }
    throw error;
  }
}

export async function waitForDesktopUpdateCandidate(
  transactionPath: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<{ status: "ready"; transaction: DesktopUpdateTransaction } | { status: "failed" | "timeout"; transaction: DesktopUpdateTransaction | null }> {
  const timeoutMs = options.timeoutMs ?? DESKTOP_UPDATE_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const transaction = await readDesktopUpdateTransaction(transactionPath);
    if (transaction?.phase === "candidate_ready") return { status: "ready", transaction };
    if (transaction?.failure) return { status: "failed", transaction };
    await delay(pollIntervalMs);
  }
  return { status: "timeout", transaction: await readDesktopUpdateTransaction(transactionPath) };
}

export async function waitForDesktopUpdateCandidateStability(
  transactionPath: string,
  options: { stabilityWindowMs?: number; pollIntervalMs?: number; maxHeartbeatAgeMs?: number } = {},
): Promise<boolean> {
  const stabilityWindowMs = options.stabilityWindowMs ?? 1_500;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const maxHeartbeatAgeMs = options.maxHeartbeatAgeMs ?? 500;
  const startedAt = Date.now();
  let observedHeartbeat = false;
  const heartbeatPath = resolveDesktopUpdateCandidateHeartbeatPath(transactionPath);
  while (Date.now() - startedAt < stabilityWindowMs) {
    const transaction = await readDesktopUpdateTransaction(transactionPath);
    if (!transaction || transaction.phase !== "candidate_ready" || transaction.failure) return false;
    const heartbeatAt = Date.parse((await readFile(heartbeatPath, "utf8").catch(() => "")).trim());
    if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= maxHeartbeatAgeMs) observedHeartbeat = true;
    await delay(pollIntervalMs);
  }
  const transaction = await readDesktopUpdateTransaction(transactionPath);
  const heartbeatAt = Date.parse((await readFile(heartbeatPath, "utf8").catch(() => "")).trim());
  return Boolean(
    observedHeartbeat
    && transaction?.phase === "candidate_ready"
    && !transaction.failure
    && Number.isFinite(heartbeatAt)
    && Date.now() - heartbeatAt <= maxHeartbeatAgeMs,
  );
}

async function readQuarantine(filePath: string): Promise<DesktopUpdateQuarantine> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("invalid");
    const entries = parsed.entries.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.targetVersion !== "string" || typeof entry.failedAt !== "string") return [];
      return [{
        targetVersion: entry.targetVersion,
        failedAt: entry.failedAt,
        ...(typeof entry.failureId === "string" ? { failureId: entry.failureId } : {}),
      }];
    });
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

export async function quarantineDesktopUpdateTarget(input: {
  targetVersion: string;
  failedAt?: string;
  failureId?: string;
  homeDir?: string;
}): Promise<void> {
  const filePath = resolveDesktopUpdateQuarantinePath(input.homeDir);
  const current = await readQuarantine(filePath);
  const entries = current.entries.filter((entry) => entry.targetVersion !== input.targetVersion);
  entries.push({
    targetVersion: input.targetVersion,
    failedAt: input.failedAt ?? new Date().toISOString(),
    ...(input.failureId ? { failureId: input.failureId } : {}),
  });
  await atomicWriteJson(filePath, { version: 1, entries: entries.slice(-20) });
}

export async function removeDesktopUpdateRecoveryArtifacts(
  transaction: DesktopUpdateTransaction,
  transactionPath = resolveDesktopUpdateTransactionPath(transaction.updateId),
): Promise<void> {
  const targets = [
    transaction.install.backupAppPath,
    transaction.database.checkpointPath,
    resolveDesktopUpdateCandidateHeartbeatPath(transactionPath),
    resolveDesktopUpdateCandidateFailurePath(transactionPath),
    resolveDesktopUpdateDecisionLockPath(transactionPath),
  ].filter(Boolean) as string[];
  for (const target of targets) {
    const stats = await stat(target).catch(() => null);
    if (stats) await rm(target, { recursive: true, force: true });
  }
}
