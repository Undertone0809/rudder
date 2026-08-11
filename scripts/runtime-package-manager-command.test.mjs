import { describe, expect, it } from "vitest";
import { pnpmCommand, pnpmSpawnShell } from "./package-manager-command.mjs";

describe("package manager command", () => {
  it("uses the Windows command shim on win32", () => {
    expect(pnpmCommand("win32")).toBe("pnpm.cmd");
    expect(pnpmSpawnShell("win32")).toBe(true);
  });

  it("uses the executable name on POSIX platforms", () => {
    expect(pnpmCommand("darwin")).toBe("pnpm");
    expect(pnpmCommand("linux")).toBe("pnpm");
    expect(pnpmSpawnShell("darwin")).toBe(false);
    expect(pnpmSpawnShell("linux")).toBe(false);
  });
});
