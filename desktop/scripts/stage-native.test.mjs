import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./stage-native.mjs", import.meta.url), "utf8");

describe("Desktop native staging contract", () => {
  it("builds and stages the server foundation at the resolved target-relative path", () => {
    expect(script).toMatch(/"--bin", "rudder-server-foundation"/u);
    expect(script).toMatch(/const targetRoot = path\.join\(stagedNativeRoot, target\);/u);
    expect(script).toMatch(/const serverFoundationSourcePath = path\.join\(profileRoot, serverFoundationBinaryName\);/u);
    expect(script).toMatch(/const serverFoundationDestinationPath = path\.join\(targetRoot, serverFoundationBinaryName\);/u);
    expect(script).toMatch(/await fs\.copyFile\(serverFoundationSourcePath, serverFoundationDestinationPath\);/u);
  });

  it("checks every source binary before replacing the target staging directory", () => {
    const foundationAccess = script.indexOf("await fs.access(serverFoundationSourcePath);");
    const targetRemoval = script.indexOf("await fs.rm(targetRoot");
    expect(foundationAccess).toBeGreaterThanOrEqual(0);
    expect(targetRemoval).toBeGreaterThan(foundationAccess);
  });

  it("keeps all existing native binaries in the staging contract", () => {
    for (const binary of [
      "rudder-process-host",
      "rudder-native",
      "rudder-update-helper",
      "migration-preflight",
      "rudder-server-foundation",
    ]) {
      expect(script).toContain(binary);
    }
  });
});
