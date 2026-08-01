import { spawn } from "node:child_process";

export function runBoundedChildProcess(command, args, options = {}) {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    // Keep the child referenced until its exit proves that parent-side cleanup
    // cannot race the command after a timeout.
    let settled = false;
    let timeoutError = null;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener?.("error", onError);
      child.removeListener?.("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => {
      // Once termination starts, only process exit is sufficient proof that a
      // parent-side cleanup cannot race this command.
      if (!timeoutError) settle(error);
    };
    const onExit = (code) => {
      if (timeoutError) {
        settle(timeoutError);
        return;
      }
      if (code === 0) settle();
      else settle(new Error(`${command} exited with status ${code ?? "unknown"}`));
    };
    const timeout = setTimeout(() => {
      timeoutError = new Error(`${command} timed out after ${timeoutMs}ms`);
      try {
        child.kill("SIGKILL");
      } catch {
        // If the child already exited, its exit event will settle the command.
        // Otherwise the watchdog remains alive and the workflow job timeout is
        // the final fail-closed ceiling; it must not race a parent fallback.
      }
    }, timeoutMs);

    child.once("error", onError);
    child.once("exit", onExit);
  });
}
