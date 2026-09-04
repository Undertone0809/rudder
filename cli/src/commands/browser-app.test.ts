import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startManagedServerFromRuntime } from "../runtime/server-entry.js";
import {
  acquireDesktopTakeoverLease,
  browserAppCommand,
  buildEdgeBrowserAppArgs,
  buildWindowsBrowserAppShortcutScript,
  createWindowsBrowserAppShortcut,
  detectSmartAppControlState,
  launchBrowserAppWindow,
  parseDesktopLaunchMode,
  parseSmartAppControlState,
  resolveDesktopLaunchMode,
  resolveEdgeExecutable,
} from "./browser-app.js";

vi.mock("../runtime/server-entry.js", () => ({
  startManagedServerFromRuntime: vi.fn(),
}));

describe("Windows browser-app compatibility", () => {
  it("refuses a mismatched native runtime without terminating active runs", async () => {
    const previousPlatform = process.platform;
    const previousHome = process.env.RUDDER_HOME;
    const previousLocalEnv = process.env.RUDDER_LOCAL_ENV;
    const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPort = process.env.PORT;
    const previousPostgresPort = process.env.RUDDER_EMBEDDED_POSTGRES_PORT;
    const home = await mkdtemp(path.join(tmpdir(), "rudder-browser-app-runtime-guard."));
    const readyFile = path.join(home, "ready.json");
    const activeRunPid = 42_424;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const startRuntimeMock = vi.mocked(startManagedServerFromRuntime);

    process.env.RUDDER_HOME = home;
    process.env.RUDDER_LOCAL_ENV = "prod_local";
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    startRuntimeMock.mockImplementation(async (options) => {
      if (options.takeoverOnVersionMismatch) process.kill(activeRunPid, "SIGTERM");
      throw new Error(
        "Local instance 'default' is already running version 0.7.18. Current server version is 0.7.19. " +
          "Stop the running instance or allow takeover. Active run is still executing.",
      );
    });

    try {
      await expect(browserAppCommand({
        child: true,
        open: false,
        readyFile,
        runtimeVersion: "0.7.19",
      })).rejects.toThrow("already running version 0.7.18");

      expect(startRuntimeMock).toHaveBeenCalledWith({
        version: "0.7.19",
        takeoverOnVersionMismatch: false,
      });
      expect(killSpy).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(readyFile, "utf8"))).toMatchObject({
        ok: false,
        error: expect.stringContaining("Active run is still executing"),
      });
    } finally {
      killSpy.mockRestore();
      startRuntimeMock.mockReset();
      Object.defineProperty(process, "platform", { configurable: true, value: previousPlatform });
      if (previousHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousHome;
      if (previousLocalEnv === undefined) delete process.env.RUDDER_LOCAL_ENV;
      else process.env.RUDDER_LOCAL_ENV = previousLocalEnv;
      if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousPostgresPort === undefined) delete process.env.RUDDER_EMBEDDED_POSTGRES_PORT;
      else process.env.RUDDER_EMBEDDED_POSTGRES_PORT = previousPostgresPort;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("allows only one Desktop takeover monitor per local instance", async () => {
    const previousHome = process.env.RUDDER_HOME;
    const home = await mkdtemp(path.join(tmpdir(), "rudder-browser-app-lease."));
    process.env.RUDDER_HOME = home;
    try {
      const releaseFirst = acquireDesktopTakeoverLease("lease-test");
      expect(releaseFirst).toBeTypeOf("function");
      expect(acquireDesktopTakeoverLease("lease-test")).toBeNull();
      releaseFirst?.();

      const releaseSecond = acquireDesktopTakeoverLease("lease-test");
      expect(releaseSecond).toBeTypeOf("function");
      releaseSecond?.();
    } finally {
      if (previousHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("parses every documented Smart App Control registry state", () => {
    expect(parseSmartAppControlState(
      "VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n",
    )).toBe("on");
    expect(parseSmartAppControlState(
      "VerifiedAndReputablePolicyState    REG_DWORD    0x0\r\n",
    )).toBe("off");
    expect(parseSmartAppControlState(
      "VerifiedAndReputablePolicyState    REG_DWORD    0x2\r\n",
    )).toBe("evaluation");
    expect(parseSmartAppControlState("unrelated output")).toBe("unknown");
  });

  it("reads Smart App Control without changing its policy", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: "VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n",
    }));
    expect(detectSmartAppControlState("win32", spawnSyncImpl as never)).toBe("on");
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "reg.exe",
      [
        "query",
        String.raw`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`,
        "/v",
        "VerifiedAndReputablePolicyState",
      ],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(detectSmartAppControlState("linux", spawnSyncImpl as never)).toBe("unknown");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
  });

  it("selects browser mode only for enforced Windows auto mode", () => {
    expect(resolveDesktopLaunchMode({
      platform: "win32",
      smartAppControlState: "on",
    })).toBe("browser");
    expect(resolveDesktopLaunchMode({
      platform: "win32",
      smartAppControlState: "evaluation",
    })).toBe("native");
    expect(resolveDesktopLaunchMode({
      platform: "linux",
      smartAppControlState: "on",
    })).toBe("native");
    expect(resolveDesktopLaunchMode({
      requested: "native",
      platform: "win32",
      smartAppControlState: "on",
    })).toBe("native");
    expect(resolveDesktopLaunchMode({
      requested: "browser",
      platform: "win32",
      smartAppControlState: "off",
    })).toBe("browser");
  });

  it("rejects an invalid desktop mode instead of silently changing launch behavior", () => {
    expect(parseDesktopLaunchMode(undefined)).toBe("auto");
    expect(() => parseDesktopLaunchMode("unsafe")).toThrow("auto, native, or browser");
  });

  it("prefers the machine Edge installation and builds a standalone app window", () => {
    const env = {
      "PROGRAMFILES(X86)": String.raw`C:\Program Files (x86)`,
      ProgramFiles: String.raw`C:\Program Files`,
      LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
    };
    const expected = path.join(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe");
    expect(resolveEdgeExecutable(env, (candidate) => candidate === expected)).toBe(expected);
    expect(buildEdgeBrowserAppArgs("http://127.0.0.1:3200")).toEqual([
      "--app=http://127.0.0.1:3200",
      "--start-maximized",
      "--no-first-run",
    ]);
  });

  it("creates a minimized Start Menu shortcut backed by Node instead of Rudder.exe", () => {
    const script = buildWindowsBrowserAppShortcutScript({
      shortcutPath: String.raw`C:\Users\test\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Rudder.lnk`,
      nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
      cliEntryPath: String.raw`C:\Users\test\AppData\Roaming\npm\node_modules\@rudderhq\cli\dist\index.js`,
      localEnv: "dev",
      dataDir: String.raw`C:\Users\test\Rudder Data\active`,
      runtimeVersion: "0.7.16",
      workingDirectory: String.raw`C:\Users\test\AppData\Local\Programs\Rudder`,
      iconPath: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    });
    expect(script).toContain("$shortcut.WindowStyle = 7");
    expect(script).toContain("--local-env dev");
    expect(script).toContain('browser-app --data-dir "C:\\Users\\test\\Rudder Data\\active" --runtime-version 0.7.16');
    expect(script).toContain("node.exe");
    expect(script).not.toContain("TargetPath = 'C:\\Users\\test\\AppData\\Local\\Programs\\Rudder\\Rudder.exe'");
  });

  it("persists a normalized custom data directory for a non-default local environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-browser-app-shortcut."));
    const spawnSyncImpl = vi.fn(() => ({ status: 0 }));
    const dataDir = path.join(root, "Rudder Data's", "active");
    try {
      const shortcutPath = createWindowsBrowserAppShortcut({
        nodePath: process.execPath,
        cliEntryPath: path.join(root, "node modules", "rudder.js"),
        localEnv: "e2e",
        dataDir,
        runtimeVersion: "0.7.19",
        workingDirectory: root,
        env: { APPDATA: path.join(root, "App Data") },
        spawnSyncImpl: spawnSyncImpl as never,
      });

      expect(shortcutPath).toBe(path.join(root, "App Data", "Microsoft", "Windows", "Start Menu", "Programs", "Rudder.lnk"));
      const script = String((spawnSyncImpl.mock.calls[0] as unknown as [string, string[], object])[1][2]);
      expect(script).toContain("--local-env e2e");
      expect(script).toContain(`--data-dir "${path.resolve(dataDir).replaceAll("'", "''")}"`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens Edge when available and falls back to the default browser", () => {
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }));
    const programFilesX86 = String.raw`C:\Program Files (x86)`;
    const edge = path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe");
    expect(launchBrowserAppWindow("http://127.0.0.1:3200", {
      env: { "PROGRAMFILES(X86)": programFilesX86 },
      pathExists: (candidate) => candidate === edge,
      spawnImpl: spawnImpl as never,
    })).toBe("edge");
    expect(spawnImpl).toHaveBeenLastCalledWith(
      edge,
      buildEdgeBrowserAppArgs("http://127.0.0.1:3200"),
      expect.objectContaining({ detached: true }),
    );

    expect(launchBrowserAppWindow("http://127.0.0.1:3200", {
      env: {},
      pathExists: () => false,
      spawnImpl: spawnImpl as never,
    })).toBe("default");
    expect(spawnImpl).toHaveBeenLastCalledWith(
      "cmd.exe",
      ["/c", "start", "", "http://127.0.0.1:3200"],
      expect.objectContaining({ detached: true, windowsHide: true }),
    );
    expect(unref).toHaveBeenCalledTimes(2);
  });
});
