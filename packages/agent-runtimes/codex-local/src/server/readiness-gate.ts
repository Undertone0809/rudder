import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const STATE_VERSION = 1;
const STATE_RELATIVE_DIRECTORY = path.join(".rudder", "provider-readiness", "codex");
const AUTH_FAILURE_COOLDOWN_MS = 60_000;
const PROBE_LEASE_MS = 120_000;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_WAIT_MS = 2_000;
const STATE_LOCK_RETRY_MS = 10;
const STATE_LOCK_COORDINATION_SUFFIX = ".coordination";
const PROCESS_START_LOOKUP_TIMEOUT_MS = 500;
const execFileAsync = promisify(execFile);

type ActiveProbeLease = {
  probeId: string;
  renewedAt: bigint;
};

const activeProbeLeases = new Map<string, ActiveProbeLease>();

type CodexAuthFailureState = {
  version: typeof STATE_VERSION;
  fingerprint: string;
  classification: "authentication";
  errorCode: "codex_provider_auth_required";
  state: "failed" | "probing";
  generation: number;
  failedAt?: string;
  probeId?: string;
  probeStartedAt?: string;
  probeOwnerPid?: number;
};

export type CodexAuthProbeLease = {
  probeId: string;
  generation: number;
};

export type CodexAuthProbeClaim =
  | { claimed: true; lease: CodexAuthProbeLease }
  | { claimed: false; readinessState: "unchanged" | "busy" };

type StateLockSnapshot = {
  raw: string;
  ownerToken: string | null;
  ownerPid: number | null;
  ownerStartIdentity: string | null;
  stat: Awaited<ReturnType<typeof fs.stat>>;
};

type StateLock = {
  handle: FileHandle;
  lockPath: string;
  ownerToken: string;
  ownerStartIdentity: string | null;
  stat: Awaited<ReturnType<typeof fs.stat>>;
};

type StateLockCoordinationSnapshot = {
  raw: string;
  ownerToken: string | null;
  ownerPid: number | null;
  ownerStartIdentity: string | null;
  stat: Awaited<ReturnType<typeof fs.stat>>;
};

type StateLockCoordination = {
  coordinationPath: string;
  ownerToken: string;
  ownerStartIdentity: string | null;
  stat: Awaited<ReturnType<typeof fs.stat>>;
};

function digestParts(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  if (process.platform === "linux") {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
    if (raw) {
      const closingCommand = raw.lastIndexOf(") ");
      const fields = closingCommand >= 0 ? raw.slice(closingCommand + 2).trim().split(/\s+/u) : [];
      // /proc fields start at field 3 after the command name. Field 22 is the
      // process start time in clock ticks, which survives PID reuse.
      const startTime = fields[19];
      if (startTime) return `linux:${startTime}`;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { timeout: PROCESS_START_LOOKUP_TIMEOUT_MS, windowsHide: true },
    );
    const startTime = stdout.trim();
    return startTime ? `ps:${startTime}` : null;
  } catch {
    return null;
  }
}

function activeProbeKey(agentHome: string, fingerprint: string): string {
  return statePath(agentHome, fingerprint);
}

function rememberActiveProbe(agentHome: string, fingerprint: string, probeId: string): void {
  activeProbeLeases.set(activeProbeKey(agentHome, fingerprint), {
    probeId,
    renewedAt: process.hrtime.bigint(),
  });
}

function forgetActiveProbe(agentHome: string, fingerprint: string, probeId?: string): void {
  const key = activeProbeKey(agentHome, fingerprint);
  const current = activeProbeLeases.get(key);
  if (!current || probeId === undefined || current.probeId === probeId) {
    activeProbeLeases.delete(key);
  }
}

function hasFreshLocalProbeLease(agentHome: string, fingerprint: string, probeId: string): boolean {
  const key = activeProbeKey(agentHome, fingerprint);
  const current = activeProbeLeases.get(key);
  if (!current || current.probeId !== probeId) return false;
  if (process.hrtime.bigint() - current.renewedAt >= BigInt(PROBE_LEASE_MS) * 1_000_000n) {
    activeProbeLeases.delete(key);
    return false;
  }
  return true;
}

async function readFingerprintInput(candidate: string): Promise<Buffer> {
  return fs.readFile(candidate).catch(() => Buffer.from("", "utf8"));
}

function isTomlTableBoundary(trimmedLine: string): boolean {
  return /^\[\[.+\]\]$/.test(trimmedLine) || /^\[(?!\[).+\]$/.test(trimmedLine);
}

function isManagedCodexConfigTable(trimmedLine: string): boolean {
  return /^\[mcp_servers(?:\..+)?\]$/.test(trimmedLine)
    || /^\[plugins\..+\]$/.test(trimmedLine)
    || trimmedLine === "[[skills.config]]";
}

function isUnsupportedServiceTierLine(trimmedLine: string): boolean {
  const match = trimmedLine.match(/^service_tier\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/i);
  if (!match) return false;
  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim().toLowerCase();
  return value !== "fast" && value !== "flex";
}

function normalizeProviderConfig(content: string): string {
  const output: string[] = [];
  let blockLines: string[] | null = null;
  let blockName = "";

  const flushBlock = () => {
    if (!blockLines) return;
    if (!isManagedCodexConfigTable(blockName)) {
      const filtered = blockName === "[features]"
        ? blockLines.filter((line, index) => index === 0 || !/^\s*plugins\s*=/.test(line))
        : blockName === "[skills.bundled]"
          ? blockLines.filter((line, index) => index === 0 || !/^\s*enabled\s*=/.test(line))
          : blockLines;
      if (filtered.slice(1).some((line) => line.trim().length > 0)) output.push(...filtered);
    }
    blockLines = null;
    blockName = "";
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (isTomlTableBoundary(trimmedLine)) {
      flushBlock();
      blockLines = [line];
      blockName = trimmedLine;
      continue;
    }

    if (blockLines) {
      blockLines.push(line);
      continue;
    }

    if (trimmedLine === "# rudder-managed-skills:start" || trimmedLine === "# rudder-managed-skills:end") continue;
    if (/^\s*notify\s*=/.test(trimmedLine) || isUnsupportedServiceTierLine(trimmedLine)) continue;
    output.push(line);
  }
  flushBlock();

  return output.join("\n").trim().replace(/\n{3,}/g, "\n\n");
}

export async function buildCodexReadinessFingerprint(input: {
  env: Record<string, string>;
  sharedCodexHome: string;
  /** Optional managed home whose staged auth/config snapshot is being executed. */
  codexHome?: string;
  model?: string;
}): Promise<string> {
  const apiKey = input.env.OPENAI_API_KEY?.trim() ?? "";
  const authSource = apiKey ? "api_key" : "subscription";
  const snapshotHome = input.codexHome ?? input.sharedCodexHome;
  const authMaterial = apiKey
    ? Buffer.from(apiKey, "utf8")
    : await readFingerprintInput(path.join(snapshotHome, "auth.json"));
  const rawProviderConfig = await readFingerprintInput(path.join(snapshotHome, "config.toml"));
  const providerConfig = Buffer.from(normalizeProviderConfig(rawProviderConfig.toString("utf8")), "utf8");

  return digestParts([
    "rudder.codex.readiness.v1",
    authSource,
    authMaterial,
    providerConfig,
    input.env.OPENAI_BASE_URL?.trim() ?? "",
    input.env.OPENAI_API_BASE?.trim() ?? "",
  ]);
}

function statePath(agentHome: string, fingerprint: string): string {
  return path.join(agentHome, STATE_RELATIVE_DIRECTORY, `${fingerprint}.json`);
}

function stateLockPath(agentHome: string, fingerprint: string): string {
  return `${statePath(agentHome, fingerprint)}.lock`;
}

async function readState(agentHome: string, fingerprint: string): Promise<CodexAuthFailureState | null> {
  const raw = await fs.readFile(statePath(agentHome, fingerprint), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CodexAuthFailureState>;
    if (
      parsed.version !== STATE_VERSION
      || parsed.fingerprint !== fingerprint
      || parsed.classification !== "authentication"
      || parsed.errorCode !== "codex_provider_auth_required"
    ) {
      return null;
    }
    const state = parsed.state === undefined ? "failed" : parsed.state;
    if (state !== "failed" && state !== "probing") return null;
    const generation = typeof parsed.generation === "number" && Number.isSafeInteger(parsed.generation)
      && parsed.generation >= 0
      ? parsed.generation
      : 0;
    if (state === "probing" && (typeof parsed.probeId !== "string" || typeof parsed.probeStartedAt !== "string")) {
      return null;
    }
    if (state === "failed" && typeof parsed.failedAt !== "string") return null;
    return {
      version: STATE_VERSION,
      fingerprint: parsed.fingerprint,
      classification: "authentication",
      errorCode: "codex_provider_auth_required",
      state,
      generation,
      ...(typeof parsed.failedAt === "string" ? { failedAt: parsed.failedAt } : {}),
      ...(typeof parsed.probeId === "string" ? { probeId: parsed.probeId } : {}),
      ...(typeof parsed.probeStartedAt === "string" ? { probeStartedAt: parsed.probeStartedAt } : {}),
      ...(typeof parsed.probeOwnerPid === "number" && Number.isSafeInteger(parsed.probeOwnerPid) && parsed.probeOwnerPid > 0
        ? { probeOwnerPid: parsed.probeOwnerPid }
        : {}),
    };
  } catch {
    return null;
  }
}

function isWithinDuration(timestamp: string | undefined, durationMs: number, nowMs: number): boolean {
  const timestampMs = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(timestampMs)) return false;
  const elapsedMs = nowMs - timestampMs;
  // A future timestamp is treated as expired. Clock skew must not turn a
  // provider failure or abandoned probe into an indefinite block.
  return elapsedMs >= 0 && elapsedMs < durationMs;
}

function isActiveState(
  agentHome: string,
  fingerprint: string,
  state: CodexAuthFailureState,
  nowMs: number,
): boolean {
  return state.state === "failed"
    ? isWithinDuration(state.failedAt, AUTH_FAILURE_COOLDOWN_MS, nowMs)
    : isProbeLeaseActive(agentHome, fingerprint, state, nowMs);
}

function isProbeLeaseActive(
  agentHome: string,
  fingerprint: string,
  state: CodexAuthFailureState,
  nowMs: number,
): boolean {
  const probeStartedAtMs = typeof state.probeStartedAt === "string"
    ? Date.parse(state.probeStartedAt)
    : Number.NaN;
  if (!Number.isFinite(probeStartedAtMs)) return false;
  if (probeStartedAtMs > nowMs) {
    // A wall-clock rollback cannot prove that a long-lived Rudder server still
    // owns the probe. Only a bounded in-process renewal can keep this state
    // active; an abandoned future-dated record is therefore recoverable.
    return hasFreshLocalProbeLease(agentHome, fingerprint, state.probeId ?? "");
  }
  return nowMs - probeStartedAtMs < PROBE_LEASE_MS;
}

function parseStateLock(raw: string): {
  ownerToken: string;
  ownerPid: number;
  ownerStartIdentity: string | null;
} | null {
  try {
    const parsed = JSON.parse(raw) as {
      ownerToken?: unknown;
      ownerPid?: unknown;
      ownerStartIdentity?: unknown;
    };
    if (
      typeof parsed.ownerToken !== "string"
      || parsed.ownerToken.length === 0
      || typeof parsed.ownerPid !== "number"
      || !Number.isSafeInteger(parsed.ownerPid)
      || parsed.ownerPid <= 0
    ) {
      return null;
    }
    return {
      ownerToken: parsed.ownerToken,
      ownerPid: parsed.ownerPid,
      ownerStartIdentity: typeof parsed.ownerStartIdentity === "string" ? parsed.ownerStartIdentity : null,
    };
  } catch {
    return null;
  }
}

async function readStateLock(lockPath: string): Promise<StateLockSnapshot | null> {
  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat) return null;
  const raw = await fs.readFile(lockPath, "utf8").catch(() => "");
  const parsed = parseStateLock(raw);
  return {
    raw,
    ownerToken: parsed?.ownerToken ?? null,
    ownerPid: parsed?.ownerPid ?? null,
    ownerStartIdentity: parsed?.ownerStartIdentity ?? null,
    stat,
  };
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isSameFileIdentity(
  left: Awaited<ReturnType<typeof fs.stat>>,
  right: Awaited<ReturnType<typeof fs.stat>>,
): boolean {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function isSameStateLockSnapshot(left: StateLockSnapshot, right: StateLockSnapshot): boolean {
  return left.raw === right.raw && isSameFileIdentity(left.stat, right.stat);
}

function isSameStateLockCoordinationSnapshot(
  left: StateLockCoordinationSnapshot,
  right: StateLockCoordinationSnapshot,
): boolean {
  return left.raw === right.raw && isSameFileIdentity(left.stat, right.stat);
}

async function isStateLockStale(snapshot: StateLockSnapshot, nowMs: number): Promise<boolean> {
  // A live owner is allowed to renew its descriptor even when a filesystem
  // clock jumps backwards or the operation is temporarily slow.
  if (isProcessAlive(snapshot.ownerPid)) {
    if (!snapshot.ownerStartIdentity) return false;
    const currentStartIdentity = await readProcessStartIdentity(snapshot.ownerPid!);
    // An unavailable process inspection is fail-closed for the lock: retain
    // the lock rather than reclaiming a possibly live owner.
    return currentStartIdentity !== null && currentStartIdentity !== snapshot.ownerStartIdentity;
  }
  const birthtimeMs = Number(snapshot.stat.birthtimeMs);
  const ctimeMs = Number(snapshot.stat.ctimeMs);
  const createdAtMs = Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : ctimeMs;
  const ageMs = nowMs - createdAtMs;
  // A dead, identified owner cannot make progress regardless of the
  // filesystem timestamp. An unidentified lock uses creation time rather than
  // mtime so a future-dated timestamp cannot turn stale contention indefinite.
  if (snapshot.ownerPid !== null) return true;
  return ageMs >= STATE_LOCK_STALE_MS;
}

function stateLockCoordinationPath(lockPath: string): string {
  return `${lockPath}${STATE_LOCK_COORDINATION_SUFFIX}`;
}

function parseCoordinationOwner(raw: string): {
  ownerToken: string;
  ownerPid: number;
  ownerStartIdentity: string | null;
} | null {
  try {
    const parsed = JSON.parse(raw) as {
      ownerToken?: unknown;
      ownerPid?: unknown;
      ownerStartIdentity?: unknown;
    };
    if (
      typeof parsed.ownerToken !== "string"
      || parsed.ownerToken.length === 0
      || typeof parsed.ownerPid !== "number"
      || !Number.isSafeInteger(parsed.ownerPid)
      || parsed.ownerPid <= 0
    ) {
      return null;
    }
    return {
      ownerToken: parsed.ownerToken,
      ownerPid: parsed.ownerPid,
      ownerStartIdentity: typeof parsed.ownerStartIdentity === "string" ? parsed.ownerStartIdentity : null,
    };
  } catch {
    return null;
  }
}

async function readStateLockCoordination(coordinationPath: string): Promise<StateLockCoordinationSnapshot | null> {
  const stat = await fs.stat(coordinationPath).catch(() => null);
  if (!stat || !stat.isDirectory()) return null;
  const ownerPath = path.join(coordinationPath, "owner.json");
  const raw = await fs.readFile(ownerPath, "utf8").catch(() => "");
  const parsed = parseCoordinationOwner(raw);
  return {
    raw,
    ownerToken: parsed?.ownerToken ?? null,
    ownerPid: parsed?.ownerPid ?? null,
    ownerStartIdentity: parsed?.ownerStartIdentity ?? null,
    stat,
  };
}

async function isStateLockCoordinationStale(
  snapshot: StateLockCoordinationSnapshot,
  nowMs: number,
): Promise<boolean> {
  if (isProcessAlive(snapshot.ownerPid)) {
    if (!snapshot.ownerStartIdentity) return false;
    const currentStartIdentity = await readProcessStartIdentity(snapshot.ownerPid!);
    return currentStartIdentity !== null && currentStartIdentity !== snapshot.ownerStartIdentity;
  }
  const birthtimeMs = Number(snapshot.stat.birthtimeMs);
  const ctimeMs = Number(snapshot.stat.ctimeMs);
  const createdAtMs = Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : ctimeMs;
  if (snapshot.ownerPid !== null) return true;
  return nowMs - createdAtMs >= STATE_LOCK_STALE_MS;
}

async function releaseStateLockCoordination(coordination: StateLockCoordination): Promise<void> {
  const current = await readStateLockCoordination(coordination.coordinationPath);
  if (
    !current
    || current.ownerToken !== coordination.ownerToken
    || current.stat.dev !== coordination.stat.dev
    || current.stat.ino !== coordination.stat.ino
  ) {
    return;
  }
  await fs.unlink(path.join(coordination.coordinationPath, "owner.json")).catch(() => undefined);
  await fs.rmdir(coordination.coordinationPath).catch(() => undefined);
}

async function acquireStateLockCoordination(lockPath: string): Promise<StateLockCoordination | null> {
  const coordinationPath = stateLockCoordinationPath(lockPath);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      await fs.mkdir(coordinationPath, { recursive: false, mode: 0o700 });
      const ownerToken = randomUUID();
      try {
        const ownerStartIdentity = await readProcessStartIdentity(process.pid);
        await fs.writeFile(
          path.join(coordinationPath, "owner.json"),
          `${JSON.stringify({ ownerToken, ownerPid: process.pid, ownerStartIdentity })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        return {
          coordinationPath,
          ownerToken,
          ownerStartIdentity,
          stat: await fs.stat(coordinationPath),
        };
      } catch (error) {
        await fs.unlink(path.join(coordinationPath, "owner.json")).catch(() => undefined);
        await fs.rmdir(coordinationPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readStateLockCoordination(coordinationPath);
      if (existing && await isStateLockCoordinationStale(existing, Date.now())) {
        // Rename the exact stale directory into a unique tombstone before
        // removing it. A second reclaimer cannot remove a replacement owner
        // that has already recreated the original coordination path.
        const reclaimPath = `${coordinationPath}.${process.pid}.${randomUUID()}.reclaim`;
        try {
          const current = await readStateLockCoordination(coordinationPath);
          if (current && isSameStateLockCoordinationSnapshot(current, existing)) {
            await fs.rename(coordinationPath, reclaimPath);
            await fs.rm(reclaimPath, { recursive: true, force: true });
          }
        } catch (reclaimError) {
          const code = (reclaimError as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY") throw reclaimError;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_RETRY_MS));
    }
  }
  return null;
}

async function releaseStateLock(lock: StateLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const current = await readStateLock(lock.lockPath);
  if (
    !current
    || current.ownerToken !== lock.ownerToken
    || !isSameFileIdentity(current.stat, lock.stat)
  ) {
    return;
  }
  await fs.unlink(lock.lockPath).catch(() => undefined);
}

async function createStateLock(lockPath: string): Promise<StateLock> {
  const handle = await fs.open(lockPath, "wx", 0o600);
  const ownerToken = randomUUID();
  const ownerStartIdentity = await readProcessStartIdentity(process.pid);
  try {
    await handle.writeFile(
      `${JSON.stringify({ ownerToken, ownerPid: process.pid, ownerStartIdentity })}\n`,
      "utf8",
    );
    return {
      handle,
      lockPath,
      ownerToken,
      ownerStartIdentity,
      stat: await handle.stat(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

async function acquireStateLock(agentHome: string, fingerprint: string): Promise<StateLock | null> {
  const lockPath = stateLockPath(agentHome, fingerprint);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    const coordination = await acquireStateLockCoordination(lockPath);
    if (!coordination) return null;
    let lock: StateLock | null = null;
    try {
      try {
        lock = await createStateLock(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readStateLock(lockPath);
        if (existing && await isStateLockStale(existing, Date.now())) {
          // Every claimant holds the coordination directory while creating or
          // reclaiming the state lock, so stale deletion cannot race a normal
          // create or another stale takeover.
          await fs.unlink(lockPath).catch((unlinkError) => {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
          });
          try {
            lock = await createStateLock(lockPath);
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
          }
        }
      }
    } finally {
      await releaseStateLockCoordination(coordination);
    }
    if (lock) return lock;
    await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_RETRY_MS));
  }
  return null;
}

async function withStateLock<T>(
  agentHome: string,
  fingerprint: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockPath = stateLockPath(agentHome, fingerprint);
  const lock = await acquireStateLock(agentHome, fingerprint);
  if (!lock) return null;
  const refreshInterval = setInterval(() => {
    void lock.handle.utimes(new Date(), new Date()).catch(() => undefined);
  }, Math.max(1_000, Math.floor(STATE_LOCK_STALE_MS / 3)));
  refreshInterval.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(refreshInterval);
    await releaseStateLock(lock);
  }
}

function isStateRenameCollision(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

async function writeState(agentHome: string, fingerprint: string, state: CodexAuthFailureState): Promise<void> {
  const target = statePath(agentHome, fingerprint);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      if (!isStateRenameCollision(error)) throw error;
      await fs.unlink(target).catch(() => undefined);
      await fs.rename(temporary, target);
    }
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function nextGeneration(state: CodexAuthFailureState | null): number {
  return (state?.generation ?? 0) + 1;
}

function matchesProbe(state: CodexAuthFailureState | null, lease: CodexAuthProbeLease): boolean {
  return state?.state === "probing"
    && state.probeId === lease.probeId
    && state.generation === lease.generation;
}

export async function claimCodexAuthProbe(
  agentHome: string,
  fingerprint: string,
): Promise<CodexAuthProbeClaim> {
  const claim = await withStateLock(agentHome, fingerprint, async () => {
    const current = await readState(agentHome, fingerprint);
    const now = Date.now();
    if (current && isActiveState(agentHome, fingerprint, current, now)) {
      return { claimed: false, readinessState: "unchanged" } as const;
    }

    const lease: CodexAuthProbeLease = {
      probeId: randomUUID(),
      generation: nextGeneration(current),
    };
    await writeState(agentHome, fingerprint, {
      version: STATE_VERSION,
      fingerprint,
      classification: "authentication",
      errorCode: "codex_provider_auth_required",
      state: "probing",
      generation: lease.generation,
      probeId: lease.probeId,
      probeStartedAt: new Date(now).toISOString(),
      probeOwnerPid: process.pid,
    });
    rememberActiveProbe(agentHome, fingerprint, lease.probeId);
    return { claimed: true, lease } as const;
  });

  return claim ?? { claimed: false, readinessState: "busy" };
}

export async function hasMatchingCodexAuthFailure(
  agentHome: string,
  fingerprint: string,
): Promise<boolean> {
  const state = await readState(agentHome, fingerprint);
  return state?.fingerprint === fingerprint
    && isActiveState(agentHome, fingerprint, state, Date.now());
}

export async function recordCodexAuthFailure(
  agentHome: string,
  fingerprint: string,
  lease?: CodexAuthProbeLease,
): Promise<boolean> {
  const recorded = await withStateLock(agentHome, fingerprint, async () => {
    const current = await readState(agentHome, fingerprint);
    const now = Date.now();
    if (lease) {
      if (!matchesProbe(current, lease)) {
        forgetActiveProbe(agentHome, fingerprint, lease.probeId);
        return false;
      }
      await writeState(agentHome, fingerprint, {
        version: STATE_VERSION,
        fingerprint,
        classification: "authentication",
        errorCode: "codex_provider_auth_required",
        state: "failed",
        generation: lease.generation,
        failedAt: new Date(now).toISOString(),
      });
      forgetActiveProbe(agentHome, fingerprint, lease.probeId);
      return true;
    }

    // Keep the compatibility API fail-closed: an unowned caller cannot steal
    // an active probe belonging to another run.
    if (current && isActiveState(agentHome, fingerprint, current, now)) return false;
    await writeState(agentHome, fingerprint, {
      version: STATE_VERSION,
      fingerprint,
      classification: "authentication",
      errorCode: "codex_provider_auth_required",
      state: "failed",
      generation: nextGeneration(current),
      failedAt: new Date(now).toISOString(),
    });
    return true;
  });

  return recorded ?? false;
}

export async function renewCodexAuthProbe(
  agentHome: string,
  fingerprint: string,
  lease: CodexAuthProbeLease,
): Promise<boolean> {
  const renewed = await withStateLock(agentHome, fingerprint, async () => {
    const current = await readState(agentHome, fingerprint);
    if (!matchesProbe(current, lease)) {
      forgetActiveProbe(agentHome, fingerprint, lease.probeId);
      return false;
    }
    await writeState(agentHome, fingerprint, {
      version: STATE_VERSION,
      fingerprint,
      classification: "authentication",
      errorCode: "codex_provider_auth_required",
      state: "probing",
      generation: lease.generation,
      probeId: lease.probeId,
      probeStartedAt: new Date().toISOString(),
      probeOwnerPid: process.pid,
    });
    rememberActiveProbe(agentHome, fingerprint, lease.probeId);
    return true;
  });
  return renewed ?? false;
}

export async function clearMatchingCodexAuthFailure(
  agentHome: string,
  fingerprint: string,
  lease?: CodexAuthProbeLease,
): Promise<boolean> {
  const cleared = await withStateLock(agentHome, fingerprint, async () => {
    const current = await readState(agentHome, fingerprint);
    if (lease) {
      if (!matchesProbe(current, lease)) {
        forgetActiveProbe(agentHome, fingerprint, lease.probeId);
        return false;
      }
    } else if (current?.state !== "failed" || current.fingerprint !== fingerprint) {
      return false;
    }
    const target = statePath(agentHome, fingerprint);
    await fs.unlink(target).catch(() => undefined);
    await fs.rmdir(path.dirname(target)).catch(() => undefined);
    forgetActiveProbe(agentHome, fingerprint, lease?.probeId);
    return true;
  });

  if (cleared !== null) {
    await fs.rmdir(path.dirname(statePath(agentHome, fingerprint)))
      .catch(() => undefined);
  }
  return cleared ?? false;
}
