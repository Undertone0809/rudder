import { spawn } from "node:child_process";
import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";
import {
  isValidLocalAppWatchdogConfig,
  localAppOwnerId,
  localAppUsesDetachedProcessGroup,
  terminateLocalAppOwner,
} from "./local-app-process-platform-shared.mjs";
import {
  captureManagedWindowsProcessIdentity,
  snapshotWindowsProcesses,
  terminateWindowsProcessInstances,
} from "./local-app-windows-processes.mjs";

const TERM_TIMEOUT_MS = 2_000;
const POLL_MS = 50;

let appProcess = null;
let appOwnerId = null;
let appOwnerCreatedAt = null;
let appIdentityPromise = null;
let cleanupPromise = null;
let stopAccepted = false;

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

async function terminateOwnedTree() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!isSafeLocalAppProcessId(appOwnerId)) return;
    if (process.platform === "win32" && appIdentityPromise) {
      await appIdentityPromise;
    }
    await terminateLocalAppOwner(appOwnerId, {
      platform: process.platform,
      expectedOwnerCreatedAt: process.platform === "win32" ? appOwnerCreatedAt : undefined,
      expectedWindowsProcesses: process.platform === "win32" && appOwnerCreatedAt
        ? [{ pid: appOwnerId, parentPid: 0, createdAt: appOwnerCreatedAt }]
        : undefined,
      snapshotWindowsProcesses: process.platform === "win32" ? snapshotWindowsProcesses : undefined,
      terminateWindowsProcessInstances: process.platform === "win32"
        ? terminateWindowsProcessInstances
        : undefined,
      termTimeoutMs: TERM_TIMEOUT_MS,
      pollMs: POLL_MS,
    });
  })();
  return cleanupPromise;
}

async function cleanupAndExit(code = 0) {
  try {
    await terminateOwnedTree();
    send({ type: "stopped" });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    code = 1;
  } finally {
    process.exit(code);
  }
}

process.stdin.resume();
process.stdin.once("end", () => { void cleanupAndExit(); });
process.stdin.once("close", () => { void cleanupAndExit(); });
process.once("disconnect", () => { void cleanupAndExit(); });
process.once("SIGTERM", () => { void cleanupAndExit(); });
process.once("SIGINT", () => { void cleanupAndExit(); });

process.on("message", (message) => {
  if (message?.type === "cleanup") {
    void cleanupAndExit();
    return;
  }
  if (message?.type === "stop") {
    if (!stopAccepted) {
      stopAccepted = true;
      send({ type: "stop-accepted" });
    }
    return;
  }
  if (appProcess || !isValidLocalAppWatchdogConfig(message)) {
    send({ type: "error", message: "Invalid Local App watchdog configuration" });
    return;
  }
  try {
    appProcess = spawn(message.executable, message.argv, {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      detached: localAppUsesDetachedProcessGroup(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    appProcess.stdout.pipe(process.stdout);
    appProcess.stderr.pipe(process.stderr);
    appProcess.once("error", (error) => {
      send({ type: "error", message: error.message });
      void cleanupAndExit(1);
    });
    if (!isSafeLocalAppProcessId(appProcess.pid)) {
      send({ type: "error", message: "Invalid Local App child process identity" });
      appProcess = null;
      void cleanupAndExit(1);
      return;
    }
    appOwnerId = localAppOwnerId(appProcess.pid);
    appProcess.once("exit", (code, signal) => {
      send({ type: "app-exit", code, signal });
      void cleanupAndExit(code === 0 ? 0 : 1);
    });
    if (process.platform === "win32") {
      const spawnedPid = appProcess.pid;
      appIdentityPromise = captureManagedWindowsProcessIdentity(appProcess).then((identity) => {
        appOwnerCreatedAt = identity.createdAt;
        if (!cleanupPromise) send({ type: "spawned", pid: spawnedPid, pgid: appOwnerId });
      });
      void appIdentityPromise.catch((error) => {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        void cleanupAndExit(1);
      });
    } else {
      send({ type: "spawned", pid: appProcess.pid, pgid: appOwnerId });
    }
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
