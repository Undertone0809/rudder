import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_CLI_FLAG,
  buildDesktopCliWrapper,
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

  it("ignores normal desktop launches", () => {
    expect(resolveDesktopCliArgv([process.execPath, "ignored"])).toBeNull();
  });

  it("only installs the desktop cli wrapper for packaged desktop builds", () => {
    expect(shouldInstallDesktopCliLink(false)).toBe(false);
    expect(shouldInstallDesktopCliLink(true)).toBe(true);
  });

  it("keeps home-relative wrapper targets shell-safe", () => {
    const executable = path.join(os.homedir(), "Applications", "Rudder.app", "Contents", "MacOS", "Rudder");
    const wrapper = buildDesktopCliWrapper(executable, "darwin");
    expect(wrapper).toContain("exec '");
    expect(wrapper).toContain(DESKTOP_CLI_FLAG);
  });
});
