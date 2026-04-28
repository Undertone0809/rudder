import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
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
  buildGithubReleaseAssetDownloadUrl,
  buildForceQuitCommand,
  buildLinuxDesktopEntry,
  compareStableSemver,
  copyPortableAppBundle,
  downloadAsset,
  downloadChecksums,
  getCliUpdateNotice,
  isInstalledDesktopCurrent,
  isPersistentCliVersionCurrent,
  parseChecksumFile,
  resolveAssetChecksum,
  resolveCliInstallSpec,
  resolveCurrentCliVersion,
  resolveDesktopAssetTarget,
  resolveDefaultDesktopInstallRoot,
  resolveDesktopAssetName,
  resolveDesktopInstallPaths,
  resolveDesktopReleaseVersion,
  resolveDesktopReleaseTag,
  selectChecksumAsset,
  selectDesktopAsset,
} from "../commands/start.js";
import { createByteProgress, formatByteProgress } from "../utils/progress.js";

function responseFromChunks(chunks: string[], headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  } as Response;
}

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
  it("copies portable app bundles without rewriting relative symlinks", async () => {
    if (process.platform === "win32") return;

    const root = await mkdtemp(path.join(tmpdir(), "rudder-copy-bundle-test."));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const packagePath = path.join(source, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg");
      const symlinkPath = path.join(source, "node_modules", "pkg");
      await mkdir(packagePath, { recursive: true });
      await writeFile(path.join(packagePath, "index.js"), "export {};\n");
      await symlink(".pnpm/pkg@1.0.0/node_modules/pkg", symlinkPath);

      await copyPortableAppBundle(source, destination);

      const copiedSymlink = path.join(destination, "node_modules", "pkg");
      expect(await readlink(copiedSymlink)).toBe(".pnpm/pkg@1.0.0/node_modules/pkg");
      await access(path.join(copiedSymlink, "index.js"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("builds deterministic portable asset names and release download URLs", () => {
    const macTarget = { platform: "macos" as const, arch: "arm64" as const, extension: ".zip" as const };
    const linuxTarget = { platform: "linux" as const, arch: "x64" as const, extension: ".AppImage" as const };
    const windowsTarget = { platform: "windows" as const, arch: "x64" as const, extension: ".zip" as const };

    expect(resolveDesktopReleaseVersion("canary/v0.3.1-canary.2")).toBe("0.3.1-canary.2");
    expect(resolveDesktopReleaseVersion("v0.3.1")).toBe("0.3.1");
    expect(resolveDesktopReleaseVersion("latest")).toBeNull();
    expect(resolveDesktopAssetName("0.3.1-canary.2", macTarget)).toBe(
      "Rudder-0.3.1-canary.2-macos-arm64-portable.zip",
    );
    expect(resolveDesktopAssetName("0.3.1-canary.2", linuxTarget)).toBe(
      "Rudder-0.3.1-canary.2-linux-x64.AppImage",
    );
    expect(resolveDesktopAssetName("0.3.1-canary.2", windowsTarget)).toBe(
      "Rudder-0.3.1-canary.2-windows-x64-portable.zip",
    );
    expect(
      buildGithubReleaseAssetDownloadUrl(
        "Undertone0809/rudder",
        "canary/v0.3.1-canary.2",
        "SHASUMS256.txt",
      ),
    ).toBe("https://github.com/Undertone0809/rudder/releases/download/canary/v0.3.1-canary.2/SHASUMS256.txt");
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

  it("formats determinate and unknown-size byte progress", () => {
    expect(formatByteProgress({ receivedBytes: 1024, totalBytes: 2048, width: 10 })).toBe(
      "[#####-----] 50% 1.0 KB/2.0 KB",
    );
    expect(formatByteProgress({ receivedBytes: 1024, totalBytes: null, width: 10 })).toBe(
      "[downloaded 1.0 KB]",
    );
  });

  it("uses stable non-TTY progress lines without cursor controls", () => {
    const writes: string[] = [];
    const stream = {
      write(chunk: string) {
        writes.push(String(chunk));
        return true;
      },
    } as unknown as Writable;

    const progress = createByteProgress("Downloading Rudder.zip", {
      stream,
      isTty: false,
    });
    progress.start(2048);
    progress.update(1024, 2048);
    progress.finish(2048, 2048);

    const output = writes.join("");
    expect(output).toContain("Downloading Rudder.zip...\n");
    expect(output).toContain("Downloading Rudder.zip complete (2.0 KB/2.0 KB).\n");
    expect(output).not.toContain("\r");
  });

  it("reports progress while downloading checksum and desktop assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-download-progress-test."));
    const originalFetch = globalThis.fetch;
    const checksumBody =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Rudder-0.3.1-linux-x64.AppImage\n";
    const desktopBody = "desktop-asset";
    const progressEvents: Array<{ event: string; label: string; receivedBytes?: number; totalBytes?: number | null }> = [];
    const progressFactory = vi.fn((label: string) => ({
      start: vi.fn((totalBytes?: number | null) => {
        progressEvents.push({ event: "start", label, totalBytes });
      }),
      update: vi.fn((receivedBytes: number, totalBytes?: number | null) => {
        progressEvents.push({ event: "update", label, receivedBytes, totalBytes });
      }),
      finish: vi.fn((receivedBytes?: number, totalBytes?: number | null) => {
        progressEvents.push({ event: "finish", label, receivedBytes, totalBytes });
      }),
      fail: vi.fn(() => {
        progressEvents.push({ event: "fail", label });
      }),
    }));

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        responseFromChunks([checksumBody], {
          "content-length": String(Buffer.byteLength(checksumBody)),
        }),
      )
      .mockResolvedValueOnce(
        responseFromChunks(["desktop-", "asset"], {
          "content-length": String(Buffer.byteLength(desktopBody)),
        }),
      ) as never;

    try {
      const checksums = await downloadChecksums(
        { name: "SHASUMS256.txt", browser_download_url: "https://example.test/checksums" },
        dir,
        progressFactory,
      );
      expect(resolveAssetChecksum(checksums, "Rudder-0.3.1-linux-x64.AppImage")).toBe(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );

      const assetPath = await downloadAsset(
        { name: "Rudder-0.3.1-linux-x64.AppImage", browser_download_url: "https://example.test/asset" },
        dir,
        progressFactory,
      );
      expect(await readFile(assetPath, "utf8")).toBe(desktopBody);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }

    expect(progressFactory).toHaveBeenCalledWith("Downloading SHASUMS256.txt");
    expect(progressFactory).toHaveBeenCalledWith("Downloading Rudder-0.3.1-linux-x64.AppImage");
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "update", label: "Downloading SHASUMS256.txt" }),
        expect.objectContaining({ event: "finish", label: "Downloading SHASUMS256.txt" }),
        expect.objectContaining({ event: "update", label: "Downloading Rudder-0.3.1-linux-x64.AppImage" }),
        expect.objectContaining({ event: "finish", label: "Downloading Rudder-0.3.1-linux-x64.AppImage" }),
      ]),
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
