import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  assertChecksumMatch,
  buildForceQuitCommand,
  buildLinuxDesktopEntry,
  compareStableSemver,
  getCliUpdateNotice,
  isInstalledDesktopCurrent,
  isPersistentCliVersionCurrent,
  parseChecksumFile,
  resolveAssetChecksum,
  resolveCliInstallSpec,
  resolveCurrentCliVersion,
  resolveDesktopAssetTarget,
  resolveDefaultDesktopInstallRoot,
  resolveDesktopInstallPaths,
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

  it("retries with --force when npm reports an existing rudder binary", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "npm error code EEXIST\nnpm error File exists: /usr/local/bin/rudder\n",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "changed 1 package",
        stderr: "",
      });

    expect(
      installPersistentCli({
        installSpec: "@rudderhq/cli@0.1.0",
        spawnSyncImpl: spawnSyncImpl as never,
      }),
    ).toEqual({
      ok: true,
      command: "npm install --global --force @rudderhq/cli@0.1.0",
      output: "changed 1 package",
    });

    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      1,
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--global", "@rudderhq/cli@0.1.0"],
      {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      2,
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--global", "--force", "@rudderhq/cli@0.1.0"],
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

  it("maps canary versions to canary GitHub release tags", () => {
    expect(resolveDesktopReleaseTag("0.3.1-canary.2")).toBe("canary/v0.3.1-canary.2");
  });

  it("rejects unsupported prerelease desktop starts", () => {
    expect(() => resolveDesktopReleaseTag("0.3.1-beta.2")).toThrow(
      "Desktop release lookup requires a release version",
    );
  });

  it("resolves platform portable asset targets", () => {
    expect(resolveDesktopAssetTarget("darwin", "arm64")).toEqual({
      platform: "macos",
      arch: "arm64",
      extension: ".zip",
    });
    expect(resolveDesktopAssetTarget("win32", "x64")).toEqual({
      platform: "windows",
      arch: "x64",
      extension: ".zip",
    });
    expect(resolveDesktopAssetTarget("win32", "arm64")).toEqual({
      platform: "windows",
      arch: "x64",
      extension: ".zip",
    });
    expect(resolveDesktopAssetTarget("linux", "x64")).toEqual({
      platform: "linux",
      arch: "x64",
      extension: ".AppImage",
    });
    expect(() => resolveDesktopAssetTarget("linux", "arm64")).toThrow("does not publish portable assets");
  });

  it("selects the best matching desktop asset by platform and architecture", () => {
    const assets = [
      { name: "Rudder-0.3.1-macos-x64-portable.zip", browser_download_url: "https://example.test/macos-x64" },
      { name: "Rudder-0.3.1-macos-arm64-portable.zip", browser_download_url: "https://example.test/macos-arm64" },
      { name: "Rudder-0.3.1-windows-x64-portable.zip", browser_download_url: "https://example.test/windows" },
    ];

    expect(selectDesktopAsset(assets, { platform: "macos", arch: "arm64", extension: ".zip" })?.name).toBe(
      "Rudder-0.3.1-macos-arm64-portable.zip",
    );
  });

  it("supports legacy macOS zip names that omit the platform", () => {
    const assets = [
      { name: "Rudder-0.3.1-arm64.zip", browser_download_url: "https://example.test/macos-arm64" },
      { name: "Rudder-0.3.1-x64.zip", browser_download_url: "https://example.test/macos-x64" },
    ];

    expect(selectDesktopAsset(assets, { platform: "macos", arch: "x64", extension: ".zip" })?.name).toBe(
      "Rudder-0.3.1-x64.zip",
    );
  });

  it("selects checksum assets and parses checksum files", () => {
    const assets = [
      { name: "Rudder-0.3.1-linux-x64.AppImage", browser_download_url: "https://example.test/linux" },
      { name: "SHASUMS256.txt", browser_download_url: "https://example.test/checksums" },
    ];

    expect(selectChecksumAsset(assets)?.name).toBe("SHASUMS256.txt");
    const checksums = parseChecksumFile(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Rudder-0.3.1-linux-x64.AppImage\n",
    );
    expect(resolveAssetChecksum(checksums, "Rudder-0.3.1-linux-x64.AppImage")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(() => resolveAssetChecksum(checksums, "Rudder-0.3.1-macos-arm64-portable.zip")).toThrow(
      "checksums do not include",
    );
  });

  it("compares stable semver versions", () => {
    expect(compareStableSemver("0.3.2", "0.3.1")).toBeGreaterThan(0);
    expect(compareStableSemver("0.3.1", "0.3.1")).toBe(0);
    expect(compareStableSemver("0.3.0", "0.3.1")).toBeLessThan(0);
  });

  it("checks whether the global CLI is already the requested version", () => {
    expect(isPersistentCliVersionCurrent("0.3.1", "0.3.1")).toBe(true);
    expect(isPersistentCliVersionCurrent("0.3.1", "0.3.0")).toBe(false);
    expect(isPersistentCliVersionCurrent("latest", "0.3.1")).toBe(false);
  });

  it("checks whether installed desktop metadata already matches the release asset", () => {
    expect(
      isInstalledDesktopCurrent(
        {
          version: 1,
          releaseTag: "v0.3.1",
          assetName: "Rudder-0.3.1-macos-arm64-portable.zip",
          assetChecksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          installedAt: "2026-04-27T00:00:00.000Z",
        },
        "v0.3.1",
        "Rudder-0.3.1-macos-arm64-portable.zip",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBe(true);
    expect(
      isInstalledDesktopCurrent(
        {
          version: 1,
          releaseTag: "v0.3.1",
          assetName: "Rudder-0.3.1-macos-arm64-portable.zip",
          assetChecksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          installedAt: "2026-04-27T00:00:00.000Z",
        },
        "v0.3.1",
        "Rudder-0.3.1-macos-arm64-portable.zip",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toBe(false);
  });

  it("resolves per-user portable install paths", () => {
    const macTarget = { platform: "macos" as const, arch: "arm64" as const, extension: ".zip" as const };
    expect(resolveDefaultDesktopInstallRoot(macTarget, {}, "/Users/test")).toBe("/Users/test/Applications");
    expect(resolveDesktopInstallPaths(macTarget, "/Users/test/Applications")).toMatchObject({
      appPath: "/Users/test/Applications/Rudder.app",
      executablePath: "/Users/test/Applications/Rudder.app/Contents/MacOS/Rudder",
    });

    const winTarget = { platform: "windows" as const, arch: "x64" as const, extension: ".zip" as const };
    expect(resolveDefaultDesktopInstallRoot(winTarget, { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test")).toBe(
      path.join("C:\\Users\\test\\AppData\\Local", "Programs", "Rudder"),
    );
  });

  it("validates checksum matches and mismatches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-checksum-test."));
    const filePath = path.join(dir, "Rudder-test.zip");
    await writeFile(filePath, "portable");
    try {
      expect(assertChecksumMatch(filePath, "01e782826ae5182220bd6158f883d01ceb1bce659dc020e7c511f802a9aa7737")).toBe(
        "01e782826ae5182220bd6158f883d01ceb1bce659dc020e7c511f802a9aa7737",
      );
      expect(() => assertChecksumMatch(filePath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(
        "Checksum mismatch",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds Windows force-quit fallback commands", () => {
    expect(buildForceQuitCommand({ platform: "windows", arch: "x64", extension: ".zip" })).toEqual({
      command: "taskkill.exe",
      args: ["/IM", "Rudder.exe", "/T", "/F"],
    });
  });

  it("builds Linux desktop entries for the AppImage", () => {
    expect(buildLinuxDesktopEntry("/home/test/.local/share/rudder/Rudder.AppImage")).toContain(
      'Exec="/home/test/.local/share/rudder/Rudder.AppImage"',
    );
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
