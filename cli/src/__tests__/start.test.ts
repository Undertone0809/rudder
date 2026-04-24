import { describe, expect, it, vi } from "vitest";
import {
  CLI_NPM_PACKAGE_NAME,
  detectPersistentCliState,
  hasGlobalInstalledPackage,
  hasPersistentBinaryOnPath,
  installPersistentCli,
  isLikelyNpxExecutionContext,
  isTransientBinaryPath,
  resolvePersistentCliInstallSpec,
} from "../install.js";
import {
  compareStableSemver,
  getCliUpdateNotice,
  parseChecksumFile,
  resolveCliInstallSpec,
  resolveCurrentCliVersion,
  resolveDesktopAssetTarget,
  resolveDesktopReleaseTag,
  selectChecksumAsset,
  selectDesktopAsset,
} from "../commands/start.js";

describe("persistent CLI install helpers", () => {
  it("detects npx execution from transient _npx entry paths", () => {
    expect(
      isLikelyNpxExecutionContext("/tmp/npm-cache/_npx/abc/node_modules/@rudderhq/cli/dist/index.js", {}),
    ).toBe(true);
  });

  it("does not treat normal local development execution as npx", () => {
    expect(
      isLikelyNpxExecutionContext("/Users/test/projects/rudder/cli/src/index.ts", {
        npm_command: "run-script",
      }),
    ).toBe(false);
  });

  it("resolves the install spec to the current package version when available", () => {
    expect(
      resolvePersistentCliInstallSpec({
        npm_package_name: CLI_NPM_PACKAGE_NAME,
        npm_package_version: "2026.327.0-canary.2",
      }),
    ).toBe("@rudderhq/cli@2026.327.0-canary.2");
  });

  it("falls back to the package name when version metadata is missing", () => {
    expect(resolvePersistentCliInstallSpec({})).toBe(CLI_NPM_PACKAGE_NAME);
  });

  it("reads the global install state from npm list output", () => {
    const execFileSyncImpl = vi.fn(() =>
      JSON.stringify({
        dependencies: {
          "@rudderhq/cli": { version: "0.1.0" },
        },
      }),
    );

    expect(hasGlobalInstalledPackage(CLI_NPM_PACKAGE_NAME, execFileSyncImpl as never)).toBe(true);
  });

  it("detects a persistent rudder binary on PATH", () => {
    const execFileSyncImpl = vi.fn(() => "/usr/local/bin/rudder\n");
    expect(hasPersistentBinaryOnPath(execFileSyncImpl as never)).toBe(true);
  });

  it("ignores transient npx binaries on PATH", () => {
    const execFileSyncImpl = vi.fn(() => "/tmp/npm-cache/_npx/abc/bin/rudder\n");
    expect(hasPersistentBinaryOnPath(execFileSyncImpl as never)).toBe(false);
    expect(isTransientBinaryPath("/tmp/npm-cache/_npx/abc/bin/rudder")).toBe(true);
  });

  it("marks npx execution as already installed when the package is present globally", () => {
    const execFileSyncImpl = vi
      .fn()
      .mockReturnValueOnce(
        JSON.stringify({
          dependencies: {
            "@rudderhq/cli": { version: "0.1.0" },
          },
        }),
      );

    expect(
      detectPersistentCliState({
        entryPath: "/tmp/npm-cache/_npx/abc/node_modules/@rudderhq/cli/dist/index.js",
        env: {},
        execFileSyncImpl: execFileSyncImpl as never,
      }),
    ).toEqual({
      usingNpx: true,
      alreadyInstalled: true,
      installSpec: "@rudderhq/cli",
      installCommand: "npm install --global @rudderhq/cli",
    });
  });

  it("requires installation when launched from npx without a global package or persistent binary", () => {
    const execFileSyncImpl = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("missing");
      })
      .mockImplementationOnce(() => "/tmp/npm-cache/_npx/abc/bin/rudder\n");

    expect(
      detectPersistentCliState({
        entryPath: "/tmp/npm-cache/_npx/abc/node_modules/@rudderhq/cli/dist/index.js",
        env: {
          npm_package_name: "@rudderhq/cli",
          npm_package_version: "0.1.0",
        },
        execFileSyncImpl: execFileSyncImpl as never,
      }),
    ).toEqual({
      usingNpx: true,
      alreadyInstalled: false,
      installSpec: "@rudderhq/cli@0.1.0",
      installCommand: "npm install --global @rudderhq/cli@0.1.0",
    });
  });

  it("runs npm install --global for the resolved package spec", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: "added 1 package",
      stderr: "",
    }));

    expect(
      installPersistentCli({
        installSpec: "@rudderhq/cli@0.1.0",
        spawnSyncImpl: spawnSyncImpl as never,
      }),
    ).toEqual({
      ok: true,
      command: "npm install --global @rudderhq/cli@0.1.0",
      output: "added 1 package",
    });

    expect(spawnSyncImpl).toHaveBeenCalledWith(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--global", "@rudderhq/cli@0.1.0"],
      {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
  });
});

describe("desktop start command helpers", () => {
  it("resolves the current CLI version from npm execution metadata", () => {
    expect(
      resolveCurrentCliVersion({
        npm_package_name: "@rudderhq/cli",
        npm_package_version: "0.3.1",
      }),
    ).toBe("0.3.1");
  });

  it("pins the persistent CLI install spec to the resolved version", () => {
    expect(resolveCliInstallSpec("0.3.1", {})).toBe("@rudderhq/cli@0.3.1");
  });

  it("maps stable versions to stable GitHub release tags", () => {
    expect(resolveDesktopReleaseTag("0.3.1")).toBe("v0.3.1");
  });

  it("rejects prerelease desktop starts until matching desktop releases exist", () => {
    expect(() => resolveDesktopReleaseTag("0.3.1-canary.2")).toThrow(
      "Desktop installer lookup requires a stable version",
    );
  });

  it("resolves platform installer targets", () => {
    expect(resolveDesktopAssetTarget("darwin", "arm64")).toEqual({
      platform: "macos",
      arch: "arm64",
      extension: ".dmg",
    });
    expect(resolveDesktopAssetTarget("win32", "x64")).toEqual({
      platform: "windows",
      arch: "x64",
      extension: ".exe",
    });
    expect(resolveDesktopAssetTarget("linux", "x64")).toEqual({
      platform: "linux",
      arch: "x64",
      extension: ".AppImage",
    });
  });

  it("selects the best matching desktop asset by platform and architecture", () => {
    const assets = [
      { name: "Rudder-0.3.1-macos-x64.dmg", browser_download_url: "https://example.test/macos-x64" },
      { name: "Rudder-0.3.1-macos-arm64.dmg", browser_download_url: "https://example.test/macos-arm64" },
      { name: "Rudder-0.3.1-windows-x64.exe", browser_download_url: "https://example.test/windows" },
    ];

    expect(selectDesktopAsset(assets, { platform: "macos", arch: "arm64", extension: ".dmg" })?.name).toBe(
      "Rudder-0.3.1-macos-arm64.dmg",
    );
  });

  it("supports legacy macOS DMG names that omit the platform", () => {
    const assets = [
      { name: "Rudder-0.3.1-arm64.dmg", browser_download_url: "https://example.test/macos-arm64" },
      { name: "Rudder-0.3.1-x64.dmg", browser_download_url: "https://example.test/macos-x64" },
    ];

    expect(selectDesktopAsset(assets, { platform: "macos", arch: "x64", extension: ".dmg" })?.name).toBe(
      "Rudder-0.3.1-x64.dmg",
    );
  });

  it("selects checksum assets and parses checksum files", () => {
    const assets = [
      { name: "Rudder-0.3.1-linux-x64.AppImage", browser_download_url: "https://example.test/linux" },
      { name: "SHASUMS256.txt", browser_download_url: "https://example.test/checksums" },
    ];

    expect(selectChecksumAsset(assets)?.name).toBe("SHASUMS256.txt");
    expect(
      parseChecksumFile(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Rudder-0.3.1-linux-x64.AppImage\n",
      ).get("Rudder-0.3.1-linux-x64.AppImage"),
    ).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("compares stable semver versions", () => {
    expect(compareStableSemver("0.3.2", "0.3.1")).toBeGreaterThan(0);
    expect(compareStableSemver("0.3.1", "0.3.1")).toBe(0);
    expect(compareStableSemver("0.3.0", "0.3.1")).toBeLessThan(0);
  });

  it("reports a non-blocking update notice when npm latest is newer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.3.2" }),
    })) as never;

    try {
      await expect(getCliUpdateNotice("0.3.1")).resolves.toContain("Rudder 0.3.2 is available");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not report an update notice when npm latest is not newer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.3.1" }),
    })) as never;

    try {
      await expect(getCliUpdateNotice("0.3.1")).resolves.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
