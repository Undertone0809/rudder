import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DESKTOP_AUTO_UPDATE_STATE_VERSION = 1;
export const DESKTOP_AUTO_UPDATE_INITIAL_DELAY_MS = 5_000;
export const DESKTOP_AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1_000;

export type DesktopAutoUpdateTargetIdentity = {
  channel: "stable" | "canary";
  version: string;
  platform: "darwin";
  arch: string;
  installId: string;
  profile: string;
  instanceId: string;
  sourceReleaseDigest: string;
};

export type DesktopAutoUpdateCandidate = DesktopAutoUpdateTargetIdentity & {
  updateId: string;
  assetName?: string;
  assetChecksum?: string;
  /** Exact immutable staged payload selected for this transaction. */
  stagedArtifactPath?: string;
  stagedArtifactDigest?: string;
  stagedAt: string;
  status: "staged" | "claimed" | "applying" | "committed" | "quarantined";
  generation: number;
};

export type DesktopAutoUpdatePreparation = {
  updateId: string;
  channel: "stable" | "canary";
  version: string;
  ownerPid: number;
  childPid?: number;
  startedAt: string;
};

export type DesktopAutoUpdateState = {
  version: typeof DESKTOP_AUTO_UPDATE_STATE_VERSION;
  generation: number;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  candidate: DesktopAutoUpdateCandidate | null;
  preparation: DesktopAutoUpdatePreparation | null;
  recoveryRequired: boolean;
  recoveryCode?: string;
  acceptedPolicySequence: number;
};

export function resolveDesktopAutoUpdateStatePath(userDataPath: string): string {
  return path.join(userDataPath, "desktop-auto-update.json");
}

export function createInitialDesktopAutoUpdateState(): DesktopAutoUpdateState {
  return {
    version: DESKTOP_AUTO_UPDATE_STATE_VERSION,
    generation: 0,
    lastCheckAt: null,
    nextCheckAt: null,
    candidate: null,
    preparation: null,
    recoveryRequired: false,
    acceptedPolicySequence: -1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseCandidate(value: unknown): DesktopAutoUpdateCandidate {
  if (!isRecord(value)) throw new Error("Rudder automatic update candidate is invalid; recovery is required.");
  const status = value.status;
  if (
    (value.channel !== "stable" && value.channel !== "canary")
    || typeof value.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)
    || value.platform !== "darwin"
    || typeof value.arch !== "string"
    || typeof value.installId !== "string"
    || !path.isAbsolute(value.installId)
    || typeof value.profile !== "string"
    || typeof value.instanceId !== "string"
    || typeof value.sourceReleaseDigest !== "string"
    || typeof value.updateId !== "string"
    || value.updateId.length < 8
    || typeof value.stagedAt !== "string"
    || !Number.isSafeInteger(value.generation)
    || (typeof value.generation === "number" && value.generation < 0)
    || !["staged", "claimed", "applying", "committed", "quarantined"].includes(String(status))
    || (value.assetName !== undefined && (typeof value.assetName !== "string" || value.assetName.includes("/")))
    || (value.assetChecksum !== undefined && !isSha256Digest(value.assetChecksum))
    || (value.stagedArtifactPath !== undefined && (typeof value.stagedArtifactPath !== "string" || !path.isAbsolute(value.stagedArtifactPath)))
    || (value.stagedArtifactDigest !== undefined && !isSha256Digest(value.stagedArtifactDigest))
  ) {
    throw new Error("Rudder automatic update candidate is invalid; recovery is required.");
  }
  return value as unknown as DesktopAutoUpdateCandidate;
}

function parsePreparation(value: unknown): DesktopAutoUpdatePreparation {
  if (!isRecord(value)) throw new Error("Rudder automatic update preparation is invalid; recovery is required.");
  if (
    typeof value.updateId !== "string"
    || value.updateId.length < 8
    || (value.channel !== "stable" && value.channel !== "canary")
    || typeof value.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)
    || typeof value.ownerPid !== "number"
    || !Number.isSafeInteger(value.ownerPid)
    || value.ownerPid <= 0
    || (value.childPid !== undefined && (typeof value.childPid !== "number" || !Number.isSafeInteger(value.childPid) || value.childPid <= 0))
    || typeof value.startedAt !== "string"
  ) {
    throw new Error("Rudder automatic update preparation is invalid; recovery is required.");
  }
  return value as unknown as DesktopAutoUpdatePreparation;
}

export function readDesktopAutoUpdateState(statePath: string): DesktopAutoUpdateState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== DESKTOP_AUTO_UPDATE_STATE_VERSION) throw new Error("Rudder automatic update state is invalid; recovery is required.");
    return {
      version: DESKTOP_AUTO_UPDATE_STATE_VERSION,
      generation: typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && parsed.generation >= 0 ? parsed.generation : 0,
      lastCheckAt: typeof parsed.lastCheckAt === "string" ? parsed.lastCheckAt : null,
      nextCheckAt: typeof parsed.nextCheckAt === "string" ? parsed.nextCheckAt : null,
      candidate: parsed.candidate === null || parsed.candidate === undefined
        ? null
        : parseCandidate(parsed.candidate),
      preparation: parsed.preparation === null || parsed.preparation === undefined
        ? null
        : parsePreparation(parsed.preparation),
      recoveryRequired: parsed.recoveryRequired === true,
      acceptedPolicySequence:
        typeof parsed.acceptedPolicySequence === "number"
        && Number.isSafeInteger(parsed.acceptedPolicySequence)
        ? parsed.acceptedPolicySequence
        : -1,
      ...(typeof parsed.recoveryCode === "string" ? { recoveryCode: parsed.recoveryCode } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return createInitialDesktopAutoUpdateState();
    throw new Error("Rudder automatic update state is unreadable; recovery is required.");
  }
}

export function acceptAutomaticUpdatePolicySequence(
  state: DesktopAutoUpdateState,
  sequence: number,
): DesktopAutoUpdateState {
  if (!Number.isSafeInteger(sequence) || sequence <= state.acceptedPolicySequence) {
    throw new Error("Automatic update policy sequence is stale or invalid.");
  }
  return {
    ...state,
    generation: state.generation + 1,
    acceptedPolicySequence: sequence,
  };
}

/**
 * Advance the accepted policy sequence while holding a short-lived install
 * scoped lock. Policy refresh can happen from a network callback while a
 * second Desktop process is still shutting down; reading and writing without
 * this compare-and-swap would allow an older sequence to win the race.
 */
export function acceptAutomaticUpdatePolicySequenceAtPath(
  statePath: string,
  sequence: number,
): DesktopAutoUpdateState {
  // Policy acceptance and helper reconciliation mutate the same durable JSON;
  // use the shared install-scoped lock so neither writer can restore an older
  // accepted sequence while clearing a terminal candidate.
  const lockPath = `${statePath}.claim.lock`;
  return withAutomaticFileLock(lockPath, "policy sequence", () => {
    const current = readDesktopAutoUpdateState(statePath);
    const accepted = acceptAutomaticUpdatePolicySequence(current, sequence);
    writeDesktopAutoUpdateState(statePath, accepted);
    return accepted;
  });
}

export function writeDesktopAutoUpdateState(statePath: string, state: DesktopAutoUpdateState): void {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, statePath);
  try {
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch {
    // Some macOS filesystem providers do not allow fsync on directories. The
    // atomic rename is still required; unsupported directory fsync is fail-open
    // only for durability, never for identity or authorization.
  }
}

/**
 * Serialize install-scoped claim mutations across multiple Desktop processes.
 * The critical section must stay synchronous and small: it only reads/writes
 * the durable state and the immutable helper request.
 */
export function withAutomaticUpdateStateLock<T>(statePath: string, callback: () => T): T {
  const lockPath = `${statePath}.claim.lock`;
  return withAutomaticFileLock(lockPath, "claim", callback);
}

const AUTOMATIC_LOCK_TIMEOUT_MS = 5_000;

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function reclaimStaleAutomaticLock(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < AUTOMATIC_LOCK_TIMEOUT_MS) return false;
    let ownerPid: number | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
      ownerPid = typeof parsed.pid === "number" ? parsed.pid : null;
    } catch {
      // A crashed writer can leave an empty/truncated lock. Age is the only
      // available signal in that case, so reclaim it after the bounded grace.
    }
    if (ownerPid !== null && processIsAlive(ownerPid)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT";
  }
}

function withAutomaticFileLock<T>(lockPath: string, label: string, callback: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let descriptor: number | null = null;
  const startedAt = Date.now();
  try {
    while (descriptor === null) {
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        const payload = Buffer.from(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        fs.writeSync(descriptor, payload, 0, payload.length, 0);
        fs.fsyncSync(descriptor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
        if (reclaimStaleAutomaticLock(lockPath)) continue;
        if (Date.now() - startedAt > AUTOMATIC_LOCK_TIMEOUT_MS) throw new Error(`Automatic update ${label} lock timed out.`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return callback();
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(lockPath); } catch { /* a stale lock may have been cleaned by another process */ }
  }
}

export function scheduleNextAutomaticCheck(state: DesktopAutoUpdateState, now: Date): DesktopAutoUpdateState {
  const nowMs = now.getTime();
  const lastCheckMs = state.lastCheckAt ? Date.parse(state.lastCheckAt) : Number.NaN;
  // Keep the hourly slot anchored to the durable check time. This prevents a
  // restart, sleep wake, or wall-clock rollback from turning every launch into
  // a fresh five-second check or creating a catch-up storm.
  const nextMs = Number.isFinite(lastCheckMs)
    ? lastCheckMs + DESKTOP_AUTO_UPDATE_INTERVAL_MS
    : nowMs + DESKTOP_AUTO_UPDATE_INITIAL_DELAY_MS;
  return {
    ...state,
    nextCheckAt: new Date(nextMs).toISOString(),
  };
}

export function shouldRunAutomaticCheck(state: DesktopAutoUpdateState, now: Date): boolean {
  if (state.recoveryRequired || !state.nextCheckAt) return false;
  const nextMs = Date.parse(state.nextCheckAt);
  return Number.isFinite(nextMs) && now.getTime() >= nextMs;
}

export function markAutomaticCheckStarted(state: DesktopAutoUpdateState, now: Date): DesktopAutoUpdateState {
  const next = {
    ...state,
    generation: state.generation + 1,
    lastCheckAt: now.toISOString(),
  };
  return scheduleNextAutomaticCheck(next, now);
}

export function targetIdentityDigest(target: DesktopAutoUpdateTargetIdentity): string {
  const identity: DesktopAutoUpdateTargetIdentity = {
    channel: target.channel,
    version: target.version,
    platform: target.platform,
    arch: target.arch,
    installId: target.installId,
    profile: target.profile,
    instanceId: target.instanceId,
    sourceReleaseDigest: target.sourceReleaseDigest,
  };
  return createHash("sha256")
    .update(JSON.stringify(Object.keys(identity).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = identity[key as keyof DesktopAutoUpdateTargetIdentity];
      return result;
    }, {})))
    .digest("hex");
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function bundleManifestDigest(root: string): string {
  const entries: Array<{ relative: string; digest: string; mode: number }> = [];
  const collect = (current: string): void => {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`bundle contains symlink: ${relative}`);
      if (metadata.isDirectory()) {
        entries.push({ relative: `${relative}/`, digest: "dir", mode: 0 });
        collect(absolute);
      } else if (metadata.isFile()) {
        entries.push({
          relative,
          digest: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
          mode: metadata.mode,
        });
      }
    }
  };
  collect(root);
  entries.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const hasher = createHash("sha256");
  for (const entry of entries) {
    hasher.update(entry.relative);
    hasher.update(Buffer.from([0]));
    hasher.update(entry.digest);
    hasher.update(Buffer.from([0]));
    const mode = Buffer.allocUnsafe(4);
    mode.writeUInt32LE(entry.mode >>> 0, 0);
    hasher.update(mode);
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest("hex");
}

/**
 * Automatic apply is allowed only for the exact immutable payload that was
 * staged. This deliberately fails closed for legacy state and symlinked paths.
 */
export function hasExactStagedAutomaticArtifact(candidate: DesktopAutoUpdateCandidate): boolean {
  const artifactPath = candidate.stagedArtifactPath;
  const expectedDigest = candidate.stagedArtifactDigest ?? candidate.assetChecksum;
  if (typeof artifactPath !== "string" || !path.isAbsolute(artifactPath) || !isSha256Digest(expectedDigest)) {
    return false;
  }

  try {
    const descriptor = fs.lstatSync(artifactPath);
    if (descriptor.isSymbolicLink()) return false;
    const actualDigest = descriptor.isDirectory()
      ? bundleManifestDigest(artifactPath)
      : descriptor.isFile()
        ? createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex")
        : null;
    if (!actualDigest) return false;
    return actualDigest === expectedDigest.toLowerCase();
  } catch {
    return false;
  }
}

export function stageAutomaticCandidate(
  state: DesktopAutoUpdateState,
  candidate: DesktopAutoUpdateCandidate,
): DesktopAutoUpdateState {
  if (state.candidate && targetIdentityDigest(state.candidate) !== targetIdentityDigest(candidate)) {
    throw new Error("Another automatic update candidate is already staged for this install.");
  }
  return { ...state, generation: Math.max(state.generation + 1, candidate.generation), candidate };
}

export function beginAutomaticPreparation(
  state: DesktopAutoUpdateState,
  preparation: DesktopAutoUpdatePreparation,
): DesktopAutoUpdateState {
  if (state.preparation && state.preparation.updateId !== preparation.updateId) {
    throw new Error("Another automatic update preparation is already active.");
  }
  return {
    ...state,
    generation: state.generation + 1,
    preparation,
  };
}

export function clearAutomaticPreparation(
  state: DesktopAutoUpdateState,
  updateId: string,
): DesktopAutoUpdateState {
  if (state.preparation?.updateId !== updateId) return state;
  return {
    ...state,
    generation: state.generation + 1,
    preparation: null,
  };
}

export function attachAutomaticPreparationChild(
  state: DesktopAutoUpdateState,
  updateId: string,
  childPid: number,
): DesktopAutoUpdateState {
  if (state.preparation?.updateId !== updateId) return state;
  if (!Number.isSafeInteger(childPid) || childPid <= 0) {
    throw new Error("Automatic update preparation child pid is invalid.");
  }
  return {
    ...state,
    generation: state.generation + 1,
    preparation: { ...state.preparation, childPid },
  };
}

export function claimAutomaticCandidate(
  state: DesktopAutoUpdateState,
  updateId: string,
  expectedGeneration: number,
): DesktopAutoUpdateState {
  if (!state.candidate || state.candidate.updateId !== updateId || state.candidate.status !== "staged" || state.generation !== expectedGeneration) {
    throw new Error("Automatic update candidate changed before apply.");
  }
  return {
    ...state,
    generation: state.generation + 1,
    candidate: { ...state.candidate, generation: state.generation + 1, status: "claimed" },
  };
}

export function markAutomaticCandidateStatus(
  state: DesktopAutoUpdateState,
  updateId: string,
  status: DesktopAutoUpdateCandidate["status"],
): DesktopAutoUpdateState {
  if (!state.candidate || state.candidate.updateId !== updateId) return state;
  return {
    ...state,
    generation: state.generation + 1,
    candidate: { ...state.candidate, status, generation: state.generation + 1 },
  };
}

export function markAutomaticRecoveryRequired(state: DesktopAutoUpdateState, recoveryCode: string): DesktopAutoUpdateState {
  return { ...state, generation: state.generation + 1, recoveryRequired: true, recoveryCode };
}

export function clearAutomaticCandidate(state: DesktopAutoUpdateState, updateId: string): DesktopAutoUpdateState {
  if (state.candidate?.updateId !== updateId) return state;
  return { ...state, generation: state.generation + 1, candidate: null };
}
