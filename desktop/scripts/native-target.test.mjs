import { describe, expect, it } from "vitest";
import { resolveNativeTarget } from "./native-target.mjs";

describe("Rust native target mapping", () => {
  it.each([
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
  ])("maps %s/%s to %s", (platform, arch, target) => {
    expect(resolveNativeTarget(platform, arch)).toBe(target);
  });

  it("does not claim an unsupported target", () => {
    expect(resolveNativeTarget("linux", "arm64")).toBeNull();
  });
});
