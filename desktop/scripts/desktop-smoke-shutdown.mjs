import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import net from "node:net";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readPositivePidFile(pidFilePath) {
  try {
    const firstLine = (await readFile(pidFilePath, "utf8")).split(/\r?\n/, 1)[0]?.trim();
    const pid = Number(firstLine);
    return Number.isSafeInteger(pid) && pid >= 2 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function isLoopbackTcpListenerReachable(port, timeoutMs = 250) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid loopback listener port: ${port}`);
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(reachable);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function inspectShutdownResidue(input, probes) {
  const [appPortReachable, dbPortReachable, runtimeDescriptorExists] = await Promise.all([
    probes.isPortReachable(input.appPort),
    probes.isPortReachable(input.dbPort),
    probes.pathExists(input.runtimeDescriptorPath),
  ]);
  return {
    appPortReachable,
    dbPortReachable,
    databasePidAlive: input.databasePid === null ? false : probes.isProcessAlive(input.databasePid),
    runtimeDescriptorExists,
  };
}

function activeResidueLabels(state, input) {
  return [
    state.appPortReachable ? `API listener 127.0.0.1:${input.appPort}` : null,
    state.dbPortReachable ? `PostgreSQL listener 127.0.0.1:${input.dbPort}` : null,
    state.databasePidAlive ? `PostgreSQL PID ${input.databasePid}` : null,
    state.runtimeDescriptorExists ? `runtime descriptor ${input.runtimeDescriptorPath}` : null,
  ].filter(Boolean);
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function execFileAsync(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function terminatePlaywrightElectronTree(child, platform = process.platform) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid < 2) {
    throw new Error("Cannot force-close Desktop without a safe Playwright-owned Electron PID");
  }
  if (platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function closeElectronApplication(electronApp, input, terminateProcessTree) {
  const closePromise = Promise.resolve().then(() => electronApp.close());
  const errors = [];
  try {
    await withTimeout(
      closePromise,
      input.closeTimeoutMs,
      `Timed out after ${input.closeTimeoutMs}ms waiting for the Desktop process to complete its graceful quit flow`,
    );
  } catch (error) {
    const child = typeof electronApp.process === "function" ? electronApp.process() : null;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      // Playwright waits for the child stdio close event, which can remain open
      // when a Windows grandchild inherited those handles. The owned Electron
      // process has exited; release only its local pipe handles, then let the
      // independent residue probes below prove the runtime is actually gone.
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      return errors;
    }
    errors.push(error);
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await terminateProcessTree(child);
      } catch (terminationError) {
        errors.push(terminationError);
      }
      try {
        await withTimeout(
          closePromise,
          input.forceCloseWaitMs,
          `Forced Desktop process tree did not exit within ${input.forceCloseWaitMs}ms`,
        );
      } catch (forcedCloseError) {
        if (forcedCloseError !== error) errors.push(forcedCloseError);
      }
    }
  }
  return errors;
}

export async function closeDesktopAndAssertReleased(input, overrides = {}) {
  const closeTimeoutMs = input.closeTimeoutMs ?? 60_000;
  const forceCloseWaitMs = input.forceCloseWaitMs ?? 5_000;
  const releaseTimeoutMs = input.releaseTimeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probes = {
    isPortReachable: overrides.isPortReachable ?? isLoopbackTcpListenerReachable,
    isProcessAlive: overrides.isProcessAlive ?? isProcessAlive,
    pathExists: overrides.pathExists ?? pathExists,
    readPositivePidFile: overrides.readPositivePidFile ?? readPositivePidFile,
    delay: overrides.delay ?? delay,
    terminateProcessTree: overrides.terminateProcessTree ?? terminatePlaywrightElectronTree,
  };
  const databasePid = await probes.readPositivePidFile(input.postmasterPidPath);

  const closeErrors = await closeElectronApplication(input.electronApp, {
    closeTimeoutMs,
    forceCloseWaitMs,
  }, probes.terminateProcessTree);

  const inspectionInput = { ...input, databasePid };
  const deadline = Date.now() + releaseTimeoutMs;
  let state;
  let releaseError = null;
  do {
    state = await inspectShutdownResidue(inspectionInput, probes);
    const active = activeResidueLabels(state, inspectionInput);
    if (active.length === 0) break;
    if (Date.now() >= deadline) {
      releaseError = new Error(`Desktop graceful shutdown left test-owned resources active: ${active.join(", ")}`);
      break;
    }
    await probes.delay(intervalMs);
  } while (true);

  const errors = [...closeErrors, ...(releaseError ? [releaseError] : [])];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Desktop smoke shutdown failed");
  return { databasePid };
}

export function createDesktopSmokeShutdownRegistry(options = {}) {
  const targets = new Map();
  const closeTarget = options.closeTarget ?? closeDesktopAndAssertReleased;
  return {
    register(electronApp, target) {
      if (targets.has(electronApp)) throw new Error("Desktop smoke launch was registered twice");
      targets.set(electronApp, target);
    },
    async close(electronApp) {
      const target = targets.get(electronApp);
      if (!target) throw new Error("Desktop smoke must retain the launched instance shutdown target");
      try {
        await closeTarget({ electronApp, ...target });
      } finally {
        // closeTarget performs the force-close and residue probes itself. Do
        // not retain an already-attempted target for drain after Playwright
        // has disposed its Electron connection.
        targets.delete(electronApp);
      }
    },
    get size() {
      return targets.size;
    },
    async drain() {
      const errors = [];
      for (const electronApp of [...targets.keys()]) {
        try {
          await this.close(electronApp);
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    },
  };
}
