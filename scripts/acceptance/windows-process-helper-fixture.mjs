import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// A closed fixture: only this root can spawn a descendant, and it keeps that
// ChildProcess handle until exit. Neither cleanup path resolves a PID to kill.
const LIFETIME_MS = 330_000;
const CHILD_GRACE_MS = 2_000;
const CHILD_EXIT_MS = 2_000;
const mode = process.argv[2];
const send = (message, callback = () => {}) => {
  if (!process.connected) { callback(); return; }
  try { process.send(message, callback); } catch { callback(); }
};

if (mode === "descendant") {
  const stop = () => process.exit(0);
  process.on("message", (message) => { if (message?.type === "stop") stop(); });
  process.once("disconnect", stop);
  setTimeout(stop, LIFETIME_MS);
  send({ type: "ready" });
} else if (mode === "root") {
  let descendantExited = false;
  let stopping = false;
  let gracefulTimer;
  let exitTimer;
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant"], {
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const finish = (verified) => {
    clearTimeout(gracefulTimer);
    clearTimeout(exitTimer);
    send({ type: "cleanup", descendantExitObserved: verified }, () => process.exit(verified ? 0 : 1));
  };
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    if (descendantExited) { finish(true); return; }
    try { descendant.send({ type: "stop" }, () => {}); } catch { /* Fall back to the retained handle. */ }
    gracefulTimer = setTimeout(() => {
      // A true kill() result is only signal submission. The exit listener below
      // remains the sole positive proof that our exact descendant has exited.
      try { descendant.kill("SIGKILL"); } catch { /* Report unverified below. */ }
      exitTimer = setTimeout(() => finish(false), CHILD_EXIT_MS);
    }, CHILD_GRACE_MS);
  };
  descendant.once("message", (message) => {
    if (message?.type === "ready") send({ type: "ready", rootPid: process.pid, descendantPid: descendant.pid });
  });
  descendant.once("exit", () => {
    descendantExited = true;
    send({ type: "descendant-exit", exitObserved: true }, () => { if (stopping) finish(true); });
  });
  descendant.once("error", cleanup);
  process.on("message", (message) => { if (message?.type === "cleanup") cleanup(); });
  process.once("disconnect", cleanup);
  setTimeout(cleanup, LIFETIME_MS - CHILD_GRACE_MS - CHILD_EXIT_MS);
} else {
  process.exitCode = 1;
}
