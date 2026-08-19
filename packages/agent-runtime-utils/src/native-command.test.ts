import { describe, expect, it } from "vitest";
import { resolveNativeCommand } from "./native-command.js";

describe("resolveNativeCommand", () => {
  it("executes Node script fixtures through Node on Windows", () => {
    expect(resolveNativeCommand("/tmp/native-fixture.mjs", ["arg"], "win32")).toEqual({
      command: process.execPath,
      args: ["/tmp/native-fixture.mjs", "arg"],
    });
  });

  it("keeps native binaries direct on Windows", () => {
    expect(resolveNativeCommand("C:/native/rudder-native.exe", ["archive"], "win32")).toEqual({
      command: "C:/native/rudder-native.exe",
      args: ["archive"],
    });
  });

  it("keeps shell-free script execution direct on Unix", () => {
    expect(resolveNativeCommand("/tmp/native-fixture.mjs", ["arg"], "linux")).toEqual({
      command: "/tmp/native-fixture.mjs",
      args: ["arg"],
    });
  });
});
