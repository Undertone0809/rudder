import path from "node:path";
import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";

export function isAbsoluteLocalAppPath(value, platform = process.platform) {
  if (typeof value !== "string") return false;
  return platform === "win32"
    ? /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
    : path.posix.isAbsolute(value);
}

export function localAppUsesDetachedProcessGroup(platform = process.platform) {
  return platform !== "win32";
}

export function localAppOwnerId(pid) {
  return isSafeLocalAppProcessId(pid) ? pid : null;
}

export function isValidLocalAppWatchdogConfig(value, platform = process.platform) {
  if (!value || typeof value !== "object" || value.type !== "start") return false;
  if (typeof value.executable !== "string"
    || value.executable.length > 4_096
    || !isAbsoluteLocalAppPath(value.executable, platform)
    || value.executable.includes("\0")) return false;
  if (typeof value.cwd !== "string"
    || value.cwd.length > 4_096
    || !isAbsoluteLocalAppPath(value.cwd, platform)
    || value.cwd.includes("\0")) return false;
  if (!Array.isArray(value.argv)
    || value.argv.length > 64
    || value.argv.some((entry) => typeof entry !== "string"
      || entry.length > 4_096
      || entry.includes("\0"))) return false;
  if (!value.env
    || typeof value.env !== "object"
    || Array.isArray(value.env)
    || Object.keys(value.env).length > 128
    || Object.entries(value.env).some(([name, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof entry !== "string"
      || entry.length > 32_768
      || entry.includes("\0"))) return false;
  return true;
}

export function isLocalAppOwnerAlive(
  ownerId,
  platform = process.platform,
  killProcess = process.kill,
) {
  if (!isSafeLocalAppProcessId(ownerId)) return true;
  try {
    killProcess(platform === "win32" ? ownerId : -ownerId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function terminateLocalAppOwner(
  ownerId,
  options = {},
) {
  if (!isSafeLocalAppProcessId(ownerId)) {
    throw new Error("Refusing to terminate an unverified Local App process owner");
  }
  const platform = options.platform ?? process.platform;
  const killProcess = options.killProcess ?? process.kill;
  const isAlive = options.isAlive
    ?? ((value) => isLocalAppOwnerAlive(value, platform, killProcess));
  const delay = options.delay
    ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const termTimeoutMs = Math.max(0, options.termTimeoutMs ?? 2_000);
  const pollMs = Math.max(1, options.pollMs ?? 50);
  const attempts = Math.max(1, Math.ceil(termTimeoutMs / pollMs));
  const waitUntilDead = async (processIds = [ownerId]) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (processIds.every((processId) => !isAlive(processId))) return true;
      await delay(pollMs);
    }
    return processIds.every((processId) => !isAlive(processId));
  };
  if (platform === "win32") {
    if (typeof options.terminateWindowsProcessInstances !== "function") {
      throw new Error("Windows Local App termination requires process-handle authority");
    }
    if (typeof options.snapshotWindowsProcesses !== "function") {
      throw new Error("Windows Local App termination requires an owned process snapshot");
    }
    if (typeof options.expectedOwnerCreatedAt !== "string"
      || options.expectedOwnerCreatedAt.length === 0) {
      throw new Error(`Local App process tree ${ownerId} could not be proven dead`);
    }
    let initialProcessTable = [];
    try {
      initialProcessTable = await options.snapshotWindowsProcesses(ownerId);
    } catch {
      if (!Array.isArray(options.expectedWindowsProcesses)) {
        throw new Error(`Local App process tree ${ownerId} could not be proven dead`);
      }
    }
    const isValidProcessRecord = (record) => record
      && typeof record === "object"
      && isSafeLocalAppProcessId(record.pid)
      && Number.isSafeInteger(record.parentPid)
      && record.parentPid >= 0
      && typeof record.createdAt === "string"
      && record.createdAt.length > 0;
    if (!Array.isArray(initialProcessTable)
      || initialProcessTable.some((record) => !isValidProcessRecord(record))) {
      throw new Error(`Local App process tree ${ownerId} could not be proven dead`);
    }
    const cachedProcesses = Array.isArray(options.expectedWindowsProcesses)
      ? options.expectedWindowsProcesses
      : [];
    if (cachedProcesses.some((record) => !isValidProcessRecord(record))) {
      throw new Error(`Local App process tree ${ownerId} could not be proven dead`);
    }
    const cachedOwner = cachedProcesses.find((record) => record.pid === ownerId);
    const currentOwner = initialProcessTable.find((record) => record.pid === ownerId);
    if (cachedOwner?.createdAt !== options.expectedOwnerCreatedAt
      && currentOwner?.createdAt !== options.expectedOwnerCreatedAt) {
      throw new Error(`Local App process tree ${ownerId} could not be proven dead`);
    }
    const ownedProcessIds = new Set([ownerId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of initialProcessTable) {
        if (!ownedProcessIds.has(record.pid) && ownedProcessIds.has(record.parentPid)) {
          ownedProcessIds.add(record.pid);
          changed = true;
        }
      }
    }
    const currentOwnedProcesses = currentOwner?.createdAt === options.expectedOwnerCreatedAt
      ? initialProcessTable.filter((record) => ownedProcessIds.has(record.pid))
      : [];
    const ownedProcesses = [...cachedProcesses];
    for (const record of currentOwnedProcesses) {
      if (!ownedProcesses.some((expected) => expected.pid === record.pid
        && expected.createdAt === record.createdAt)) {
        ownedProcesses.push(record);
      }
    }
    const snapshotProcessInstances = async () => {
      const currentProcessTable = await options.snapshotWindowsProcesses(ownerId);
      if (!Array.isArray(currentProcessTable)
        || currentProcessTable.some((record) => !isValidProcessRecord(record))) {
        throw new Error("Invalid Windows process snapshot");
      }
      return currentProcessTable;
    };
    const processInstanceExists = (processTable, expected) => {
      return processTable.some((record) => record.pid === expected.pid
        && record.createdAt === expected.createdAt);
    };
    const waitUntilInstancesExit = async () => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const processTable = await snapshotProcessInstances();
        if (ownedProcesses.every((expected) => !processInstanceExists(processTable, expected))) {
          return true;
        }
        await delay(pollMs);
      }
      const processTable = await snapshotProcessInstances();
      return ownedProcesses.every((expected) => !processInstanceExists(processTable, expected));
    };
    try {
      // The Windows helper opens every exact process instance, validates its
      // full-precision creation token, and terminates through the retained OS
      // handle. PID reuse after the snapshot therefore cannot redirect a kill.
      await options.terminateWindowsProcessInstances(ownedProcesses);
    } catch {
      // Fail closed after the independent exact-instance death proof below.
    }
    if (await waitUntilInstancesExit()) return;
    throw new Error(`Local App process tree ${ownerId} could not be proven dead`);
  }

  if (!isAlive(ownerId)) return;
  const killGroup = (signal) => {
    try {
      killProcess(-ownerId, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  killGroup("SIGTERM");
  if (await waitUntilDead()) return;
  killGroup("SIGKILL");
  if (await waitUntilDead()) return;
  throw new Error(`Local App process group ${ownerId} could not be proven dead`);
}
