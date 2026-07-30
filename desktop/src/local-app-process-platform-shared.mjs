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
  const waitUntilDead = async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!isAlive(ownerId)) return true;
      await delay(pollMs);
    }
    return !isAlive(ownerId);
  };
  if (platform === "win32") {
    if (typeof options.runTaskkill !== "function") {
      throw new Error("Windows Local App termination requires taskkill");
    }
    let treeKillSucceeded = false;
    try {
      await options.runTaskkill(ownerId, false);
      treeKillSucceeded = true;
    } catch {
      // Escalate, but do not accept root PID disappearance as tree proof.
    }
    if (treeKillSucceeded && await waitUntilDead()) return;
    try {
      await options.runTaskkill(ownerId, true);
      treeKillSucceeded = true;
    } catch {
      // Fail closed below.
    }
    if (treeKillSucceeded && await waitUntilDead()) return;
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
