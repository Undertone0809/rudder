import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  closeDesktopAndAssertReleased,
  createDesktopSmokeShutdownRegistry,
  isLoopbackTcpListenerReachable,
} from "./desktop-smoke-shutdown.mjs";

const shutdownInput = {
  appPort: 41_001,
  dbPort: 41_002,
  postmasterPidPath: "/private/tmp/rudder-smoke/db/postmaster.pid",
  runtimeDescriptorPath: "/private/tmp/rudder-smoke/runtime/server.json",
};

describe("Desktop smoke shutdown", () => {
  it("uses the real Electron graceful close before proving every owned resource was released", async () => {
    let desktopClosed = false;
    const electronApp = {
      close: vi.fn(async () => {
        desktopClosed = true;
      }),
    };
    const isPortReachable = vi.fn(async () => {
      expect(desktopClosed).toBe(true);
      return false;
    });
    const pathExists = vi.fn(async () => {
      expect(desktopClosed).toBe(true);
      return false;
    });
    const isProcessAlive = vi.fn(() => {
      expect(desktopClosed).toBe(true);
      return false;
    });

    await expect(closeDesktopAndAssertReleased({
      ...shutdownInput,
      electronApp,
    }, {
      isPortReachable,
      isProcessAlive,
      pathExists,
      readPositivePidFile: vi.fn(async () => 42),
    })).resolves.toEqual({ databasePid: 42 });

    expect(electronApp.close).toHaveBeenCalledOnce();
    expect(isPortReachable).toHaveBeenCalledWith(shutdownInput.appPort);
    expect(isPortReachable).toHaveBeenCalledWith(shutdownInput.dbPort);
    expect(isProcessAlive).toHaveBeenCalledWith(42);
    expect(pathExists).toHaveBeenCalledWith(shutdownInput.runtimeDescriptorPath);
  });

  it("fails closed with exact residue when a listener survives graceful quit", async () => {
    await expect(closeDesktopAndAssertReleased({
      ...shutdownInput,
      electronApp: { close: vi.fn(async () => undefined) },
      intervalMs: 1,
      releaseTimeoutMs: 1,
    }, {
      delay: vi.fn(async () => undefined),
      isPortReachable: vi.fn(async (port) => port === shutdownInput.dbPort),
      isProcessAlive: vi.fn(() => false),
      pathExists: vi.fn(async () => false),
      readPositivePidFile: vi.fn(async () => null),
    })).rejects.toThrow(`PostgreSQL listener 127.0.0.1:${shutdownInput.dbPort}`);
  });

  it("allows an inherited database to outlive a Desktop process that does not own it", async () => {
    const isPortReachable = vi.fn(async (port) => port === shutdownInput.dbPort);
    const isProcessAlive = vi.fn(() => true);

    await expect(closeDesktopAndAssertReleased({
      ...shutdownInput,
      electronApp: { close: vi.fn(async () => undefined) },
      expectDatabaseRelease: false,
    }, {
      isPortReachable,
      isProcessAlive,
      pathExists: vi.fn(async () => false),
      readPositivePidFile: vi.fn(async () => 42),
    })).resolves.toEqual({ databasePid: 42 });

    expect(isPortReachable).toHaveBeenCalledWith(shutdownInput.appPort);
    expect(isPortReachable).not.toHaveBeenCalledWith(shutdownInput.dbPort);
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it("force-closes the Playwright-owned process tree on timeout and still inspects residue", async () => {
    const child = { pid: 42, exitCode: null, signalCode: null };
    const terminateProcessTree = vi.fn(async () => {
      child.signalCode = "SIGKILL";
    });
    const isPortReachable = vi.fn(async () => false);
    await expect(closeDesktopAndAssertReleased({
      ...shutdownInput,
      electronApp: {
        close: vi.fn(() => new Promise(() => {})),
        process: vi.fn(() => child),
      },
      closeTimeoutMs: 1,
      forceCloseWaitMs: 1,
    }, {
      isPortReachable,
      isProcessAlive: vi.fn(() => false),
      pathExists: vi.fn(async () => false),
      readPositivePidFile: vi.fn(async () => null),
      terminateProcessTree,
    })).rejects.toThrow("Desktop smoke shutdown failed");

    expect(terminateProcessTree).toHaveBeenCalledWith(child);
    expect(isPortReachable).toHaveBeenCalledWith(shutdownInput.appPort);
    expect(isPortReachable).toHaveBeenCalledWith(shutdownInput.dbPort);
  });

  it("accepts an exited Electron child when Playwright never settles its close promise", async () => {
    const child = {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      stdin: { destroy: vi.fn() },
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
    };
    const terminateProcessTree = vi.fn(async () => undefined);
    await expect(closeDesktopAndAssertReleased({
      ...shutdownInput,
      electronApp: {
        close: vi.fn(() => new Promise(() => {})),
        process: vi.fn(() => child),
      },
      closeTimeoutMs: 1,
    }, {
      isPortReachable: vi.fn(async () => false),
      isProcessAlive: vi.fn(() => false),
      pathExists: vi.fn(async () => false),
      readPositivePidFile: vi.fn(async () => null),
      terminateProcessTree,
    })).resolves.toEqual({ databasePid: null });

    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
  });

  it("drains launches that fail before a scenario receives their handle", async () => {
    const closeTarget = vi.fn(async () => undefined);
    const registry = createDesktopSmokeShutdownRegistry({ closeTarget });
    const firstApp = { id: "first" };
    const earlyFailureApp = { id: "early-failure" };
    registry.register(firstApp, { appPort: 41_001 });
    registry.register(earlyFailureApp, { appPort: 41_002 });

    await registry.close(firstApp);
    expect(registry.size).toBe(1);
    await expect(registry.drain()).resolves.toEqual([]);
    expect(registry.size).toBe(0);
    expect(closeTarget).toHaveBeenCalledWith({ electronApp: earlyFailureApp, appPort: 41_002 });
  });

  it("releases only an already-exited launch for crash-recovery scenarios", () => {
    const registry = createDesktopSmokeShutdownRegistry();
    const runningApp = {
      process: () => ({ exitCode: null, signalCode: null }),
    };
    const exitedApp = {
      process: () => ({ exitCode: null, signalCode: "SIGKILL" }),
    };
    registry.register(runningApp, { appPort: 41_001 });
    registry.register(exitedApp, { appPort: 41_002 });

    expect(() => registry.releaseExited(runningApp)).toThrow("still running");
    expect(registry.size).toBe(2);
    expect(() => registry.releaseExited(exitedApp)).not.toThrow();
    expect(registry.size).toBe(1);
  });

  it("accepts a frozen exited child after Playwright disposes the application handle", () => {
    const registry = createDesktopSmokeShutdownRegistry();
    const disposedApp = {
      process: () => {
        throw new Error("Playwright application already disposed");
      },
    };
    const exitedChild = { exitCode: null, signalCode: "SIGKILL" };
    registry.register(disposedApp, { appPort: 41_001 });

    expect(() => registry.releaseExited(disposedApp, exitedChild)).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it("detects a real exact-loopback TCP listener and observes its release", async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    expect(address && typeof address !== "string").toBe(true);
    const port = typeof address === "object" && address ? address.port : 0;

    expect(await isLoopbackTcpListenerReachable(port)).toBe(true);
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    expect(await isLoopbackTcpListenerReachable(port)).toBe(false);
  });
});
