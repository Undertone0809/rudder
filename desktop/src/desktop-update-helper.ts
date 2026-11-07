import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, copyFileSync, constants as fsConstants, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requirePackage = createRequire(import.meta.url);
const desktopPackage = requirePackage("../package.json") as { version?: unknown };
const desktopVersion = typeof desktopPackage.version === "string" ? desktopPackage.version : null;
if (!desktopVersion) throw new Error("Desktop package version is required for native helper attestation");
export const DESKTOP_UPDATE_HELPER_PROTOCOL = `rudder-update-helper ${desktopVersion} protocol=1`;
/**
 * A detached helper normally writes its journal within seconds of receiving
 * the request. Keep a bounded grace period for process startup, then isolate
 * an orphaned request so a claimed candidate cannot block every future quit.
 */
export const DESKTOP_UPDATE_REQUEST_STALE_AFTER_MS = 5 * 60 * 1_000;
// Helper attestation runs synchronously so a false timeout must fail closed,
// but process startup on a cold macOS filesystem can exceed two seconds.
// Keep the bound finite without turning a transient launch delay into a
// permanently unavailable update capability.
export const DESKTOP_UPDATE_HELPER_ATTESTATION_TIMEOUT_MS = 5_000;
export const DESKTOP_UPDATE_PROBATION_TIMEOUT_MS = 60_000;

export type HelperAttestation = {
  path: string;
  protocol: string;
  ownerUid: number;
  mode: number;
  sha256: string;
};

export type DesktopUpdateHelperIdentity = Pick<HelperAttestation, "path" | "ownerUid" | "mode" | "sha256">;

export type DesktopUpdateRuntimeReceipt = {
  descriptorPath: string;
  instanceId: string;
  apiPort: number;
  postgresDataDir: string;
  postgresPort: number;
  /** Native helper may add observed process identities to its journal. */
  apiPid?: number;
  postgresPid?: number;
  /** Legacy helper journal field retained as an observed-only value. */
  postmasterPid?: number;
};

function isRuntimePort(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= 65_535;
}

function isRuntimePid(value: unknown): value is number | null | undefined {
  return value === undefined
    || value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
}

function isRuntimePath(value: unknown): value is string {
  return typeof value === "string"
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && !value.split(path.sep).includes("..");
}

function parseDesktopUpdateRuntimeReceipt(value: unknown): DesktopUpdateRuntimeReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!isRuntimePath(candidate.descriptorPath)
    || typeof candidate.instanceId !== "string"
    || !/^[A-Za-z0-9_-]+$/u.test(candidate.instanceId)
    || !isRuntimePort(candidate.apiPort)
    || !isRuntimePath(candidate.postgresDataDir)
    || !isRuntimePort(candidate.postgresPort)
    || candidate.apiPort === candidate.postgresPort
    || !isRuntimePid(candidate.apiPid)
    || !isRuntimePid(candidate.postgresPid)
    || !isRuntimePid(candidate.postmasterPid)) return null;
  return {
    descriptorPath: candidate.descriptorPath,
    instanceId: candidate.instanceId,
    apiPort: candidate.apiPort,
    postgresDataDir: candidate.postgresDataDir,
    postgresPort: candidate.postgresPort,
    ...(typeof candidate.apiPid === "number" ? { apiPid: candidate.apiPid } : {}),
    ...(typeof candidate.postgresPid === "number" ? { postgresPid: candidate.postgresPid } : {}),
    ...(typeof candidate.postmasterPid === "number" ? { postmasterPid: candidate.postmasterPid } : {}),
  };
}

export function isDesktopUpdateRuntimeReceipt(value: unknown): value is DesktopUpdateRuntimeReceipt {
  return parseDesktopUpdateRuntimeReceipt(value) !== null;
}

/** Compare the persisted runtime identity, excluding helper-observed PIDs. */
export function desktopUpdateRuntimeReceiptsMatch(actual: unknown, expected: unknown): boolean {
  const parsedActual = parseDesktopUpdateRuntimeReceipt(actual);
  const parsedExpected = parseDesktopUpdateRuntimeReceipt(expected);
  if (!parsedActual || !parsedExpected) return false;
  return parsedActual.descriptorPath === parsedExpected.descriptorPath
    && parsedActual.instanceId === parsedExpected.instanceId
    && parsedActual.apiPort === parsedExpected.apiPort
    && parsedActual.postgresDataDir === parsedExpected.postgresDataDir
    && parsedActual.postgresPort === parsedExpected.postgresPort;
}

export function resolveDesktopUpdateRuntimeReceipt(options: {
  instanceRoot: string;
  instanceId: string;
  apiPort: number;
  postgresDataDir?: string;
  postgresPort: number;
}): DesktopUpdateRuntimeReceipt {
  const receipt: DesktopUpdateRuntimeReceipt = {
    descriptorPath: path.resolve(options.instanceRoot, "runtime", "server.json"),
    instanceId: options.instanceId,
    apiPort: options.apiPort,
    postgresDataDir: path.resolve(options.postgresDataDir ?? path.join(options.instanceRoot, "db")),
    postgresPort: options.postgresPort,
  };
  if (!isDesktopUpdateRuntimeReceipt(receipt)) throw new Error("Invalid Desktop runtime receipt.");
  return receipt;
}

export type DesktopUpdateHelperRequest = {
  operation: "apply" | "recover" | "status";
  ownerToken: string;
  transactionId: string;
  parentPid?: number;
  installPath: string;
  stagedPath: string;
  lkgPath: string;
  journalPath: string;
  checkpointPath: string;
  /** Durable Desktop scheduler state to reconcile after terminal commit. */
  statePath?: string;
  targetVersion: string;
  candidateSha256: string;
  admission: {
    closed: boolean;
    activeRuns: number;
    drainToken: string;
  };
  checkpoint: {
    instanceId: string;
    databaseRevision: string;
    migrationCompatible: boolean;
  };
  helper: DesktopUpdateHelperIdentity;
  probation: {
    executable: string;
    args: string[];
    timeoutMs: number;
    runtime: DesktopUpdateRuntimeReceipt;
  };
};

export type DesktopUpdateTransactionPaths = {
  installPath: string;
  lkgPath: string;
  journalPath: string;
  checkpointPath: string;
};

export type DesktopUpdateJournalSnapshot = {
  transactionId: string;
  ownerToken?: string;
  installPath?: string;
  stagedPath?: string;
  lkgPath?: string;
  checkpointPath?: string;
  statePath?: string;
  targetVersion?: string;
  candidateSha256?: string;
  probationRuntime?: DesktopUpdateRuntimeReceipt;
  helper?: DesktopUpdateHelperIdentity;
  admission?: { closed: boolean; activeRuns: number; drainToken: string };
  checkpoint?: { instanceId: string; databaseRevision: string; migrationCompatible: boolean };
  stage: string;
  recoveryRequired: boolean;
  recoveryCode?: string | null;
};

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "rudder-update-helper.exe" : "rudder-update-helper";
}

function helperInstallationKey(userDataPath: string, resourcesPath?: string): string {
  const installRoot = resourcesPath
    ? path.resolve(resourcesPath, "..", "..")
    : path.resolve(userDataPath);
  return createHash("sha256").update(installRoot).digest("hex").slice(0, 16);
}

function hasNonSymlinkParentChain(candidatePath: string, stopAt: string): boolean {
  const candidate = path.resolve(candidatePath);
  const boundary = path.resolve(stopAt);
  const relative = path.relative(boundary, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = boundary;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }
  return true;
}

export function resolveExternalDesktopUpdateHelperPath(options: {
  userDataPath: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const name = executableName(platform);
  const configured = options.env?.RUDDER_DESKTOP_UPDATE_HELPER_PATH?.trim();
  const helperRoot = path.resolve(options.userDataPath, "update-helper", helperInstallationKey(options.userDataPath, options.resourcesPath));
  const candidates = [
    configured && path.resolve(configured).startsWith(`${helperRoot}${path.sep}`) ? configured : undefined,
    path.join(helperRoot, name),
    // Read the pre-keyed location for one migration cycle; new installs always
    // use the installation-scoped directory above.
    path.join(options.userDataPath, "update-helper", name),
  ].filter((value): value is string => Boolean(value));
  const resourcesPath = options.resourcesPath ? path.resolve(options.resourcesPath) : null;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!hasNonSymlinkParentChain(resolved, path.resolve(options.userDataPath))) continue;
    if (resourcesPath && (resolved === resourcesPath || resolved.startsWith(`${resourcesPath}${path.sep}`))) continue;
    try {
      const lstat = lstatSync(resolved);
      if (!lstat.isFile() || lstat.isSymbolicLink()) continue;
      accessSync(resolved, fsConstants.X_OK);
      const stat = statSync(resolved);
      if ((stat.mode & 0o7777) !== 0o755) continue;
      return resolved;
    } catch {
      // A missing or non-executable helper is an unavailable capability.
    }
  }
  return null;
}

export function attestExternalDesktopUpdateHelper(options: {
  userDataPath: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): HelperAttestation | null {
  let helperPath: string | null;
  try { helperPath = resolveExternalDesktopUpdateHelperPath(options); } catch { return null; }
  if (!helperPath) return null;
  let result;
  try {
    result = spawnSync(helperPath, ["--version"], {
    encoding: "utf8",
      timeout: DESKTOP_UPDATE_HELPER_ATTESTATION_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return null; }
  if (result.error || result.status !== 0 || result.stdout.trim() !== DESKTOP_UPDATE_HELPER_PROTOCOL) return null;
  try {
    const stat = statSync(helperPath);
    const sha256 = createHash("sha256").update(readFileSync(helperPath)).digest("hex");
    const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if ((stat.mode & 0o7777) !== 0o755 || !Number.isInteger(stat.uid) || stat.uid !== currentUid) return null;
    return {
      path: helperPath,
      protocol: result.stdout.trim(),
      ownerUid: stat.uid,
      mode: stat.mode & 0o7777,
      sha256,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the durable exchange paths for one automatic update transaction.
 * These paths live outside the replaceable App bundle so a helper can finish
 * after Desktop exits and recover the journal on the next launch.
 */
export function resolveDesktopUpdateTransactionPaths(options: {
  userDataPath: string;
  transactionId: string;
  resourcesPath?: string;
  execPath?: string;
  installPath?: string;
}): DesktopUpdateTransactionPaths {
  const userDataPath = path.resolve(options.userDataPath);
  const transactionId = options.transactionId.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(transactionId)) {
    throw new Error("Invalid automatic update transaction identity.");
  }
  const installPath = options.installPath
    ? path.resolve(options.installPath)
    : options.resourcesPath
    ? path.resolve(options.resourcesPath, "..", "..")
    : path.resolve(options.execPath ?? process.execPath, "..", "..", "..");
  const transactionRoot = path.join(userDataPath, "update-helper", "transactions");
  return {
    installPath,
    lkgPath: path.join(userDataPath, "update-helper", "lkg", "Rudder.app"),
    journalPath: path.join(transactionRoot, `${transactionId}.journal.json`),
    checkpointPath: path.join(transactionRoot, `${transactionId}.checkpoint.json`),
  };
}

export function readDesktopUpdateJournal(
  userDataPath: string,
  transactionId: string,
): DesktopUpdateJournalSnapshot | null {
  try {
    const journalPath = resolveDesktopUpdateTransactionPaths({ userDataPath, transactionId }).journalPath;
    const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    if (parsed.transactionId !== transactionId || typeof parsed.stage !== "string") {
      return { transactionId, stage: "invalid", recoveryRequired: true, recoveryCode: "journal_identity_mismatch" };
    }
    const probationRuntime = parseDesktopUpdateRuntimeReceipt(parsed.probationRuntime);
    return {
      transactionId,
      ...(typeof parsed.ownerToken === "string" ? { ownerToken: parsed.ownerToken } : {}),
      ...(typeof parsed.installPath === "string" ? { installPath: parsed.installPath } : {}),
      ...(typeof parsed.stagedPath === "string" ? { stagedPath: parsed.stagedPath } : {}),
      ...(typeof parsed.lkgPath === "string" ? { lkgPath: parsed.lkgPath } : {}),
      ...(typeof parsed.checkpointPath === "string" ? { checkpointPath: parsed.checkpointPath } : {}),
      ...(typeof parsed.statePath === "string" ? { statePath: parsed.statePath } : {}),
      ...(typeof parsed.targetVersion === "string" ? { targetVersion: parsed.targetVersion } : {}),
      ...(typeof parsed.candidateSha256 === "string" ? { candidateSha256: parsed.candidateSha256 } : {}),
      ...(probationRuntime ? { probationRuntime } : {}),
      ...(parsed.helper && typeof parsed.helper === "object" ? { helper: parsed.helper as DesktopUpdateHelperIdentity } : {}),
      ...(parsed.admission && typeof parsed.admission === "object" ? { admission: parsed.admission as DesktopUpdateJournalSnapshot["admission"] } : {}),
      ...(parsed.checkpoint && typeof parsed.checkpoint === "object" ? { checkpoint: parsed.checkpoint as DesktopUpdateJournalSnapshot["checkpoint"] } : {}),
      stage: parsed.stage,
      recoveryRequired: parsed.recoveryRequired === true,
      ...(typeof parsed.recoveryCode === "string" ? { recoveryCode: parsed.recoveryCode } : {}),
    };
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return null;
    return { transactionId, stage: "invalid", recoveryRequired: true, recoveryCode: "journal_unreadable" };
  }
}

export function isDesktopUpdateRequestFresh(
  requestPath: string,
  nowMs = Date.now(),
): boolean {
  try {
    const stat = statSync(requestPath);
    if (!stat.isFile()) return false;
    const age = nowMs - stat.mtimeMs;
    return age >= 0 && age < DESKTOP_UPDATE_REQUEST_STALE_AFTER_MS;
  } catch {
    return false;
  }
}

export function readDesktopUpdateHelperRequest(requestPath: string): DesktopUpdateHelperRequest | null {
  try {
    const parsed = JSON.parse(readFileSync(requestPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const request = parsed as Partial<DesktopUpdateHelperRequest>;
    const probation = request.probation;
    const probationRuntime = probation && typeof probation === "object"
      ? parseDesktopUpdateRuntimeReceipt((probation as Partial<DesktopUpdateHelperRequest["probation"]>).runtime)
      : null;
    if (request.operation !== "apply"
      || typeof request.ownerToken !== "string"
      || typeof request.transactionId !== "string"
      || typeof request.installPath !== "string"
      || typeof request.stagedPath !== "string"
      || typeof request.lkgPath !== "string"
      || typeof request.journalPath !== "string"
      || typeof request.checkpointPath !== "string"
      || typeof request.statePath !== "string"
      || typeof request.targetVersion !== "string"
      || typeof request.candidateSha256 !== "string"
      || !request.helper
      || !request.admission
      || !request.checkpoint
      || !probation
      || !probationRuntime) return null;
    return {
      ...request,
      probation: { ...probation, runtime: probationRuntime },
    } as DesktopUpdateHelperRequest;
  } catch {
    return null;
  }
}

export function requestMatchesAutomaticCandidate(input: {
  request: DesktopUpdateHelperRequest;
  candidate: {
    updateId: string;
    version: string;
    instanceId?: string;
    stagedArtifactPath?: string;
    stagedArtifactDigest?: string;
  };
  statePath: string;
  paths: DesktopUpdateTransactionPaths;
  helper?: DesktopUpdateHelperIdentity;
  runtimeReceipt?: DesktopUpdateRuntimeReceipt;
}): boolean {
  const { request, candidate, statePath, paths, helper, runtimeReceipt } = input;
  return request.operation === "apply"
    && request.transactionId === candidate.updateId
    && request.targetVersion === candidate.version
    && typeof candidate.instanceId === "string"
    && candidate.instanceId === runtimeReceipt?.instanceId
    && request.statePath === statePath
    && request.installPath === paths.installPath
    && request.lkgPath === paths.lkgPath
    && request.journalPath === paths.journalPath
    && request.checkpointPath === paths.checkpointPath
    && request.stagedPath === candidate.stagedArtifactPath
    && request.candidateSha256 === candidate.stagedArtifactDigest
    && (!helper || (request.helper.path === helper.path
      && request.helper.ownerUid === helper.ownerUid
      && request.helper.mode === helper.mode
      && request.helper.sha256 === helper.sha256))
    && request.admission.closed === true
    && request.admission.activeRuns === 0
    && typeof request.admission.drainToken === "string"
    && typeof request.checkpoint.instanceId === "string"
    && typeof request.checkpoint.databaseRevision === "string"
    && (request.checkpoint.migrationCompatible === true || request.checkpoint.migrationCompatible === false)
    && typeof request.probation.executable === "string"
    && Array.isArray(request.probation.args)
    && request.probation.args.every((arg) => typeof arg === "string")
    && desktopUpdateRuntimeReceiptsMatch(request.probation.runtime, runtimeReceipt);
}

/** Move an orphaned request out of the active transaction namespace. */
export function quarantineDesktopUpdateRequest(requestPath: string): string | null {
  try {
    if (!statSync(requestPath).isFile()) return null;
    const quarantinePath = `${requestPath}.stale-${Date.now()}-${process.pid}`;
    renameSync(requestPath, quarantinePath);
    return quarantinePath;
  } catch {
    return null;
  }
}

/**
 * Start the already-attested native helper and hand it one immutable request.
 * The helper is detached before Desktop begins its normal quit finalization.
 */
export function handoffDesktopUpdateToExternalHelper(options: {
  request: DesktopUpdateHelperRequest;
  helperPath: string;
  spawnProcess?: typeof spawn;
}): ChildProcess {
  const requestPath = writeDesktopUpdateHelperRequest(options.request);
  try {
    return spawnDesktopUpdateHelper({
      requestPath,
      helperPath: options.helperPath,
      spawnProcess: options.spawnProcess,
    });
  } catch (error) {
    rmSync(requestPath, { force: true });
    throw error;
  }
}

export function writeDesktopUpdateHelperRequest(request: DesktopUpdateHelperRequest): string {
  if (!isDesktopUpdateRuntimeReceipt(request.probation.runtime)) {
    throw new Error("Desktop update runtime receipt is required.");
  }
  const requestPath = `${request.journalPath}.request.json`;
  const temporaryPath = `${requestPath}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(path.dirname(requestPath), { recursive: true, mode: 0o700 });
  writeFileSync(temporaryPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, requestPath);
  return requestPath;
}

export function spawnDesktopUpdateHelper(options: {
  requestPath: string;
  helperPath: string;
  spawnProcess?: typeof spawn;
}): ChildProcess {
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(options.helperPath, ["--request", options.requestPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child;
}

type DesktopUpdateRecoveryResult = {
  ok: boolean;
  stage?: string;
  recoveryRequired?: boolean;
  recoveryCode?: string | null;
  error?: string;
};

type ExternalDesktopUpdateHelperOutput = {
  output: string;
  error?: Error;
  timedOut: boolean;
  signal?: NodeJS.Signals | null;
  outputTooLarge: boolean;
  exitConfirmed: boolean;
};

const DESKTOP_UPDATE_HELPER_OUTPUT_TAIL_BYTES = 64 * 1024;
const DESKTOP_UPDATE_HELPER_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DESKTOP_UPDATE_HELPER_TERMINATION_GRACE_MS = 5_000;

function collectExternalDesktopUpdateHelperOutput(
  child: ChildProcess,
  timeoutMs: number,
): Promise<ExternalDesktopUpdateHelperOutput> {
  return new Promise((resolve) => {
    let outputTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let processError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    let terminationPhase: "sigterm" | "sigkill" | null = null;

    const onStdout = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      const combined = bytes.length >= DESKTOP_UPDATE_HELPER_OUTPUT_TAIL_BYTES
        ? bytes.subarray(bytes.length - DESKTOP_UPDATE_HELPER_OUTPUT_TAIL_BYTES)
        : Buffer.concat([outputTail, bytes]);
      outputTail = combined.length > DESKTOP_UPDATE_HELPER_OUTPUT_TAIL_BYTES
        ? combined.subarray(combined.length - DESKTOP_UPDATE_HELPER_OUTPUT_TAIL_BYTES)
        : combined;
    };
    const onStderr = () => {
      // Drain stderr so a noisy helper cannot block on a full pipe.
    };
    const removeStreamListeners = () => {
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
    };
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      removeStreamListeners();
    };
    const outputResult = (): Pick<ExternalDesktopUpdateHelperOutput, "output" | "outputTooLarge"> => ({
      output: outputTail.toString("utf8"),
      outputTooLarge: outputBytes > DESKTOP_UPDATE_HELPER_OUTPUT_MAX_BYTES,
    });
    const retainExitListeners = () => {
      const onLateError = () => {
        // A process error does not prove that the process has exited. Keep a
        // sink installed until close so a late kill error is never unhandled.
      };
      const onLateClose = () => {
        child.removeListener("error", onLateError);
        child.removeListener("close", onLateClose);
      };
      child.on("error", onLateError);
      child.once("close", onLateClose);
    };
    const finishConfirmed = (signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ...outputResult(),
        ...(processError ? { error: processError } : {}),
        timedOut,
        signal,
        exitConfirmed: true,
      });
    };
    const finishUnconfirmed = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      removeStreamListeners();
      retainExitListeners();
      resolve({
        ...outputResult(),
        error: processError,
        timedOut: true,
        exitConfirmed: false,
      });
    };
    const onError = (error: Error) => {
      // Node emits error before close for spawn failures. Record it, but wait
      // for close because error alone does not prove that the child stopped.
      processError ??= error;
    };
    const onClose = (_code: number | null, signal: NodeJS.Signals | null) => finishConfirmed(signal);

    const scheduleTerminationEscalation = () => {
      if (settled) return;
      terminationTimer = setTimeout(() => {
        if (settled) return;
        if (terminationPhase === "sigterm") {
          terminationPhase = "sigkill";
          try {
            child.kill("SIGKILL");
          } catch {
            // Wait for close; if no close arrives, preserve the request below.
          }
          scheduleTerminationEscalation();
          return;
        }
        finishUnconfirmed();
      }, DESKTOP_UPDATE_HELPER_TERMINATION_GRACE_MS);
    };
    const beginTermination = () => {
      if (settled) return;
      timedOut = true;
      terminationPhase = "sigterm";
      try {
        child.kill("SIGTERM");
      } catch {
        // Escalate after the same bounded grace period if SIGTERM cannot be sent.
      }
      scheduleTerminationEscalation();
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.once("close", onClose);
    timeout = setTimeout(beginTermination, timeoutMs);
  });
}

function parseExternalDesktopUpdateHelperResult(output: string): DesktopUpdateRecoveryResult {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, error: "automatic_update_recovery_no_result" };

  let terminal: Record<string, unknown>;
  try {
    const parsed = JSON.parse(lines.at(-1)!) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("terminal result is not an object");
    terminal = parsed as Record<string, unknown>;
    if (typeof terminal.ok !== "boolean") throw new Error("terminal result has no boolean ok field");
  } catch {
    return { ok: false, error: "automatic_update_recovery_invalid_result" };
  }

  const ok = terminal.ok === true;
  const stage = typeof terminal.stage === "string" ? terminal.stage : undefined;
  const recoveryCode = typeof terminal.recoveryCode === "string" || terminal.recoveryCode === null
    ? terminal.recoveryCode
    : undefined;
  const error = typeof terminal.error === "string"
    ? terminal.error
    : typeof terminal.message === "string"
    ? terminal.message
    : "automatic_update_recovery_failed";
  return {
    ok,
    stage,
    recoveryRequired: terminal.recoveryRequired === true,
    recoveryCode,
    ...(!ok && { error }),
  };
}

export async function recoverDesktopUpdateWithExternalHelper(options: {
  request: DesktopUpdateHelperRequest;
  helperPath: string;
  spawnProcess?: typeof spawn;
}): Promise<DesktopUpdateRecoveryResult> {
  if (!isDesktopUpdateRuntimeReceipt(options.request.probation.runtime)) {
    return { ok: false, error: "automatic_update_runtime_receipt_invalid" };
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  const requestPath = `${options.request.journalPath}.request.json`;
  try {
    mkdirSync(path.dirname(requestPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${requestPath}.${process.pid}.${Date.now()}.recover.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...options.request, operation: "recover", parentPid: undefined })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, requestPath);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let exitConfirmed = false;
  try {
    const child = spawnProcess(options.helperPath, ["--request", requestPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const recoveryTimeoutMs = (2 * options.request.probation.timeoutMs) + 15_000;
    const result = await collectExternalDesktopUpdateHelperOutput(child, recoveryTimeoutMs);
    exitConfirmed = result.exitConfirmed;
    if (!result.exitConfirmed) {
      return {
        ok: false,
        recoveryRequired: true,
        recoveryCode: "automatic_update_recovery_process_exit_unconfirmed",
        error: result.error?.message ?? "automatic_update_recovery_timeout",
      };
    }
    if (result.timedOut) return { ok: false, error: "automatic_update_recovery_timeout" };
    if (result.outputTooLarge) return { ok: false, error: "automatic_update_recovery_output_too_large" };
    if (result.signal) return { ok: false, error: "automatic_update_recovery_terminated_by_signal" };
    if (result.error) return { ok: false, error: result.error.message };
    return parseExternalDesktopUpdateHelperResult(result.output);
  } catch (error) {
    return {
      ok: false,
      recoveryRequired: true,
      recoveryCode: "automatic_update_recovery_process_exit_unconfirmed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (exitConfirmed) rmSync(requestPath, { force: true });
  }
}

/**
 * Install the packaged helper into an installation-scoped location that is
 * outside the replaceable App bundle. Existing helpers are replaced only after
 * the new binary has passed protocol attestation.
 */
export function ensureExternalDesktopUpdateHelper(options: {
  userDataPath: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): HelperAttestation | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const name = executableName(platform);
  const resourceRoot = options.resourcesPath ? path.resolve(options.resourcesPath) : null;
  if (!resourceRoot) return attestExternalDesktopUpdateHelper(options);
  const target = path.join(options.userDataPath, "update-helper", helperInstallationKey(options.userDataPath, options.resourcesPath), name);
  const bundledCandidates = [
    path.join(resourceRoot, "native", "aarch64-apple-darwin", name),
    path.join(resourceRoot, "native", "arm64-apple-darwin", name),
    path.join(resourceRoot, "native", "x86_64-apple-darwin", name),
    path.join(resourceRoot, "native", "x64-apple-darwin", name),
    path.join(resourceRoot, "native", name),
  ];
  const bundled = bundledCandidates.find((candidate) => {
    try {
      const stat = lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!bundled) return attestExternalDesktopUpdateHelper(options);
  // A claimed/applying transaction owns the helper generation recorded in its
  // journal. Do not replace that binary with the newly unpacked bundle before
  // recovery has validated and completed the transaction.
  try {
    const statePath = path.join(options.userDataPath, "desktop-auto-update.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      candidate?: { status?: unknown } | null;
    };
    const activeTransaction = state.candidate?.status === "claimed" || state.candidate?.status === "applying";
    if (activeTransaction) return attestExternalDesktopUpdateHelper(options);
  } catch {
    // Missing or unreadable state must not create a new capability. The normal
    // attestation path below will fail closed if the existing helper is absent.
  }
  try {
    const helperRoot = path.dirname(target);
    if (!hasNonSymlinkParentChain(helperRoot, path.resolve(options.userDataPath))) return null;
    mkdirSync(helperRoot, { recursive: true, mode: 0o700 });
    const helperRootStat = lstatSync(helperRoot);
    if (helperRootStat.isSymbolicLink() || !helperRootStat.isDirectory() || (helperRootStat.mode & 0o777) !== 0o700) return null;
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    copyFileSync(bundled, temp);
    chmodSync(temp, 0o755);
    const attested = attestExternalDesktopUpdateHelper({ ...options, env: { ...(options.env ?? process.env), RUDDER_DESKTOP_UPDATE_HELPER_PATH: temp } });
    if (!attested) {
      rmSync(temp, { force: true });
      return attestExternalDesktopUpdateHelper(options);
    }
    renameSync(temp, target);
    return attestExternalDesktopUpdateHelper({ ...options, env: { ...(options.env ?? process.env), RUDDER_DESKTOP_UPDATE_HELPER_PATH: target } });
  } catch {
    return attestExternalDesktopUpdateHelper(options);
  }
}
