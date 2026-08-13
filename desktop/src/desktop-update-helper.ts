import { accessSync, chmodSync, constants as fsConstants, copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const DESKTOP_UPDATE_HELPER_PROTOCOL = "rudder-update-helper 0.1.0 protocol=1";

export type HelperAttestation = {
  path: string;
  protocol: string;
};

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
};

export type DesktopUpdateTransactionPaths = {
  installPath: string;
  lkgPath: string;
  journalPath: string;
  checkpointPath: string;
};

export type DesktopUpdateJournalSnapshot = {
  transactionId: string;
  stage: string;
  recoveryRequired: boolean;
  recoveryCode?: string | null;
};

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "rudder-update-helper.exe" : "rudder-update-helper";
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
  const candidates = [
    configured,
    path.join(options.userDataPath, "update-helper", name),
    path.join(options.userDataPath, "UpdateHelper", name),
  ].filter((value): value is string => Boolean(value));
  const resourcesPath = options.resourcesPath ? path.resolve(options.resourcesPath) : null;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resourcesPath && (resolved === resourcesPath || resolved.startsWith(`${resourcesPath}${path.sep}`))) continue;
    try {
      const stat = lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      accessSync(resolved, fsConstants.X_OK);
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
  const helperPath = resolveExternalDesktopUpdateHelperPath(options);
  if (!helperPath) return null;
  const result = spawnSync(helperPath, ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== DESKTOP_UPDATE_HELPER_PROTOCOL) return null;
  return { path: helperPath, protocol: result.stdout.trim() };
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
}): DesktopUpdateTransactionPaths {
  const userDataPath = path.resolve(options.userDataPath);
  const transactionId = options.transactionId.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(transactionId)) {
    throw new Error("Invalid automatic update transaction identity.");
  }
  const installPath = options.resourcesPath
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
    if (parsed.transactionId !== transactionId || typeof parsed.stage !== "string") return null;
    return {
      transactionId,
      stage: parsed.stage,
      recoveryRequired: parsed.recoveryRequired === true,
      ...(typeof parsed.recoveryCode === "string" ? { recoveryCode: parsed.recoveryCode } : {}),
    };
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
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(options.helperPath, ["--stdin"], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const payload = `${JSON.stringify(options.request)}\n`;
  child.stdin?.write(payload, () => {
    const end = child.stdin && "end" in child.stdin && typeof child.stdin.end === "function"
      ? child.stdin.end.bind(child.stdin)
      : null;
    end?.();
  });
  child.unref();
  return child;
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
  const target = path.join(options.userDataPath, "update-helper", name);
  const bundledCandidates = [
    path.join(resourceRoot, "native", "aarch64-apple-darwin", name),
    path.join(resourceRoot, "native", "arm64-apple-darwin", name),
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
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
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
