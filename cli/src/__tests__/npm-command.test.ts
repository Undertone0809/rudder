import { describe, expect, it } from "vitest";
import { resolveNpmCommandInvocation } from "../npm-command.js";

describe("npm command invocation", () => {
  it("uses cmd.exe to invoke npm.cmd on Windows", () => {
    expect(resolveNpmCommandInvocation("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd"],
    });
  });

  it("supports uppercase COMSPEC and the cmd.exe fallback", () => {
    expect(resolveNpmCommandInvocation("win32", { COMSPEC: "C:\\Windows\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd"],
    });
    expect(resolveNpmCommandInvocation("win32", {})).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd"],
    });
  });

  it("invokes npm directly on non-Windows platforms", () => {
    expect(resolveNpmCommandInvocation("linux", { ComSpec: "ignored.exe" })).toEqual({
      command: "npm",
      args: [],
    });
  });
});
