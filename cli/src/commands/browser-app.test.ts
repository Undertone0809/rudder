import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireDesktopTakeoverLease,
  buildEdgeBrowserAppArgs,
  buildWindowsBrowserAppShortcutScript,
  detectSmartAppControlState,
  launchBrowserAppWindow,
  parseDesktopLaunchMode,
  parseSmartAppControlState,
  resolveDesktopLaunchMode,
  resolveEdgeExecutable,
} from "./browser-app.js";

describe("Windows browser-app compatibility", () => {
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
      runtimeVersion: "0.7.16",
      workingDirectory: String.raw`C:\Users\test\AppData\Local\Programs\Rudder`,
      iconPath: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    });
    expect(script).toContain("$shortcut.WindowStyle = 7");
    expect(script).toContain("browser-app --runtime-version 0.7.16");
    expect(script).toContain("node.exe");
    expect(script).not.toContain("TargetPath = 'C:\\Users\\test\\AppData\\Local\\Programs\\Rudder\\Rudder.exe'");
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
