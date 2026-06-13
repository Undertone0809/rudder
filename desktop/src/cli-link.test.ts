import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_CLI_FLAG,
  buildDesktopCliWrapper,
  ensureDesktopCliLink,
  resolveDesktopCliArgv,
  shouldInstallDesktopCliLink,
} from "./cli-link.js";

describe("desktop cli link helpers", () => {
  it("builds a unix wrapper that routes through the desktop executable", () => {
    const wrapper = buildDesktopCliWrapper("/Applications/Rudder.app/Contents/MacOS/Rudder", "darwin");
    expect(wrapper).toContain("# rudder-desktop-cli-managed");
    expect(wrapper).toContain(`'${"/Applications/Rudder.app/Contents/MacOS/Rudder"}' ${DESKTOP_CLI_FLAG} "$@"`);
  });

  it("builds a windows wrapper that preserves argv passthrough", () => {
    const wrapper = buildDesktopCliWrapper(String.raw`C:\Program Files\Rudder\Rudder.exe`, "win32");
    expect(wrapper).toContain(`"${String.raw`C:\Program Files\Rudder\Rudder.exe`}" ${DESKTOP_CLI_FLAG} %*`);
  });

  it("extracts desktop cli argv from the wrapper flag", () => {
    const argv = [process.execPath, "ignored", DESKTOP_CLI_FLAG, "issue", "list", "--json"];
    expect(resolveDesktopCliArgv(argv)).toEqual([process.execPath, "rudder", "issue", "list", "--json"]);
  });

  it("extracts desktop cli argv from legacy desktop-cli.js shim wrappers", () => {
    const argv = [
      process.execPath,
      "/Applications/Rudder.app/Contents/Resources/server-package/desktop-cli.js",
      "agent",
      "me",
      "--json",
    ];
    expect(resolveDesktopCliArgv(argv)).toEqual([process.execPath, "rudder", "agent", "me", "--json"]);
  });

  it("ignores normal desktop launches", () => {
    expect(resolveDesktopCliArgv([process.execPath, "ignored"])).toBeNull();
  });

  it("does not treat later desktop-cli.js path arguments as legacy shim wrappers", () => {
    expect(resolveDesktopCliArgv([process.execPath, "--open", "/tmp/desktop-cli.js"])).toBeNull();
  });

  it("only installs the desktop cli wrapper for packaged desktop builds", () => {
    expect(shouldInstallDesktopCliLink(false)).toBe(false);
    expect(shouldInstallDesktopCliLink(true)).toBe(true);
  });

  it("does not install the desktop cli wrapper for smoke or explicitly disabled launches", () => {
    expect(shouldInstallDesktopCliLink(true, { RUDDER_DESKTOP_APP_NAME: "Rudder-smoke-packaged-3100" })).toBe(false);
    expect(shouldInstallDesktopCliLink(true, { RUDDER_DESKTOP_DISABLE_CLI_LINK: "1" })).toBe(false);
  });

  it("does not write global wrappers for temporary desktop executables", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cli-link-test-"));
    const binDir = path.join(root, "bin");
    const tempAppExecutable = path.join(root, "desktop-install", "Rudder.app", "Contents", "MacOS", "Rudder");
    const existingWrapper = path.join(binDir, "rudder");
    await fs.mkdir(path.dirname(tempAppExecutable), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(tempAppExecutable, "", "utf8");
    await fs.writeFile(existingWrapper, "#!/bin/sh\n# rudder-desktop-cli-managed\necho old\n", "utf8");

    try {
      const result = await ensureDesktopCliLink({
        executablePath: tempAppExecutable,
        pathValue: binDir,
        homeDir: path.join(root, "home"),
      });

      expect(result.status).toBe("skipped_temporary_install");
      expect(await fs.readFile(existingWrapper, "utf8")).toContain("echo old");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps home-relative wrapper targets shell-safe", () => {
    const executable = path.join(os.homedir(), "Applications", "Rudder.app", "Contents", "MacOS", "Rudder");
    const wrapper = buildDesktopCliWrapper(executable, "darwin");
    expect(wrapper).toContain("exec '");
    expect(wrapper).toContain(DESKTOP_CLI_FLAG);
  });
});
