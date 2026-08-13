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

export type HelperAttestation = {
  path: string;
  protocol: string;
  ownerUid: number;
  mode: number;
  sha256: string;
};

export type DesktopUpdateHelperIdentity = Pick<HelperAttestation, "path" | "ownerUid" | "mode" | "sha256">;

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

export function recoverDesktopUpdateWithExternalHelper(options: {
  request: DesktopUpdateHelperRequest;
  helperPath: string;
  spawnProcess?: typeof spawnSync;
}): { ok: boolean; stage?: string; recoveryRequired?: boolean; recoveryCode?: string | null; error?: string } {
  const spawnProcess = options.spawnProcess ?? spawnSync;
  const requestPath = `${options.request.journalPath}.request.json`;
  try {
    mkdirSync(path.dirname(requestPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${requestPath}.${process.pid}.${Date.now()}.recover.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...options.request, operation: "recover", parentPid: undefined })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, requestPath);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const result = spawnProcess(options.helperPath, ["--request", requestPath], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = result.stdout?.toString().trim().split(/\r?\n/u).filter(Boolean).at(-1);
    const parsed = output ? JSON.parse(output) as {
      ok?: boolean;
      stage?: string;
      recoveryRequired?: boolean;
      recoveryCode?: string | null;
      error?: string;
      message?: string;
    } : null;
    if (!parsed) return { ok: false, error: "automatic_update_recovery_no_result" };
    return {
      ok: parsed.ok === true,
      stage: parsed.stage,
      recoveryRequired: parsed.recoveryRequired === true,
      recoveryCode: parsed.recoveryCode,
      ...(!parsed.ok && { error: parsed.error ?? parsed.message ?? "automatic_update_recovery_failed" }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(requestPath, { force: true });
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
