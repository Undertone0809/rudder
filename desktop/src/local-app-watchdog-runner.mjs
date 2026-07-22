import { spawn } from "node:child_process";

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4_096;
const MAX_ENVIRONMENT_ENTRIES = 128;
const TERM_TIMEOUT_MS = 2_000;
const POLL_MS = 50;

let appProcess = null;
let appPgid = null;
let cleanupPromise = null;

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function validConfig(value) {
  if (!value || typeof value !== "object" || value.type !== "start") return false;
  if (typeof value.executable !== "string" || value.executable.length > 4_096 || !value.executable.startsWith("/") || value.executable.includes("\0")) return false;
  if (typeof value.cwd !== "string" || value.cwd.length > 4_096 || !value.cwd.startsWith("/") || value.cwd.includes("\0")) return false;
  if (!Array.isArray(value.argv) || value.argv.length > MAX_ARGUMENTS
    || value.argv.some((entry) => typeof entry !== "string" || entry.length > MAX_ARGUMENT_LENGTH || entry.includes("\0"))) return false;
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)
    || Object.keys(value.env).length > MAX_ENVIRONMENT_ENTRIES
    || Object.entries(value.env).some(([name, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof entry !== "string" || entry.length > 32_768 || entry.includes("\0"))) return false;
  return true;
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function terminateGroup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!Number.isInteger(appPgid) || appPgid <= 0) return;
    try { process.kill(-appPgid, "SIGTERM"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    const attempts = Math.max(1, Math.ceil(TERM_TIMEOUT_MS / POLL_MS));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!groupAlive(appPgid)) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (groupAlive(appPgid)) {
      try { process.kill(-appPgid, "SIGKILL"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  })();
  return cleanupPromise;
}

async function cleanupAndExit(code = 0) {
  try {
    await terminateGroup();
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
  if (appProcess || !validConfig(message)) {
    send({ type: "error", message: "Invalid Local App watchdog configuration" });
    return;
  }
  try {
    appProcess = spawn(message.executable, message.argv, {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    appProcess.stdout.pipe(process.stdout);
    appProcess.stderr.pipe(process.stderr);
    appProcess.once("error", (error) => {
      send({ type: "error", message: error.message });
      void cleanupAndExit(1);
    });
    if (!appProcess.pid) return;
    appPgid = appProcess.pid;
    appProcess.once("exit", (code, signal) => {
      send({ type: "app-exit", code, signal });
      void cleanupAndExit(code === 0 ? 0 : 1);
    });
    send({ type: "spawned", pid: appProcess.pid, pgid: appPgid });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
