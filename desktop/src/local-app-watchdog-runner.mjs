import { spawn } from "node:child_process";
import path from "node:path";
import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";
import {
  isValidLocalAppWatchdogConfig,
  localAppOwnerId,
  localAppUsesDetachedProcessGroup,
  terminateLocalAppOwner,
} from "./local-app-process-platform-shared.mjs";
import { runBoundedChildProcess } from "./local-app-watchdog-process.mjs";

const TERM_TIMEOUT_MS = 2_000;
const POLL_MS = 50;
const TASKKILL_TIMEOUT_MS = 5_000;

let appProcess = null;
let appOwnerId = null;
let cleanupPromise = null;

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function runTaskkill(ownerId, force) {
  const taskkillPath = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  return runBoundedChildProcess(taskkillPath, [
    "/PID",
    String(ownerId),
    "/T",
    ...(force ? ["/F"] : []),
  ], {
    timeoutMs: TASKKILL_TIMEOUT_MS,
  });
}

async function terminateOwnedTree() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!isSafeLocalAppProcessId(appOwnerId)) return;
    await terminateLocalAppOwner(appOwnerId, {
      platform: process.platform,
      runTaskkill,
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
  if (message?.type === "stop") {
    void cleanupAndExit();
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
    send({ type: "spawned", pid: appProcess.pid, pgid: appOwnerId });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
