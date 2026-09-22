import { describe, expect, it } from "vitest";
import {
  resolveDesktopPackagedRustFoundationBinaryPath,
  resolveDesktopRustFoundationRuntimeOverrides,
} from "./rust-foundation-runtime.js";

describe("Desktop Rust foundation startup configuration", () => {
  const resourcesPath = "/tmp/codex-rudder-missing-resources";
  const packagedBinaryPath = `${resourcesPath}/native/aarch64-apple-darwin/rudder-server-foundation`;

  it("selects the packaged required policy without inspecting asset presence", () => {
    expect(resolveDesktopRustFoundationRuntimeOverrides({
      isPackaged: true,
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    })).toEqual({
      rustFoundationMode: "required",
      rustFoundationBinaryPath: packagedBinaryPath,
    });
  });

  it("preserves explicit off and shadow modes", () => {
    expect(resolveDesktopRustFoundationRuntimeOverrides({
      isPackaged: true,
      memberDirectoryMode: "off",
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    })).toEqual({ rustFoundationBinaryPath: packagedBinaryPath });
    expect(resolveDesktopRustFoundationRuntimeOverrides({
      isPackaged: true,
      memberDirectoryMode: "shadow",
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    })).toEqual({ rustFoundationBinaryPath: packagedBinaryPath });
  });

  it("does not replace an explicitly configured binary path", () => {
    expect(resolveDesktopRustFoundationRuntimeOverrides({
      isPackaged: true,
      configuredBinaryPath: " /custom/rudder-server-foundation ",
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    })).toEqual({ rustFoundationMode: "required" });
  });

  it("returns a deterministic path even when the packaged file is absent", () => {
    expect(resolveDesktopPackagedRustFoundationBinaryPath({
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    })).toBe(packagedBinaryPath);
  });
});
