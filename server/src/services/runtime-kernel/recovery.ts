const ORPHANED_PROCESS_TERMINATION_GRACE_MS = 2_000;
const ORPHANED_PROCESS_KILL_WAIT_MS = 500;
const ORPHANED_PROCESS_POLL_INTERVAL_MS = 100;

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export function isTrackedLocalChildProcessAdapter(agentRuntimeType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(agentRuntimeType);
}

export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, ORPHANED_PROCESS_POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}

export async function terminateOrphanedProcess(pid: number): Promise<{
  stillAlive: boolean;
  terminationSignal: NodeJS.Signals | null;
  error: string | null;
}> {
  if (!isProcessAlive(pid)) {
    return {
      stillAlive: false,
      terminationSignal: null,
      error: null,
    };
  }

  let terminationSignal: NodeJS.Signals | null = null;
  try {
    process.kill(pid, "SIGTERM");
    terminationSignal = "SIGTERM";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return {
        stillAlive: false,
        terminationSignal: null,
        error: null,
      };
    }
    return {
      stillAlive: isProcessAlive(pid),
      terminationSignal,
      error: `SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (await waitForProcessExit(pid, ORPHANED_PROCESS_TERMINATION_GRACE_MS)) {
    return {
      stillAlive: false,
      terminationSignal,
      error: null,
    };
  }

  try {
    process.kill(pid, "SIGKILL");
    terminationSignal = "SIGKILL";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return {
        stillAlive: false,
        terminationSignal,
        error: null,
      };
    }
    return {
      stillAlive: isProcessAlive(pid),
      terminationSignal,
      error: `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const exitedAfterKill = await waitForProcessExit(pid, ORPHANED_PROCESS_KILL_WAIT_MS);
  return {
    stillAlive: !exitedAfterKill,
    terminationSignal,
    error: exitedAfterKill ? null : `Timed out waiting for child pid ${pid} to exit after ${terminationSignal}`,
  };
}
