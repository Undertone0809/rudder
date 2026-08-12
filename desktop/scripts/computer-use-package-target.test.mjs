import { describe, expect, it } from "vitest";
import { resolveComputerUsePackageTarget } from "./computer-use-package-target.mjs";

describe("Computer Use native package target", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64", "libcua_driver_sdk.dylib"],
    ["darwin", "x64", "darwin-x64", "libcua_driver_sdk.dylib"],
    ["linux", "arm64", "linux-arm64-gnu", "libcua_driver_sdk.so"],
    ["linux", "x64", "linux-x64-gnu", "libcua_driver_sdk.so"],
    ["win32", "arm64", "win32-arm64-msvc", "cua_driver_sdk.dll"],
    ["win32", "x64", "win32-x64-msvc", "cua_driver_sdk.dll"],
  ])("maps %s/%s to its native runtime", (platform, arch, suffix, library) => {
    expect(resolveComputerUsePackageTarget(platform, arch)).toMatchObject({
      nativeSuffix: suffix,
      driverPackage: `@trycua/cua-driver-${suffix}`,
      ubjsPackage: `@ubjs/node-${suffix}`,
      driverFiles: [library, "cua_driver_node_runtime.node"],
      ubjsFile: `uniffi-runtime-napi.${suffix}.node`,
    });
  });

  it("returns null for unsupported operating systems", () => {
    expect(resolveComputerUsePackageTarget("aix", "x64")).toBeNull();
  });

  it("fails closed for unsupported architectures on supported systems", () => {
    expect(() => resolveComputerUsePackageTarget("linux", "riscv64"))
      .toThrow("Unsupported linux Computer Use architecture: riscv64.");
  });
});
